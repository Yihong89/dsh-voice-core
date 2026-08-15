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
    // speakBrowser guards on `typeof window.fetch === 'function'` but then
    // calls the bare `fetch(...)` — which resolves via globalThis, not this
    // stub object. Keep this truthy so the guard passes; tests that need to
    // observe/intercept the actual call must stub globalThis.fetch instead.
    fetch: () => {},
  }
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

function mockSlots() {
  const entries = []
  const slots = {
    inject: (slot, callback) => entries.push({ slot, register: callback }),
    register: (opts, component) => ({ opts, component }),
  }
  return { slots, entries }
}

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

test('createVoiceClient registers speak toggle, cheer chip, and style picker', () => {
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
  assert.deepEqual(overlays, ['dsh-voice-sister-cheer-chip', 'dsh-voice-sister-hear-full', 'dsh-voice-sister-style-picker'])
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

test('a preset\'s SpeakToggle does not speak voice/spoken events from a session of another preset', () => {
  // Every mounted preset's SpeakToggle receives the same active-session
  // projection via useProjection('voiceSpeak') (there's only one active
  // session). Without the isVoice gate on the "explicit speak" effect, the
  // sister session's cheer got read aloud in teacher's voice too.
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
      useProjection: () => ({ speakEnabled: true, lastSpoken: { seq: 1, text: '嗨嗨～你来啦！' }, lastCheer: null }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })
  } finally {
    globalThis.fetch = savedFetch
  }
  assert.equal(calls.length, 0, 'teacher SpeakToggle must not fetch TTS for a sister session event')
})

test('switching sessions discards audio still in flight for the session left behind', async () => {
  // TTS generation can take tens of seconds. If the user switches sessions
  // before a queued fetch resolves, that audio must not play into the new
  // session — it belongs to the session that requested it.
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
  const savedFetch = globalThis.fetch
  globalThis.Audio = FakeAudio
  globalThis.URL = { createObjectURL: (blob) => 'blob:' + blob.id, revokeObjectURL: () => {} }
  let resolveFetch
  globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve })

  try {
    const state = { byId: { s1: { agentPreset: 'sister' }, s2: { agentPreset: 'sister' } } }
    // Session s1 speaks; its TTS fetch is still pending (slow generation).
    SpeakToggle({
      sessionId: 's1',
      useSessions: (sel) => sel(state),
      useProjection: () => ({ speakEnabled: true, lastSpoken: { seq: 1, text: 'hello from session one' }, lastCheer: null }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })
    // User switches to s2 before the fetch resolves.
    SpeakToggle({
      sessionId: 's2',
      useSessions: (sel) => sel(state),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: null }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })
    // Now s1's slow TTS generation finally completes.
    resolveFetch({ ok: true, blob: () => Promise.resolve({ id: 's1-audio' }) })
    await Promise.resolve().then(() => {}).then(() => {}).then(() => {})
  } finally {
    globalThis.Audio = savedAudio
    globalThis.URL = savedURL
    globalThis.fetch = savedFetch
  }
  assert.deepEqual(played, [], 'session-1 audio must not play after switching to session 2')
})

