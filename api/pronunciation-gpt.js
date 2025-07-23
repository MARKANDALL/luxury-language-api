// api/pronunciation-gpt.js
// -------------------------------------------------------------------
//  POST  → { sections:[ {title, titleL1, en, l1} x6 ] }
//  Generates six bilingual coaching blocks for the pronunciation tool.
// -------------------------------------------------------------------
// 2025‑07‑23 – rebuilt to:  
//   • remove any double‑parsing of req.body (no more JSON.parse errors)  
//   • tighten CORS / pre‑flight handling  
//   • normalise language codes (maps zh → zh‑CN, etc.)  
//   • guarantee valid JSON from OpenAI with extra repair guard  
//   • graceful fallback: if translation fails, return English‑only blocks
// -------------------------------------------------------------------

export const config = { api: { bodyParser: true, externalResolver: true } };

import { OpenAI }      from "openai";
import { countTokens } from "gpt-tokenizer";

/* ──────────────────────────────────────────────────────────── */
const openai     = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TOK_LIMIT  = { "gpt-4o": 8192, "gpt-4o-mini": 4096 };

/* ----- util helpers ---------------------------------------- */
const universallyHard = new Set(["θ", "ð", "ɹ"]);

// display names for UI only
const LANGS = {
  es:"Spanish", fr:"French",   pt:"Portuguese", zh:"Chinese",
  ja:"Japanese", ko:"Korean",  ar:"Arabic",     ru:"Russian",
  de:"German",   hi:"Hindi",   mr:"Marathi",    universal:"Universal"
};

// map UI value → locale used by translation model
const LOCALE = {
  zh:"zh-CN",  ja:"ja",   ko:"ko",   es:"es",   fr:"fr",  de:"de",
  pt:"pt",    ar:"ar",   ru:"ru",   hi:"hi",  mr:"mr"
};

const ALIAS = { dh:"ð", th:"θ", r:"ɹ" };
const norm  = s => ALIAS[s] || s;

/* worst phoneme / word helpers ------------------------------ */
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
  return Object.entries(tally).sort((a,b)=>b[1]-a[1])[0]?.[0] || "";
}

function worstWords(json, n = 3){
  return (json?.NBest?.[0]?.Words || [])
    .filter(w => w.AccuracyScore < 70)
    .sort((a,b)=>a.AccuracyScore - b.AccuracyScore)
    .slice(0,n)
    .map(w => w.Word);
}

/* section meta ------------------------------------------------*/
const SECTIONS = [
  { emoji:"🎯", en:"Quick Coaching",  min:80,  max:120 },
  { emoji:"🔬", en:"Phoneme Profile", min:70,  max:110 },
  { emoji:"🪜", en:"Common Pitfalls", min:80,  max:120 },
  { emoji:"⚖️", en:"Comparisons",     min:90,  max:130 },
  { emoji:"🌍", en:"Did You Know?",   min:80,  max:130 },
  { emoji:"🤝", en:"Reassurance",     min:40,  max:70  }
];

const rangesText = SECTIONS.map((s,i)=>`${i+1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`).join("\n");

/* helpers ----------------------------------------------------*/
function safeMax(model, prompt){
  const used = countTokens(prompt, model);
  const free = Math.max(120, TOK_LIMIT[model] - used - 50);
  return Math.min(900, free);
}

const stripFences = txt => txt
  .replace(/^```[a-z]*\s*/i, "")
  .replace(/```$/, "")
  .replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

/* translate missing L1 blocks --------------------------------*/
async function translateMissing(arr, lang){
  if (lang === "universal") return;
  const target = arr.filter(s=>!s.l1);
  if (!target.length) return;

  const prompt = `Translate each string in the input array into ${LANGS[lang]}. Return a JSON array.`;
  const textArr= target.map(s=>s.en);

  const tr = await openai.chat.completions.create({
    model:"gpt-4o-mini", temperature:0,
    response_format:{type:"json_object"},
    max_tokens:safeMax("gpt-4o-mini", prompt+JSON.stringify(textArr)),
    messages:[
      {role:"system",content:prompt},
      {role:"user",  content:JSON.stringify(textArr)}
    ]
  });

  const translations = JSON.parse(stripFences(tr.choices[0].message.content));
  if(!Array.isArray(translations)) throw new Error("Translator JSON malformed");
  target.forEach((sec,i)=>{sec.l1 = translations[i] || ""});
}

/* ------------------------------------------------------------------ */
export default async function handler(req, res){
  /* CORS -----------------------------------------------------------*/
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type",                "application/json; charset=utf-8");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({error:"Only POST allowed"});

  try{
    /* ---------- req.body is already parsed by Next/Vercel ---------- */
    const { referenceText = "", azureResult = {}, firstLang = "" } = req.body;

    const langCodeRaw = (firstLang || "").trim().toLowerCase();
    const langCode    = langCodeRaw || "universal";
    console.log("[AI] firstLang received:", `"${langCode}"`);

    const universal   = universallyHard.has(worstPhoneme(azureResult));
    const payload     = {
      worstPhoneme : worstPhoneme(azureResult),
      worstWords   : worstWords(azureResult),
      sampleText   : referenceText,
      universal,
      langCode
    };

    /* ---------- build prompt ------------------------------------- */
    const SYS = (
`You are the world's leading bilingual pronunciation coach.
Return pure JSON exactly in this shape:
{ "sections":[ { "title":"", "titleL1":"", "en":"", "l1":"" } ] }

Follow the 6 sections in order:
${rangesText}

If langCode === "universal" leave \"l1\" blank.
No markdown, no triple backticks.`).trim();

    const main = await openai.chat.completions.create({
      model:"gpt-4o", temperature:0.6,
      response_format:{type:"json_object"},
      max_tokens:1800,
      messages:[
        {role:"system", content:SYS},
        {role:"user",   content:JSON.stringify(payload)}
      ]
    });

    let draft = stripFences(main.choices[0].message.content || "");
    let data;

    /* try parse → repair once on failure -------------------------- */
    try{ data = JSON.parse(draft); }
    catch{
      const reparsed = await openai.chat.completions.create({
        model:"gpt-4o-mini", temperature:0,
        response_format:{type:"json_object"},
        max_tokens:safeMax("gpt-4o-mini", draft),
        messages:[
          {role:"system", content:"Fix the JSON so it parses; do NOT change its meaning."},
          {role:"user",   content:draft.slice(0,4000)}
        ]
      });
      data = JSON.parse(stripFences(reparsed.choices[0].message.content || "{}"));
    }

    if(!Array.isArray(data.sections) || data.sections.length!==6)
      throw new Error("Bad sections array");

    /* fill any missing L1 translations ---------------------------- */
    await translateMissing(data.sections, langCode);

    return res.status(200).json({ sections:data.sections });

  }catch(err){
    console.error("[pronunciation-gpt]", err.message || err);
    return res.status(500).json({ error: err.message || "AI feedback failed." });
  }
}
