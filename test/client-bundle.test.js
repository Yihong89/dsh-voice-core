/**
 * Client-bundle test for dsh-voice-core: evaluates lib/client.js with a mocked
 * __ModuleLoader__ and asserts createVoiceClient returns a slots-plugin with
 * the right registrations and preset gating.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function loadBundle() {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  let captured = null
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    // useEffect runs synchronously (below), so a setter that mutates the
    // same boxed array in place is enough to observe effect-driven state
    // updates within one component call — no fiber/re-render needed.
    useState: (init) => {
      const box = [init, (next) => { box[0] = typeof next === 'function' ? next(box[0]) : next }]
      return box
    },
    useEffect: (fn) => { fn() },
    useRef: (init) => ({ current: init }),
  }
  globalThis.window = {
    __ModuleLoader__: { load: (def) => { captured = def } },
    // request() guards on `typeof window.EventSource === 'function'` but
    // then calls the bare `new EventSource(...)` — which resolves via
    // globalThis, not this stub object. Keep this truthy so the guard
    // passes; tests that need to observe/intercept the actual stream must
    // stub globalThis.EventSource instead (see makeFakeEventSource below).
    EventSource: function () {},
    fetch: () => {},
  }
  // BackgroundLayer sets document.body.style directly (see client.js) since
  // shell.overlay's own elevated stacking context defeats any z-index a
  // child of it could use to sit behind the app instead of on top of it.
  // Minimal stub so that effect has somewhere to write.
  globalThis.document = { body: { style: {} }, getElementById: () => null }
  // This harness never invokes a useEffect's returned cleanup (there is no
  // real unmount/reconciliation here — each test just calls a component as
  // a plain function), so any code that starts a setInterval would leak a
  // live timer past the end of whichever test triggered it (watchQueue's
  // polling, for one). Default to safe no-ops; a test that needs to
  // observe real interval/timeout behavior installs its own local
  // override and restores it in a finally block (see the speakBrowser
  // 5s-timeout tests).
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  // The auto-read effect is the ONLY path into voice.request() (see
  // client.js) and debounces 1000ms before firing. Fire that specific
  // delay immediately so tests don't need a real 1s wait; leave every
  // other delay (voice.request's 5s/120s give-up timers) as a no-op by
  // default, same reasoning as above — a test that needs to observe THOSE
  // installs its own more specific override locally.
  globalThis.setTimeout = (fn, ms) => {
    if (ms === 1000) fn()
    return 0
  }
  globalThis.clearTimeout = () => {}
  // eslint-disable-next-line no-eval
  ;(0, eval)(source)
  assert.ok(captured, 'bundle did not call __ModuleLoader__.load')
  const moduleObj = captured.factory((spec) => {
    if (spec === 'react') return reactStub
    if (spec === 'react/jsx-runtime') return reactStub
    throw new Error(`unexpected require: ${spec}`)
  })
  return { moduleObj, reactStub }
}

/** A session snapshot whose latest assistant message is (seq, text) — the
 * ONLY thing that can trigger voice.request() now (see client.js: the
 * speak/cheer tool's own text no longer speaks, only the actual reply). */
function assistantSession(seq, text) {
  return { nodes: [{ kind: 'assistant', seq, blocks: [{ kind: 'text', text }] }], chat: { order: [], nodes: {} } }
}

function emptySession() {
  return { nodes: [], chat: { order: [], nodes: {} } }
}

/** Simulates the real render sequence for "a session that was already being
 * viewed just got a new reply": one call with no assistant message yet
 * (establishes the auto-read baseline for this sessionId), then the call
 * with the reply (the one that should actually trigger voice.request()).
 * Without the first call, SpeakToggle can't distinguish this from "just
 * switched into a session that already had an old reply sitting there" —
 * see client.js's lastSeenSessionIdRef comment. */
function primeThenReply(SpeakToggle, baseProps) {
  SpeakToggle({ ...baseProps, session: emptySession() })
}

function mockSlots() {
  const entries = []
  const slots = {
    inject: (slot, callback) => entries.push({ slot, register: callback }),
    register: (opts, component) => ({ opts, component }),
  }
  return { slots, entries }
}

/** Minimal EventSource stub for exercising speakStream(): each `new
 * EventSource(url)` call is recorded in `instances` (in creation order) so
 * a test can grab the latest one and manually fire `.onmessage({data})` /
 * `.onerror()` to simulate SSE frames, and check `.closed` afterward. */
function makeFakeEventSource() {
  const instances = []
  function FakeEventSource(url) {
    this.url = url
    this.closed = false
    this.onmessage = null
    this.onerror = null
    instances.push(this)
  }
  FakeEventSource.prototype.close = function () { this.closed = true }
  return { FakeEventSource, instances }
}

/** A valid (content doesn't matter -- tests check play order/count, not
 * decoded audio) base64 payload for an SSE `data.audio` field. */
const FAKE_AUDIO_B64 = 'eA=='

test('client bundle exports createVoiceClient', () => {
  const { moduleObj } = loadBundle()
  assert.equal(moduleObj.name, 'dsh-voice-core')
  assert.equal(typeof moduleObj.createVoiceClient, 'function')
})

