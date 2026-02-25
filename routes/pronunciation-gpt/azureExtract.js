// routes/pronunciation-gpt/azureExtract.js
// ONE-LINE: Azure pronunciation assessment extraction helpers (worst phoneme + worst words) for coaching prompts.

export function makeNorm() {
  return (s) => (({ dh: "ð", th: "θ", r: "ɹ" })[s] || s);
}

export function worstPhoneme(json, { scoreTier, norm }) {
  const tally = {};
  json?.NBest?.[0]?.Words?.forEach((w) =>
    w.Phonemes?.forEach((p) => {
      if (p.AccuracyScore != null && scoreTier(p.AccuracyScore) !== "good") {
        const k = norm(p.Phoneme);
        tally[k] = (tally[k] || 0) + 1;
      }
    })
  );
  return Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

export function worstWords(json, { scoreTier }, n = 3) {
  return (json?.NBest?.[0]?.Words || [])
    .filter((w) => scoreTier(w.AccuracyScore) !== "good")
    .sort((a, b) => a.AccuracyScore - b.AccuracyScore)
    .slice(0, n)
    .map((w) => w.Word);
}