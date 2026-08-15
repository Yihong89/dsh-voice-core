import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  voiceSpeakProjectionWith, VOICE_SPEAK_KEY,
  initVoiceSpeakProjection, applyVoiceSpeakProjection,
} from '../lib/voice-projection.js'

test('projection key and version are stable', () => {
  const def = voiceSpeakProjectionWith({})
  assert.equal(def.key, VOICE_SPEAK_KEY)
  assert.equal(def.stateVersion, 1)
  assert.equal(typeof def.init, 'function')
  assert.equal(typeof def.apply, 'function')
  assert.equal(typeof def.view, 'function')
})

test('init has speak on and nothing spoken', () => {
  assert.deepEqual(initVoiceSpeakProjection(), { speakEnabled: true, lastSpoken: null, lastCheer: null })
})

test('apply folds speak toggle, spoken, and cheer', () => {
  let s = initVoiceSpeakProjection()
  s = applyVoiceSpeakProjection(s, { type: 'voice/speak', data: { enabled: false } })
  assert.equal(s.speakEnabled, false)
  s = applyVoiceSpeakProjection(s, { type: 'voice/spoken', time: 7, data: { text: 'hi', voice: null } })
  assert.deepEqual(s.lastSpoken, { text: 'hi', voice: null, seq: 7 })
  assert.equal(s.speakEnabled, false, 'toggle state survives')
  s = applyVoiceSpeakProjection(s, { type: 'voice/cheer', time: 9, data: { text: 'go!', at: 123 } })
  assert.deepEqual(s.lastCheer, { text: 'go!', at: 123, seq: 9 })
  assert.equal(s.speakEnabled, false)
})

test('apply returns the same reference for unrelated events', () => {
  const s = initVoiceSpeakProjection()
  const next = applyVoiceSpeakProjection(s, { type: 'user/message', data: {} })
  assert.equal(next, s)
})

test('view is identity', () => {
  const s = initVoiceSpeakProjection()
  assert.equal(voiceSpeakProjectionWith({}).view(s), s)
})