test('client bundle top-level export is itself a valid cordis plugin (boot-row loader entry)', () => {
  // The profile patch activates a loader entry named `dsh-voice-core` (see
  // cordis.patch.yml) whose client bundle IS this module's top-level export
  // — client-side cordis calls `.apply` on it directly, same as the
  // server-side no-op apply in index.js. Missing `apply` here breaks the
  // whole client boot graph with "invalid plugin ... received object".
  const { moduleObj } = loadBundle()
  assert.equal(typeof moduleObj.apply, 'function')
  assert.doesNotThrow(() => moduleObj.apply({ get: () => undefined }))
})

test('createVoiceClient registers speak toggle and style picker', () => {
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'sister',
    ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'x' } },
    defaultStyle: 'paimon',
  })
  assert.equal(plugin.name, 'dsh-voice-core/sister')
  assert.deepEqual(plugin.inject, ['slots', 'conversation'])
  assert.equal(typeof plugin.apply, 'function')
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const right = entries.filter((e) => e.slot === 'conversation.input.right')
  assert.equal(right.length, 1)
  assert.equal(right[0].register().opts.id, 'dsh-voice-sister-speak')
  const overlays = entries.filter((e) => e.slot === 'shell.overlay').map((e) => e.register().opts.id).sort()
  assert.deepEqual(overlays, ['dsh-voice-sister-background', 'dsh-voice-sister-style-picker'])
})

test('single-style config omits the picker button (no choice to make)', () => {
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'teacher',
    ttsPath: '/dsh-teacher/tts',
    styles: { onee: { label: '御姐', instruct: 'x' } },
    defaultStyle: 'onee',
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const right = entries.filter((e) => e.slot === 'conversation.input.right')
  assert.equal(right.length, 1)
  // Component renders a div; with one style there is only the 🔊 button.
  const { component: SpeakToggle } = right[0].register()
  const tree = SpeakToggle({
    sessionId: 's1',
    useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'teacher' } } }),
    useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
    session: { nodes: [], chat: { order: [], nodes: {} } },
  })
  assert.ok(tree !== null)
  assert.equal(tree.type, 'div')
  const buttons = tree.children.filter((c) => c && c.type === 'button')
  assert.equal(buttons.length, 1, 'only the speak toggle when one style')
})

test('a preset\'s SpeakToggle does not auto-read a session belonging to another preset', () => {
  // Every mounted preset's SpeakToggle receives the same active-session
  // projection and session content (there's only one active session).
  // Without the isVoice gate, a sister session's reply got auto-read in
  // teacher's voice too.
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'teacher',
    ttsPath: '/dsh-teacher/tts',
    styles: { onee: { label: '御姐', instruct: 'onee-instruct' } },
    defaultStyle: 'onee',
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()

  // speakBrowser guards on window.fetch but actually calls the bare global
  // fetch(...), so the spy must replace globalThis.fetch, not window.fetch.
  const calls = []
  const savedFetch = globalThis.fetch
  globalThis.fetch = (url) => { calls.push(url); return new Promise(() => {}) }
  try {
    SpeakToggle({
      sessionId: 's1',
      useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'sister' } } }), // active session is SISTER, not teacher
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
      session: assistantSession(1, '嗨嗨～你来啦！'),
    })
  } finally {
    globalThis.fetch = savedFetch
  }
  assert.equal(calls.length, 0, 'teacher SpeakToggle must not fetch TTS for a sister session reply')
})

test('switching into (or reloading onto) a session that already has a reply does not auto-read old history', () => {
  // Regression: a session with an old reply already sitting in it (viewed
  // 2+ hours ago, say) got read aloud again the instant SpeakToggle first
  // evaluated it -- e.g. after a page reload, or navigating away and back.
  // The cursor only guards "the exact session I last wrote a cursor for",
  // so the FIRST time a *different* (or not-yet-tracked) session is seen,
  // it fell through as if its already-visible reply were brand new.
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'teacher',
    ttsPath: '/dsh-teacher/tts',
    styles: { onee: { label: '御姐', instruct: 'x' } },
    defaultStyle: 'onee',
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()

  const { FakeEventSource, instances } = makeFakeEventSource()
  const savedEventSource = globalThis.EventSource
  globalThis.EventSource = FakeEventSource
  try {
    // Simulates opening a page fresh (or switching sessions) straight onto
    // a session that already has an old reply in it -- no earlier
    // "empty" render for this sessionId ever happened in this mount.
    SpeakToggle({
      sessionId: 'eng-teacher',
      useSessions: (sel) => sel({ byId: { 'eng-teacher': { agentPreset: 'teacher' } } }),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
      session: assistantSession(42, 'old roaches quiz hint from two hours ago'),
    })
    assert.equal(instances.length, 0, 'old history already on screen must never be sent to TTS')

    // A genuinely NEW reply arriving afterward (session content changes
    // again) must still be auto-read normally -- the fix only suppresses
    // the FIRST look at a session's pre-existing content, not everything.
    SpeakToggle({
      sessionId: 'eng-teacher',
      useSessions: (sel) => sel({ byId: { 'eng-teacher': { agentPreset: 'teacher' } } }),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
      session: assistantSession(43, 'a brand new reply after the old one'),
    })
    assert.equal(instances.length, 1, 'a genuinely new reply in the same session is still auto-read')
  } finally {
    globalThis.EventSource = savedEventSource
  }
})

