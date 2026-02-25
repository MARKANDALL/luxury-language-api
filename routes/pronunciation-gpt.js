// routes/pronunciation-gpt.js
// ONE-LINE: API route handler that generates structured pronunciation coaching (personas, chunking, optional history) using OpenAI + Azure assessment JSON.

// API route handler that generates structured pronunciation coaching (personas, chunking, optional history) using OpenAI + Azure assessment JSON.

// Phase F: Structured Output + Personas + Hybrid Models (4o Logic / Mini Translation)
// STATUS: Complete (All helpers + Chunking + Personas restored)

import { PERSONAS, DRILL_CASING_GUARDRAILS } from './pronunciation-gpt/personas.js';
import { forceJson, parseJsonWithRepair } from './pronunciation-gpt/json.js';
import {
  safeNum,
  scoreTier,
  cefrBandFromScore,
  extractOverallPronScore,
  extractPronScore,
} from './pronunciation-gpt/scoring.js';
import {
  makeNorm,
  worstPhoneme,
  worstWords,
} from './pronunciation-gpt/azureExtract.js';
import { translateMissing } from './pronunciation-gpt/translate.js';
import { computeHistorySummaryIfNeeded } from './pronunciation-gpt/historySummary.js';
import { buildCoachPrompt } from './pronunciation-gpt/prompt.js';

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

export default async function handler(req, res) {
  // 1. CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-token");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  // P0: ADMIN_TOKEN gate (cost-control for paid OpenAI calls)
  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();
  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  if (!expected || token !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // 2. Imports & Init
  let OpenAI, jsonrepair;
  try {
    const modAI = await import("openai");
    const modRepair = await import("jsonrepair");
    OpenAI = modAI.OpenAI;
    jsonrepair = modRepair.jsonrepair;
  } catch (e) {
    console.error("Import error", e);
    return res.status(500).json({ error: "Server Init Error" });
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Model selection
  const QUICK_MODEL = process.env.LUX_AI_QUICK_MODEL || "gpt-4.1-mini";  // fast, non-reasoning
  const DEEP_MODEL  = process.env.LUX_AI_DEEP_MODEL  || "gpt-4.1";       // strongest non-reasoning

  // Optional: only if you want DeepDive to sometimes use a reasoning model
  const DEEP_REASONING_MODEL  = process.env.LUX_AI_DEEP_REASONING_MODEL || "";
  const DEEP_REASONING_EFFORT = process.env.LUX_AI_DEEP_REASONING_EFFORT || "medium";

  const TRANSLATE_MODEL = process.env.LUX_AI_TRANSLATE_MODEL || "gpt-4o-mini";

  // 3. Helpers (Restored)
  const universallyHard = new Set(["θ", "ð", "ɹ"]);
  const langs = {
    es: "Spanish", fr: "French", pt: "Portuguese", zh: "Chinese",
    ja: "Japanese", ko: "Korean", ar: "Arabic", ru: "Russian",
    de: "German", hi: "Hindi", mr: "Marathi", universal: "Universal",
  };

  const norm = makeNorm();

  // 5. Main Handler
  try {
    const {
      referenceText = "",
      azureResult = {},
      firstLang = "",
      mode = "detailed",
      chunk = 1,
      persona = "tutor",

      // NEW: for speed + paging + history
      uid = "",
      attemptId = null,
      tipIndex = 0,
      tipCount = 3,
      includeHistory = undefined
    } = req.body || {};

    const langRaw = firstLang.trim().toLowerCase();
    const langCode = langRaw === "" ? "universal" : (langRaw.startsWith("zh") ? "zh" : langRaw);

    const worst = worstPhoneme(azureResult, { scoreTier, norm });
    const badList = worstWords(azureResult, { scoreTier }, 3);

    const overallScore = extractOverallPronScore(azureResult);
    const overallTier = scoreTier(overallScore);
    const overallCefr = cefrBandFromScore(overallScore);

    // History summary (only if DeepDive, chunk 1, and rule says include)
    const historySummary = await computeHistorySummaryIfNeeded(
      { safeNum, extractPronScore },
      { mode, chunk, includeHistory, attemptId, uid }
    );

    let targetSections = [];
    let systemPrompt = "";
    let model = DEEP_MODEL;
    let maxTokens = 1800;

    const selectedPersona = PERSONAS[persona] || PERSONAS.tutor;

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
    });

    targetSections = built.targetSections;
    systemPrompt = built.systemPrompt;
    maxTokens = built.maxTokens;

    if (mode === "simple") {
      model = QUICK_MODEL;
    }
    if (built.modelUpgrade) {
      model = built.modelUpgrade;
    }

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
      await translateMissing({ openai, forceJson, langs, TRANSLATE_MODEL }, finalSections, langCode);
    }

    return res.status(200).json({
      sections: finalSections,
      meta: {
        mode,
        chunk: Number(chunk) || 1,
        tipIndex: Number(tipIndex) || 0,
        tipCount: Number(tipCount) || 3,
        usedModel: model
      }
    });

  } catch (err) {
    console.error("[pronunciation-gpt] Fatal Error:", err);
    return res.status(200).json({
      fallbackSections: [{ title: "Error", en: "Could not generate feedback.", emoji: "⚠️" }]
    });
  }
}