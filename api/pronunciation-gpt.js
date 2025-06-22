// /api/pronunciation-gpt.js
//
// NEXT.js / Vercel API route
// ----------------------------------------------------------------
export const config = { api: { bodyParser: true, externalResolver: true } };

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- helpers ---------- */
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

/* ---------- handler ---------- */
export default async function handler(req, res) {
  /* ---------- CORS pre-flight ---------- */
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type",               "application/json; charset=utf-8");

  try {
    /* ---------- pull POST body ---------- */
    const { referenceText, azureResult, firstLang = "" } = req.body;

    const targetLangCode = firstLang.trim().toLowerCase();       // e.g. "es"
    const l1Label        = langMap[targetLangCode] || targetLangCode || "Universal";

    const worst   = worstPhoneme(azureResult);
    const badList = worstWords(azureResult);
    const universal = universallyHard.has(worst);

    /* ---------- section labels (emoji titles) ---------- */
    const baseTitles = [
      "🎯 Quick Coaching",
      "🔬 Phoneme Profile",
      "🤝 Reassurance",
      `🪜 Common Pitfalls for ${l1Label}`,
      `💪 ${l1Label} Super-Power`,
      "🧠 Did You Know?",
      `🌍 ${l1Label} Spotlight`,
    ];

    /* ---------- GPT prompt ---------- */
    const system = `
You are a bilingual pronunciation coach.

Output JSON with EXACTLY this shape:
{
  "sections":[             // always 7 objects, SAME order as titles list
    { "title":"", "titleL1":"", "en":"", "l1":"" },
    ...
  ]
}

RULES
1. \`title\`     = the emoji title supplied (do NOT translate it).
2. \`titleL1\`   = **translate title text only** (no emoji) into learner’s language.
   • If target language is "Universal", leave titleL1 = "".
3. \`en\`        = English coaching, 45-65 words.
4. \`l1\`        = L1 translation of \`en\`, wrapped in
   <span style="color:#888;font-style:italic">…</span>
   • Leave empty if "Universal".
5. Do **NOT** add any extra keys.
`.trim();

    const user = {
      worstPhoneme : worst,
      worstWords   : badList,
      sampleText   : referenceText,
      universal,
      firstLang    : targetLangCode,
      l1Label,
      titles       : baseTitles,        // give GPT the exact list
    };

    /* ---------- single GPT-4o call does everything ---------- */
    const completion = await openai.chat.completions.create({
      model       : "gpt-4o-mini",
      temperature : 0.55,
      max_tokens  : 1100,
      messages    : [
        { role: "system", content: system },
        { role: "user",   content: JSON.stringify(user) },
      ],
    });

    /* ---------- safe parse ---------- */
    let payload;
    try {
      payload = JSON.parse(completion.choices[0].message.content);
      if (!Array.isArray(payload.sections)) throw "bad shape";
    } catch (_) {
      return res.status(500).json({ error: "Bad AI JSON shape." });
    }

    /* ---------- success ---------- */
    res.status(200).json(payload);
  } catch (e) {
    console.error("pronunciation-gpt error:", e);
    res.status(500).json({ error: "AI feedback failed." });
  }
}