test('switching sessions discards audio still in flight for the session left behind', () => {
  // TTS streaming can take a while to deliver its first segment. If the
  // user switches sessions before one arrives, that audio must not play
  // into the new session — it belongs to the session that requested it.
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'sister',
    ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'paimon-instruct' } },
    defaultStyle: 'paimon',
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()

  const played = []
  class FakeAudio {
    constructor(url) { this.url = url }
    play() { played.push(this.url); return Promise.resolve() }
    pause() {}
  }
  const savedAudio = globalThis.Audio
  const savedURL = globalThis.URL
  const { FakeEventSource, instances } = makeFakeEventSource()
  const savedEventSource = globalThis.EventSource
  globalThis.Audio = FakeAudio
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }
  globalThis.EventSource = FakeEventSource

  try {
    const state = { byId: { s1: { agentPreset: 'sister' }, s2: { agentPreset: 'sister' } } }
    const s1Props = {
      sessionId: 's1',
      useSessions: (sel) => sel(state),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
    }
    primeThenReply(SpeakToggle, s1Props) // establish s1 as already-viewed-and-empty
    // Session s1's reply is auto-read; its stream is still open (slow generation).
    SpeakToggle({ ...s1Props, session: assistantSession(1, 'hello from session one') })
    const s1Stream = instances[0]
    // User switches to s2 before a segment arrives.
    SpeakToggle({
      sessionId: 's2',
      useSessions: (sel) => sel(state),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })
    assert.ok(s1Stream.closed, 's1 stream is closed on session switch')
    // Now s1's slow stream finally delivers a segment anyway.
    s1Stream.onmessage({ data: JSON.stringify({ audio: FAKE_AUDIO_B64, isFinal: true }) })
  } finally {
    globalThis.Audio = savedAudio
    globalThis.URL = savedURL
    globalThis.EventSource = savedEventSource
  }
  assert.deepEqual(played, [], 'session-1 audio must not play after switching to session 2')
})

test('switching to a different preset\'s session cancels a still-pending auto-read debounce for the one left behind', () => {
  // The auto-read effect waits 1s before firing so a burst of streaming
  // updates only ever sends the settled reply once. If the user switches
  // away (to a DIFFERENT preset's session, so isVoice flips false) inside
  // that 1s window, the scheduled timer must never fire at all -- it must
  // not silently push the abandoned session's reply to TTS a moment later.
  const { moduleObj } = loadBundle()
  const sisterPlugin = moduleObj.createVoiceClient({
    presetName: 'sister', ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'x' } }, defaultStyle: 'paimon',
  })
  const teacherPlugin = moduleObj.createVoiceClient({
    presetName: 'teacher', ttsPath: '/dsh-teacher/tts',
    styles: { onee: { label: '御姐', instruct: 'x' } }, defaultStyle: 'onee',
  })
  const { slots, entries } = mockSlots()
  sisterPlugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  teacherPlugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const speakToggleById = (id) => entries.filter((e) => e.slot === 'conversation.input.right' && e.register().opts.id === id)[0].register().component
  const sisterSpeakToggle = speakToggleById('dsh-voice-sister-speak')
  const teacherSpeakToggle = speakToggleById('dsh-voice-teacher-speak')

  const fetchCalls = []
  const savedFetch = globalThis.fetch
  const savedSetTimeout = globalThis.setTimeout
  const savedClearTimeout = globalThis.clearTimeout
  let nextId = 0
  const pendingTimers = new Map() // id -> fn
  const clearedIds = new Set()
  globalThis.fetch = (url) => { fetchCalls.push(url); return new Promise(() => {}) }
  globalThis.setTimeout = (fn, ms) => {
    if (ms !== 1000) return 0 // let other timers (chip auto-dismiss, etc.) no-op as usual
    const id = ++nextId
    pendingTimers.set(id, fn)
    return id
  }
  globalThis.clearTimeout = (id) => { clearedIds.add(id) }

  try {
    const state = { byId: { s1: { agentPreset: 'sister' }, s2: { agentPreset: 'teacher' } } }
    const s1Props = {
      sessionId: 's1',
      useSessions: (sel) => sel(state),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
    }
    primeThenReply(sisterSpeakToggle, s1Props) // establish s1 as already-viewed-and-empty
    // Sister session s1's reply lands; its 1s debounce is scheduled but not fired yet.
    sisterSpeakToggle({ ...s1Props, session: assistantSession(1, 'hello from sister session') })
    assert.equal(pendingTimers.size, 1, 'sister schedules its debounce')

    // User switches to s2, a TEACHER session -- sister's SpeakToggle re-renders
    // with isVoice now false for the abandoned session.
    sisterSpeakToggle({
      sessionId: 's2',
      useSessions: (sel) => sel(state),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })
    teacherSpeakToggle({
      sessionId: 's2',
      useSessions: (sel) => sel(state),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })

    // Fire whatever timers survive -- if the pending one wasn't cancelled,
    // this is where it would (wrongly) push sister's old reply to TTS.
    for (const [id, fn] of pendingTimers) {
      if (!clearedIds.has(id)) fn()
    }

    assert.deepEqual(fetchCalls, [], 'the abandoned session\'s reply must never reach the TTS endpoint')
  } finally {
    globalThis.fetch = savedFetch
    globalThis.setTimeout = savedSetTimeout
    globalThis.clearTimeout = savedClearTimeout
  }
})