test('speakBrowser aborts an older in-flight request when a newer one arrives', () => {
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

  const fetchCalls = []
  const savedFetch = globalThis.fetch
  const savedSetTimeout = globalThis.setTimeout
  const savedClearTimeout = globalThis.clearTimeout
  globalThis.fetch = (url, init) => { fetchCalls.push({ url, signal: init.signal }); return new Promise(() => {}) }
  globalThis.setTimeout = () => 0 // avoid scheduling a real 5s give-up timer
  globalThis.clearTimeout = () => {}
  try {
    const state = { byId: { s1: { agentPreset: 'sister' } } }
    SpeakToggle({
      sessionId: 's1',
      useSessions: (sel) => sel(state),
      useProjection: () => ({ speakEnabled: true, lastSpoken: { seq: 1, text: 'old message' }, lastCheer: null }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })
    SpeakToggle({
      sessionId: 's1',
      useSessions: (sel) => sel(state),
      useProjection: () => ({ speakEnabled: true, lastSpoken: { seq: 2, text: 'new message' }, lastCheer: null }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })
  } finally {
    globalThis.fetch = savedFetch
    globalThis.setTimeout = savedSetTimeout
    globalThis.clearTimeout = savedClearTimeout
  }
  assert.equal(fetchCalls.length, 2)
  assert.equal(fetchCalls[0].signal.aborted, true, 'the older in-flight request must be aborted')
  assert.equal(fetchCalls[1].signal.aborted, false, 'the newest request must still be active')
})

test('a newer speak request stops and clears audio already queued from an earlier one in the same turn', async () => {
  // e.g. the cheer tool's short intro and the full auto-read reply for the
  // SAME assistant turn are two independent speakBrowser calls, each with
  // its own dedup tracking, unaware of each other. If both finish
  // generating, they must not play back-to-back ("so many sentences") -
  // the newer one should stop/clear the earlier one immediately.
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
  const savedFetch = globalThis.fetch
  globalThis.Audio = FakeAudio
  globalThis.URL = { createObjectURL: (blob) => 'blob:' + blob.id, revokeObjectURL: () => {} }
  const state = { byId: { s1: { agentPreset: 'sister' } } }

  try {
    // First speak (e.g. the cheer's short intro) resolves and starts playing.
    globalThis.fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve({ id: 'cheer-audio' }) })
    SpeakToggle({
      sessionId: 's1',
      useSessions: (sel) => sel(state),
      useProjection: () => ({ speakEnabled: true, lastSpoken: { seq: 1, text: 'cheer intro' }, lastCheer: null }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })
    await Promise.resolve().then(() => {}).then(() => {}).then(() => {})
    assert.deepEqual(events, [['play', 'blob:cheer-audio']])

    // Second speak (the full auto-read reply for the SAME turn) fires next.
    globalThis.fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve({ id: 'reply-audio' }) })
    SpeakToggle({
      sessionId: 's1',
      useSessions: (sel) => sel(state),
      useProjection: () => ({ speakEnabled: true, lastSpoken: { seq: 2, text: 'full reply text' }, lastCheer: null }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })
    // The cheer clip is stopped immediately, before the reply's own audio
    // is even ready — it does not get to keep playing to completion.
    assert.ok(
      events.some((e) => e[0] === 'pause' && e[1] === 'blob:cheer-audio'),
      'the earlier cheer clip is stopped, not left to finish playing',
    )

    await Promise.resolve().then(() => {}).then(() => {}).then(() => {})
    assert.deepEqual(
      events.filter((e) => e[0] === 'play'),
      [['play', 'blob:cheer-audio'], ['play', 'blob:reply-audio']],
      'the reply eventually plays once ready',
    )
  } finally {
    globalThis.Audio = savedAudio
    globalThis.URL = savedURL
    globalThis.fetch = savedFetch
  }
})

test('speakBrowser gives up after 5s so a stuck request cannot block whatever comes after it', () => {
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

  let capturedSignal = null
  let timeoutCallback = null
  let capturedDelay = null
  const savedSetTimeout = globalThis.setTimeout
  const savedFetch = globalThis.fetch
  globalThis.setTimeout = (fn, ms) => { timeoutCallback = fn; capturedDelay = ms; return 0 }
  globalThis.fetch = (url, init) => { capturedSignal = init.signal; return new Promise(() => {}) }
  try {
    SpeakToggle({
      sessionId: 's1',
      useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'sister' } } }),
      useProjection: () => ({ speakEnabled: true, lastSpoken: { seq: 1, text: 'hello' }, lastCheer: null }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })
    assert.equal(capturedDelay, 5000, 'gives up after 5 seconds')
    assert.equal(capturedSignal.aborted, false)
    timeoutCallback() // simulate the 5s elapsing without a response
    assert.equal(capturedSignal.aborted, true, 'the stuck request is aborted once the timeout fires')
  } finally {
    globalThis.setTimeout = savedSetTimeout
    globalThis.fetch = savedFetch
  }
})

