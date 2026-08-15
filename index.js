/**
 * dsh-voice-core host — the shared voice engine for companion plugins.
 *
 * This package is a LIBRARY, not a standalone plugin: consumer plugins
 * (dsh-teacher, dsh-sister) call `applyVoice(ctx, config)` from their own
 * `apply()`. It provides:
 *
 * - TTS proxy routes (`/dsh-voice/tts` + health) forwarding to the local
 *   Qwen3-TTS VoiceDesign service (127.0.0.1:3091, overridable via
 *   `DSH_VOICE_TTS_URL`). The path prefix is configurable so multiple
 *   consumers can coexist.
 * - `speak` / `cheer` model tools (log-only `voice/*` events).
 * - `/speak /cheer /cheer-at /cheer-text /voice` commands.
 * - The `voiceSpeak` session projection (folded from `voice/*` events).
 * - The daily greeting scheduler: at configured times it nudges live sessions
 *   via `agent.followup` so the agent itself composes a fresh greeting + fun
 *   fact/news (or speaks a fixed text when one is configured).
 *
 * Voice styles are config-driven: `config.styles` (default catalog) +
 * `config.defaultStyle`. The client reads the projection and offers a style
 * picker; each style is a natural-language VoiceDesign instruct.
 *
 * @module dsh-voice-core
 */
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

import { SPEAK_EVENT, SPOKEN_EVENT, CHEER_EVENT, foldVoiceState } from './lib/fold.js'
import { voiceSpeakProjectionWith } from './lib/voice-projection.js'
import { DEFAULT_STYLES, DEFAULT_STYLE, DEFAULT_CHEERS, pickCheer, parseTimes, dateKey, dueTimes } from './lib/voice.js'

for (const type of [SPEAK_EVENT, SPOKEN_EVENT, CHEER_EVENT]) {
  KNOWN_SESSION_EVENT_TYPES.add(type)
}

export const VOICE_NAME = 'dsh-voice-core'

export const TICK_MS = 30_000

function defaultStateDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'state', 'dsh-voice')
}

/** Persisted daily-greeting schedule: { times: string[], fired: Record<date, string[]>, text?: string }. */
export class VoiceSchedule {
  constructor(path) {
    this.path = path
    this.times = []
    this.fired = {}
    this.text = ''
    this.load()
  }

  load() {
    try {
      if (existsSync(this.path)) {
        const data = JSON.parse(readFileSync(this.path, 'utf8'))
        if (Array.isArray(data.times) && data.times.length > 0) this.times = data.times
        if (data.fired && typeof data.fired === 'object') this.fired = data.fired
        if (typeof data.text === 'string') this.text = data.text
      }
    } catch (error) {
      // corrupt schedule file → fall back to defaults
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const payload = { times: this.times, fired: this.fired }
      if (this.text) payload.text = this.text
      writeFileSync(this.path, JSON.stringify(payload, null, 2))
    } catch (error) {
      // best-effort persistence
    }
  }

  setTimes(times) {
    this.times = times
    this.save()
  }

  /** Set a fixed greeting text spoken at every scheduled time ('' clears it). */
  setText(text) {
    this.text = text === undefined || text === null ? '' : String(text).trim()
    this.save()
  }

  markFired(day, time) {
    ;(this.fired[day] ??= []).push(time)
    this.save()
  }

  firedToday(day, time) {
    return Array.isArray(this.fired[day]) && this.fired[day].includes(time)
  }
}

/** Session-scoped controller: TTS fold state per session + shared schedule. */
export class VoiceController {
  constructor(ctx, schedule, config) {
    this.ctx = ctx
    this.schedule = schedule
    this.config = config
    this.sessions = new Map() // sessionId -> { agent }
    this.timer = null
  }

  sessionKey(agent) {
    return agent.session.id
  }

  track(agent) {
    if (agent !== undefined && agent !== null && agent.session !== undefined) {
      this.sessions.set(this.sessionKey(agent), { agent })
    }
  }

  speakEnabledOf(agent) {
    return foldVoiceState(agent.session.events).speakEnabled
  }