test('speakBrowser closes an older in-flight stream when a newer one arrives', () => {
  // Only the latest speak/cheer should ever reach TTS: an older reply the
  // conversation has already moved past must not keep occupying the
  // single-worker generation queue behind the newest one.
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'sister',
    ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'x' } },
    defaultStyle: 'paimon',
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()

  const { FakeEventSource, instances } = makeFakeEventSource()
  const savedEventSource = globalThis.EventSource
  const savedSetTimeout = globalThis.setTimeout
  const savedClearTimeout = globalThis.clearTimeout
  globalThis.EventSource = FakeEventSource
  // Fire the 1s auto-read debounce (so both calls below actually reach
  // voice.request) but avoid scheduling a real idle-watchdog timer.
  globalThis.setTimeout = (fn, ms) => { if (ms === 1000) fn(); return 0 }
  globalThis.clearTimeout = () => {}
  try {
    const state = { byId: { s1: { agentPreset: 'sister' } } }
    const s1Props = {
      sessionId: 's1',
      useSessions: (sel) => sel(state),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
    }
    primeThenReply(SpeakToggle, s1Props) // establish s1 as already-viewed-and-empty
    SpeakToggle({ ...s1Props, session: assistantSession(1, 'old message') })
    SpeakToggle({ ...s1Props, session: assistantSession(2, 'new message') })
  } finally {
    globalThis.EventSource = savedEventSource
    globalThis.setTimeout = savedSetTimeout
    globalThis.clearTimeout = savedClearTimeout
  }
  assert.equal(instances.length, 2)
  assert.equal(instances[0].closed, true, 'the older in-flight stream must be closed')
  assert.equal(instances[1].closed, false, 'the newest stream must still be open')
})

test('resolveInstruct overrides the static default style for the auto-read TTS request', () => {
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'sister',
    ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'static-default-instruct' } },
    defaultStyle: 'paimon',
    resolveInstruct: (sessionId) => (sessionId === 's1' ? 'resolved-per-session-instruct' : ''),
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()

  const { FakeEventSource, instances } = makeFakeEventSource()
  const savedEventSource = globalThis.EventSource
  globalThis.EventSource = FakeEventSource
  try {
    const s1Props = {
      sessionId: 's1',
      useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'sister' } } }),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
    }
    primeThenReply(SpeakToggle, s1Props)
    SpeakToggle({ ...s1Props, session: assistantSession(1, 'hello') })
    assert.equal(instances.length, 1)
    const sentInstruct = decodeURIComponent(instances[0].url.match(/instruct=([^&]*)/)[1])
    assert.equal(sentInstruct, 'resolved-per-session-instruct', 'resolveInstruct wins over the static default')
  } finally {
    globalThis.EventSource = savedEventSource
  }
})

test('resolveInstruct returning empty falls back to the static default style', () => {
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'sister',
    ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'static-default-instruct' } },
    defaultStyle: 'paimon',
    resolveInstruct: () => '',
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()

  const { FakeEventSource, instances } = makeFakeEventSource()
  const savedEventSource = globalThis.EventSource
  globalThis.EventSource = FakeEventSource
  try {
    const s1Props = {
      sessionId: 's1',
      useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'sister' } } }),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
    }
    primeThenReply(SpeakToggle, s1Props)
    SpeakToggle({ ...s1Props, session: assistantSession(1, 'hello') })
    const sentInstruct = decodeURIComponent(instances[0].url.match(/instruct=([^&]*)/)[1])
    assert.equal(sentInstruct, 'static-default-instruct')
  } finally {
    globalThis.EventSource = savedEventSource
  }
})

test('showStylePicker: false hides the 🎤 button and does not register the picker overlay, even with multiple styles', () => {
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'sister',
    ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'x' }, cute: { label: '软萌', instruct: 'y' } },
    defaultStyle: 'paimon',
    showStylePicker: false,
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const overlays = entries.filter((e) => e.slot === 'shell.overlay').map((e) => e.register().opts.id)
  assert.ok(!overlays.includes('dsh-voice-sister-style-picker'), 'picker overlay is not registered at all')

  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()
  const tree = SpeakToggle({
    sessionId: 's1',
    useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'sister' } } }),
    useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
    session: { nodes: [], chat: { order: [], nodes: {} } },
  })
  const buttons = (tree ? tree.children : []).filter((c) => c && c.type === 'button')
  assert.equal(buttons.length, 1, 'only the 🔊 speak toggle remains')
})

test('showSpeakToggle: false and showStylePicker: false together render nothing', () => {
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'sister',
    ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'x' }, cute: { label: '软萌', instruct: 'y' } },
    defaultStyle: 'paimon',
    showSpeakToggle: false,
    showStylePicker: false,
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const overlays = entries.filter((e) => e.slot === 'shell.overlay').map((e) => e.register().opts.id)
  assert.ok(!overlays.includes('dsh-voice-sister-style-picker'))

  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()
  const tree = SpeakToggle({
    sessionId: 's1',
    useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'sister' } } }),
    useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
    session: { nodes: [], chat: { order: [], nodes: {} } },
  })
  assert.equal(tree, null, 'no icons to show ⇒ component renders nothing')
})

test('auto-read and queue polling keep working with both UI icons hidden', () => {
  // Suppressing the icons must not suppress the underlying behavior.
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'sister',
    ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'x' } },
    defaultStyle: 'paimon',
    showSpeakToggle: false,
    showStylePicker: false,
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()

  const { FakeEventSource, instances } = makeFakeEventSource()
  const savedEventSource = globalThis.EventSource
  globalThis.EventSource = FakeEventSource
  try {
    const s1Props = {
      sessionId: 's1',
      useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'sister' } } }),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
    }
    primeThenReply(SpeakToggle, s1Props)
    SpeakToggle({ ...s1Props, session: assistantSession(1, 'hello') })
    assert.equal(instances.length, 1, 'auto-read still fires with icons hidden')
  } finally {
    globalThis.EventSource = savedEventSource
  }
})

