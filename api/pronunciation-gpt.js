// api/pronunciation-gpt.js
// ------------------------------------------------------------
//  Bilingual pronunciation-coach endpoint
//  ➊ Analyses Azure JSON              (hard work → GPT-4o)
//  ➋ Returns six coaching sections    (L1 + EN)
// ------------------------------------------------------------

export const config = { api: { bodyParser: true, externalResolver: true } };

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- TOKEN GUARD (gpt-tokenizer) ---------- */
import { countTokens } from "gpt-tokenizer";

const MODEL_LIMIT = { "gpt-4o": 8192, "gpt-4o-mini": 4096 };
function safeMax(model, ...prompts) {
  const used = prompts.reduce((n, p) => n + countTokens(p, model), 0);
  // leave ~50-token buffer, cap at 900 so we never blow up billing
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
  { emoji: "🎯", en: "Quick Coaching",   min: 80, max: 110 },
  { emoji: "🔬", en: "Phoneme Profile",  min: 70, max: 100 },
  { emoji: "🪜", en: "Common Pitfalls",  min: 75, max: 110 },
  { emoji: "⚖️", en: "Comparisons",      min: 80, max: 120 },
  { emoji: "🌍", en: "Did You Know?",    min: 70, max: 100 },
  { emoji: "🤝", en: "Reassurance",      min: 40, max: 65 }  // trimmed by ⅓
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
  if (req.method !== "POST")
    return res.status(405).json({ error: "Only POST allowed" });

  try {
    /* ---------- extract payload ---------- */
    const { referenceText, azureResult, firstLang = "" } = req.body;
    const targetLangCode = firstLang.trim().toLowerCase();
    const l1Label        = langMap[targetLangCode] || "Universal";
    const universal      = targetLangCode === "universal" || targetLangCode === "";

    const worst     = worstPhoneme(azureResult);
    const badList   = worstWords(azureResult);

    /* ---------- build prompts ---------- */
    const rangesStr = sectionMeta
      .map((s, i) => `${i + 1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`)
      .join("\n");

    const sys = `
You are the world's leading bilingual pronunciation coach.

❏ Output exactly:
{
  "sections":[
    {"title":"","titleL1":"","en":"","l1":""}
  ]
}

❏ Provide *six* sections, in this order:
${rangesStr}

• "title"   = emoji + English title above (fixed)
• "titleL1" = title translated to learner's L1 (no emoji, blank if Universal)
• "en"      = English coaching (within word ranges, specific & rich)
• "l1"      = same text translated to learner's L1 (blank if Universal)

→ Section notes:
1 Quick Coaching  – instant advice for worst phoneme/word
2 Phoneme Profile – tongue/lip details, airflow etc.
3 Common Pitfalls – typical L1 errors + fixes
4 Comparisons     – explicit ENG vs L1 pronunciation contrast
5 Did You Know?   – engaging factoid linking sound & L1 context
6 Reassurance     – warm encouragement (keep it short!)

Respond in **valid JSON** only – no markdown, no prose.
`.trim();

    const usr = JSON.stringify({
      worstPhoneme : worst,
      worstWords   : badList,
      sampleText   : referenceText,
      universal,
      firstLang    : targetLangCode,
      l1Label
    });

    /* ---------- OpenAI call ---------- */
    const model      = "gpt-4o-mini";
    const max_tokens = safeMax(model, sys, usr);

    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.6,
      max_tokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user",   content: usr }
      ]
    });

    /* ---------- validation ---------- */
    let payload;
    try {
      payload = JSON.parse(completion.choices[0].message.content);
      if (payload.sections?.data) payload.sections = payload.sections.data;
      if (!Array.isArray(payload.sections)) throw new Error("sections not array");

      // six sections & keys present
      if (payload.sections.length !== 6)
        throw new Error("Must return 6 sections");
      payload.sections.forEach(s => {
        ["title","titleL1","en","l1"].forEach(k => {
          if (!(k in s)) throw new Error(`Missing key: ${k}`);
        });
      });

      // ---- extra L1 check --------------------------------
      if (!universal) {
        const allHaveL1 = payload.sections.every(
          s => (s.l1 || "").trim().length > 9
        );
        if (!allHaveL1) throw new Error("Missing L1 content");
      } else {
        const anyL1 = payload.sections.some(
          s => (s.l1 || "").trim().length > 0
        );
        if (anyL1) throw new Error("Unexpected L1 in Universal mode");
      }
    } catch (e) {
      console.error("GPT JSON parse error:", e);
      return res.status(500).json({ error: "Bad AI JSON shape." });
    }

    // ---------- success ----------
    res.status(200).json({ sections: payload.sections });
  } catch (err) {
    console.error("pronunciation-gpt error:", err);
    res.status(500).json({ error: "AI feedback failed." });
  }
}
