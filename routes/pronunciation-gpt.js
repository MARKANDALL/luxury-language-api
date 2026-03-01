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
import { runPronunciationCoach } from './pronunciation-gpt/runCoach.js';

export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

export default async function handler(req, res) {
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

  try {
    const result = await runPronunciationCoach({
      openai,
      jsonrepair,

      QUICK_MODEL,
      DEEP_MODEL,
      DEEP_REASONING_MODEL,
      DEEP_REASONING_EFFORT,
      TRANSLATE_MODEL,

      PERSONAS,
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
    }, req.body || {});

    return res.status(200).json(result);
  } catch (err) {
    console.error("[pronunciation-gpt] Fatal Error:", err);
    return res.status(200).json({
      fallbackSections: [{ title: "Error", en: "Could not generate feedback.", emoji: "⚠️" }]
    });
  }
}