test('a newer speak request stops and clears audio already queued from an earlier one for the same session', () => {
  // e.g. a streaming reply: the auto-read effect can fire once for a
  // partial snapshot and again for the final, longer text of the SAME
  // message (same seq, different text — the dedup check compares both).
  // If both finish generating, they must not play back-to-back — the
  // newer one should stop/clear the earlier one immediately.
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'sister',
    ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'x' } },
    defaultStyle: 'paimon',
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()

  const events = []
  class FakeAudio {
    constructor(url) { this.url = url }
    play() { events.push(['play', this.url]); return Promise.resolve() }
    pause() { events.push(['pause', this.url]) }
  }
  const savedAudio = globalThis.Audio
  const savedURL = globalThis.URL
  const { FakeEventSource, instances } = makeFakeEventSource()
  const savedEventSource = globalThis.EventSource
  globalThis.Audio = FakeAudio
  var nextBlobId = 0
  globalThis.URL = { createObjectURL: () => 'blob:' + (nextBlobId++), revokeObjectURL: () => {} }
  globalThis.EventSource = FakeEventSource
  const state = { byId: { s1: { agentPreset: 'sister' } } }
  const s1Props = {
    sessionId: 's1',
    useSessions: (sel) => sel(state),
    useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
  }

  try {
    primeThenReply(SpeakToggle, s1Props) // establish s1 as already-viewed-and-empty
    // First auto-read (partial streamed text): its stream delivers one
    // final segment and starts playing.
    SpeakToggle({ ...s1Props, session: assistantSession(1, 'partial reply') })
    instances[0].onmessage({ data: JSON.stringify({ audio: FAKE_AUDIO_B64, isFinal: true }) })
    assert.deepEqual(events, [['play', 'blob:0']])

    // Second auto-read (the final, longer text of the SAME message) fires next.
    SpeakToggle({ ...s1Props, session: assistantSession(1, 'partial reply, now complete') })
    // The partial clip is stopped immediately, before the final reply's own
    // audio is even ready — it does not get to keep playing to completion.
    assert.ok(
      events.some((e) => e[0] === 'pause' && e[1] === 'blob:0'),
      'the earlier partial clip is stopped, not left to finish playing',
    )
    assert.equal(instances[0].closed, true, 'the earlier stream is closed too')

    instances[1].onmessage({ data: JSON.stringify({ audio: FAKE_AUDIO_B64, isFinal: true }) })
    assert.deepEqual(
      events.filter((e) => e[0] === 'play'),
      [['play', 'blob:0'], ['play', 'blob:1']],
      'the final reply eventually plays once ready',
    )
  } finally {
    globalThis.Audio = savedAudio
    globalThis.URL = savedURL
    globalThis.EventSource = savedEventSource
  }
})

test('speakBrowser closes a stream that goes idle for 15s so a stuck one cannot block whatever comes after it', () => {
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'sister',
    ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'x' } },
    defaultStyle: 'paimon',
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()

  let idleCallback = null
  let capturedDelay = null
  const savedSetTimeout = globalThis.setTimeout
  const { FakeEventSource, instances } = makeFakeEventSource()
  const savedEventSource = globalThis.EventSource
  // Fire the 1s auto-read debounce immediately (so voice.request actually
  // runs) but capture the stream's idle-watchdog timer for manual control.
  globalThis.setTimeout = (fn, ms) => {
    if (ms === 1000) { fn(); return 0 }
    idleCallback = fn
    capturedDelay = ms
    return 0
  }
  globalThis.EventSource = FakeEventSource
  try {
    const s1Props = {
      sessionId: 's1',
      useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'sister' } } }),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
    }
    primeThenReply(SpeakToggle, s1Props) // establish s1 as already-viewed-and-empty
    SpeakToggle({ ...s1Props, session: assistantSession(1, 'hello') })
    assert.equal(capturedDelay, 15000, 'gives up after 15 seconds of silence')
    assert.equal(instances[0].closed, false)
    idleCallback() // simulate 15s elapsing with no segment received
    assert.equal(instances[0].closed, true, 'the stuck stream is closed once the idle watchdog fires')
  } finally {
    globalThis.setTimeout = savedSetTimeout
    globalThis.EventSource = savedEventSource
  }
})

test('auto-read speaks the FULL reply through one stream (no truncation, no client-side splitting)', () => {
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'sister',
    ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'x' } },
    defaultStyle: 'paimon',
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()

  const longReply = '第一句话说明背景信息。'.repeat(30) // long -- would have been truncated under the old design
  const { FakeEventSource, instances } = makeFakeEventSource()
  const savedEventSource = globalThis.EventSource
  globalThis.EventSource = FakeEventSource
  try {
    const s1Props = {
      sessionId: 's1',
      useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'sister' } } }),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
    }
    primeThenReply(SpeakToggle, s1Props) // establish s1 as already-viewed-and-empty
    SpeakToggle({ ...s1Props, session: assistantSession(1, longReply) })
    assert.equal(instances.length, 1, 'exactly one streaming connection for the whole reply')
    const sentText = decodeURIComponent(instances[0].url.match(/text=([^&]*)/)[1])
    assert.equal(sentText, longReply, 'the full, untruncated text is sent -- nothing split or cut client-side')
  } finally {
    globalThis.EventSource = savedEventSource
  }
})

