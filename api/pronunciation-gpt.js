// api/pronunciation-gpt.js
// ------------------------------------------------------------
//  Bilingual pronunciation coach – stable L1 fallback
// ------------------------------------------------------------

export const config = { api: { bodyParser: true, externalResolver: true } };

import { OpenAI } from "openai";
import { countTokens } from "gpt-tokenizer";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- helpers ---------- */
const MODEL_LIMIT = { "gpt-4o": 8192, "gpt-4o-mini": 4096 };
const safeMax = (m, ...txt) =>
  Math.max(100,
    Math.min(900, MODEL_LIMIT[m] - txt.reduce((n,t)=>n + countTokens(t, m), 0) - 50)
  );

const alias = { dh:"ð", th:"θ", r:"ɹ" };
const norm = s => alias[s] || s;
function worstPhoneme(j){
  const tally={};
  j?.NBest?.[0]?.Words?.forEach(w =>
    w.Phonemes?.forEach(p=>{
      if(p.AccuracyScore<85){
        const k=norm(p.Phoneme);
        tally[k]=(tally[k]||0)+1;
      }
    })
  );
  return Object.entries(tally).sort((a,b)=>b[1]-a[1])[0]?.[0]||"";
}
function worstWords(j,n=3){
  return (j?.NBest?.[0]?.Words||[])
    .filter(w=>w.AccuracyScore<70)
    .sort((a,b)=>a.AccuracyScore-b.AccuracyScore)
    .slice(0,n).map(w=>w.Word);
}

const langMap={
  es:"Spanish",fr:"French",pt:"Portuguese",zh:"Chinese",
  ja:"Japanese",ko:"Korean",ar:"Arabic",ru:"Russian",
  de:"German",hi:"Hindi",mr:"Marathi",
  universal:"Universal","":"Universal"
};

const sections=[
  { emoji:"🎯", en:"Quick Coaching",   min:80, max:110 },
  { emoji:"🔬", en:"Phoneme Profile",  min:70, max:100 },
  { emoji:"🪜", en:"Common Pitfalls",  min:75, max:110 },
  { emoji:"⚖️", en:"Comparisons",      min:80, max:120 },
  { emoji:"🌍", en:"Did You Know?",    min:70, max:100 },
  { emoji:"🤝", en:"Reassurance",      min:40, max:65 }
];

/* ========================================================== */
export default async function handler(req,res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  res.setHeader("Content-Type","application/json;charset=utf-8");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(req.method!=="POST")    return res.status(405).json({error:"Only POST"});

  try{
    const { referenceText, azureResult, firstLang="" }=req.body;
    const code  = firstLang.trim().toLowerCase();
    const label = langMap[code] || "Universal";
    const isUni = (code==="universal"||code==="");

    const worst=worstPhoneme(azureResult);
    const bad  =worstWords(azureResult);

    const rangeLine = sections.map(
      (s,i)=>`${i+1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`
    ).join("\n");

    const sys=`
You are the world's top bilingual pronunciation coach.

Return strict JSON:
{"sections":[{"title":"","titleL1":"","en":"","l1":""}]}

Make 6 sections in order:
${rangeLine}

If learner L1 = Universal, leave "titleL1" and "l1" blank.
Otherwise translate both.

# Section purposes
1 Quick Coaching – tip for worst phoneme/word
2 Phoneme Profile – articulator details
3 Common Pitfalls – usual L1 errors + fix
4 Comparisons     – ENG vs L1 contrast
5 Did You Know?   – fun fact
6 Reassurance     – brief encouragement (≤65 EN words)

Respond **JSON only**.
`.trim();

    const usr=JSON.stringify({ worstPhoneme:worst,worstWords:bad,
                               sampleText:referenceText,
                               firstLang:code,l1Label:label });

    const model="gpt-4o-mini";
    const main=await openai.chat.completions.create({
      model,temperature:0.6,
      max_tokens:safeMax(model,sys,usr),
      response_format:{type:"json_object"},
      messages:[{role:"system",content:sys},{role:"user",content:usr}]
    });

    let data=JSON.parse(main.choices[0].message.content);
    if(data.sections?.data) data.sections=data.sections.data;
    if(!Array.isArray(data.sections)||data.sections.length!==6)
      throw new Error("Bad section count");

    /* ---------- universal cleanup ---------- */
    if(isUni){
      data.sections.forEach(s=>{s.titleL1="";s.l1="";});
      return res.status(200).json({sections:data.sections});
    }

    /* ---------- fallback translate if blanks ---------- */
    const missing=data.sections
      .map((s,i)=>(!s.l1||s.l1.trim().length<8)?i:-1)
      .filter(i=>i>=0);

    if(missing.length){
      const enChunks=missing.map(i=>data.sections[i].en);
      const tPrompt=`
Translate EACH of these English chunks into ${label}.
Return JSON: {"translations":[ "...", "..." ]}
Order must match.
${JSON.stringify(enChunks)}
`.trim();

      const tRes=await openai.chat.completions.create({
        model,temperature:0.3,
        max_tokens:safeMax(model,tPrompt),
        response_format:{type:"json_object"},
        messages:[
          {role:"system",content:"You are a precise translator; JSON only."},
          {role:"user",content:tPrompt}
        ]
      });

      const transObj=JSON.parse(tRes.choices[0].message.content||"{}");
      const translations=Array.isArray(transObj.translations)?
                          transObj.translations:[];

      if(translations.length===missing.length){
        missing.forEach((idx,i)=>{
          data.sections[idx].l1=translations[i];
 // put only the first ~6 tokens in the heading
 data.sections[idx].titleL1 = translations[i]
        .split(/\s+/)        // words
        .slice(0, 6)         // keep six
        .join(" ");
        });
      }
    }

    return res.status(200).json({sections:data.sections});

  }catch(err){
    console.error("pronunciation-gpt error:",err);
    res.status(500).json({error:"AI feedback failed."});
  }
}
