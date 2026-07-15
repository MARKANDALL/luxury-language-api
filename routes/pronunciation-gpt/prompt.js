// routes/pronunciation-gpt/prompt.js
// ONE-LINE: Builds coaching sections + system prompts (simple vs detailed) for the pronunciation coach.

// ── SCRUTINY (Phase 4): rigor → coach language ───────────────────────────────
// The learner's scrutiny slider must be AUDIBLE in the coach's judgment, not
// just visible in the colors: softer settings celebrate approximations and
// correct only blockers; stricter settings hold near-native precision and name
// subtle deviations — always inside the selected persona's voice. delta 0
// returns "" so the prompt stays byte-identical to today when rigor is off.
// The scores the coach sees are ALREADY remapped (Phase 3), so the directive
// explicitly forbids re-scaling them.
function scrutinyDirective(scrutinyDelta, pointsPerNotch) {
  const d = Number(scrutinyDelta);
  if (!Number.isFinite(d) || d === 0) return "";
  const n = Math.abs(d);
  const notches = `${n} ${n === 1 ? "notch" : "notches"}`;
  const pts = (n * (Number(pointsPerNotch) || 2.2)).toFixed(1);

  if (d < 0) {
    return `
SCRUTINY: The learner chose to be scored ${notches} SOFTER than this scene's default — the scoring bar is ${pts} points more forgiving, and every score you see has ALREADY been adjusted for it (do not re-judge or re-scale any number). Make your judgment match that softer bar: celebrate close approximations as wins, and correct only errors that genuinely block being understood.${n >= 3 ? " Be maximally forgiving: lead with praise, offer at most ONE gentle correction, and let subtle deviations pass without comment." : " Keep corrections light, brief, and encouraging."} Express all of this in your persona's own voice and tone.`;
  }
  return `
SCRUTINY: The learner chose to be scored ${notches} STRICTER than this scene's default — the scoring bar is ${pts} points more demanding, and every score you see has ALREADY been adjusted for it (do not re-judge or re-scale any number). Make your judgment match that stricter bar: hold the learner to near-native precision, name subtle deviations (vowel reductions, aspiration, linking, stress) even where the scores look acceptable, and do not inflate praise.${n >= 3 ? " Be maximally exacting: lead with the most important refinement and give concrete articulatory detail." : " Be noticeably more demanding than usual."} Express all of this in your persona's own voice and tone.`;
}

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
  isEs = false,
  scrutinyDelta = 0,
  pointsPerNotch = 2.2,
}) {
  // es-MX flip: when isEs, write coaching content in Spanish and address the
  // learner as "tú". Added once here so it applies to every persona/section.
  // When !isEs the prompts below are byte-identical to today's English.
  const esDirective = isEs
    ? `\nLANGUAGE: Write ALL coaching content (every "en" field value) in natural Mexican Spanish (español mexicano). Address the learner informally as "tú" (never "usted"). You are coaching Mexican Spanish pronunciation.`
    : "";
  const praiseExample = isEs ? "Buen trabajo" : "Nice work";
  const wordUnit = isEs ? "Spanish" : "EN";
  const rigor = scrutinyDirective(scrutinyDelta, pointsPerNotch);

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
${pCasing}${esDirective}${rigor}

Write exactly 2 to 4 sentences in ONE paragraph.
No bullets. No markdown. No headings.
Structure: 1 quick praise + 1 correction + 1 micro-drill.
Stay under ~75 words.

You are generating tip variant ${qIndex + 1}/${qCount} (kind: ${variantKind}).

If overallScore is present, mention it ONCE in a compact way like: "${praiseExample} (82% · B2) ..." (do not over-explain CEFR).
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
    .map((s, i) => `${i + 1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} ${wordUnit} words`)
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
${pCasing}${esDirective}${rigor}
You may receive an overallScore (0–100) with an approximate CEFR band (A1–C2).
If overallScore is present, mention it ONCE in a compact way like: "${praiseExample} (82% · B2) ..." (do not over-explain CEFR).
Do not label individual words/phonemes with CEFR; keep CEFR macro (overall only).
Return pure JSON exactly like: { "sections":[ {"title":"","titleL1":"","en":"","l1":""} ] }
Follow these ${targetSections.length} sections in order:
${ranges}
If langCode === "universal" leave "l1" blank. No markdown.
`;

  return { targetSections, systemPrompt, maxTokens, modelUpgrade, meta: { chunk: chunkIdx + 1 } };
}