test('streamed segments queue and play in order as they arrive, before the stream even finishes', () => {
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'sister',
    ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'x' } },
    defaultStyle: 'paimon',
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()

  const played = []
  const audioInstances = []
  class FakeAudio {
    constructor(url) { this.url = url; audioInstances.push(this) }
    play() { played.push(this.url); return Promise.resolve() }
    pause() {}
  }
  const savedAudio = globalThis.Audio
  const savedURL = globalThis.URL
  const { FakeEventSource, instances } = makeFakeEventSource()
  const savedEventSource = globalThis.EventSource
  globalThis.Audio = FakeAudio
  var nextBlobId = 0
  globalThis.URL = { createObjectURL: () => 'blob:' + (nextBlobId++), revokeObjectURL: () => {} }
  globalThis.EventSource = FakeEventSource

  try {
    const s1Props = {
      sessionId: 's1',
      useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'sister' } } }),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
    }
    primeThenReply(SpeakToggle, s1Props) // establish s1 as already-viewed-and-empty
    SpeakToggle({ ...s1Props, session: assistantSession(1, 'a long reply spoken as several segments') })
    const es = instances[0]

    // Three non-final segments arrive back to back (the server keeps
    // generating ahead of playback); only the first one has started
    // playing so far since FakeAudio never fires onended on its own.
    es.onmessage({ data: JSON.stringify({ audio: FAKE_AUDIO_B64, isFinal: false }) })
    es.onmessage({ data: JSON.stringify({ audio: FAKE_AUDIO_B64, isFinal: false }) })
    es.onmessage({ data: JSON.stringify({ audio: FAKE_AUDIO_B64, isFinal: false }) })
    assert.deepEqual(played, ['blob:0'], 'only the first segment has started playing so far')
    assert.equal(es.closed, false, 'stream stays open -- more segments (or isFinal) still to come')

    // Each finishing playback picks up the next queued segment immediately.
    audioInstances[0].onended()
    assert.deepEqual(played, ['blob:0', 'blob:1'])
    audioInstances[1].onended()
    assert.deepEqual(played, ['blob:0', 'blob:1', 'blob:2'])

    // Final segment arrives and closes the stream once delivered.
    es.onmessage({ data: JSON.stringify({ audio: FAKE_AUDIO_B64, isFinal: true }) })
    audioInstances[2].onended()
    assert.deepEqual(played, ['blob:0', 'blob:1', 'blob:2', 'blob:3'])
    assert.equal(es.closed, true, 'stream closes itself once the final segment is delivered')
  } finally {
    globalThis.Audio = savedAudio
    globalThis.URL = savedURL
    globalThis.EventSource = savedEventSource
  }
})

test('BackgroundLayer shows only while its own preset\'s session is active, and only if configured', () => {
  const { moduleObj } = loadBundle()
  const { slots, entries } = mockSlots()
  const sisterPlugin = moduleObj.createVoiceClient({
    presetName: 'sister', ttsPath: '/dsh-sister/tts', backgroundUrl: 'https://example.com/sister-bg.jpg',
    styles: { paimon: { label: '派蒙', instruct: 'x' } }, defaultStyle: 'paimon',
  })
  const teacherPlugin = moduleObj.createVoiceClient({
    presetName: 'teacher', ttsPath: '/dsh-teacher/tts', // no backgroundUrl -- keeps the host default
    styles: { onee: { label: '御姐', instruct: 'x' } }, defaultStyle: 'onee',
  })
  sisterPlugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  teacherPlugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })

  const speakToggleById = (id) => entries.filter((e) => e.slot === 'conversation.input.right' && e.register().opts.id === id)[0].register().component
  const backgroundById = (id) => entries.filter((e) => e.slot === 'shell.overlay' && e.register().opts.id === id)[0].register().component
  const sisterSpeakToggle = speakToggleById('dsh-voice-sister-speak')
  const teacherSpeakToggle = speakToggleById('dsh-voice-teacher-speak')
  const sisterBackground = backgroundById('dsh-voice-sister-background')
  const teacherBackground = backgroundById('dsh-voice-teacher-background')

  const state = { byId: { s1: { agentPreset: 'sister' }, s2: { agentPreset: 'teacher' } } }
  const noop = () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null })

  document.body.style.backgroundImage = ''

  // Sister session active: applied directly to document.body (not rendered
  // as a DOM node — see the comment on makeBackgroundLayer for why).
  sisterSpeakToggle({ sessionId: 's1', useSessions: (sel) => sel(state), useProjection: noop, session: { nodes: [], chat: { order: [], nodes: {} } } })
  teacherSpeakToggle({ sessionId: 's1', useSessions: (sel) => sel(state), useProjection: noop, session: { nodes: [], chat: { order: [], nodes: {} } } })
  sisterBackground()
  assert.ok(
    document.body.style.backgroundImage.includes('url(https://example.com/sister-bg.jpg)'),
    'sister backdrop applies to body while its session is active',
  )

  const bodyStyleSnapshot = Object.assign({}, document.body.style)
  teacherBackground() // no backgroundUrl configured for teacher -- must never touch body style
  assert.deepEqual(document.body.style, bodyStyleSnapshot, 'teacher has no backgroundUrl configured, so it never touches body style')
  // (This harness's useEffect stub never invokes a returned cleanup, so it
  // cannot exercise "switching sessions restores the previous body style"
  // here -- that path is verified live in the browser instead.)
})


