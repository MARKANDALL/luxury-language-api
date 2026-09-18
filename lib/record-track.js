// lib/record-track.js
// The record track: what the learner actually said, alongside the score.
//
// THE PROBLEM IT SOLVES. Every /api/assess call sends a ReferenceText
// (routes/assess.js:64 rejects the request without one), so Azure always runs
// SCRIPTED mode, which ALIGNS against that script rather than transcribing.
// Off-script speech and fillers come back as phantom words tagged
// ErrorType 'Insertion', and the recognized text is the script, not the
// speech. On a passage or a suggestion-chip turn there is no record anywhere
// of what was really said.
//
// THE FIX IS THE PRO-DICTATE PATTERN, GENERALIZED. The pro-dictate control
// already does this right: it runs plain Azure STT first
// (features/convo/convo-compose-upgrades.js:740 -> routes/dictate.js), then
// assesses against what Azure heard, so fillers arrive as real tokens. This
// module runs that same STT on the same audio buffer as the scripted
// assessment, in parallel, inside the same request, so every turn gets the
// same unconstrained record.
//
// WHAT IS DIFFERENT FROM routes/dictate.js. One query parameter:
// wordLevelTimestamps=true. Without it Azure returns no Words[] at all, so a
// record built from the dictate route alone could carry text but never
// timings. dictate.js itself is deliberately NOT changed: it has a shipped
// response contract ({ text, status }) and a live caller.
//
// FAILURE IS NEVER FATAL. The scripted assessment is the product; the record
// is an addition to it. Every failure path here returns null, and the caller
// simply omits the record rather than failing the attempt.

const STT_TIMEOUT_MS = 10000;

// Read at call time rather than at import time so a test can flip it and so
// the value is never baked into a warm serverless instance at deploy.
export function recordTrackEnabled() {
  return String(process.env.LUX_RECORD_TRACK || "").trim().toLowerCase() === "true";
}

// Number(null) is 0, so a plain isFinite check would turn an absent confidence
// or offset into a real zero. A genuine 0 survives; absent stays null.
function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Trim Azure's detailed STT response to what a transcript needs. Words[] is
// present only when wordLevelTimestamps was requested AND Azure chose to
// return it, so an empty list is normal, not an error: the contract is
// "words if there are word timings, otherwise the text fields alone".
function trimSttResult(json) {
  const nb = json?.NBest?.[0] || {};
  const words = Array.isArray(nb?.Words) ? nb.Words : [];

  return {
    source: "stt",
    display:
      (typeof nb?.Display === "string" && nb.Display) ||
      (typeof json?.DisplayText === "string" ? json.DisplayText : null),
    lexical: typeof nb?.Lexical === "string" ? nb.Lexical : null,
    confidence: numOrNull(nb?.Confidence),
    words: words.map((w) => ({
      word: String(w?.Word ?? ""),
      offset: numOrNull(w?.Offset),
      duration: numOrNull(w?.Duration),
    })),
  };
}

// The record a pro-dictate turn already has in hand. The frontend transcribed
// this clip through /api/dictate before it ever called assess, so running STT
// again would be a second Azure call for an answer we were already given.
// /api/dictate returns the transcript only, so this record carries the text
// fields and no timings.
export function recordFromDictate(text) {
  const display = typeof text === "string" ? text.trim() : "";
  if (!display) return null;
  return { source: "dictate", display, lexical: null, confidence: null, words: [] };
}

/**
 * Plain Azure speech-to-text over an already-decoded 16 kHz mono WAV buffer.
 * Returns the trimmed record, or null on any failure.
 */
export async function runRecordTrack({ audioBuffer, language, region, key }) {
  if (!audioBuffer || !key) return null;

  const endpoint =
    `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
    `?language=${language}&format=detailed&wordLevelTimestamps=true`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
        Accept: "application/json",
      },
      body: audioBuffer,
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn("[record-track] Azure STT returned", res.status);
      return null;
    }

    const json = await res.json();
    // Silence recognizes as Success with no text, and NoMatch is a normal
    // outcome. Both mean there is no record to store, not that anything broke.
    if (!json || (json.RecognitionStatus && json.RecognitionStatus !== "Success")) return null;

    const record = trimSttResult(json);
    return record.display ? record : null;
  } catch (err) {
    console.warn("[record-track] STT failed:", String(err?.message || err));
    return null;
  }
}
