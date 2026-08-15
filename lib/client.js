/**
 * dsh-voice-core Web client — shared voice UI for companion plugins.
 *
 * Exports `createVoiceClient(opts)` which returns a slots-plugin object
 * `{ name, inject, apply }` that consumer plugins (dsh-teacher, dsh-sister)
 * return from their own client bundle (or compose into it). Registers:
 *
 *  - `conversation.input.right` 🎤 style picker + 🔊 speak toggle, gated to
 *    the consumer's agent preset (opts.presetName).
 *  - `shell.overlay` voice style picker panel + cheer chip.
 *
 * Speech: fetches a WAV from the consumer's TTS proxy (opts.ttsPath) and plays
 * it through an <audio> queue — sound comes out of the user's own machine.
 * Auto-reads every assistant reply (1s text-first beat) with a per-session
 * localStorage cursor so switching sessions never re-reads old messages.
 *
 * @module dsh-voice-core/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-voice-core',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')

    // ---- tiny shared store: cheer chip + picker + latest projection --------
    var store = { cheer: null, sessionId: undefined, voiceOpen: false, listeners: [] }
    var pluginCtx = null
    function emit() {
      for (var i = 0; i < store.listeners.length; i++) store.listeners[i]()
    }
    function subscribe(fn) {
      store.listeners.push(fn)
      return function () {
        var at = store.listeners.indexOf(fn)
        if (at >= 0) store.listeners.splice(at, 1)
      }
    }
    function setStoreVoiceOpen(open) {
      store.voiceOpen = open
      emit()
    }

    // ---- helpers -----------------------------------------------------------
    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props].concat(children))
    }

    // ---- styles (theme-variable driven) ------------------------------------
    var PANEL_CARD = {
      border: '1px solid var(--dsw-border-color, rgba(128,128,128,.25))',
      borderRadius: 8,
      padding: '10px 14px',
      fontSize: 13,
      lineHeight: 1.5,
      background: 'var(--dsw-alias-bg-overlay, var(--dsw-surface-color, #ffffff))',
      boxShadow: '0 8px 30px rgba(0,0,0,.25)',
    }

    /** Strip markdown-ish markup so the speech is clean prose. */
    function speakable(text) {
      return String(text)
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`#>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    }

    // Generation time on this hardware scales roughly linearly with text
    // length (~2.75s floor + ~0.4s/char observed), so an unbounded reply can
    // monopolize the single-request TTS queue for minutes and stall every
    // other pending speak/cheer behind it. Cap what actually gets sent.
    var MAX_SPEAK_CHARS = 150
    /** Cut at the last sentence boundary within the limit so it doesn't stop
     * mid-word; falls back to a hard cut + ellipsis if there's no boundary
     * past the first 40% of the window (avoids truncating to a stray early
     * "Mr." or similar). */
    function truncateForSpeech(text, maxChars) {
      var limit = maxChars || MAX_SPEAK_CHARS
      if (text.length <= limit) return text
      var window = text.slice(0, limit)
      var boundary = Math.max(
        window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'),
        window.lastIndexOf('.'), window.lastIndexOf('!'), window.lastIndexOf('?')
      )
      if (boundary > limit * 0.4) return window.slice(0, boundary + 1)
      return window.trim() + '…'
    }

    /** Text of an assistant node from its text blocks. */
    function assistantNodeText(node) {
      var blocks = node.blocks || []
      return blocks
        .filter(function (b) { return b !== null && (b.kind === 'text' || b.type === 'text') && typeof b.text === 'string' })
        .map(function (b) { return b.text })
        .join('\n')
        .trim()
    }

    /** The real conversation node behind a chat-store view wrapper. */
    function unwrapNode(node) {
      if (node === null || node === undefined) return null
      var d = node
      if (d.data !== undefined && d.data !== null && d.blocks === undefined && d.seq === undefined && d.kind !== 'assistant') {
        d = d.data
      }
      if (d !== null && d !== undefined && d.finalNode !== undefined && d.finalNode !== null) {
        d = d.finalNode
      }
      return d
    }

    /** Latest assistant message text from the conversation snapshot, or null. */
    function latestAssistantText(session) {
      if (session === null || session === undefined) return null
      if (Array.isArray(session.nodes)) {
        for (var i = session.nodes.length - 1; i >= 0; i--) {
          var n = unwrapNode(session.nodes[i])
          if (n === null || n.kind !== 'assistant') continue
          var text = assistantNodeText(n)
          if (text) return { seq: n.seq, text: text }
        }
      }
      if (session.chat !== null && session.chat !== undefined) {
        var order = session.chat.order || []
        var nodes = session.chat.nodes
        var get = typeof nodes.get === 'function' ? function (id) { return nodes.get(id) } : function (id) { return nodes[id] }
        for (var j = order.length - 1; j >= 0; j--) {
          var m = unwrapNode(get(order[j]))
          if (m === null || m.kind !== 'assistant') continue
          var t = assistantNodeText(m)
          if (t) return { seq: m.seq, text: t }
        }
      }
      return null
    }

    // ---- audio queue ---------------------------------------------------
    // Shared across every mounted preset instance (only one voice can speak
    // at a time), so it must be scoped to whichever session is currently
    // being viewed — otherwise switching sessions lets an old session's
    // still-playing or still-in-flight speech keep going into the new one.
    var audioQueue = []
    var audioPlaying = false
    var currentAudio = null
    var activeSessionId
    // Only the latest speak/cheer request matters — an older one still
    // in flight (queued behind other TTS work, or just slow) gets aborted
    // the moment a newer one comes in, instead of eventually playing a
    // reply to a message the conversation has already moved past.
    var pendingSpeakController = null
    var SPEAK_TIMEOUT_MS = 5000
    function stopAndClearAudioQueue() {
      for (var i = 0; i < audioQueue.length; i++) {
        try { URL.revokeObjectURL(audioQueue[i].url) } catch (e) {}
      }
      audioQueue = []
      if (currentAudio !== null) {
        try { currentAudio.pause() } catch (e) {}
        currentAudio = null
      }
      audioPlaying = false
    }
    function setActiveSession(sessionId) {
      if (sessionId === activeSessionId) return
      activeSessionId = sessionId
      stopAndClearAudioQueue()
    }
    function playNextAudio() {
      if (audioPlaying || audioQueue.length === 0) return
      var item = audioQueue.shift()
      if (item.sessionId !== activeSessionId) {
        try { URL.revokeObjectURL(item.url) } catch (e) {}
        return playNextAudio() // skip audio queued by a session we've left
      }
      audioPlaying = true
      currentAudio = new Audio(item.url)
      currentAudio.onended = function () {
        audioPlaying = false
        currentAudio = null
        playNextAudio()
      }
      currentAudio.onerror = function () {
        audioPlaying = false
        currentAudio = null
        playNextAudio()
      }
      currentAudio.play().catch(function () {
        audioPlaying = false
        currentAudio = null
        playNextAudio()
      })
    }

    // ---- style preview (voice picker) --------------------------------------
    var previewController = null
    var previewAudio = null
    function stopPreview() {
      if (previewController !== null) {
        try { previewController.abort() } catch (e) {}
        previewController = null
      }
      if (previewAudio !== null) {
        try { previewAudio.pause() } catch (e) {}
        previewAudio = null
      }
    }
    function previewStyle(opts, key) {
      stopPreview()
      var controller = new AbortController()
      previewController = controller
      var instruct = opts.styles[key] ? opts.styles[key].instruct : ''
      return fetch(opts.ttsPath + '?text=' + encodeURIComponent(opts.previewText) + '&instruct=' + encodeURIComponent(instruct), {
        signal: controller.signal,
      })
        .then(function (res) {
          if (!res.ok) throw new Error('tts ' + res.status)
          return res.blob()
        })
        .then(function (blob) {
          if (previewController !== controller) return // superseded
          var url = URL.createObjectURL(blob)
          var audio = new Audio(url)
          previewAudio = audio
          return audio.play().catch(function () {})
        })
        .catch(function () {})
    }

    /** Speak text through the consumer's TTS proxy, played in order. */
    function makeSpeakBrowser(opts) {
      return function speakBrowser(text, sessionId) {
        if (typeof window === 'undefined' || typeof window.fetch !== 'function') return
        var clean = truncateForSpeech(speakable(text))
        if (!clean) return
        // Supersede whatever speak/cheer request is still in flight: only
        // the newest one should ever reach the TTS server or the queue.
        if (pendingSpeakController !== null) {
          try { pendingSpeakController.abort() } catch (e) {}
        }
        var controller = new AbortController()
        pendingSpeakController = controller
        // Give up after 5s instead of waiting behind a slow/backlogged
        // generation — a dropped clip is better than one that blocks every
        // speak request queued behind it.
        var timeoutId = setTimeout(function () { controller.abort() }, SPEAK_TIMEOUT_MS)
        var instruct = opts.styles[opts.defaultStyle] ? opts.styles[opts.defaultStyle].instruct : ''
        fetch(opts.ttsPath + '?text=' + encodeURIComponent(clean) + '&instruct=' + encodeURIComponent(instruct), {
          signal: controller.signal,
        })
          .then(function (res) {
            clearTimeout(timeoutId)
            if (!res.ok) throw new Error('tts ' + res.status)
            return res.blob()
          })
          .then(function (blob) {
            // Superseded by a newer request while this one was in flight.
            if (pendingSpeakController !== controller) return
            // TTS generation can take tens of seconds (queued behind other
            // requests); if the user has since switched sessions, drop it
            // instead of queueing audio for a session no longer in view.
            if (sessionId !== activeSessionId) return
            var url = URL.createObjectURL(blob)
            audioQueue.push({ url: url, sessionId: sessionId })
            playNextAudio()
          })
          .catch(function () { clearTimeout(timeoutId) })
      }
    }

    /** The preset gate: only render in the consumer's agent preset sessions. */
    function makeIsSession(props, presetName) {
      return function isSession() {
        if (props.sessionId === undefined || typeof props.useSessions !== 'function') return false
        var preset = props.useSessions(function (s) { return s.byId[props.sessionId]?.agentPreset })
        return preset === presetName
      }
    }

    // ---- speak toggle + style picker + cheer chip --------------------------
    function makeSpeakToggle(opts) {
      return function SpeakToggle(props) {
        var value = (props.useProjection ? props.useProjection('voiceSpeak') : null) || { speakEnabled: true, lastSpoken: null, lastCheer: null }
        var state = React.useState(value.speakEnabled !== false)
        React.useEffect(function () {
          state[1](value.speakEnabled !== false)
        }, [value.speakEnabled])
        var session = props.session || (props.useSession ? props.useSession(function (s) { return s }) : null)
        var isSession = makeIsSession(props, opts.presetName)
        var isVoice = isSession()
        var speakBrowser = makeSpeakBrowser(opts)
        // Every mounted preset instance sees the same props.sessionId (the
        // session currently in view), so whichever instance renders first
        // after a switch stops the previous session's audio queue/playback.
        React.useEffect(function () {
          setActiveSession(props.sessionId)
        }, [props.sessionId])
        // Explicit speak requests (speak tool / /speak <text>). Gated on
        // isVoice like the auto-read effect below: `value` comes from the
        // CURRENTLY ACTIVE session's projection, and every mounted preset's
        // SpeakToggle instance receives the same `value` — without this
        // gate, a cheer/speak fired in a sister session also gets read by
        // teacher's (or any other preset's) instance, in ITS voice style.
        var spokenSeqRef = React.useRef(0)
        var spokenTextRef = React.useRef(null)
        React.useEffect(function () {
          if (!isVoice) return
          var last = value.lastSpoken
          if (last === null || last === undefined) return
          if (last.seq <= spokenSeqRef.current) return
          spokenSeqRef.current = last.seq
          if (value.speakEnabled === false) return
          spokenTextRef.current = String(last.text || '')
          speakBrowser(last.text, props.sessionId)
        }, [value.lastSpoken, value.speakEnabled, isVoice])
        // Auto-read EVERY assistant reply. Per-session localStorage cursor so
        // switching sessions never re-reads old messages.
        var spokenMsgRef = React.useRef(null)
        var pendingSpeakRef = React.useRef(null)
        var CURSOR_KEY = 'dsh-voice.spoken-cursor.' + opts.presetName
        var readCursor = function () {
          try {
            var raw = window.localStorage.getItem(CURSOR_KEY)
            return raw ? JSON.parse(raw) : null
          } catch (e) {
            return null
          }
        }
        var writeCursor = function (sessionId, seq) {
          try {
            window.localStorage.setItem(CURSOR_KEY, JSON.stringify({ sessionId: sessionId, seq: seq }))
          } catch (e) {}
        }
        React.useEffect(function () {
          if (!isVoice) return
          if (value.speakEnabled === false) return
          var msg = latestAssistantText(session)
          if (msg === null) return
          var cursor = readCursor()
          if (cursor !== null && cursor.sessionId === props.sessionId && cursor.seq >= msg.seq) return
          if (spokenMsgRef.current !== null && spokenMsgRef.current.seq === msg.seq && spokenMsgRef.current.text === msg.text) return
          if (pendingSpeakRef.current !== null && pendingSpeakRef.current.seq === msg.seq && pendingSpeakRef.current.text === msg.text) return
          if (spokenTextRef.current !== null && spokenTextRef.current === msg.text) return
          if (pendingSpeakRef.current !== null) {
            clearTimeout(pendingSpeakRef.current.timer)
            pendingSpeakRef.current = null
          }
          var timer = setTimeout(function () {
            pendingSpeakRef.current = null
            spokenMsgRef.current = msg
            writeCursor(props.sessionId, msg.seq)
            speakBrowser(msg.text, props.sessionId)
          }, 1000)
          pendingSpeakRef.current = { seq: msg.seq, text: msg.text, timer: timer }
        }, [session, value.speakEnabled, isVoice])
        // Cheer chip: surface a fired cheer into the shared store. Gated on
        // isVoice like the effects above, and tagged with presetName: the
        // store (and every mounted preset's CheerChip subscribed to it) is
        // global, so without the tag every CheerChip would display this
        // session's cheer under ITS OWN title (e.g. a sister cheer showing
        // up in a "Teacher says..." bubble).
        React.useEffect(function () {
          if (!isVoice) return
          var cheer = value.lastCheer
          if (cheer === null || cheer === undefined) return
          store.cheer = { text: String(cheer.text || ''), at: Date.now(), sessionId: props.sessionId, presetName: opts.presetName }
          store.sessionId = props.sessionId
          emit()
        }, [value.lastCheer, isVoice])
        React.useEffect(function () {
          return function () {
            if (pendingSpeakRef.current !== null) clearTimeout(pendingSpeakRef.current.timer)
          }
        }, [])
        if (!isVoice) return null
        var enabled = state[0]
        var styleKeys = Object.keys(opts.styles)
        return h('div', { style: { display: 'flex', alignItems: 'center', gap: 2 } },
          styleKeys.length > 1
            ? h('button', {
                onClick: function () { setStoreVoiceOpen(!store.voiceOpen) },
                title: '选择音色 — pick & preview the voice',
                'aria-label': opts.presetName + ' voice picker',
                style: {
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 14, padding: '2px 4px',
                  color: 'var(--dsw-text-color, inherit)',
                },
              }, '🎤')
            : null,
          h('button', {
            onClick: function () {
              var next = !enabled
              state[1](next)
              try {
                var sessions = pluginCtx.get('sessions')
                var binding = sessions === undefined ? undefined : sessions.binding(props.sessionId)
                if (binding !== undefined && typeof binding.session.command === 'function') {
                  binding.session.command('/speak ' + (next ? 'on' : 'off')).catch(function () {})
                }
              } catch (e) {}
            },
            title: enabled ? 'Voice is on — click to mute' : 'Voice is muted — click to enable',
            'aria-label': opts.presetName + ' speak toggle',
            style: {
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 14, padding: '2px 6px',
              color: enabled ? 'var(--dsw-text-color, inherit)' : '#8e8e8e',
              textDecoration: enabled ? 'none' : 'line-through',
            },
          }, '🔊'),
        )
      }
    }

    function makeVoicePicker(opts) {
      var PICKER_WRAP = {
        position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
        zIndex: 1000, width: 'min(560px, 94vw)', maxWidth: 560,
      }
      var PICKER_BACKDROP = {
        position: 'fixed', inset: 0, zIndex: 999,
        background: 'rgba(0, 0, 0, 0.35)',
      }
      var PICKER_ROW = {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 6,
        cursor: 'pointer', marginBottom: 2,
        border: '1px solid var(--dsw-border-color, rgba(128,128,128,.25))',
        background: 'var(--dsw-surface-color, transparent)',
        color: 'var(--dsw-text-color, inherit)', fontSize: 13,
      }
      return function VoicePicker() {
        var openState = React.useState(store.voiceOpen)
        var busyState = React.useState(null)
        React.useEffect(function () {
          return subscribe(function () {
            openState[1](store.voiceOpen)
          })
        }, [])
        if (!openState[0]) return null
        var saved = savedStyleKey(opts)
        var keys = Object.keys(opts.styles)
        var busy = busyState[0]
        var rows = keys.map(function (key) {
          var active = saved === key
          var generating = busy === key
          var label = opts.styles[key].label
          return h('button', {
            key: key,
            disabled: busy !== null && busy !== key,
            onClick: function () {
              saveStyleKey(opts, key)
              busyState[1](key)
              previewStyle(opts, key).then(function () {
                busyState[1](function (current) { return current === key ? null : current })
              })
            },
            style: Object.assign({}, PICKER_ROW, active ? { border: '2px solid #f39c12' } : {}, generating ? { opacity: .55, cursor: 'wait' } : {}),
          },
            h('span', { style: { fontWeight: active ? 700 : 400 } },
              (active ? '✓ ' : '') + (generating ? '⏳ 生成中… ' : '') + label),
          )
        })
        return h(React.Fragment, null,
          h('div', { style: PICKER_BACKDROP, onClick: function () { setStoreVoiceOpen(false) } }),
          h('div', { style: PICKER_WRAP },
            h('div', { style: Object.assign({}, PANEL_CARD, { maxHeight: '86vh', overflow: 'auto' }), className: 'dsh-voice-style-picker' },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
                h('span', { style: { fontWeight: 600 } }, '🎤 音色 — click to preview & select'),
                h('button', { onClick: function () { setStoreVoiceOpen(false) }, style: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 } }, '✕'),
              ),
              h('div', { style: { fontSize: 11, opacity: .6, marginBottom: 8 } },
                '点一下试听，自动记住你最后选的音色（Qwen3-TTS 生成，几秒钟）。Click a style to hear it — your last pick is remembered.'),
              rows,
            ),
          ),
        )
      }
    }

    function makeCheerChip(opts) {
      return function CheerChip() {
        var state = React.useState(store.cheer)
        React.useEffect(function () {
          return subscribe(function () {
            state[1](store.cheer)
          })
        }, [])
        // store.cheer is shared by every mounted preset's CheerChip; only
        // render the ones tagged for THIS preset, else a sister cheer shows
        // up under teacher's (or vice versa's) title.
        var raw = state[0]
        var cheer = raw && raw.presetName === opts.presetName ? raw : null
        var visibleState = React.useState(false)
        React.useEffect(function () {
          if (cheer === null || cheer === undefined || typeof cheer.text !== 'string' || cheer.text === '') {
            visibleState[1](false)
            return
          }
          visibleState[1](true)
          var timer = setTimeout(function () { visibleState[1](false) }, 9000)
          return function () { clearTimeout(timer) }
        }, [cheer])
        if (!visibleState[0] || cheer === null) return null
        return h('div', {
          style: { position: 'fixed', left: 16, bottom: 96, zIndex: 1000, maxWidth: 380, width: 'calc(100vw - 32px)' },
        },
          h('div', { style: Object.assign({}, PANEL_CARD, { borderLeft: '3px solid #f39c12' }), className: 'dsh-voice-cheer-chip' },
            h('div', { style: { fontWeight: 600, marginBottom: 2, color: 'var(--dsw-text-color, inherit)' } }, opts.cheerTitle || '💛 Voice says…'),
            h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--dsw-text-color, inherit)' } }, cheer.text),
          ),
        )
      }
    }

    // ---- style persistence (per consumer) ----------------------------------
    function styleKeyOf(opts) {
      return 'dsh-voice.style.' + opts.presetName
    }
    function savedStyleKey(opts) {
      try {
        var s = window.localStorage.getItem(styleKeyOf(opts))
        return s !== null && opts.styles[s] !== undefined ? s : null
      } catch (e) {
        return null
      }
    }
    function saveStyleKey(opts, key) {
      try {
        window.localStorage.setItem(styleKeyOf(opts), key)
      } catch (e) {}
    }

    // ---- createVoiceClient -------------------------------------------------
    /**
     * Build a slots-plugin for a companion preset.
     * @param {object} opts
     * @param {string} opts.presetName - agent preset name this UI serves (e.g. 'teacher', 'sister')
     * @param {string} opts.ttsPath - host TTS proxy path (e.g. '/dsh-teacher/tts')
     * @param {object} opts.styles - voice style catalog { key: { label, instruct } }
     * @param {string} [opts.defaultStyle] - default style key
     * @param {string} [opts.previewText] - picker preview phrase
     * @param {string} [opts.cheerTitle] - cheer chip title
     * @returns {{ name: string, inject: string[], apply: (ctx) => void }}
     */
    function createVoiceClient(opts) {
      var o = Object.assign({
        presetName: 'voice',
        ttsPath: '/dsh-voice/tts',
        styles: {},
        defaultStyle: null,
        previewText: '嗨嗨！我是你的妹妹呀～你喜欢我的声音吗？嘿嘿！',
        cheerTitle: '💛 Voice says…',
      }, opts || {})
      if (!o.defaultStyle) o.defaultStyle = Object.keys(o.styles)[0] || null
      var SpeakToggle = makeSpeakToggle(o)
      var VoicePicker = makeVoicePicker(o)
      var CheerChip = makeCheerChip(o)
      return {
        name: 'dsh-voice-core/' + o.presetName,
        inject: ['slots', 'conversation'],
        apply: function (ctx) {
          var slots = ctx.get('slots')
          if (slots === undefined) return
          pluginCtx = ctx
          slots.inject('conversation.input.right', function () {
            return slots.register(
              { name: 'conversation.input.right', id: 'dsh-voice-' + o.presetName + '-speak', order: 9, label: function () { return 'Speak' } },
              SpeakToggle,
            )
          })
          slots.inject('shell.overlay', function () {
            return slots.register({ name: 'shell.overlay', id: 'dsh-voice-' + o.presetName + '-cheer-chip', order: 40 }, CheerChip)
          })
          slots.inject('shell.overlay', function () {
            return slots.register({ name: 'shell.overlay', id: 'dsh-voice-' + o.presetName + '-style-picker', order: 45 }, VoicePicker)
          })
        },
      }
    }

    // Boot-row plugin shape: this module doubles as the loader entry that
    // pulls the client bundle into the boot graph (mirrors the server-side
    // no-op `apply` in index.js — see cordis.patch.yml `id: dsh-voice-core`).
    // Consumers require('dsh-voice-core') for `createVoiceClient`, not for
    // this no-op `apply`.
    exports.name = 'dsh-voice-core'
    exports.apply = function (ctx) {}
    exports.createVoiceClient = createVoiceClient
    exports._test = { assistantNodeText, latestAssistantText, unwrapNode, speakable, truncateForSpeech }

    return module.exports
  },
})