test('a cheer fires without generating audio; only the assistant\'s actual reply text does', () => {
  // "I said good night and sister spoke many sentences" -- the cheer
  // tool's own text and the auto-read of the full reply were two
  // independent audio triggers for one turn. Only the reply (what's
  // actually shown in the chat box) is ever sent to TTS; a cheer with no
  // reply (e.g. the scheduler's /cheer-text fixed greeting) still shows up
  // as its own tool-call line in the chat transcript, but stays silent.
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'sister',
    ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'x' } },
    defaultStyle: 'paimon',
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()

  const calls = []
  const savedFetch = globalThis.fetch
  globalThis.fetch = (url) => { calls.push(url); return new Promise(() => {}) }
  try {
    SpeakToggle({
      sessionId: 's1',
      useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'sister' } } }),
      useProjection: () => ({ speakEnabled: true, lastSpoken: { seq: 1, text: '晚上好呀！能见到你超开心～' }, lastCheer: { seq: 1, text: '晚上好呀！能见到你超开心～' } }),
      // No accompanying assistant chat message this turn (the scheduler's
      // fixed-greeting path never creates one).
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })
  } finally {
    globalThis.fetch = savedFetch
  }
  assert.equal(calls.length, 0, 'the cheer text alone must not reach TTS')
})

test('a cheer matching the pre-baked manifest plays a static clip, never touching the TTS endpoint', async () => {
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'sister',
    ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'x' } },
    defaultStyle: 'paimon',
    cheerAudioManifestUrl: '/dsh-sister/cheer-audio/manifest.json',
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()

  const ttsCalls = []
  const played = []
  class FakeAudio {
    constructor(url) { this.url = url }
    play() { played.push(this.url); return Promise.resolve() }
    pause() {}
  }
  const savedAudio = globalThis.Audio
  const savedURL = globalThis.URL
  const savedFetch = globalThis.fetch
  globalThis.Audio = FakeAudio
  globalThis.URL = { createObjectURL: (blob) => 'blob:' + blob.id, revokeObjectURL: () => {} }
  globalThis.fetch = (url) => {
    if (String(url) === '/dsh-sister/cheer-audio/manifest.json') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ '晚安呀，做个好梦！': '/dsh-sister/cheer-audio/03.m4a' }) })
    }
    ttsCalls.push(url)
    return new Promise(() => {})
  }
  try {
    SpeakToggle({
      sessionId: 's1',
      useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'sister' } } }),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: { seq: 1, text: '晚安呀，做个好梦！' } }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })
    // loadCheerManifest's fetch().then() resolves on a later microtask.
    await Promise.resolve().then(() => {}).then(() => {}).then(() => {}).then(() => {}).then(() => {}).then(() => {})
  } finally {
    globalThis.Audio = savedAudio
    globalThis.URL = savedURL
    globalThis.fetch = savedFetch
  }
  assert.deepEqual(played, ['/dsh-sister/cheer-audio/03.m4a'], 'plays the pre-baked clip for the matching cheer text')
  assert.equal(ttsCalls.length, 0, 'a manifest-matched cheer never reaches the TTS endpoint')
})

test('a cheer NOT in the pre-baked manifest stays silent (no playClip, no live TTS)', async () => {
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'sister',
    ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'x' } },
    defaultStyle: 'paimon',
    cheerAudioManifestUrl: '/dsh-sister/cheer-audio/manifest.json',
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()

  const ttsCalls = []
  const played = []
  class FakeAudio {
    constructor(url) { this.url = url }
    play() { played.push(this.url); return Promise.resolve() }
    pause() {}
  }
  const savedAudio = globalThis.Audio
  const savedFetch = globalThis.fetch
  globalThis.Audio = FakeAudio
  globalThis.fetch = (url) => {
    if (String(url) === '/dsh-sister/cheer-audio/manifest.json') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ '晚安呀，做个好梦！': '/dsh-sister/cheer-audio/03.m4a' }) })
    }
    ttsCalls.push(url)
    return new Promise(() => {})
  }
  try {
    SpeakToggle({
      sessionId: 's1',
      useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'sister' } } }),
      // A custom /cheer text (or the scheduler's model-composed daily
      // greeting) never matches the fixed bank exactly.
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: { seq: 1, text: '今天股票大涨，恭喜发财！' } }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })
    await Promise.resolve().then(() => {}).then(() => {}).then(() => {}).then(() => {}).then(() => {}).then(() => {})
  } finally {
    globalThis.Audio = savedAudio
    globalThis.fetch = savedFetch
  }
  assert.deepEqual(played, [], 'no pre-baked clip matches, so nothing plays')
  assert.equal(ttsCalls.length, 0, 'a non-matching cheer still never reaches the TTS endpoint')
})

