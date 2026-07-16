// routes/pronunciation-gpt/scoring.js
// ONE-LINE: Numeric safety + score tiering + CEFR mapping + Azure score extraction helpers for pronunciation-gpt.

export function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Canonical tiering (keep consistent with frontend: 80/60)
export function scoreTier(score) {
  const s = safeNum(score);
  if (s == null) return "unknown";
  if (s >= 80) return "good";
  if (s >= 60) return "warn";
  return "bad";
}

// Keep this mapping aligned with frontend core/scoring/index.js (display-only).
export function cefrBandFromScore(score) {
  const s = safeNum(score);
  if (s == null) return "";
  if (s >= 95) return "C2";
  if (s >= 90) return "C1";
  if (s >= 85) return "B2";
  if (s >= 75) return "B1";
  if (s >= 60) return "A2";
  return "A1";
}

/* ============================================================================
   SCRUTINY REMAP — backend mirror (Phase 3)
   ---------------------------------------------------------------------------
   ⚠️ TWIN FILE: core/scoring/scrutiny.js in lux-frontend is the other half of
   this mirror. POINTS_PER_NOTCH, the clamp(round(raw − delta × 2.2), 0, 100)
   formula (rounding included — it is load-bearing for tier parity with the
   signed-off prototype), and the __scrutiny tag semantics MUST stay identical
   in both files, or coach-side tiering will disagree with the UI. Change them
   in the same PR only.

   The frontend sends display-adjusted results tagged with __scrutiny; raw
   results (e.g. attempts loaded from storage) are untagged. Adjust untagged
   input by the request's scrutinyDelta; never double-apply to tagged input.
============================================================================ */

export const POINTS_PER_NOTCH = 2.2;

// The scrutiny slider spans 18 notches (0..17): |delta| can never exceed 17.
const MAX_SCRUTINY_DELTA = 17;

const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function normalizeScrutinyDelta(delta) {
  const d = Number(delta);
  if (!Number.isFinite(d)) return 0;
  return clampNum(d, -MAX_SCRUTINY_DELTA, MAX_SCRUTINY_DELTA);
}

// adjusted = clamp(round(raw − delta × 2.2), 0, 100); null-safe.
export function applyScrutiny(raw, delta) {
  const r = Number(raw);
  if (raw == null || !Number.isFinite(r)) return null;
  const d = normalizeScrutinyDelta(delta);
  if (d === 0) return r;
  return clampNum(Math.round(r - d * POINTS_PER_NOTCH), 0, 100);
}

export function getScrutinyInfo(azureResult) {
  const tag = azureResult?.__scrutiny;
  return tag && typeof tag === "object" ? tag : null;
}

// Adjust a score field in place (on the clone), keeping the original beside it
// as `<Field>Raw` — CEFR bands always derive from the raw sibling (the band is
// a claim about the learner, not the session). Twin of the frontend adj().
function adjField(obj, key, d) {
  if (!obj || obj[key] == null) return;
  const v = applyScrutiny(obj[key], d);
  if (v != null) {
    obj[key + "Raw"] = obj[key];
    obj[key] = v;
  }
}

// Only pronunciation-ACCURACY scores shift; Fluency/Completeness/Prosody/
// ContentAssessment are delivery/content metrics and stay raw.
function adjustPronScores(node, d) {
  if (!node || typeof node !== "object") return;
  adjField(node, "AccuracyScore", d);
  adjField(node, "PronScore", d);
  const pa = node.PronunciationAssessment;
  if (pa && typeof pa === "object") {
    adjField(pa, "AccuracyScore", d);
    adjField(pa, "PronScore", d);
    adjField(pa, "PronunciationScore", d);
  }
}

// Deep-copy remap of a RAW Azure result (overall + words + syllables +
// phonemes), tagged __scrutiny. Identity on delta 0 / already-tagged input.
// Never mutates its input: PERSIST RAW; DERIVE ADJUSTED.
export function adjustAzureResultForScrutiny(azureResult, delta) {
  if (!azureResult || typeof azureResult !== "object") return azureResult;
  const d = normalizeScrutinyDelta(delta);
  if (d === 0) return azureResult;
  if (getScrutinyInfo(azureResult)) return azureResult;

  const copy = structuredClone(azureResult);

  adjustPronScores(copy, d);
  for (const nbest of copy.NBest || []) {
    adjustPronScores(nbest, d);
    for (const w of nbest?.Words || []) {
      adjustPronScores(w, d);
      for (const syl of w?.Syllables || []) adjustPronScores(syl, d);
      for (const ph of w?.Phonemes || []) adjustPronScores(ph, d);
    }
  }

  copy.__scrutiny = { delta: d, pointsPerNotch: POINTS_PER_NOTCH };
  return copy;
}

export function extractOverallPronScore(azureResult) {
  const pa =
    azureResult?.NBest?.[0]?.PronunciationAssessment ||
    azureResult?.PronunciationAssessment ||
    null;
  if (!pa) return null;
  return safeNum(pa.PronunciationScore);
}

// RAW overall pronunciation score of a possibly scrutiny-adjusted result:
// prefers the `PronunciationScoreRaw` sibling the remap records, falls back to
// the plain field (raw/untagged/delta-0 results ARE raw). CEFR bands must
// always derive from this, never from the adjusted value.
export function extractOverallPronScoreRaw(azureResult) {
  const pa =
    azureResult?.NBest?.[0]?.PronunciationAssessment ||
    azureResult?.PronunciationAssessment ||
    null;
  if (!pa) return null;
  return safeNum(pa.PronunciationScoreRaw) ?? safeNum(pa.PronunciationScore);
}

export function extractPronScore(summary) {
  if (!summary || typeof summary !== "object") return null;
  // tolerant: support a few likely shapes
  const direct =
    safeNum(summary.pron) ??
    safeNum(summary.pronunciation) ??
    safeNum(summary.pronScore) ??
    safeNum(summary.PronunciationScore);

  if (direct != null) return direct;

  const scores = summary.scores && typeof summary.scores === "object" ? summary.scores : null;
  if (scores) {
    return safeNum(scores.pron) ?? safeNum(scores.pronunciation) ?? safeNum(scores.pronScore) ?? null;
  }
  return null;
}