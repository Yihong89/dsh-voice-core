import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_STYLES, DEFAULT_CHEERS, pickCheer, parseTimes, timeOf, dateKey, dueTimes } from '../lib/voice.js'

test('style catalog has the four core voices with instructs', () => {
  assert.deepEqual(Object.keys(DEFAULT_STYLES).sort(), ['cute', 'genki', 'onee', 'paimon'])
  assert.match(DEFAULT_STYLES.paimon.instruct, /萝莉|卖萌|撒娇/)
  assert.match(DEFAULT_STYLES.onee.instruct, /御姐|成年的女声|清冷/)
  for (const key of Object.keys(DEFAULT_STYLES)) {
    assert.ok(DEFAULT_STYLES[key].label.length > 0)
    assert.ok(DEFAULT_STYLES[key].instruct.length > 10)
  }
})

test('cheer bank is non-empty and stable per day', () => {
  assert.ok(DEFAULT_CHEERS.length >= 15)
  const now = new Date(2026, 7, 15, 9, 0, 0)
  assert.equal(pickCheer(DEFAULT_CHEERS, now), pickCheer(DEFAULT_CHEERS, new Date(2026, 7, 15, 23, 59)))
  assert.notEqual(pickCheer(DEFAULT_CHEERS, new Date(2026, 7, 15)), pickCheer(DEFAULT_CHEERS, new Date(2026, 7, 16)))
})

test('pickCheer handles empty bank', () => {
  assert.equal(pickCheer([], new Date()), '你太棒了！继续加油！💛')
})

test('parseTimes normalizes, dedupes, and rejects bad formats', () => {
  assert.deepEqual(parseTimes(['15:00']), ['15:00'])
  assert.deepEqual(parseTimes('15:00,08:00'), ['15:00', '08:00'])
  assert.deepEqual(parseTimes('08:00 08:00'), ['08:00'])
  assert.throws(() => parseTimes(['25:00']), /invalid time/)
  assert.throws(() => parseTimes(['08:60']), /invalid time/)
  assert.throws(() => parseTimes([]), /at least one/)
})

test('timeOf / dateKey format local time', () => {
  const now = new Date(2026, 7, 15, 15, 0, 30)
  assert.equal(timeOf(now), '15:00')
  assert.equal(dateKey(now), '2026-08-15')
})

test('dueTimes fires each configured time once per day', () => {
  const at = new Date(2026, 7, 15, 15, 0, 10)
  assert.deepEqual(dueTimes(['15:00'], at, new Set()), ['15:00'])
  assert.deepEqual(dueTimes(['15:00'], at, new Set(['15:00'])), [])
  assert.deepEqual(dueTimes(['08:00'], at, new Set()), [])
})
