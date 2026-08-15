/**
 * Shared voice-event folding for dsh-voice-core.
 *
 * Unified session event types used by every voice-enabled companion:
 *
 * - `voice/speak`   { enabled: boolean }   — TTS toggle
 * - `voice/spoken`  { text, voice }        — a speak request
 * - `voice/cheer`   { text, at }           — a cheer/greeting fired
 */

export const SPEAK_EVENT = 'voice/speak'
export const SPOKEN_EVENT = 'voice/spoken'
export const CHEER_EVENT = 'voice/cheer'

/**
 * Fold voice state from a session log (or a prefix of it).
 * @returns {{ speakEnabled: boolean, lastSpoken: object|null, lastCheer: object|null }}
 */
export function foldVoiceState(events, end = events.length) {
  let speakEnabled = true
  let lastSpoken = null
  let lastCheer = null
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index++
    if (event.type === SPEAK_EVENT) {
      speakEnabled = Boolean(event.data.enabled)
    } else if (event.type === SPOKEN_EVENT) {
      lastSpoken = {
        text: event.data.text ?? '',
        voice: event.data.voice ?? null,
        seq: event.time ?? index,
      }
    } else if (event.type === CHEER_EVENT) {
      lastCheer = {
        text: event.data.text ?? '',
        at: event.data.at ?? null,
        seq: event.time ?? index,
      }
    }
  }
  return { speakEnabled, lastSpoken, lastCheer }
}

/** Whether the log holds an opened turn without its closing `turn/end`. */
export function hasOpenTurn(events) {
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}
