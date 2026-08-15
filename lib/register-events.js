/**
 * dsh-voice-core/register-events — profile-boot registrar.
 *
 * Registers the shared `voice/*` event types into the harness persistence
 * catalog (`KNOWN_SESSION_EVENT_TYPES`) at profile boot, before any session
 * log is read. Consumer plugins compose this row (or import the main entry,
 * which also self-registers at module load).
 *
 *   - id: dsh-voice-registrar
 *     name: dsh-voice-core/register-events
 *
 * @module dsh-voice-core/register-events
 */
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { SPEAK_EVENT, SPOKEN_EVENT, CHEER_EVENT } from './fold.js'

export const name = 'dsh-voice-core/register-events'

export function apply() {
  for (const type of [SPEAK_EVENT, SPOKEN_EVENT, CHEER_EVENT]) {
    KNOWN_SESSION_EVENT_TYPES.add(type)
  }
}
