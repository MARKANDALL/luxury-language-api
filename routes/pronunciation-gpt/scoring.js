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

export function extractOverallPronScore(azureResult) {
  const pa =
    azureResult?.NBest?.[0]?.PronunciationAssessment ||
    azureResult?.PronunciationAssessment ||
    null;
  if (!pa) return null;
  return safeNum(pa.PronunciationScore);
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