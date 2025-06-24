// api/pronunciation-gpt.js
export const config = { api: { bodyParser: true, externalResolver: true } };

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ------------------------------------------------------------------
   TOKEN GUARD  ➜  counts prompt tokens & returns a safe max_tokens
------------------------------------------------------------------- */
import { encoding_for_model } from "tiktoken";
const encoders = {
  "gpt-4o": encoding_for_model("gpt-4o"),
  "gpt-4o-mini": encoding_for_model("gpt-4o-mini"),
};
const MODEL_LIMIT = { "gpt-4o": 8192, "gpt-4o-mini": 4096 };

function safeMax(model, prompt) {
  const used = encoders[model].encode(prompt).length;
  return Math.max(100, Math.min(900, MODEL_LIMIT[model] - used - 50)); // 50-token buffer
}

/* ------------------------------------------------------------------
   CONSTANTS & HELPERS
------------------------------------------------------------------- */
const MODEL_EN = process.env.OPENAI_MODEL_EN || "gpt-4o";
const MODEL_L1 = process.env.OPENAI_MODEL_L1 || "gpt-4o-mini";

const universallyHard = new Set(["θ", "ð", "ɹ"]);
const langMap = {
  es: "Spanish",
  fr: "French",
  pt: "Portuguese",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ar: "Arabic",
  ru: "Russian",
  de: "German",
  hi: "Hindi",
  mr: "Marathi",
  universal: "Universal",
  "": "Universal",
};
const alias = { dh: "ð", th: "θ", r: "ɹ" };
const norm = (s) => alias[s] || s;

/* ---------- Azure helpers ---------- */
function worstPhoneme(json) {
  const tally = {};
  json?.NBest?.[0]?.Words?.forEach((w) =>
    w.Phonemes?.forEach((p) => {
      if (p.AccuracyScore < 85) {
        const k = norm(p.Phoneme);
        tally[k] = (tally[k] || 0) + 1;
      }
    })
  );
  return Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}
function worstWords(json, n = 3) {
  return (json?.NBest?.[0]?.Words || [])
    .filter((w) => w.AccuracyScore < 70)
    .sort((a, b) => a.AccuracyScore - b.AccuracyScore)
    .slice(0, n)
    .map((w) => w.Word);
}

/* ---------- Section blueprint ---------- */
const sectionMeta = [
  { emoji: "🎯", en: "Quick Coaching", min: 80, max: 120 },
  { emoji: "🔬", en: "Phoneme Profile", min: 70, max: 110 },
  { emoji: "🪜", en: "Common Pitfalls", min: 80, max: 120 },
  { emoji: "⚖️", en: "Comparisons", min: 90, max: 130 },
  { emoji: "🌍", en: "Did You Know?", min: 80, max: 130 },
  { emoji: "🤝", en: "Reassurance", min: 60, max: 100 },
];

/* ==================================================================
   MAIN HANDLER
================================================================== */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Only POST allowed" });

  try {
    /* ------------ INPUTS ------------ */
    const { referenceText, azureResult, firstLang = "" } = req.body;
    const targetLangCode = firstLang.trim().toLowerCase();
    const l1Label = langMap[targetLangCode] || "Universal";

    /* ------------ QUICK ANALYSIS from Azure ------------ */
    const worst = worstPhoneme(azureResult);
    const badList = worstWords(azureResult);
    const universal = universallyHard.has(worst);

    const rangesStr = sectionMeta
      .map((s, i) => `${i + 1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`)
      .join("\n");

    /* ------------ SYSTEM PROMPT ------------ */
    const systemPrompt = `
You are the world's leading expert bilingual pronunciation coach.

❏ Output exactly:
{
  "sections":[{"title":"","titleL1":"","en":"","l1":""},...]
}

❏ Provide exactly 6 sections, in this order:
${rangesStr}

• "title": emoji + English title above (fixed)
• "titleL1": Title translated to learner's L1 (no emoji)
• "en": English coaching (respect word limits above, be rich & specific, never generic)
• "l1": Same text translated to learner's L1. Leave blank if firstLang = "Universal".

Respond in pure JSON (no markdown, no HTML).
`.trim();

    const userObj = {
      worstPhoneme: worst,
      worstWords: badList,
      sampleText: referenceText,
      universal,
      firstLang: targetLangCode,
      l1Label,
    };

    /* ================================================================
       1) ENGLISH-ONLY ANALYSIS  (GPT-4o)
    ================================================================ */
    const completionEn = await openai.chat.completions.create({
      model: MODEL_EN,
      temperature: 0.6,
      max_tokens: safeMax(MODEL_EN, systemPrompt + JSON.stringify(userObj)),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userObj) },
      ],
    });

    let payload = JSON.parse(completionEn.choices[0].message.content);

    // GPT sometimes wraps in {sections:{data:[…]}}
    if (payload.sections?.data) payload.sections = payload.sections.data;
    if (!Array.isArray(payload.sections))
      throw new Error("Invalid GPT JSON shape (EN).");

    /* ================================================================
       2) OPTIONAL TRANSLATION (GPT-4o-mini)
    ================================================================ */
    if (targetLangCode && targetLangCode !== "universal") {
      const completionL1 = await openai.chat.completions.create({
        model: MODEL_L1,
        temperature: 0.4,
        max_tokens: safeMax(MODEL_L1, JSON.stringify(payload)),
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `
You are a professional translator. Keep the JSON identical.
Copy every "title"; write a natural ${l1Label} version in "titleL1".
Translate each "en" into "l1".`,
          },
          { role: "user", content: JSON.stringify(payload) },
        ],
      });

      payload = JSON.parse(completionL1.choices[0].message.content);
      if (payload.sections?.data) payload.sections = payload.sections.data;
      if (!Array.isArray(payload.sections))
        throw new Error("Invalid GPT JSON shape (L1).");
    }

    return res.status(200).json({ sections: payload.sections });
  } catch (err) {
    /* -------- Fail-soft on length overflow -------- */
    if (err?.error?.code === "context_length_exceeded") {
      return res.status(200).json({
        sections: [
          {
            title: "⚠️ System",
            titleL1: "",
            en: "Your passage was too long for detailed analysis. Please try a shorter one.",
            l1: "",
          },
        ],
      });
    }

    console.error("pronunciation-gpt error:", err);
    return res.status(500).json({ error: "AI feedback failed." });
  }
}
