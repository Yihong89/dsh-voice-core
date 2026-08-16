/**
 * Host smoke test for dsh-voice-core: applies applyVoice against mocked DSH
 * services and asserts commands/tools/projection/TTS proxy register, then
 * exercises the scheduler and greet paths.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function installToolStub() {
  const dir = join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', type: 'module', main: 'index.js' }))
  writeFileSync(join(dir, 'index.js'), 'export function defineTool(def) { return def }\n')
  const zodDir = join(REPO_ROOT, 'node_modules', 'zod')
  mkdirSync(zodDir, { recursive: true })
  writeFileSync(join(zodDir, 'package.json'), JSON.stringify({ name: 'zod', type: 'module', main: 'index.js' }))
  writeFileSync(join(zodDir, 'index.js'), 'export const z = { object: (s) => ({ _shape: s }), array: (x) => x, any: () => "any", boolean: () => "boolean", string: () => "string" }\n')
  const sessionDir = join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh-session')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', type: 'module', main: 'index.js' }))
  writeFileSync(join(sessionDir, 'index.js'), 'export const KNOWN_SESSION_EVENT_TYPES = new Set()\n')
  return dir
}

function mockSession(id = 's1') {
  const session = {
    id,
    events: [],
    append(type, data) {
      this.events.push({ type, data })
    },
  }
  return session
}

function mockCtx(opts = {}) {
  const registrations = { commands: [], tools: [], events: {}, projections: [], webRoutes: [] }
  const webServer = opts.webServer === true
    ? {
        register: (route) => {
          registrations.webRoutes.push(route)
          return () => {}
        },
      }
    : undefined
  const ctx = {
    get: (key) => (key === 'webServer' ? webServer : undefined),
    on(name, fn) {
      ;(registrations.events[name] ??= []).push(fn)
    },
    inject(_deps, fn) {
      fn(ctx)
    },
    systemPrompt: { section: () => {} },
    tools: { register: (t) => registrations.tools.push(t) },
    commands: { register: (c) => registrations.commands.push(c) },
    sessionProjections: { register: (def) => registrations.projections.push(def) },
    logger: { warn: () => {}, info: () => {} },
    emit: () => {},
    events: registrations.events,
  }
  return { ctx, registrations }
}

function dispose(ctx) {
  for (const fn of ctx.events['dispose'] ?? []) fn()
}

let stubDir = null
let smokeHomeDir = null

before(() => {
  stubDir = installToolStub()
  smokeHomeDir = mkdtempSync(join(tmpdir(), 'dsh-voice-home-'))
  process.env.DSH_HOME = smokeHomeDir
})

after(() => {
  rmSync(stubDir, { recursive: true, force: true })
  rmSync(smokeHomeDir, { recursive: true, force: true })
})

test('applyVoice registers commands, tools, projection, and TTS proxy', async () => {
  const { applyVoice } = await import('../index.js')
  const { ctx, registrations } = mockCtx({ webServer: true })
  await applyVoice(ctx, { presetName: 'teacher', ttsPath: '/dsh-teacher/tts', schedulerEnabled: true })
  dispose(ctx)
  assert.deepEqual(registrations.commands.map((c) => c.name).sort(), ['cheer', 'cheer-at', 'cheer-text', 'speak', 'voice'])
  assert.deepEqual(registrations.tools.map((t) => t.name).sort(), ['cheer', 'speak'])
  assert.equal(registrations.projections.length, 1)
  assert.equal(registrations.projections[0].key, 'voiceSpeak')
  const paths = registrations.webRoutes.map((r) => r.path)
  assert.ok(paths.includes('/dsh-teacher/tts'))
  assert.ok(paths.includes('/dsh-teacher/tts-stream'))
  assert.ok(paths.includes('/dsh-teacher/tts-health'))
  assert.ok(registrations.events['agent/session-start'])
  assert.ok(registrations.events['agent/pre-step'])
  assert.ok(registrations.events['dispose'])
})

test('session event types are registered into the catalog', async () => {
  const { KNOWN_SESSION_EVENT_TYPES } = await import('@deepseek-ai/dsh-session')
  assert.ok(KNOWN_SESSION_EVENT_TYPES.has('voice/speak'))
  assert.ok(KNOWN_SESSION_EVENT_TYPES.has('voice/spoken'))
  assert.ok(KNOWN_SESSION_EVENT_TYPES.has('voice/cheer'))
})

test('speak command toggles TTS and speaks arbitrary text', async () => {
  const { applyVoice } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await applyVoice(ctx, {})
  dispose(ctx)
  const speak = registrations.commands.find((c) => c.name === 'speak')
  const agent = { session: mockSession() }
  const status = await speak.handler({ agent, rawInput: '' })
  assert.match(status.text, /TTS auto-speak is on/)
  const spoken = await speak.handler({ agent, rawInput: 'You are amazing!' })
  assert.match(spoken.text, /Speaking/)
  const evt = agent.session.events.find((e) => e.type === 'voice/spoken')
  assert.equal(evt.data.text, 'You are amazing!')
})

test('cheer command fires voice/cheer + voice/spoken', async () => {
  const { applyVoice } = await import('../index.js')
  const { ctx, registrations } = mockCtx()
  await applyVoice(ctx, {})
  dispose(ctx)
  const cheer = registrations.commands.find((c) => c.name === 'cheer')
  const agent = { session: mockSession() }
  const res = await cheer.handler({ agent, rawInput: '' })
  assert.match(res.text, /Cheer sent/)
  assert.ok(agent.session.events.some((e) => e.type === 'voice/cheer'))
  assert.ok(agent.session.events.some((e) => e.type === 'voice/spoken'))
})

test('greet nudges the agent via followup (model composes the welcome)', async () => {
  const { applyVoice, VoiceController, VoiceSchedule } = await import('../index.js')
  const { ctx } = mockCtx()
  await applyVoice(ctx, {})
  dispose(ctx)
  const schedule = new VoiceSchedule(join(smokeHomeDir, 'state', 'g.json'))
  const controller = new VoiceController({ logger: { warn: () => {} } }, schedule, { greetingPrompt: '（定时问候）欢迎回家+趣闻' })
  const followups = []
  const agent = { session: mockSession('s1'), followup: (msg) => { followups.push(msg) } }
  controller.track(agent)
  assert.equal(await controller.greet(agent), true)
  assert.equal(followups.length, 1)
  assert.match(followups[0].content[0].text, /欢迎回家/)
  assert.equal(agent.session.events.some((e) => e.type === 'voice/cheer'), false)
})

test('fixed greeting text is spoken verbatim instead of the model nudge', async () => {
  const { VoiceController, VoiceSchedule } = await import('../index.js')
  const schedule = new VoiceSchedule(join(smokeHomeDir, 'state', 'fixed.json'))
  schedule.setText('哥哥，欢迎回家')
  const controller = new VoiceController({ logger: { warn: () => {} } }, schedule, {})
  const followups = []
  const agent = { session: mockSession('s1'), followup: (msg) => { followups.push(msg) } }
  controller.track(agent)
  assert.equal(await controller.greet(agent), true)
  assert.equal(followups.length, 0)
  const cheerEvt = agent.session.events.find((e) => e.type === 'voice/cheer')
  assert.ok(cheerEvt && cheerEvt.data.text === '哥哥，欢迎回家')
})

test('scheduler fires one greeting per due time per day', async () => {
  const { VoiceController, VoiceSchedule } = await import('../index.js')
  const schedule = new VoiceSchedule(join(smokeHomeDir, 'state', 'sched.json'))
  const controller = new VoiceController({ logger: { warn: () => {} } }, schedule, {})
  const agent = { session: mockSession('s1') }
  controller.track(agent)
  const now = new Date()
  const cur = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  schedule.setTimes([cur])
  assert.equal(await controller.tick(), 1)
  assert.equal(await controller.tick(), 0, 'deduped within the same minute')
  const cheerEvt = agent.session.events.find((e) => e.type === 'voice/cheer')
  assert.ok(cheerEvt && cheerEvt.data.text.length > 0)
})

test('TTS proxy rejects a request without text', async () => {
  const { applyVoice } = await import('../index.js')
  const { ctx, registrations } = mockCtx({ webServer: true })
  await applyVoice(ctx, { ttsPath: '/dsh-voice/tts' })
  dispose(ctx)
  const tts = registrations.webRoutes.find((r) => r.path === '/dsh-voice/tts')
  let status = 0
  let body = ''
  const res = { writeHead: (s) => { status = s }, end: (b) => { body = b } }
  await tts.handler({ url: '/dsh-voice/tts?instruct=x' }, res)
  assert.equal(status, 400)
  assert.match(body, /text is required/)
})

test('TTS stream proxy rejects a request without text', async () => {
  const { applyVoice } = await import('../index.js')
  const { ctx, registrations } = mockCtx({ webServer: true })
  await applyVoice(ctx, { ttsPath: '/dsh-voice/tts' })
  dispose(ctx)
  const ttsStream = registrations.webRoutes.find((r) => r.path === '/dsh-voice/tts-stream')
  assert.ok(ttsStream, '/dsh-voice/tts-stream is registered')
  let status = 0
  let body = ''
  const res = { writeHead: (s) => { status = s }, end: (b) => { body = b } }
  await ttsStream.handler({ url: '/dsh-voice/tts-stream?instruct=x' }, res)
  assert.equal(status, 400)
  assert.match(body, /text is required/)
})

test('normalizeConfig applies defaults and honors overrides', async () => {
  const { normalizeConfig } = await import('../index.js')
  const def = normalizeConfig({})
  assert.equal(def.presetName, 'voice')
  assert.equal(def.ttsPath, '/dsh-voice/tts')
  assert.equal(def.defaultStyle, 'paimon')
  assert.equal(def.schedulerEnabled, false)
  const over = normalizeConfig({ presetName: 'teacher', ttsPath: '/dsh-teacher/tts', defaultStyle: 'onee', schedulerEnabled: true })
  assert.equal(over.presetName, 'teacher')
  assert.equal(over.ttsPath, '/dsh-teacher/tts')
  assert.equal(over.defaultStyle, 'onee')
  assert.equal(over.schedulerEnabled, true)
})
