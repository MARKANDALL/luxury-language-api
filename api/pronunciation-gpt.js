// /api/pronunciation-gpt.js
// -------------------------
export const config = { api: { bodyParser: true, externalResolver: true } };

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------------- helper utilities ---------------- */
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

/* ---------------- section catalogue ---------------- */
const sectionMeta = [
  { emoji: "🎯", en: "Quick Coaching",      min: 60, max: 80 },
  { emoji: "🔬", en: "Phoneme Profile",     min: 60, max: 80 },
  { emoji: "🤝", en: "Reassurance",         min: 30, max: 50 },
  { emoji: "🪜", en: "Common Pitfalls",     min: 50, max: 70 },
  { emoji: "💪", en: "L1 Super-Power",      min: 35, max: 55 },
  { emoji: "🧠", en: "Did You Know?",       min: 25, max: 45 },
  { emoji: "🌍", en: "L1 Spotlight",        min: 40, max: 60 }
];

/* ---------------- API handler ---------------------- */
export default async function handler(req, res) {
  /* --- CORS boiler-plate (unchanged) --- */
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  if (req.method !== "POST")
    return res.status(405).json({ error: "Only POST allowed" });

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const { referenceText, azureResult, firstLang = "" } = req.body;

    const targetLangCode = firstLang.trim().toLowerCase();
    const l1Label        = langMap[targetLangCode] || targetLangCode || "Universal";

    /* ---- gather pronunciation facts to feed GPT ---- */
    const worst   = worstPhoneme(azureResult);
    const badList = worstWords(azureResult);
    const universal = universallyHard.has(worst);

    /* ------------- BUILD SYSTEM PROMPT -------------- */
    const rangesStr = sectionMeta
      .map((s, i) => `${i + 1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`)
      .join("\n");

    const system = `
You are a bilingual pronunciation coach.

❏ Output EXACTLY:
{
  "sections":[                       // order preserved
    { "title":"", "titleL1":"", "en":"", "l1":"" },
    ...
  ]
}

❏ For the 7 sections use these English titles *with emoji* and word ranges:
${rangesStr}

  • "title"   = emoji + English label (fixed)
  • "titleL1" = title translated into the learner's L-1 (omit emoji)
  • "en"      = coaching text in English (respect min/max word range of that section)
  • "l1"      = same content translated into the learner's L-1
               Leave "" if firstLang == "Universal"

Styling rules
  – NO HTML / Markdown in any field
  – Plain text only; frontend handles styling.
`.trim();

    const user = {
      worstPhoneme : worst,
      worstWords   : badList,
      sampleText   : referenceText,
      universal,
      firstLang    : targetLangCode,
      l1Label
    };

    /* ------------- CALL OPEN-AI --------------------- */
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.55,
      max_tokens: 1200,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: JSON.stringify(user) }
      ]
    });

    /* ------------- sanity-check JSON ---------------- */
    let payload;
    try {
      payload = JSON.parse(completion.choices[0].message.content);
      if (!Array.isArray(payload.sections)) throw "bad shape";
    } catch (_) {
      return res.status(500).json({ error: "Bad AI JSON shape." });
    }

    res.status(200).json(payload);
  } catch (e) {
    console.error("pronunciation-gpt error:", e);
    res.status(500).json({ error: "AI feedback failed." });
  }
}
