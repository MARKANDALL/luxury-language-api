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
  extractPronScore,

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
    includeHistory = undefined
  } = reqBody || {};

  // es-MX flip: when pack==="es" the coach coaches Mexican Spanish pronunciation
  // in Spanish. Absent / !== "es" → English, byte-identical to today.
  const isEs = String(pack).trim().toLowerCase() === "es";

  // "Universally hard" phonemes toggle a reassurance flag for the coach. English
  // set is th/th/r; Spanish learners struggle with the trill/tap and jota family.
  const universallyHard = isEs
    ? new Set(["r", "ɾ", "x", "ʎ", "ɲ"])
    : new Set(["θ", "ð", "ɹ"]);
  const langs = {
    es: "Spanish", fr: "French", pt: "Portuguese", zh: "Chinese",
    ja: "Japanese", ko: "Korean", ar: "Arabic", ru: "Russian",
    de: "German", hi: "Hindi", mr: "Marathi", universal: "Universal",
  };

  const langRaw = firstLang.trim().toLowerCase();
  const langCode = langRaw === "" ? "universal" : (langRaw.startsWith("zh") ? "zh" : langRaw);

  const norm = makeNorm();

  const worst = worstPhoneme(azureResult, { scoreTier, norm });
  const badList = worstWords(azureResult, { scoreTier }, 3);

  const overallScore = extractOverallPronScore(azureResult);
  const overallTier = scoreTier(overallScore);
  const overallCefr = cefrBandFromScore(overallScore);

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

    overallScore,
    overallTier,
    overallCefr,

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
      usedModel: model
    }
  };
}