test('a matching cheer clip never interrupts an in-flight live reply from the same turn', async () => {
  // The auto-read effect (declared first) can already have kicked off a
  // live TTS stream for the turn's actual reply by the time the
  // cheer-audio effect (declared after it) resolves its manifest match --
  // playClip must back off instead of stopAndClear()ing that stream out
  // from under the real content. (Regression: playClip used to call
  // stopAndClear() unconditionally, which aborted the reply's own
  // in-flight request — confirmed live via net::ERR_ABORTED on the
  // reply's /tts request right after a matching cheer fired in the same
  // turn.)
  const { moduleObj } = loadBundle()
  const plugin = moduleObj.createVoiceClient({
    presetName: 'sister',
    ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'x' } },
    defaultStyle: 'paimon',
    cheerAudioManifestUrl: '/dsh-sister/cheer-audio/manifest.json',
  })
  const { slots, entries } = mockSlots()
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const { component: SpeakToggle } = entries.filter((e) => e.slot === 'conversation.input.right')[0].register()

  const played = []
  class FakeAudio {
    constructor(url) { this.url = url }
    play() { played.push(this.url); return Promise.resolve() }
    pause() {}
  }
  const savedAudio = globalThis.Audio
  const savedFetch = globalThis.fetch
  const { FakeEventSource, instances } = makeFakeEventSource()
  const savedEventSource = globalThis.EventSource
  globalThis.Audio = FakeAudio
  globalThis.fetch = (url) => {
    if (String(url) === '/dsh-sister/cheer-audio/manifest.json') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ '晚安呀，做个好梦！': '/dsh-sister/cheer-audio/03.m4a' }) })
    }
    return Promise.reject(new Error('unexpected fetch: ' + url))
  }
  globalThis.EventSource = FakeEventSource // the reply's stream never emits -- still "in flight"
  try {
    const s1Props = {
      sessionId: 's1',
      useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'sister' } } }),
    }
    // establish s1 as already-viewed-and-empty
    SpeakToggle({ ...s1Props, useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }), session: emptySession() })
    SpeakToggle({
      ...s1Props,
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: { seq: 1, text: '晚安呀，做个好梦！' } }),
      // A real assistant reply this turn -- auto-read's 1000ms debounce
      // (stubbed to fire synchronously) calls voice.request() for it
      // BEFORE the cheer-audio effect's manifest fetch has a chance to
      // resolve, so pendingSource is already set when playClip runs.
      session: assistantSession(1, '晚安啦，做个好梦哦！'),
    })
    await Promise.resolve().then(() => {}).then(() => {}).then(() => {}).then(() => {}).then(() => {}).then(() => {})
  } finally {
    globalThis.Audio = savedAudio
    globalThis.fetch = savedFetch
    globalThis.EventSource = savedEventSource
  }
  assert.equal(instances.length, 1, 'the real reply still reaches the TTS endpoint')
  assert.equal(instances[0].closed, false, 'the reply\'s stream is still open, not aborted by the cheer')
  assert.deepEqual(played, [], 'the cheer clip backs off instead of interrupting the in-flight reply')
})

test('watchQueue polls the health route and getQueueStatus reflects it; ref-counted across multiple watchers', async () => {
  const { moduleObj } = loadBundle()
  const { voice } = moduleObj._test

  let intervalCallback = null
  let clearedId = null
  const savedSetInterval = globalThis.setInterval
  const savedClearInterval = globalThis.clearInterval
  const savedFetch = globalThis.fetch
  globalThis.setInterval = (fn) => { intervalCallback = fn; return 'timer-1' }
  globalThis.clearInterval = (id) => { clearedId = id }
  globalThis.fetch = (url) => {
    assert.equal(url, '/dsh-sister/tts-health')
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ pending: 3, lastGenerationMs: 4200 }) })
  }
  try {
    assert.equal(voice.getQueueStatus('/dsh-sister/tts'), null, 'no status before anyone is watching')

    const stopA = voice.watchQueue('/dsh-sister/tts')
    const stopB = voice.watchQueue('/dsh-sister/tts') // second watcher joins the same path
    assert.ok(intervalCallback !== null, 'starts a single interval on first watcher')

    intervalCallback() // simulate a poll tick
    await Promise.resolve().then(() => {}).then(() => {}).then(() => {})
    assert.deepEqual(voice.getQueueStatus('/dsh-sister/tts'), { pending: 3, lastGenerationMs: 4200 })

    stopA()
    assert.equal(clearedId, null, 'timer stays alive while a watcher remains')
    stopB()
    assert.equal(clearedId, 'timer-1', 'timer is torn down once every watcher has stopped')
    assert.equal(voice.getQueueStatus('/dsh-sister/tts'), null, 'status is gone once nobody is watching')
  } finally {
    globalThis.setInterval = savedSetInterval
    globalThis.clearInterval = savedClearInterval
    globalThis.fetch = savedFetch
  }
})

test('_test helpers extract assistant text by kind', () => {
  const { moduleObj } = loadBundle()
  const { assistantNodeText, latestAssistantText, speakable } = moduleObj._test
  assert.equal(speakable('**Hello** ✅'), 'Hello ✅')
  assert.equal(
    assistantNodeText({ kind: 'assistant', seq: 1, blocks: [{ kind: 'text', text: 'hi' }, { kind: 'reasoning', text: 'think' }] }),
    'hi',
  )
  const session = {
    nodes: [{ kind: 'assistant', seq: 3, blocks: [{ kind: 'text', text: 'Latest' }] }],
    chat: { order: [], nodes: {} },
  }
  assert.deepEqual(latestAssistantText(session), { seq: 3, text: 'Latest' })
})
