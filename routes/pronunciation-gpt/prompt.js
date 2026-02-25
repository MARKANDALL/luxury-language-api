// routes/pronunciation-gpt/prompt.js
// ONE-LINE: Builds coaching sections + system prompts (simple vs detailed) for the pronunciation coach.

export function buildCoachPrompt({
  mode,
  chunk,
  persona,
  tipIndex,
  tipCount,
  selectedPersona,
  DRILL_CASING_GUARDRAILS,
  DEEP_REASONING_MODEL,
  DEEP_REASONING_EFFORT,
  historySummary,
}) {
  const ALL_SECTIONS = [
    { emoji: "🎯", en: "Quick Coaching", min: 80, max: 120 },
    { emoji: "🔬", en: "Phoneme Profile", min: 70, max: 110 },
    { emoji: "🪜", en: "Common Pitfalls", min: 80, max: 120 },
    { emoji: "⚖️", en: "Comparisons", min: 90, max: 130 },
    { emoji: "🌍", en: "Did You Know?", min: 80, max: 130 },
    { emoji: "🤝", en: "Reassurance", min: 40, max: 70 },
  ];

  const pCasing = persona === "drill" ? DRILL_CASING_GUARDRAILS : "";

  // Defaults (caller can override model/maxTokens)
  let modelUpgrade = null;
  let maxTokens = mode === "simple" ? 220 : 1000;

  let targetSections = [];
  let systemPrompt = "";

  if (mode === "simple") {
    const qCount = Math.max(2, Math.min(6, Number(tipCount) || 3));
    const qIndex = Math.max(0, Math.min(qCount - 1, Number(tipIndex) || 0));
    const variantKind = ["phoneme", "words", "prosody"][qIndex % 3];

    targetSections = [{ title: "QuickTip", en: "string", emoji: "⚡" }];

    systemPrompt = `
${selectedPersona.role}
Tone: ${selectedPersona.style}
${pCasing}

Write exactly 2 to 4 sentences in ONE paragraph.
No bullets. No markdown. No headings.
Structure: 1 quick praise + 1 correction + 1 micro-drill.
Stay under ~75 words.

You are generating tip variant ${qIndex + 1}/${qCount} (kind: ${variantKind}).

If overallScore is present, mention it ONCE in a compact way like: "Nice work (82% · B2) ..." (do not over-explain CEFR).
Do not label individual words/phonemes with CEFR; keep CEFR macro (overall only).

Return pure JSON ONLY:
{
  "sections":[{"title":"QuickTip","en":"string","emoji":"⚡"}],
  "meta":{"tipIndex":${qIndex},"tipCount":${qCount},"variantKind":"${variantKind}"}
}
`;
    return { targetSections, systemPrompt, maxTokens, modelUpgrade, meta: { tipIndex: qIndex, tipCount: qCount, variantKind } };
  }

  // DETAILED MODE: chunked (2 sections per chunk)
  const chunkIdx = Math.max(1, Math.min(3, Number(chunk) || 1)) - 1;
  const start = chunkIdx * 2;
  const end = start + 2;
  targetSections = ALL_SECTIONS.slice(start, end);

  const ranges = targetSections
    .map((s, i) => `${i + 1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`)
    .join("\n");

  if (DEEP_REASONING_MODEL && String(DEEP_REASONING_MODEL).trim()) {
    const worthIt = (Number(chunk) || 1) >= 2 || !!historySummary;
    if (worthIt) {
      modelUpgrade = String(DEEP_REASONING_MODEL).trim();
      console.log(`[AI Coach] DeepDive upgraded to reasoning model (effort=${DEEP_REASONING_EFFORT})`);
    }
  }

  systemPrompt = `
${selectedPersona.role}
Tone: ${selectedPersona.style}
${pCasing}
You may receive an overallScore (0–100) with an approximate CEFR band (A1–C2).
If overallScore is present, mention it ONCE in a compact way like: "Nice work (82% · B2) ..." (do not over-explain CEFR).
Do not label individual words/phonemes with CEFR; keep CEFR macro (overall only).
Return pure JSON exactly like: { "sections":[ {"title":"","titleL1":"","en":"","l1":""} ] }
Follow these ${targetSections.length} sections in order:
${ranges}
If langCode === "universal" leave "l1" blank. No markdown.
`;

  return { targetSections, systemPrompt, maxTokens, modelUpgrade, meta: { chunk: chunkIdx + 1 } };
}