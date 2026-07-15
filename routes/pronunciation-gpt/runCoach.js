// routes/pronunciation-gpt/runCoach.js
// ONE-LINE: Runs the pronunciation coach flow (extract → history → prompt → OpenAI → parse → translate → shape response).

export async function runPronunciationCoach({
  openai,
  jsonrepair,

  // models/config
  QUICK_MODEL,
  DEEP_MODEL,
  DEEP_REASONING_MODEL,
  DEEP_REASONING_EFFORT,
  TRANSLATE_MODEL,

  // shared helpers/modules
  PERSONAS,
  PERSONAS_ES,
  DRILL_CASING_GUARDRAILS,
  forceJson,
  parseJsonWithRepair,

  safeNum,
  scoreTier,
  cefrBandFromScore,
  extractOverallPronScore,
  extractOverallPronScoreRaw,
  extractPronScore,
  adjustAzureResultForScrutiny,
  getScrutinyInfo,
  normalizeScrutinyDelta,
  POINTS_PER_NOTCH = 2.2,

  makeNorm,
  worstPhoneme,
  worstWords,

  translateMissing,
  computeHistorySummaryIfNeeded,
  buildCoachPrompt,
}, reqBody) {
  const {
    referenceText = "",
    azureResult = {},
    firstLang = "",
    mode = "detailed",
    chunk = 1,
    persona = "tutor",

    pack = "",

    uid = "",
    attemptId = null,
    tipIndex = 0,
    tipCount = 3,
    includeHistory = undefined,
    scrutinyDelta = 0
  } = reqBody || {};

  // ── SCRUTINY REMAP (Phase 3 mirror) ──
  // The frontend's display-adjusted results arrive tagged (__scrutiny) and are
  // used as-is — never double-applied. Untagged (raw) input is remapped here by
  // the request's scrutinyDelta so coach-side tiering (worst words/phonemes,
  // overall tier/CEFR) always agrees with what the learner's UI shows.
  // effectiveScrutinyDelta is the rigor actually in force (Phase 4 feeds it to
  // the coach prompt).
  const preTag = getScrutinyInfo(azureResult);
  const effectiveScrutinyDelta = preTag
    ? normalizeScrutinyDelta(preTag.delta)
    : normalizeScrutinyDelta(scrutinyDelta);
  const azureScored = preTag
    ? azureResult
    : adjustAzureResultForScrutiny(azureResult, effectiveScrutinyDelta);

  // es-MX flip: when pack==="es" the coach coaches Mexican Spanish pronunciation
  // in Spanish. Absent / !== "es" → English, byte-identical to today.
  const isEs = String(pack).trim().toLowerCase() === "es";

  // "Universally hard" phonemes toggle a reassurance flag for the coach. English
  // set is th/th/r; for Spanish learners the notoriously hard ones are the trill
  // /r/, the tap /ɾ/, and the jota /x/ — all phonemic in Mexican Spanish. (/ʎ/ is
  // excluded: yeísmo means it is not phonemic in es-MX, so Azure never returns it.)
  const universallyHard = isEs
    ? new Set(["r", "ɾ", "x"])
    : new Set(["θ", "ð", "ɹ"]);
  const langs = {
    es: "Spanish", fr: "French", pt: "Portuguese", zh: "Chinese",
    ja: "Japanese", ko: "Korean", ar: "Arabic", ru: "Russian",
    de: "German", hi: "Hindi", mr: "Marathi", universal: "Universal",
  };

  const langRaw = firstLang.trim().toLowerCase();
  const langCode = langRaw === "" ? "universal" : (langRaw.startsWith("zh") ? "zh" : langRaw);

  const norm = makeNorm();

  const worst = worstPhoneme(azureScored, { scoreTier, norm });
  const badList = worstWords(azureScored, { scoreTier }, 3);

  const overallScore = extractOverallPronScore(azureScored);
  const overallTier = scoreTier(overallScore);
  // CONGRUENCY: the CEFR band is a claim about the LEARNER, not the session —
  // it always derives from the RAW score (the *Raw sibling on adjusted views;
  // extractOverallPronScoreRaw falls back to the plain field on raw input).
  // overallScore/overallTier stay adjusted: colors and the coach's judgment
  // react to scrutiny; the band does not. Mirrors the frontend's fmtPctCefr
  // raw-band rule.
  const overallCefr = cefrBandFromScore(
    (extractOverallPronScoreRaw ? extractOverallPronScoreRaw(azureScored) : null) ?? overallScore
  );

  const historySummary = await computeHistorySummaryIfNeeded(
    { safeNum, extractPronScore },
    { mode, chunk, includeHistory, attemptId, uid }
  );

  let model = DEEP_MODEL;

  const personaSet = isEs ? (PERSONAS_ES || PERSONAS) : PERSONAS;
  const selectedPersona = personaSet[persona] || personaSet.tutor;

  const built = buildCoachPrompt({
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
    isEs,
    // Phase 4: rigor → the coach's strictness of language (0 = byte-identical
    // prompt to pre-scrutiny behavior).
    scrutinyDelta: effectiveScrutinyDelta,
    pointsPerNotch: POINTS_PER_NOTCH,
  });

  const targetSections = built.targetSections;
  const systemPrompt = built.systemPrompt;
  const maxTokens = built.maxTokens;

  if (mode === "simple") model = QUICK_MODEL;
  if (built.modelUpgrade) model = built.modelUpgrade;

  const userPrompt = JSON.stringify({
    worstPhoneme: worst,
    worstWords: badList,
    sampleText: referenceText,
    universal: universallyHard.has(worst),
    langCode,

    // All score fields below come from azureScored — ADJUSTED for rigor.
    // (history is a summary of PAST attempts and is raw-derived by design;
    // it is context, not this attempt's judgment.)
    overallScore,
    overallTier,
    overallCefr,

    // Phase 4: the effective rigor, so the coach can reference it naturally.
    scrutiny: effectiveScrutinyDelta !== 0
      ? {
          notches: effectiveScrutinyDelta,
          direction: effectiveScrutinyDelta > 0 ? "stricter" : "softer",
          pointsShift: +(Math.abs(effectiveScrutinyDelta) * POINTS_PER_NOTCH).toFixed(1),
        }
      : undefined,

    history: historySummary || undefined,
  });

  const draft = await openai.chat.completions.create({
    model,
    temperature: 0.6,
    response_format: { type: "json_object" },
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  let gptRaw = draft.choices[0].message.content || "";
  let data;

  try {
    data = forceJson(gptRaw);
  } catch (e1) {
    data = parseJsonWithRepair(gptRaw, jsonrepair);
  }

  const finalSections = Array.isArray(data.sections) ? data.sections : [];

  while (finalSections.length < targetSections.length) {
    finalSections.push({ title: "Note", en: "Additional feedback unavailable.", emoji: "📝" });
  }

  if (mode !== "simple") {
    await translateMissing({ openai, forceJson, langs, TRANSLATE_MODEL, isEs }, finalSections, langCode);
  }

  return {
    sections: finalSections,
    meta: {
      mode,
      chunk: Number(chunk) || 1,
      tipIndex: Number(tipIndex) || 0,
      tipCount: Number(tipCount) || 3,
      usedModel: model,
      // Rigor actually applied to the scores the coach reasoned about
      // (Phase 4 will also feed this into the prompt's strictness language).
      scrutinyDelta: effectiveScrutinyDelta
    }
  };
}