test('a truncated long reply shows a "hear full reply" chip; clicking it plays the untruncated text', () => {
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
  const { component: HearFullChip } = entries.filter((e) => e.slot === 'shell.overlay' && e.register().opts.id === 'dsh-voice-sister-hear-full')[0].register()

  const longReply = '第一句话说明背景信息。'.repeat(30) // way past MAX_SPEAK_CHARS
  const fetchCalls = []
  const savedFetch = globalThis.fetch
  const savedSetTimeout = globalThis.setTimeout
  const savedClearTimeout = globalThis.clearTimeout
  globalThis.fetch = (url) => { fetchCalls.push(url); return new Promise(() => {}) }
  globalThis.setTimeout = () => 0
  globalThis.clearTimeout = () => {}
  try {
    SpeakToggle({
      sessionId: 's1',
      useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'sister' } } }),
      useProjection: () => ({ speakEnabled: true, lastSpoken: { seq: 1, text: longReply }, lastCheer: null }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })
    assert.equal(fetchCalls.length, 1)
    const firstSentText = decodeURIComponent(fetchCalls[0].match(/text=([^&]*)/)[1])
    assert.ok(firstSentText.length < longReply.length, 'the first speak attempt is truncated')

    const chip = HearFullChip()
    assert.ok(chip !== null, 'the hear-full chip should be visible after truncation')
    const button = chip.children[0].children[1]
    assert.equal(button.type, 'button')

    button.props.onClick()

    assert.equal(fetchCalls.length, 2, 'clicking the chip fires a second TTS request')
    const secondSentText = decodeURIComponent(fetchCalls[1].match(/text=([^&]*)/)[1])
    assert.equal(secondSentText, longReply, 'the second request sends the full untruncated text')
    assert.equal(HearFullChip(), null, 'the chip dismisses itself once used')
  } finally {
    globalThis.fetch = savedFetch
    globalThis.setTimeout = savedSetTimeout
    globalThis.clearTimeout = savedClearTimeout
  }
})

test('a preset\'s HearFullChip does not offer to play another preset\'s truncated reply', () => {
  const { moduleObj } = loadBundle()
  const { slots, entries } = mockSlots()
  const sisterPlugin = moduleObj.createVoiceClient({
    presetName: 'sister', ttsPath: '/dsh-sister/tts',
    styles: { paimon: { label: '派蒙', instruct: 'x' } }, defaultStyle: 'paimon',
  })
  const teacherPlugin = moduleObj.createVoiceClient({
    presetName: 'teacher', ttsPath: '/dsh-teacher/tts',
    styles: { onee: { label: '御姐', instruct: 'x' } }, defaultStyle: 'onee',
  })
  sisterPlugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  teacherPlugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })

  const speakToggleById = (id) => entries.filter((e) => e.slot === 'conversation.input.right' && e.register().opts.id === id)[0].register().component
  const hearFullChipById = (id) => entries.filter((e) => e.slot === 'shell.overlay' && e.register().opts.id === id)[0].register().component
  const sisterSpeakToggle = speakToggleById('dsh-voice-sister-speak')
  const sisterHearFullChip = hearFullChipById('dsh-voice-sister-hear-full')
  const teacherHearFullChip = hearFullChipById('dsh-voice-teacher-hear-full')

  const savedFetch = globalThis.fetch
  const savedSetTimeout = globalThis.setTimeout
  const savedClearTimeout = globalThis.clearTimeout
  globalThis.fetch = () => new Promise(() => {})
  globalThis.setTimeout = () => 0
  globalThis.clearTimeout = () => {}
  try {
    const longReply = '第一句话说明背景信息。'.repeat(30)
    sisterSpeakToggle({
      sessionId: 's1',
      useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'sister' } } }),
      useProjection: () => ({ speakEnabled: true, lastSpoken: { seq: 1, text: longReply }, lastCheer: null }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })
    assert.notEqual(sisterHearFullChip(), null, 'sister should offer to play its own truncated reply')
    assert.equal(teacherHearFullChip(), null, 'teacher must not offer to play a sister reply')
  } finally {
    globalThis.fetch = savedFetch
    globalThis.setTimeout = savedSetTimeout
    globalThis.clearTimeout = savedClearTimeout
  }
})

