// api/pronunciation-gpt.js
// -----------------------------------------------------------------------------
//  Pronunciation Feedback + Translation (two-pass, token-safe)
// -----------------------------------------------------------------------------
export const config = { api: { bodyParser: true, externalResolver: true } };

import OpenAI from "openai";
import { encode, decode } from "gpt-tokenizer";         // NEW
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- Helper look-ups ---------- */
const universallyHard = new Set(["θ", "ð", "ɹ"]);
const langMap = {
  es: "Spanish", fr: "French", pt: "Portuguese", zh: "Chinese",
  ja: "Japanese", ko: "Korean", ar: "Arabic", ru: "Russian",
  de: "German", hi: "Hindi", mr: "Marathi", universal: "Universal", "": "Universal"
};
const alias = { dh: "ð", th: "θ", r: "ɹ" };
const norm  = (sym) => alias[sym] || sym;

/* ---------- Worst-error detectors ---------- */
function worstPhoneme(json){
  const tally = {};
  json?.NBest?.[0]?.Words?.forEach(w =>
    w.Phonemes?.forEach(p=>{
      if(p.AccuracyScore < 85){
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
   .map(w=>w.Word);
}

/* ---------- Section metadata ---------- */
const sectionMeta = [
  { emoji:"🎯", en:"Quick Coaching",    min:80,  max:120 },
  { emoji:"🔬", en:"Phoneme Profile",   min:70,  max:110 },
  { emoji:"🪜", en:"Common Pitfalls",   min:80,  max:120 },
  { emoji:"⚖️", en:"Comparisons",      min:90,  max:130 },
  { emoji:"🌍", en:"Did You Know?",     min:80,  max:130 },
  { emoji:"🤝", en:"Reassurance",       min:60,  max:100 }
];

/* ---------- Token caps per section (English text) ---------- */
const SECTION_LIMITS = [180,180,180,120,120,60];

/* ---------- Tiny trim helper ---------- */
function trimToTokens(str, limit){
  const t = encode(str);
  if(t.length <= limit) return str;
  return decode(t.slice(0, limit-1)) + "…";
}

/* ---------- System-prompt builders ---------- */
function buildSystemPrompt(withTranslate){
  const ranges = sectionMeta
    .map((s,i)=>`${i+1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`)
    .join("\n");

  return `
You are the world's leading bilingual pronunciation coach.

Return exactly:
{"sections":[{"title":"","en":""${withTranslate?', "l1":""':''}]}

Provide 6 sections in this order:
${ranges}

No markdown or HTML. Respect word ranges; be specific, never generic.
${withTranslate?`If learner's first language is provided, fill "l1" with the translation.`:''}
`.trim();
}

function buildUserJson(refText, azureJson, langCode, l1Label){
  return {
    worstPhoneme : worstPhoneme(azureJson),
    worstWords   : worstWords(azureJson),
    sampleText   : refText,
    universal    : universallyHard.has(worstPhoneme(azureJson)),
    firstLang    : langCode,
    l1Label
  };
}

/* =============================================================================
   MAIN HANDLER  —  two GPT-mini calls
============================================================================= */
export default async function handler(req,res){
  // ---- CORS boilerplate ----
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  res.setHeader("Content-Type","application/json; charset=utf-8");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(req.method!=="POST")    return res.status(405).json({error:"Only POST allowed"});

  try{
    /* ---------- Parse input ---------- */
    const { referenceText, azureResult, firstLang="" } = req.body;
    const langCode = firstLang.trim().toLowerCase();
    const l1Label  = langMap[langCode] || "Universal";

    /* ---------- 1️⃣  English-only pass ---------- */
    const sysEN  = buildSystemPrompt(false);
    const userEN = buildUserJson(referenceText, azureResult, langCode, l1Label);

    const enResp = await openai.chat.completions.create({
      model:"gpt-4o-mini",
      temperature:0.6,
      max_tokens:2048,
      messages:[
        {role:"system",content:sysEN},
        {role:"user",  content:JSON.stringify(userEN)}
      ]
    });

    let payload = JSON.parse(enResp.choices[0].message.content);
    if(!Array.isArray(payload.sections))
      throw new Error("Bad shape from GPT EN pass");

    /* ---------- Trim EN text to safe size ---------- */
    payload.sections.forEach((s,i)=>{
      s.en = trimToTokens(s.en, SECTION_LIMITS[i]);
    });

    /* ---------- 2️⃣  Translation pass (if needed) ---------- */
    if(langCode){
      const sysTR = `Translate the field "en" into ${l1Label}. 
Return the SAME array shape with a new key "l1", others untouched.`;

      const trResp = await openai.chat.completions.create({
        model:"gpt-4o-mini",
        temperature:0.3,
        max_tokens:1024,
        messages:[
          {role:"system",content:sysTR},
          {role:"user",  content:JSON.stringify(payload.sections)}
        ]
      });

      payload.sections = JSON.parse(trResp.choices[0].message.content);
    }

    /* ---------- Respond ---------- */
    return res.status(200).json(payload);

  }catch(err){
    console.error("pronunciation-gpt error:", err);
    return res.status(500).json({error:String(err)});
  }
}
