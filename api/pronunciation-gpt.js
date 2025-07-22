// api/pronunciation-gpt.js
// ------------------------------------------------------------
//  POST →  { sections:[ … ] }      (6 bilingual coaching blocks)
// ------------------------------------------------------------
export const config = { api: { bodyParser: true, externalResolver: true } };

import { OpenAI }      from "openai";
import { countTokens } from "gpt-tokenizer";

const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TOK_LIMIT = { "gpt-4o": 8192, "gpt-4o-mini": 4096 };

/* ─ util helpers ──────────────────────────────────────────── */
const universallyHard = new Set(["θ", "ð", "ɹ"]);

const langs = {                                     // for display only
  es:"Spanish", fr:"French",  pt:"Portuguese", zh:"Chinese",
  ja:"Japanese", ko:"Korean", ar:"Arabic",    ru:"Russian",
  de:"German",   hi:"Hindi",  mr:"Marathi",
  universal:"Universal"
};

const alias = { dh:"ð", th:"θ", r:"ɹ" };
const norm  = s => alias[s] || s;

function worstPhoneme(json){
  const tally = {};
  json?.NBest?.[0]?.Words?.forEach(w =>
    w.Phonemes?.forEach(p => {
      if (p.AccuracyScore < 85) {
        const k = norm(p.Phoneme);
        tally[k] = (tally[k] || 0) + 1;
      }
    })
  );
  return Object.entries(tally).sort((a,b) => b[1]-a[1])[0]?.[0] || "";
}

function worstWords(json, n = 3){
  return (json?.NBest?.[0]?.Words || [])
    .filter(w => w.AccuracyScore < 70)
    .sort((a,b) => a.AccuracyScore - b.AccuracyScore)
    .slice(0, n)
    .map(w => w.Word);
}

/* 6 coaching blocks — min/max = target English word count */
const sections = [
  { emoji:"🎯", en:"Quick Coaching",  min:80,  max:120 },
  { emoji:"🔬", en:"Phoneme Profile", min:70,  max:110 },
  { emoji:"🪜", en:"Common Pitfalls", min:80,  max:120 },
  { emoji:"⚖️", en:"Comparisons",     min:90,  max:130 },
  { emoji:"🌍", en:"Did You Know?",   min:80,  max:130 },
  { emoji:"🤝", en:"Reassurance",     min:40,  max:70 }
];

function safeMax(model, prompt){
  const used = countTokens(prompt, model);
  const free = Math.max(120, TOK_LIMIT[model] - used - 50);
  return Math.min(900, free);
}

function stripFences(txt){
  if (txt.startsWith("```"))
    txt = txt.replace(/^```[a-z]*\s*/i, "").replace(/```$/, "");
  return txt.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

/* ─ translation helper ───────────────────────────────────── */
async function translateMissing(sectionsArr, langCode){
  const need = sectionsArr.filter(s => !s.l1);
  if (!need.length || langCode === "universal") return;

  const prompt = `
You will receive an array of English strings. Translate each
string into the target language *${langs[langCode]}* and return a
JSON array of the same length, no extra keys.
  `.trim();

  const textArr = need.map(s => s.en);
  const result  = await openai.chat.completions.create({
    model           : "gpt-4o-mini",
    temperature     : 0,
    max_tokens      : safeMax("gpt-4o-mini", prompt + JSON.stringify(textArr)),
    response_format : { type:"json_object" },
    messages : [
      { role:"system", content:prompt },
      { role:"user",   content:JSON.stringify(textArr) }
    ]
  });

  const translations = JSON.parse(stripFences(result.choices[0].message.content));
  if (!Array.isArray(translations))
    throw new Error("Translator JSON malformed");

  need.forEach((sec,i) => { sec.l1 = translations[i] || ""; });
}

/* ─ main handler ──────────────────────────────────────────── */
export default async function handler(req, res){
  /* ---- CORS pre‑flight ---- */
  res.setHeader("Access-Control-Allow-Origin" , "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error:"Only POST allowed" });

  try{
    const { referenceText, azureResult, firstLang = "" } = req.body;

    /* ---- normalise language code ---- */
    const langCodeRaw = (firstLang ?? "").trim().toLowerCase();
    const langCode    = langCodeRaw || "universal";          // ✅ default fallback
    console.log("[AI] firstLang received:", `"${langCode}"`);

    const worst    = worstPhoneme(azureResult);
    const badList  = worstWords(azureResult);
    const universal= universallyHard.has(worst);

    /* ---------- build prompts ---------- */
    const ranges = sections.map((s,i) =>
      `${i+1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`).join("\n");

    const SYSTEM = `
You are the world's leading bilingual pronunciation coach.

Return pure JSON exactly in this shape:
{ "sections":[ { "title":"","titleL1":"","en":"","l1":"" } ] }

Follow the 6 sections in order:
${ranges}

If langCode === "universal" leave "l1" blank.
No markdown, no triple backticks.`.trim();

    const USER = JSON.stringify({
      worstPhoneme : worst,
      worstWords   : badList,
      sampleText   : referenceText,
      universal,
      langCode
    });

    /* ---------- main GPT call ---------- */
    const draft = await openai.chat.completions.create({
      model            : "gpt-4o",
      temperature      : 0.6,
      response_format  : { type:"json_object" },
      max_tokens       : 1800,
      messages : [
        { role:"system", content:SYSTEM },
        { role:"user",   content:USER   }
      ]
    });

    let raw  = stripFences(draft.choices[0].message.content || "");
    let data;

    /* ---------- parse, repair if needed ---------- */
    try{
      data = JSON.parse(raw);
    }catch{
      const repair = await openai.chat.completions.create({
        model           : "gpt-4o-mini",
        temperature     : 0,
        response_format : { type:"json_object" },
        max_tokens      : safeMax("gpt-4o-mini", raw),
        messages : [
          { role:"system", content:"Fix the JSON so it parses; do NOT change its meaning." },
          { role:"user",   content:raw.slice(0,4000) }
        ]
      });
      data = JSON.parse(stripFences(repair.choices[0].message.content || ""));
    }

    if (!Array.isArray(data.sections) || data.sections.length !== 6)
      throw new Error("Bad sections array");

    /* ---------- fill in missing L1 text ---------- */
    await translateMissing(data.sections, langCode);

    return res.status(200).json({ sections:data.sections });

  }catch(err){
    console.error("pronunciation-gpt error:", err.message || err);
    return res.status(500).json({ error:err.message || "AI feedback failed." });
  }
}