test('a preset\'s CheerChip does not display a cheer fired in another preset\'s session', () => {
  // store.cheer is shared by every mounted preset's CheerChip (they all
  // subscribe to the same module-level store and render at the same fixed
  // screen position). A sister-session cheer must not show up in teacher's
  // chip under teacher's own title.
  const { moduleObj } = loadBundle()
  const { slots, entries } = mockSlots()
  const sisterPlugin = moduleObj.createVoiceClient({
    presetName: 'sister', ttsPath: '/dsh-sister/tts', cheerTitle: '💛 Sister says…',
    styles: { paimon: { label: '派蒙', instruct: 'x' } }, defaultStyle: 'paimon',
  })
  const teacherPlugin = moduleObj.createVoiceClient({
    presetName: 'teacher', ttsPath: '/dsh-teacher/tts', cheerTitle: '💛 Teacher says…',
    styles: { onee: { label: '御姐', instruct: 'x' } }, defaultStyle: 'onee',
  })
  sisterPlugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  teacherPlugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })

  const speakToggleById = (id) => entries.filter((e) => e.slot === 'conversation.input.right' && e.register().opts.id === id)[0].register().component
  const cheerChipById = (id) => entries.filter((e) => e.slot === 'shell.overlay' && e.register().opts.id === id)[0].register().component
  const sisterSpeakToggle = speakToggleById('dsh-voice-sister-speak')
  const teacherSpeakToggle = speakToggleById('dsh-voice-teacher-speak')
  const sisterCheerChip = cheerChipById('dsh-voice-sister-cheer-chip')
  const teacherCheerChip = cheerChipById('dsh-voice-teacher-cheer-chip')

  // CheerChip's auto-hide uses a real 9s setTimeout; stub it so the test
  // doesn't block on a live timer (its cleanup never runs — the React stub
  // ignores useEffect's returned disposer).
  const savedSetTimeout = globalThis.setTimeout
  const savedClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = () => 0
  globalThis.clearTimeout = () => {}
  try {
    const state = { byId: { s1: { agentPreset: 'sister' } } }
    const props = {
      sessionId: 's1',
      useSessions: (sel) => sel(state),
      useProjection: () => ({ speakEnabled: true, lastSpoken: null, lastCheer: { seq: 1, text: '嗨嗨～你来啦！' } }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    }
    // Both mounted preset instances see the same active (sister) session —
    // exactly like the real page, where there's one active session and every
    // preset's plugin is mounted globally.
    sisterSpeakToggle(props)
    teacherSpeakToggle(props)

    assert.notEqual(sisterCheerChip(), null, 'sister CheerChip should show its own cheer')
    assert.equal(teacherCheerChip(), null, 'teacher CheerChip must not show a sister-session cheer')
  } finally {
    globalThis.setTimeout = savedSetTimeout
    globalThis.clearTimeout = savedClearTimeout
  }
})

test('truncateForSpeech caps text length so one long reply cannot monopolize the TTS queue', () => {
  const { moduleObj } = loadBundle()
  const { truncateForSpeech } = moduleObj._test

  const short = '嗨嗨～你来啦！'
  assert.equal(truncateForSpeech(short), short, 'text under the limit is untouched')

  // A boundary well past 40% of the window: cut there, no ellipsis.
  const withBoundary = 'A'.repeat(80) + '. ' + 'B'.repeat(80)
  const cut = truncateForSpeech(withBoundary, 100)
  assert.ok(cut.length <= 82, 'cuts at the sentence boundary, not mid-sentence')
  assert.ok(cut.endsWith('.'), 'keeps the boundary punctuation')
  assert.ok(!cut.includes('B'), 'drops everything after the boundary')

  // No boundary within the window at all: hard cut + ellipsis.
  const noBoundary = 'C'.repeat(300)
  const hardCut = truncateForSpeech(noBoundary, 100)
  assert.equal(hardCut, 'C'.repeat(100) + '…')
})

test('speakBrowser sends truncated text to the TTS endpoint for a very long reply', async () => {
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

  const longReply = '第一句话说明背景信息。'.repeat(30) // way past MAX_SPEAK_CHARS
  const calls = []
  const savedFetch = globalThis.fetch
  // Resolve (rather than hang forever) so speakBrowser's internal 5s
  // give-up timer gets cleared instead of leaking a real pending timer
  // past the end of this test.
  globalThis.fetch = (url) => { calls.push(url); return Promise.resolve({ ok: true, blob: () => Promise.resolve({ id: 'audio' }) }) }
  try {
    SpeakToggle({
      sessionId: 's1',
      useSessions: (sel) => sel({ byId: { s1: { agentPreset: 'teacher' } } }),
      useProjection: () => ({ speakEnabled: true, lastSpoken: { seq: 1, text: longReply }, lastCheer: null }),
      session: { nodes: [], chat: { order: [], nodes: {} } },
    })
    await Promise.resolve().then(() => {}).then(() => {}).then(() => {})
  } finally {
    globalThis.fetch = savedFetch
  }
  assert.equal(calls.length, 1)
  const sentText = decodeURIComponent(calls[0].match(/text=([^&]*)/)[1])
  assert.ok(sentText.length < longReply.length, 'the full reply must not be sent verbatim to TTS')
  assert.ok(sentText.length <= 151, 'sent text stays within the truncation cap (+ellipsis)')
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
