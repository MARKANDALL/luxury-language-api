// api/pronunciation-gpt.js
// ------------------------------------------------------------
//  Bilingual pronunciation-coach endpoint
//  – returns { sections: [...] } JSON for the front-end
// ------------------------------------------------------------

export const config = { api: { bodyParser: true, externalResolver: true } };

import { OpenAI }       from "openai";
import { countTokens }  from "gpt-tokenizer";   // tiny, pure JS

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- TOKEN LIMIT ---------- */
const MODEL_LIMIT = { "gpt-4o-mini": 4096, "gpt-4o": 8192 };
function safeMax(model, prompt) {
  const used = countTokens(prompt, model);
  // allow up to 1 500 but never above model cap-50
  const spare = MODEL_LIMIT[model] - used - 50;
  return Math.max(200, Math.min(1500, spare));
}

/* ---------- misc helpers ---------- */
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

const sectionMeta = [
  { emoji: "🎯", en: "Quick Coaching",   min: 80,  max: 120 },
  { emoji: "🔬", en: "Phoneme Profile",  min: 70,  max: 110 },
  { emoji: "🪜", en: "Common Pitfalls",  min: 80,  max: 120 },
  { emoji: "⚖️", en: "Comparisons",      min: 90,  max: 130 },
  { emoji: "🌍", en: "Did You Know?",    min: 80,  max: 130 },
  // Reassurance already trimmed
  { emoji: "🤝", en: "Reassurance",      min: 40,  max: 70  }
];

/* ========================================================== */
export default async function handler(req, res) {
  /* ---- CORS ---- */
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !==  "POST")   return res.status(405).json({ error: "Only POST allowed" });

  try {
    /* ---- input ---- */
    const { referenceText, azureResult, firstLang = "" } = req.body;
    const targetCode = firstLang.trim().toLowerCase();
    const l1Label    = langMap[targetCode] || "Universal";

    const worst      = worstPhoneme(azureResult);
    const badList    = worstWords(azureResult);
    const universal  = universallyHard.has(worst);

    const rangesStr  = sectionMeta
      .map((s,i)=>`${i+1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`)
      .join("\n");

    const system = `
You are the world's leading expert bilingual pronunciation coach.

Return EXACTLY:
{
  "sections":[
    {"title":"","titleL1":"","en":"","l1":""}
  ]
}

❏ Provide 6 sections in this order (${sectionMeta.map(s=>s.en).join(", ")}).
❏ Fill every "l1" unless firstLang = "Universal".
❏ Word limits above (English count only).
❏ Reassurance ≈40-70 EN words (already trimmed).

Respond in JSON format. Do NOT wrap in markdown.
`.trim();

    const user = JSON.stringify({
      worstPhoneme : worst,
      worstWords   : badList,
      sampleText   : referenceText,
      universal,
      firstLang    : targetCode,
      l1Label
    });

    const model = "gpt-4o-mini";
    const result = await askGPT(model, system, user, 0.45);
    if (!result.ok) {
      // one retry with slightly higher temperature
      const retry = await askGPT(model, system, user, 0.65);
      if (!retry.ok) throw retry.err;
      return res.status(200).json({ sections: retry.sections });
    }
    return res.status(200).json({ sections: result.sections });

  } catch (err) {
    console.error("pronunciation-gpt error:", err);
    res.status(500).json({ error: "AI feedback failed." });
  }
}

/* ---------- helper to call OpenAI & parse ---------- */
async function askGPT(model, sysPrompt, usrPrompt, temperature) {
  const max_tokens = safeMax(model, sysPrompt + usrPrompt);

  const completion = await openai.chat.completions.create({
    model,
    temperature,
    response_format: { type: "json_object" },
    max_tokens,
    messages: [
      { role: "system", content: sysPrompt },
      { role: "user",   content: usrPrompt }
    ]
  });

  try {
    let payload = JSON.parse(completion.choices[0].message.content);
    if (payload.sections?.data) payload.sections = payload.sections.data;
    if (!Array.isArray(payload.sections)) throw "bad shape";
    const missingL1 = payload.sections.some(sec =>
      (!sec.l1 || !sec.l1.trim()) && usrPrompt.includes('"firstLang":"') && !usrPrompt.includes('"universal"')
    );
    if (missingL1) throw "missing L1";
    return { ok:true, sections: payload.sections };
  } catch (err) {
    return { ok:false, err };
  }
}
