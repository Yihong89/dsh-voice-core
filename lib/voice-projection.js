/**
 * `voiceSpeak` session projection: folds `voice/speak`, `voice/spoken` and
 * `voice/cheer` events so the Web client can drive TTS playback through
 * `useProjection('voiceSpeak')` — auto-reading assistant replies, honoring
 * explicit speak requests, and surfacing cheers/greetings.
 */

export const VOICE_SPEAK_KEY = 'voiceSpeak'

export function initVoiceSpeakProjection() {
  return { speakEnabled: true, lastSpoken: null, lastCheer: null }
}

/**
 * Fold one committed session event. Must return the SAME reference when the
 * event is not the unit's (the projection registry's zero-work contract).
 */
export function applyVoiceSpeakProjection(state, event) {
  if (event.type === 'voice/speak') {
    return { speakEnabled: Boolean(event.data.enabled), lastSpoken: state.lastSpoken, lastCheer: state.lastCheer }
  }
  if (event.type === 'voice/spoken') {
    return {
      speakEnabled: state.speakEnabled,
      lastSpoken: {
        text: event.data.text ?? '',
        voice: event.data.voice ?? null,
        seq: event.time ?? state.lastSpoken?.seq ?? 0,
      },
      lastCheer: state.lastCheer,
    }
  }
  if (event.type === 'voice/cheer') {
    return {
      speakEnabled: state.speakEnabled,
      lastSpoken: state.lastSpoken,
      lastCheer: {
        text: event.data.text ?? '',
        at: event.data.at ?? null,
        seq: event.time ?? state.lastCheer?.seq ?? 0,
      },
    }
  }
  return state
}

/** State → wire payload (read-side projection; schema-validated by the host). */
export function viewVoiceSpeakProjection(state) {
  return state
}

/** Bind the fold to a schema and return a ProjectionDefinition. */
export function voiceSpeakProjectionWith(schema) {
  return {
    key: VOICE_SPEAK_KEY,
    schema,
    init: initVoiceSpeakProjection,
    apply: applyVoiceSpeakProjection,
    view: viewVoiceSpeakProjection,
    stateVersion: 1,
  }
}
