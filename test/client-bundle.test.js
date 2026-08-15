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
    useState: (init) => [init, () => {}],
    useEffect: (fn) => { fn() },
    useRef: (init) => ({ current: init }),
  }
  globalThis.window = {
    __ModuleLoader__: { load: (def) => { captured = def } },
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
  assert.deepEqual(overlays, ['dsh-voice-sister-cheer-chip', 'dsh-voice-sister-style-picker'])
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
