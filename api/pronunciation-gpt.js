// /api/pronunciation-gpt.js
// -------------------------------------------------
export const config = { api: { bodyParser: true, externalResolver: true } };

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ----------- Utilities -------------- */
const universallyHard = new Set(["θ", "ð", "ɹ"]);

const langMap = {
  es: "Spanish", fr: "French", pt: "Portuguese", zh: "Chinese",
  ja: "Japanese", ko: "Korean", ar: "Arabic", ru: "Russian",
  de: "German", hi: "Hindi", mr: "Marathi",
  universal: "Universal", "": "Universal"
};

const alias = { dh: "ð", th: "θ", r: "ɹ" };
const norm  = (sym) => alias[sym] || sym;

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

/* ----------- Section Metadata -------------- */
const sectionMeta = [
  { emoji: "🎯", en: "Quick Coaching",      min: 60, max: 80 },
  { emoji: "🔬", en: "Phoneme Profile",     min: 60, max: 80 },
  { emoji: "🤝", en: "Reassurance",         min: 30, max: 50 },
  { emoji: "🪜", en: "Common Pitfalls",     min: 50, max: 70 },
  { emoji: "💪", en: "L1 Super-Power",      min: 35, max: 55 },
  { emoji: "🧠", en: "Did You Know?",       min: 25, max: 45 },
  { emoji: "🌍", en: "L1 Spotlight",        min: 40, max: 60 }
];

/* ----------- Main API Handler -------------- */
export default async function handler(req, res) {
  // Set CORS headers for every request
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // Handle preflight
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Only POST allowed" });

  try {
    const { referenceText, azureResult, firstLang = "" } = req.body;

    const targetLangCode = firstLang.trim().toLowerCase();
    const l1Label = langMap[targetLangCode] || targetLangCode || "Universal";

    // Gather pronunciation facts to feed GPT
    const worst = worstPhoneme(azureResult);
    const badList = worstWords(azureResult);
    const universal = universallyHard.has(worst);

    // Build explicit system prompt (forces valid JSON)
    const rangesStr = sectionMeta
      .map((s, i) => `${i + 1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`)
      .join("\n");

    const systemPrompt = `
You are the best bilingual pronunciation coach and overall linguist in the world. You must return valid JSON only, in the precise structure below—no extra text, no Markdown, no explanations.

❏ Output EXACTLY and ONLY:
{
  "sections":[                       // order preserved
    { "title":"", "titleL1":"", "en":"", "l1":"" },
    ...
  ]
}

❏ For the 7 sections, use these English titles *with emoji* and word ranges:
${rangesStr}

  • "title"   = emoji + English label (fixed)
  • "titleL1" = title translated into the learner's L-1 (omit emoji)
  • "en"      = coaching text in English (respect min/max word range)
  • "l1"      = same content translated into the learner's L-1; leave "" if firstLang == "Universal"

IMPORTANT RULES:
- Output ONLY valid JSON—no markdown, no explanations, no extra text.
- All 7 sections are required in correct order.
- Omit emoji from "titleL1".
`.trim();

    const userPrompt = {
      worstPhoneme: worst,
      worstWords: badList,
      sampleText: referenceText,
      universal,
      firstLang: targetLangCode,
      l1Label
    };

    // GPT call
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.55,
      max_tokens: 1200,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPrompt) }
      ]
    });

    // --- Robust parsing & logging ---
    let payload;
    try {
      payload = JSON.parse(completion.choices[0].message.content);
      if (!Array.isArray(payload.sections)) throw new Error("sections not array");
    } catch (err) {
      console.error(
        "[pronunciation-gpt.js] GPT JSON parse error:",
        completion.choices[0].message.content,
        err
      );
      return res.status(500).json({
        error: "Bad AI JSON shape",
        details: err.message,
        raw: completion.choices[0].message.content
      });
    }

    res.status(200).json(payload);
  } catch (e) {
    console.error("[pronunciation-gpt.js] error:", e);
    res.status(500).json({ error: "AI feedback failed.", details: e.message });
  }
}
