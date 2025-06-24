// api/pronunciation-gpt.js
// ------------------------------------------------------------
//  Bilingual pronunciation-coach endpoint
//  – returns { sections: [...] } JSON for the front-end
// ------------------------------------------------------------

export const config = { api: { bodyParser: true, externalResolver: true } };

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- TOKEN GUARD (gpt-tokenizer) ---------- */
import { countTokens } from "gpt-tokenizer"; // tiny, pure-JS

const MODEL_LIMIT = { "gpt-4o": 8192, "gpt-4o-mini": 4096 };
function safeMax(model, prompt) {
  const used = countTokens(prompt, model);
  return Math.max(100, Math.min(900, MODEL_LIMIT[model] - used - 50));
}

/* ---------- pronunciation helpers ---------- */
const universallyHard = new Set(["θ", "ð", "ɹ"]);
const langMap = {
  es: "Spanish", fr: "French", pt: "Portuguese", zh: "Chinese",
  ja: "Japanese", ko: "Korean", ar: "Arabic",  ru: "Russian",
  de: "German",   hi: "Hindi",  mr: "Marathi",
  universal: "Universal", "": "Universal"
};
const alias = { dh: "ð", th: "θ", r: "ɹ" };
const norm  = (sym) => alias[sym] || sym;

function worstPhoneme(json) {
  const tally = {};
  json?.NBest?.[0]?.Words?.forEach(w =>
    w.Phonemes?.forEach(p => {
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
    .filter(w => w.AccuracyScore < 70)
    .sort((a, b) => a.AccuracyScore - b.AccuracyScore)
    .slice(0, n)
    .map(w => w.Word);
}

/* ---------- section spec ---------- */
const sectionMeta = [
  { emoji: "🎯", en: "Quick Coaching",   min: 80, max: 120 },
  { emoji: "🔬", en: "Phoneme Profile",  min: 70, max: 110 },
  { emoji: "🪜", en: "Common Pitfalls",  min: 80, max: 120 },
  { emoji: "⚖️", en: "Comparisons",      min: 90, max: 130 },
  { emoji: "🌍", en: "Did You Know?",    min: 80, max: 130 },
  { emoji: "🤝", en: "Reassurance",      min: 35, max: 55 }   // shortened
];

/* ============================================================ */
/*  Main handler                                                */
/* ============================================================ */
export default async function handler(req, res) {
  /* ---------- CORS ---------- */
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !==  "POST")   return res.status(405).json({ error: "Only POST allowed" });

  const { referenceText, azureResult, firstLang = "" } = req.body || {};
  const langCode = firstLang.trim().toLowerCase();
  const l1Label  = langMap[langCode] || "Universal";

  const worst     = worstPhoneme(azureResult);
  const badList   = worstWords(azureResult);
  const universal = universallyHard.has(worst);

  /* ---------- build prompts ---------- */
  const rangesStr = sectionMeta
    .map((s, i) => `${i + 1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`)
    .join("\n");

  const systemPrompt = `
You are the world's leading expert bilingual pronunciation coach.

❏ Output exactly:
{
  "sections": [
    {"title":"", "titleL1":"", "en":"", "l1":""}
  ]
}

❏ Provide exactly 6 sections, in this order:
${rangesStr}

• "title":   emoji + English title (fixed)
• "titleL1": title translated to learner's L1 (no emoji)
• "en":      English coaching (respect word limits)
• "l1":      same text translated to learner's L1 — leave blank *only* if firstLang = "Universal"

• If firstLang ≠ "Universal", EVERY "l1" string must be non-empty.
  If you cannot translate, respond with the single word ERR.

Respond in JSON format.
`.trim();

  const userPrompt = JSON.stringify({
    worstPhoneme : worst,
    worstWords   : badList,
    sampleText   : referenceText,
    universal,
    firstLang    : langCode,
    l1Label
  });

  /* ---------- ask OpenAI (retry once if L1 missing) ---------- */
  async function ask(temp) {
    const model      = "gpt-4o-mini";
    const max_tokens = safeMax(model, systemPrompt + userPrompt);
    return openai.chat.completions.create({
      model,
      temperature: temp,
      response_format: { type: "json_object" },
      max_tokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   }
      ]
    });
  }

  try {
    let completion = await ask(0.6);

    // quick retry if GPT replied with ERR
    if (completion.choices[0].message.content.trim() === "ERR") {
      completion = await ask(0.8);
    }

    /* ---------- parse & validate ---------- */
    let payload = JSON.parse(completion.choices[0].message.content);
    if (payload.sections?.data) payload.sections = payload.sections.data;
    if (!Array.isArray(payload.sections)) throw new Error("sections missing");

    if (langCode !== "universal") {
      const missing = payload.sections.find(s => !s.l1?.trim());
      if (missing) throw new Error("GPT dropped L1 text");
    }

    return res.status(200).json({ sections: payload.sections });

  } catch (err) {
    console.error("pronunciation-gpt error:", err);
    return res.status(500).json({ error: "Bad AI JSON shape." });
  }
}