  /** Toggle TTS auto-speak (log-only `voice/speak` event). */
  setSpeak(agent, enabled) {
    try {
      agent.session.append(SPEAK_EVENT, { enabled })
      return 'committed'
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-voice-core: failed to append voice/speak: ${error}`)
      return 'queued'
    }
  }

  /** Record a speak request (browser plays it; never blocks the agent). */
  appendSpoken(agent, text, voice = null) {
    try {
      agent.session.append(SPOKEN_EVENT, { text: String(text ?? ''), voice })
      return true
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-voice-core: failed to append voice/spoken: ${error}`)
      return false
    }
  }

  /** Record a cheer/greeting (client speaks it AND shows the chip). */
  appendCheer(agent, text) {
    try {
      agent.session.append(CHEER_EVENT, { text: String(text ?? ''), at: Date.now() })
      agent.session.append(SPOKEN_EVENT, { text: String(text ?? ''), voice: null })
      return true
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-voice-core: failed to append voice/cheer: ${error}`)
      return false
    }
  }

  /**
   * Nudge one session to greet the learner. A fixed text (if configured) is
   * spoken directly; otherwise the agent itself composes a welcome + fun fact
   * / news via the cheer tool (model-generated, varies daily). Falls back to
   * the rotating bank when the session can't accept messages.
   */
  async greet(agent) {
    const fixed = this.schedule.text && this.schedule.text.trim()
    if (fixed) {
      return this.appendCheer(agent, fixed.trim())
    }
    const prompt = this.config.greetingPrompt
    if (agent !== undefined && typeof agent.followup === 'function') {
      try {
        agent.followup({
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: 'dsh-voice-core' },
        })
        return true
      } catch (error) {
        this.ctx.logger?.warn?.(`dsh-voice-core: greet followup failed: ${error}`)
        return this.appendCheer(agent, pickCheer(DEFAULT_CHEERS, new Date()))
      }
    }
    return this.appendCheer(agent, pickCheer(DEFAULT_CHEERS, new Date()))
  }

  /** Fire today's due greeting into every live session, once per time. */
  async tick() {
    const now = new Date()
    const day = dateKey(now)
    const due = dueTimes(this.schedule.times, now, new Set(this.schedule.fired[day] ?? []))
    if (due.length === 0) return 0
    let fired = 0
    for (const time of due) {
      for (const { agent } of this.sessions.values()) {
        if (await this.greet(agent)) fired++
      }
      this.schedule.markFired(day, time)
    }
    return fired
  }

  start() {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      try {
        void this.tick()
      } catch (error) {
        this.ctx.logger?.warn?.(`dsh-voice-core: greeting tick failed: ${error}`)
      }
    }, TICK_MS)
  }

  stop() {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

/** Resolve consumer config against defaults. */
export function normalizeConfig(input = {}) {
  const styles = input.styles ?? DEFAULT_STYLES
  const defaultStyle = input.defaultStyle ?? (styles[DEFAULT_STYLE] ? DEFAULT_STYLE : Object.keys(styles)[0])
  const times = Array.isArray(input.cheerTimes) ? input.cheerTimes : []
  const schedulerEnabled = input.schedulerEnabled ?? false
  return {
    presetName: input.presetName ?? 'voice',
    ttsPath: input.ttsPath ?? '/dsh-voice/tts',
    ttsBase: input.ttsBase ?? process.env.DSH_VOICE_TTS_URL ?? process.env.DSH_SISTER_TTS_URL ?? 'http://127.0.0.1:3091',
    styles,
    defaultStyle,
    cheerTimes: times,
    schedulerEnabled,
    greetingPrompt: input.greetingPrompt
      ?? '（定时问候）现在是下午 3 点，请先用 cheer 工具送上一句温暖的欢迎回家问候，并顺带分享一个有趣的小知识或今天的小新闻（可以用网络搜索），一两句话就好，说完请休息放松。',
    scheduleFile: input.scheduleFile ?? defaultScheduleFile(input.scheduleName),
  }
}

function defaultScheduleFile(name) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'state', name && String(name).trim() ? String(name).trim() : 'dsh-voice', 'schedule.json')
}

/**
 * Apply the voice engine into a consumer plugin context. Returns the
 * controller so the consumer can stop the timer on dispose.
 */
export async function applyVoice(ctx, input = {}) {
  const config = normalizeConfig(input)
  const schedule = new VoiceSchedule(config.scheduleFile)
  const controller = new VoiceController(ctx, schedule, config)

  // Track live sessions so the scheduler can greet into them.
  ctx.on('agent/session-start', ({ agent }) => {
    controller.track(agent)
  })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    controller.track(agent)
    return next()
  })

  // Session projection: fold voice/speak + voice/spoken + voice/cheer so the
  // Web client drives TTS + the cheer chip via useProjection('voiceSpeak').
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(
      voiceSpeakProjectionWith(
        z.object({
          speakEnabled: z.boolean(),
          lastSpoken: z.any(),
          lastCheer: z.any(),
        }),
      ),
    )
  })

  // Daily greeting scheduler (opt-in via config.schedulerEnabled).
  let started = false
  if (config.schedulerEnabled) {
    controller.start()
    started = true
  }
  const disposer = () => {
    if (started) controller.stop()
  }
  ctx.on('dispose', disposer)

  // ---- TTS proxy -----------------------------------------------------------
  const webServer = ctx.get('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    const healthPath = config.ttsPath.replace(/\/$/, '') + '-health'
    webServer.register({
      kind: 'exact',
      path: config.ttsPath,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const text = url.searchParams.get('text') ?? ''
        const instruct = url.searchParams.get('instruct') ?? ''
        if (!text) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'text is required' }))
          return
        }
        try {
          const target = new URL('/tts', config.ttsBase)
          target.searchParams.set('text', text)
          if (instruct) target.searchParams.set('instruct', instruct)
          const upstream = await fetch(target.toString())
          if (!upstream.ok) {
            res.writeHead(502, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: `tts upstream ${upstream.status}` }))
            return
          }
          const buf = Buffer.from(await upstream.arrayBuffer())
          res.writeHead(200, {
            'content-type': 'audio/wav',
            'cache-control': 'no-store',
            'content-length': String(buf.length),
            'x-tts-ms': upstream.headers.get('x-tts-ms') ?? '',
          })
          res.end(buf)
        } catch (error) {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: `tts service unreachable: ${String(error)}` }))
        }
      },
    })
    webServer.register({
      kind: 'exact',
      path: healthPath,
      handler: async (_req, res) => {
        try {
          const upstream = await fetch(new URL('/health', config.ttsBase).toString())
          const body = await upstream.text()
          res.writeHead(upstream.status, { 'content-type': 'application/json' })
          res.end(body)
        } catch {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'tts service unreachable' }))
        }
      },
    })
  }

  // ---- commands -----------------------------------------------------------
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'speak',
      description: 'Toggle TTS auto-speak, or speak text aloud right now',
      input: { hint: '[on|off|<text>]' },
      handler: async ({ agent, rawInput }) => {
        const action = rawInput.trim()
        if (action === 'on' || action === 'off') {
          controller.setSpeak(agent, action === 'on')
          return { kind: 'success', text: `TTS ${action === 'on' ? 'on' : 'off'}.` }
        }
        if (action === '') {
          return {
            kind: 'success',
            text: controller.speakEnabledOf(agent)
              ? 'TTS auto-speak is on. /speak off to mute.'
              : 'TTS auto-speak is off. /speak on to enable.',
          }
        }
        if (controller.appendSpoken(agent, action)) {
          return { kind: 'success', text: 'Speaking…' }
        }
        return { kind: 'error', text: 'speak failed' }
      },
    })

    commandCtx.commands.register({
      name: 'cheer',
      description: 'Fire a warm cheer right now (spoken + shown as a chip)',
      input: { hint: '[<custom text>]' },
      handler: async ({ agent, rawInput }) => {
        const text = rawInput.trim() || pickCheer(DEFAULT_CHEERS)
        if (controller.appendCheer(agent, text)) {
          return { kind: 'success', text: 'Cheer sent! 💛' }
        }
        return { kind: 'error', text: 'cheer failed' }
      },
    })

    commandCtx.commands.register({
      name: 'cheer-at',
      description: 'Set the daily greeting times (HH:MM, 24h). e.g. /cheer-at 15:00',
      input: { hint: '<HH:MM> [<HH:MM> …]' },
      handler: async ({ rawInput }) => {
        try {
          const times = parseTimes(rawInput.trim().split(/\s+/), null)
          controller.schedule.setTimes(times)
          return {
            kind: 'success',
            text: `Daily greetings set at ${times.join(', ')} — sound requires the browser tab to be open at that time.`,
          }
        } catch (error) {
          return { kind: 'error', text: error.message }
        }
      },
    })

    commandCtx.commands.register({
      name: 'cheer-text',
      description: 'Set a fixed greeting text (spoken verbatim at every scheduled time); /cheer-text off clears it and the agent composes a fresh welcome + fun fact each day',
      input: { hint: '<text> | off' },
      handler: async ({ rawInput }) => {
        const text = rawInput.trim()
        if (text === '' || text === 'off' || text === 'clear') {
          controller.schedule.setText('')
          return {
            kind: 'success',
            text: 'Fixed greeting text cleared — the agent now composes a fresh welcome + fun fact/news each day.',
          }
        }
        controller.schedule.setText(text)
        return { kind: 'success', text: `Fixed greeting text set: "${text}"` }
      },
    })

    commandCtx.commands.register({
      name: 'voice',
      description: 'Show the voice status: TTS on/off, style, and daily greeting times',
      input: { hint: '' },
      handler: async ({ agent }) => {
        const enabled = controller.speakEnabledOf(agent)
        const fixed = controller.schedule.text && controller.schedule.text.trim()
        const style = config.defaultStyle
        const times = controller.schedule.times.length > 0 ? controller.schedule.times.join(', ') : '(off)'
        return {
          kind: 'success',
          text: `Voice status: TTS ${enabled ? 'on' : 'off'} · style: ${style} · daily greetings: ${times} · fixed text: ${fixed ? `"${fixed}"` : 'auto (fresh welcome + fun fact each day)'} · /speak on|off · /cheer-at sets times · /cheer-text sets fixed text.`,
        }
      },
    })
  })

  // ---- model-facing tools -------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'speak',
    description:
      'Ask that text be spoken aloud to the learner. The speech is generated by Qwen3-TTS on the host and played by the browser on the user\'s own machine — this tool only records the request. Use it for short, warm, encouraging lines (1–2 sentences). Respect /speak off (TTS muted).',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to speak aloud.' },
      voice: { type: 'string', description: 'Optional voice style key (e.g. paimon/onee/cute).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
        },
      },
      render: (_args, result) => [
        { type: 'text', text: result.ok ? 'Speech requested.' : 'speak failed' },
      ],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('speak requires a calling agent')
      if (!controller.appendSpoken(agent, String(args.text ?? ''), args.voice ?? null)) {
        throw new Error('speak failed')
      }
      return { ok: true }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Speak', kind: 'other' }),
    presentResult: (_args, result) => {
      if (result.isError) return void 0
      return { card: 'generic', title: 'Speech requested', content: 'The browser will read it aloud on the user\'s machine.' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cheer',
    description:
      'Send the learner a warm, positive cheer or greeting. The browser speaks it aloud and shows a little chip. Use it generously — whenever the learner achieves something, feels down, or just needs a boost. Keep it to 1–2 short, cheerful sentences.',
    parameters: {
      text: { type: 'string', description: 'Optional custom cheer text; a bank cheer is picked when omitted.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
        },
      },
      render: (_args, result) => [
        { type: 'text', text: result.ok ? 'Cheer sent.' : 'cheer failed' },
      ],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('cheer requires a calling agent')
      const text = String(args.text ?? '').trim() || pickCheer(DEFAULT_CHEERS)
      if (!controller.appendCheer(agent, text)) {
        throw new Error('cheer failed')
      }
      return { ok: true }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Cheer', kind: 'other' }),
    presentResult: (_args, result) => {
      if (result.isError) return void 0
      return { card: 'generic', title: 'Cheer sent', content: 'The browser will read it aloud and show the chip.' }
    },
  }))

  return controller
}
