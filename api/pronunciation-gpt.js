// api/pronunciation-gpt.js
// ------------------------------------------------------------
//  Bilingual pronunciation‑coach endpoint
//  ➜ returns { sections:[…] } JSON consumed by the front‑end
// ------------------------------------------------------------

export const config = {
  api: { bodyParser: true, externalResolver: true }
};

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* -------------------------------------------------------------
 *  Token guard – uses gpt‑tokenizer (lighter than @dqbd/tiktoken)
 * ----------------------------------------------------------- */
import { countTokens } from "gpt-tokenizer"; // only helper we need

const MODEL_LIMIT = { "gpt-4o": 8192, "gpt-4o-mini": 4096 };
function safeMax(model, prompt) {
  const used = countTokens(prompt, model);
  // keep a 50‑token breathing room, but never hand back <100 or >900
  return Math.max(100, Math.min(900, MODEL_LIMIT[model] - used - 50));
}

/* -------------------------------------------------------------
 *  Pronunciation‑analysis helpers
 * ----------------------------------------------------------- */
const universallyHard = new Set(["θ", "ð", "ɹ"]);
const langMap = {
  es: "Spanish",   fr: "French",     pt: "Portuguese", zh: "Chinese",
  ja: "Japanese",  ko: "Korean",     ar: "Arabic",     ru: "Russian",
  de: "German",    hi: "Hindi",      mr: "Marathi",
  universal: "Universal", "": "Universal"
};

const alias = { dh: "ð", th: "θ", r: "ɹ" };
const norm  = (ipa) => alias[ipa] || ipa;

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
  return Object.entries(tally).sort((a,b)=>b[1]-a[1])[0]?.[0] || "";
}

function worstWords(json, n = 3) {
  return (json?.NBest?.[0]?.Words || [])
    .filter(w => w.AccuracyScore < 70)
    .sort((a,b)=>a.AccuracyScore - b.AccuracyScore)
    .slice(0,n)
    .map(w => w.Word);
}

// NEW ➜ first word that actually contains <ipa> & was mis‑pronounced
function firstBadWordWithPhoneme(json, ipa) {
  if (!ipa) return "";
  for (const w of json?.NBest?.[0]?.Words || []) {
    if (w.AccuracyScore < 85 && (w.Phonemes || []).some(p => norm(p.Phoneme) === ipa)) {
      return w.Word;
    }
  }
  return "";
}

/* -------------------------------------------------------------
 *  Section spec sent to GPT
 * ----------------------------------------------------------- */
const sectionMeta = [
  { emoji:"🎯", en:"Quick Coaching",   min:80, max:120 },
  { emoji:"🔬", en:"Phoneme Profile",  min:70, max:110 },
  { emoji:"🪜", en:"Common Pitfalls",  min:80, max:120 },
  { emoji:"⚖️", en:"Comparisons",      min:90, max:130 },
  { emoji:"🌍", en:"Did You Know?",    min:80, max:130 },
  { emoji:"🤝", en:"Reassurance",      min:60, max:100 }
];

/* ============================================================
 *  Main handler
 * ========================================================== */
export default async function handler(req, res) {
  // ---------- CORS ----------
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error:"Only POST allowed" });

  try {
    /* ------ pull data from body ------ */
    const { referenceText, azureResult, firstLang = "" } = req.body;
    const targetLangCode = firstLang.trim().toLowerCase();
    const l1Label        = langMap[targetLangCode] || "Universal";

    const worstPh        = worstPhoneme(azureResult);
    const badList        = worstWords(azureResult);
    const universal      = universallyHard.has(worstPh);
    const exampleWord    = firstBadWordWithPhoneme(azureResult, worstPh);

    /* ------ build prompts ------ */
    const rangesStr = sectionMeta.map((s,i)=>`${i+1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`).join("\n");

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

• "title":   emoji + English title above (fixed)
• "titleL1": Title translated to learner's L1 (no emoji)
• "en":      English coaching (respect word limits above, be rich & specific)
• "l1":      Same text translated to learner's L1 — leave blank if firstLang = "Universal"

❏ Sections explained:
1. Quick Coaching  – direct advice for **${worstPh || "key"}** in **${exampleWord || "example"}**
2. Phoneme Profile – precise articulation detail
3. Common Pitfalls – mistakes typical of L1 speakers, with fixes
4. Comparisons     – explicit comparison ENG sound ↔ L1 sound/shape
5. Did You Know?   – fun facts linking phoneme to L1 & global context
6. Reassurance     – warm encouragement

Respond in JSON format.`.trim();

    const userPrompt = JSON.stringify({
      worstPhoneme: worstPh,
      exampleWord,
      worstWords : badList,
      sampleText : referenceText,
      universal,
      firstLang  : targetLangCode,
      l1Label
    });

    /* ------ OpenAI call ------ */
    const model       = "gpt-4o-mini";
    const max_tokens  = safeMax(model, systemPrompt + userPrompt);

    const completion  = await openai.chat.completions.create({
      model,
      temperature: 0.6,
      response_format: { type:"json_object" },
      max_tokens,
      messages:[
        { role:"system", content: systemPrompt },
        { role:"user",   content: userPrompt   }
      ]
    });

    /* ------ parse & sanity‑check ------ */
    let payload;
    try {
      payload = JSON.parse(completion.choices[0].message.content);
      if (payload.sections?.data) payload.sections = payload.sections.data; // flatten odd GPT wrapper
      if (!Array.isArray(payload.sections)) throw new Error("Bad shape");
    } catch (e) {
      console.error("GPT JSON parse error:", e);
      return res.status(500).json({ error:"Bad AI JSON shape." });
    }

    return res.status(200).json({ sections: payload.sections });

  } catch (err) {
    console.error("pronunciation-gpt error:", err);
    res.status(500).json({ error:"AI feedback failed." });
  }
}
