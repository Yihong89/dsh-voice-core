/**
 * dsh-voice-core Web client — shared voice UI for companion plugins.
 *
 * Exports `createVoiceClient(opts)` which returns a slots-plugin object
 * `{ name, inject, apply }` that consumer plugins (dsh-teacher, dsh-sister)
 * return from their own client bundle (or compose into it). Registers:
 *
 *  - `conversation.input.right` 🎤 style picker + 🔊 speak toggle, gated to
 *    the consumer's agent preset (opts.presetName).
 *  - `shell.overlay` voice style picker panel + cheer chip + hear-full-reply
 *    chip.
 *
 * All cross-preset invariants (only one clip plays/generates at a time,
 * only the active session's audio survives a switch, only the latest
 * speak/cheer for a turn is ever heard, cheer/hear-full UI state scoped to
 * its own preset) live in ONE place: `createVoiceController()` below. Every
 * component is a thin view over it — it reads snapshots via
 * voice.getCheer/getPendingFull/getQueueStatus and calls
 * voice.request/setActiveSession/watchQueue. No component touches a shared
 * queue/session/abort variable directly. This module is loaded once and
 * shared by every consumer (teacher, sister, ...); the controller instance
 * below is the single owner of "what's audible right now" across all of
 * them.
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

    // ---- helpers -------------------------------------------------------
    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props].concat(children))
    }

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

    /** Voice-design instruct string for a preset's currently selected style. */
    function instructFor(opts) {
      return opts.styles[opts.defaultStyle] ? opts.styles[opts.defaultStyle].instruct : ''
    }

    // =====================================================================
    // VoiceController — single owner of every cross-preset invariant.
    //
    // Every mounted preset's UI (SpeakToggle, CheerChip, HearFullChip)
    // shares this one instance: only one voice can be speaking at a time,
    // and only one companion's plugin is ever active for the session in
    // view, so "what's audible right now" has to be tracked in exactly one
    // place instead of by convention across N call sites. Three bugs this
    // session were the SAME root cause found in three different call
    // sites (a preset's SpeakToggle voicing another preset's session, a
    // cheer chip showing another preset's cheer, a stale clip playing
    // alongside a newer one) — this controller is where that invariant is
    // now enforced exactly once.
    // =====================================================================
    function createVoiceController() {
      var SPEAK_TIMEOUT_MS = 5000
      // A user-requested "hear full reply" click is worth waiting longer
      // for — they explicitly opted in — but still needs a ceiling.
      var FULL_SPEAK_TIMEOUT_MS = 120000
      var QUEUE_POLL_MS = 5000

      var audioQueue = []
      var audioPlaying = false
      var currentAudio = null
      var activeSessionId
      var activePresetName
      // Only the latest speak/cheer request matters — an older one still in
      // flight (queued behind other TTS work, or just slow) gets aborted
      // the moment a newer one comes in, instead of eventually playing a
      // reply to a message the conversation has already moved past.
      var pendingController = null
      var cheer = null // { text, at, sessionId, presetName }
      var pendingFull = null // { text, sessionId, presetName }
      var queueByPath = {} // ttsPath -> { watchers, timer, pending, lastGenerationMs }
      var listeners = []

      function emit() {
        for (var i = 0; i < listeners.length; i++) listeners[i]()
      }
      function subscribe(fn) {
        listeners.push(fn)
        return function () {
          var at = listeners.indexOf(fn)
          if (at >= 0) listeners.splice(at, 1)
        }
      }

      function stopAndClear() {
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

      /** Whichever session is currently in view. Switching sessions drops
       * whatever the PREVIOUS session was still playing or generating.
       * `presetName` should be the CALLER's own preset when (and only when)
       * its isVoice check is true — every mounted preset's SpeakToggle
       * calls this on every render, but only the one actually matching the
       * active session ever passes a defined presetName, so whichever one
       * that is always wins regardless of render/mount order. */
      function setActiveSession(sessionId, presetName) {
        var changed = false
        if (sessionId !== activeSessionId) {
          activeSessionId = sessionId
          activePresetName = undefined
          stopAndClear()
          changed = true
        }
        if (presetName !== undefined && presetName !== activePresetName) {
          activePresetName = presetName
          changed = true
        }
        if (changed) emit() // let subscribers (CheerChip, HearFullChip, BackgroundLayer, ...) refresh
      }

      /** The preset whose session is currently in view (matches whichever
       * SpeakToggle instance last reported isVoice === true), or undefined. */
      function getActivePreset() {
        return activePresetName
      }

      function playNext() {
        if (audioPlaying || audioQueue.length === 0) return
        var item = audioQueue.shift()
        if (item.sessionId !== activeSessionId) {
          try { URL.revokeObjectURL(item.url) } catch (e) {}
          return playNext() // skip audio queued by a session we've left
        }
        audioPlaying = true
        currentAudio = new Audio(item.url)
        currentAudio.onended = function () {
          audioPlaying = false
          currentAudio = null
          playNext()
        }
        currentAudio.onerror = function () {
          audioPlaying = false
          currentAudio = null
          playNext()
        }
        currentAudio.play().catch(function () {
          audioPlaying = false
          currentAudio = null
          playNext()
        })
      }

      /**
       * THE single entry point for audible speech (auto-read, explicit
       * speak/cheer, or a user-requested full replay).
       * @param {object} req
       * @param {string} req.text
       * @param {*} req.sessionId
       * @param {string} req.presetName
       * @param {string} req.ttsPath
       * @param {string} req.instruct
       * @param {boolean} [req.full] - bypass truncation; longer timeout
       */
      function request(req) {
        if (typeof window === 'undefined' || typeof window.fetch !== 'function') return
        var full = req.full === true
        var prepared = speakable(req.text)
        var clean = full ? prepared : truncateForSpeech(prepared)
        if (!clean) return

        if (full) {
          // Playing the full version now — clear the "hear more" chip if it
          // was offering exactly this reply.
          if (pendingFull !== null && pendingFull.sessionId === req.sessionId && pendingFull.presetName === req.presetName) {
            pendingFull = null
            emit()
          }
        } else if (clean.length < prepared.length) {
          // Cut short for TTS — offer the user a way to hear the rest
          // instead of silently dropping it.
          pendingFull = { text: prepared, sessionId: req.sessionId, presetName: req.presetName }
          emit()
        }

        // Supersede whatever speak/cheer request is still in flight AND
        // wipe anything already queued or playing: a cheer's short intro
        // and the full auto-read reply for the SAME turn are two
        // independent request() calls (each with its own dedup tracking in
        // the calling component, unaware of the other) that can both
        // finish generating and play back-to-back. Only ever the latest
        // request should be audible — one voice, one line, always newest.
        if (pendingController !== null) {
          try { pendingController.abort() } catch (e) {}
        }
        stopAndClear()

        var controller = new AbortController()
        pendingController = controller
        // Give up rather than wait behind a slow/backlogged generation — a
        // dropped clip is better than one that blocks every speak request
        // queued behind it.
        var timeoutId = setTimeout(function () { controller.abort() }, full ? FULL_SPEAK_TIMEOUT_MS : SPEAK_TIMEOUT_MS)
        fetch(req.ttsPath + '?text=' + encodeURIComponent(clean) + '&instruct=' + encodeURIComponent(req.instruct || ''), {
          signal: controller.signal,
        })
          .then(function (res) {
            clearTimeout(timeoutId)
            if (!res.ok) throw new Error('tts ' + res.status)
            return res.blob()
          })
          .then(function (blob) {
            // Superseded by a newer request while this one was in flight.
            if (pendingController !== controller) return
            // TTS generation can take tens of seconds (queued behind other
            // requests); if the user has since switched sessions, drop it
            // instead of queueing audio for a session no longer in view.
            if (req.sessionId !== activeSessionId) return
            var url = URL.createObjectURL(blob)
            audioQueue.push({ url: url, sessionId: req.sessionId })
            playNext()
          })
          .catch(function () { clearTimeout(timeoutId) })
      }

      /** Surface a fired cheer for its OWN preset's CheerChip. */
      function fireCheer(text, sessionId, presetName) {
        cheer = { text: String(text || ''), at: Date.now(), sessionId: sessionId, presetName: presetName }
        emit()
      }

      /** This preset's current cheer, or null if there is none / it belongs
       * to another preset. */
      function getCheer(presetName) {
        return cheer !== null && cheer.presetName === presetName ? cheer : null
      }

      /** This preset's pending "hear full reply" offer for the ACTIVE
       * session, or null. */
      function getPendingFull(presetName) {
        return pendingFull !== null && pendingFull.presetName === presetName && pendingFull.sessionId === activeSessionId
          ? pendingFull
          : null
      }

      // ---- TTS queue status polling (ref-counted per ttsPath) -----------
      // Multiple mounted instances sharing the same ttsPath must not each
      // start their own interval; watchQueue()/its returned stop function
      // ref-count so exactly one timer runs per path, torn down once
      // nobody needs it.
      function pollQueue(ttsPath) {
        if (typeof window === 'undefined' || typeof window.fetch !== 'function') return
        var healthPath = ttsPath.replace(/\/$/, '') + '-health'
        fetch(healthPath)
          .then(function (res) { return res.ok ? res.json() : null })
          .then(function (data) {
            if (data === null) return
            var entry = queueByPath[ttsPath]
            if (entry === undefined) return // watcher stopped before this resolved
            entry.pending = typeof data.pending === 'number' ? data.pending : 0
            entry.lastGenerationMs = typeof data.lastGenerationMs === 'number' ? data.lastGenerationMs : null
            emit()
          })
          .catch(function () {})
      }

      /** Start (or join) polling `ttsPath`'s health route on an interval.
       * Returns a stop function; the underlying timer is torn down once
       * every caller has stopped watching. */
      function watchQueue(ttsPath) {
        var entry = queueByPath[ttsPath]
        if (entry === undefined) {
          entry = { watchers: 0, timer: null, pending: 0, lastGenerationMs: null }
          queueByPath[ttsPath] = entry
        }
        entry.watchers += 1
        if (entry.timer === null) {
          entry.timer = setInterval(function () { pollQueue(ttsPath) }, QUEUE_POLL_MS)
        }
        var stopped = false
        return function () {
          if (stopped) return
          stopped = true
          entry.watchers -= 1
          if (entry.watchers <= 0) {
            clearInterval(entry.timer)
            delete queueByPath[ttsPath]
          }
        }
      }

      /** Snapshot of a ttsPath's queue depth, or null if nobody is watching
       * it yet. */
      function getQueueStatus(ttsPath) {
        var entry = queueByPath[ttsPath]
        return entry === undefined ? null : { pending: entry.pending, lastGenerationMs: entry.lastGenerationMs }
      }

      return {
        subscribe: subscribe,
        setActiveSession: setActiveSession,
        getActivePreset: getActivePreset,
        request: request,
        fireCheer: fireCheer,
        getCheer: getCheer,
        getPendingFull: getPendingFull,
        watchQueue: watchQueue,
        getQueueStatus: getQueueStatus,
      }
    }

    var voice = createVoiceController()
    var pluginCtx = null

    // ---- style-picker open/close: tiny UI-local store, orthogonal to the
    // audio invariants above (never auto-triggered, always a direct click).
    var pickerStore = { open: false, listeners: [] }
    function setPickerOpen(open) {
      pickerStore.open = open
      for (var i = 0; i < pickerStore.listeners.length; i++) pickerStore.listeners[i]()
    }
    function subscribePicker(fn) {
      pickerStore.listeners.push(fn)
      return function () {
        var at = pickerStore.listeners.indexOf(fn)
        if (at >= 0) pickerStore.listeners.splice(at, 1)
      }
    }

    // ---- style preview (voice picker) -----------------------------------
    // Deliberately separate from VoiceController: preview playback is
    // always a direct user click inside the picker, never auto-triggered,
    // and doesn't participate in the session/preset scoping above.
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

    /** The preset gate: only render in the consumer's agent preset sessions. */
    function makeIsSession(props, presetName) {
      return function isSession() {
        if (props.sessionId === undefined || typeof props.useSessions !== 'function') return false
        var preset = props.useSessions(function (s) { return s.byId[props.sessionId]?.agentPreset })
        return preset === presetName
      }
    }

    // ---- speak toggle + queue-status badge --------------------------------
    function makeSpeakToggle(opts) {
      return function SpeakToggle(props) {
        var value = (props.useProjection ? props.useProjection('voiceSpeak') : null) || { speakEnabled: true, lastSpoken: null, lastCheer: null }
        var state = React.useState(value.speakEnabled !== false)
        React.useEffect(function () {
          state[1](value.speakEnabled !== false)
        }, [value.speakEnabled])
        var session = props.session || (props.useSession ? props.useSession(function (s) { return s }) : null)
        var isVoice = makeIsSession(props, opts.presetName)()
        // Every mounted preset instance sees the same props.sessionId (the
        // session currently in view), so whichever instance renders first
        // after a switch stops the previous session's audio queue/playback.
        // Only the instance whose isVoice is true reports its presetName —
        // that is how BackgroundLayer (and anything else keyed on "which
        // preset is active") learns which preset owns the current session
        // without needing session props of its own.
        React.useEffect(function () {
          voice.setActiveSession(props.sessionId, isVoice ? opts.presetName : undefined)
        }, [props.sessionId, isVoice])
        // Audio comes ONLY from the assistant's actual chat reply (below),
        // never from the speak/cheer tool's own text directly: a cheer's
        // short intro and the fuller reply that follows it in the SAME
        // turn were two independent triggers that could both generate and
        // play audio ("so many sentences" for one turn). lastSpoken /
        // lastCheer still drive the CheerChip's visual bubble via the
        // effect further down — only the reply shown in the chat box gets
        // voiced. Tradeoff: a cheer fired with no accompanying reply (the
        // scheduler's /cheer-text fixed greeting, or its no-reply
        // fallback) shows the chip but is silent.
        //
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
          if (pendingSpeakRef.current !== null) {
            clearTimeout(pendingSpeakRef.current.timer)
            pendingSpeakRef.current = null
          }
          var timer = setTimeout(function () {
            pendingSpeakRef.current = null
            spokenMsgRef.current = msg
            writeCursor(props.sessionId, msg.seq)
            voice.request({ text: msg.text, sessionId: props.sessionId, presetName: opts.presetName, ttsPath: opts.ttsPath, instruct: instructFor(opts) })
          }, 1000)
          pendingSpeakRef.current = { seq: msg.seq, text: msg.text, timer: timer }
        }, [session, value.speakEnabled, isVoice])
        // Surface a fired cheer into the controller. Gated on isVoice like
        // the effects above: `value` reflects the active session
        // regardless of which preset's instance is asking.
        React.useEffect(function () {
          if (!isVoice) return
          var c = value.lastCheer
          if (c === null || c === undefined) return
          voice.fireCheer(c.text, props.sessionId, opts.presetName)
        }, [value.lastCheer, isVoice])
        React.useEffect(function () {
          return function () {
            if (pendingSpeakRef.current !== null) clearTimeout(pendingSpeakRef.current.timer)
          }
        }, [])
        // TTS queue status: watch the health route (already proxied by the
        // host — see index.js) while this preset's toggle is the active
        // one, so a backed-up service is visible instead of silent.
        var queueState = React.useState(voice.getQueueStatus(opts.ttsPath))
        React.useEffect(function () {
          return voice.subscribe(function () { queueState[1](voice.getQueueStatus(opts.ttsPath)) })
        }, [opts.ttsPath])
        React.useEffect(function () {
          if (!isVoice) return
          return voice.watchQueue(opts.ttsPath)
        }, [isVoice, opts.ttsPath])
        if (!isVoice) return null
        var enabled = state[0]
        var styleKeys = Object.keys(opts.styles)
        var queue = queueState[0]
        return h('div', { style: { display: 'flex', alignItems: 'center', gap: 2 } },
          styleKeys.length > 1
            ? h('button', {
                onClick: function () { setPickerOpen(!pickerStore.open) },
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
          queue !== null && queue.pending > 0
            ? h('span', {
                title: 'TTS 排队中 — ' + queue.pending + ' 个请求在等待'
                  + (queue.lastGenerationMs !== null ? '（上一次生成用时 ' + Math.round(queue.lastGenerationMs / 1000) + 's）' : ''),
                'aria-label': opts.presetName + ' tts queue depth',
                style: {
                  fontSize: 11, marginLeft: 1, color: '#f39c12', whiteSpace: 'nowrap',
                  cursor: 'default',
                },
              }, '⏳' + queue.pending)
            : null,
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
        var openState = React.useState(pickerStore.open)
        var busyState = React.useState(null)
        React.useEffect(function () {
          return subscribePicker(function () {
            openState[1](pickerStore.open)
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
          h('div', { style: PICKER_BACKDROP, onClick: function () { setPickerOpen(false) } }),
          h('div', { style: PICKER_WRAP },
            h('div', { style: Object.assign({}, PANEL_CARD, { maxHeight: '86vh', overflow: 'auto' }), className: 'dsh-voice-style-picker' },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
                h('span', { style: { fontWeight: 600 } }, '🎤 音色 — click to preview & select'),
                h('button', { onClick: function () { setPickerOpen(false) }, style: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 } }, '✕'),
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
        var state = React.useState(voice.getCheer(opts.presetName))
        React.useEffect(function () {
          return voice.subscribe(function () {
            state[1](voice.getCheer(opts.presetName))
          })
        }, [])
        var cheer = state[0]
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

    /**
     * A long reply only got its lead-in spoken (see truncateForSpeech); this
     * chip offers a one-click way to hear the rest instead of losing it
     * silently. Auto-dismisses if unused, or as soon as the reply it refers
     * to is superseded (new message, session switch, or the click itself).
     */
    function makeHearFullChip(opts) {
      return function HearFullChip() {
        var state = React.useState(voice.getPendingFull(opts.presetName))
        React.useEffect(function () {
          return voice.subscribe(function () {
            state[1](voice.getPendingFull(opts.presetName))
          })
        }, [])
        var pending = state[0]
        var visibleState = React.useState(false)
        React.useEffect(function () {
          if (pending === null) {
            visibleState[1](false)
            return
          }
          visibleState[1](true)
          var timer = setTimeout(function () { visibleState[1](false) }, 20000)
          return function () { clearTimeout(timer) }
        }, [pending])
        if (!visibleState[0] || pending === null) return null
        return h('div', {
          style: { position: 'fixed', left: 16, bottom: 170, zIndex: 1000, maxWidth: 380, width: 'calc(100vw - 32px)' },
        },
          h('div', {
            style: Object.assign({}, PANEL_CARD, {
              borderLeft: '3px solid #4a90d9', display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', gap: 10,
            }),
            className: 'dsh-voice-hear-full-chip',
          },
            h('span', { style: { color: 'var(--dsw-text-color, inherit)' } }, '这条回复有点长，只念了开头～'),
            h('button', {
              onClick: function () {
                voice.request({ text: pending.text, sessionId: pending.sessionId, presetName: opts.presetName, ttsPath: opts.ttsPath, instruct: instructFor(opts), full: true })
              },
              'aria-label': opts.presetName + ' hear full reply',
              style: {
                background: 'none', border: '1px solid currentColor', borderRadius: 6,
                cursor: 'pointer', padding: '4px 10px', fontSize: 13, whiteSpace: 'nowrap',
                color: 'var(--dsw-text-color, inherit)',
              },
            }, '🔊 听完整版'),
          ),
        )
      }
    }

    // Properties this module touches on document.body while a backdrop is
    // active, saved/restored around that window so leaving the preset (or
    // a second consumer configuring its own) never leaks style behind.
    var BODY_BG_PROPS = ['backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat', 'backgroundAttachment']

    /**
     * Optional full-viewport backdrop image behind the chat, shown only
     * while THIS preset's session is the active one. No-op when
     * opts.backgroundUrl is not set — most consumers (e.g. teacher) keep
     * the host's default background by simply not passing one.
     *
     * Applied directly to document.body rather than rendered as a DOM node
     * of its own: this component is registered under shell.overlay, which
     * the host deliberately stacks ABOVE the main app content — no z-index
     * on a child of that slot can escape its parent's elevated stacking
     * context to sit BEHIND the chat instead of on top of it.
     *
     * Driven by voice.getActivePreset() (set by SpeakToggle's isVoice
     * check) rather than props, since shell.overlay is not confirmed to
     * pass session props to its children the way conversation.input.right does.
     */
    function makeBackgroundLayer(opts) {
      return function BackgroundLayer() {
        var state = React.useState(voice.getActivePreset())
        React.useEffect(function () {
          return voice.subscribe(function () {
            state[1](voice.getActivePreset())
          })
        }, [])
        var active = Boolean(opts.backgroundUrl) && state[0] === opts.presetName
        React.useEffect(function () {
          if (!active || typeof document === 'undefined') return
          var body = document.body
          var previous = {}
          for (var i = 0; i < BODY_BG_PROPS.length; i++) previous[BODY_BG_PROPS[i]] = body.style[BODY_BG_PROPS[i]]
          body.style.backgroundImage = 'url(' + opts.backgroundUrl + ')'
          body.style.backgroundSize = 'cover'
          body.style.backgroundPosition = 'center'
          body.style.backgroundRepeat = 'no-repeat'
          body.style.backgroundAttachment = 'fixed'
          return function () {
            for (var j = 0; j < BODY_BG_PROPS.length; j++) body.style[BODY_BG_PROPS[j]] = previous[BODY_BG_PROPS[j]]
          }
        }, [active, opts.backgroundUrl])
        return null
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
     * @param {string} [opts.backgroundUrl] - full-viewport backdrop image URL, shown only while this preset's session is active; omit to keep the host's default background
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
        backgroundUrl: null,
      }, opts || {})
      if (!o.defaultStyle) o.defaultStyle = Object.keys(o.styles)[0] || null
      var SpeakToggle = makeSpeakToggle(o)
      var VoicePicker = makeVoicePicker(o)
      var CheerChip = makeCheerChip(o)
      var HearFullChip = makeHearFullChip(o)
      var BackgroundLayer = makeBackgroundLayer(o)
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
            return slots.register({ name: 'shell.overlay', id: 'dsh-voice-' + o.presetName + '-background', order: 1 }, BackgroundLayer)
          })
          slots.inject('shell.overlay', function () {
            return slots.register({ name: 'shell.overlay', id: 'dsh-voice-' + o.presetName + '-cheer-chip', order: 40 }, CheerChip)
          })
          slots.inject('shell.overlay', function () {
            return slots.register({ name: 'shell.overlay', id: 'dsh-voice-' + o.presetName + '-hear-full', order: 41 }, HearFullChip)
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
    exports._test = { assistantNodeText, latestAssistantText, unwrapNode, speakable, truncateForSpeech, voice }

    return module.exports
  },
})
