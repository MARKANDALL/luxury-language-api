// api/pronunciation-gpt.js
// ------------------------------------------------------------
//  Bilingual pronunciation-coach back-end
//  - returns   { sections:[ … ] }   to the front-end
// ------------------------------------------------------------

export const config = { api: { bodyParser: true, externalResolver: true } };

/* ─────────── dependencies ─────────── */
import { OpenAI }      from "openai";
import { countTokens } from "gpt-tokenizer";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TOK_LIMIT = { "gpt-4o": 8192, "gpt-4o-mini": 4096 };

/* ---------- misc helpers ---------- */
const universallyHard = new Set(["θ","ð","ɹ"]);
const langs = { es:"Spanish", fr:"French", pt:"Portuguese", zh:"Chinese", ja:"Japanese",
                ko:"Korean",  ar:"Arabic",  ru:"Russian",   de:"German",  hi:"Hindi",
                mr:"Marathi", universal:"Universal", "":"Universal" };
const alias = { dh:"ð", th:"θ", r:"ɹ" };
const norm  = s => alias[s] || s;

function worstPhoneme(json){
  const tally={};
  json?.NBest?.[0]?.Words?.forEach(w=>
    w.Phonemes?.forEach(p=>{
      if(p.AccuracyScore<85){
        const k=norm(p.Phoneme);
        tally[k]=(tally[k]||0)+1;
      }
    })
  );
  return Object.entries(tally).sort((a,b)=>b[1]-a[1])[0]?.[0]||"";
}
function worstWords(json,n=3){
  return (json?.NBest?.[0]?.Words||[])
    .filter(w=>w.AccuracyScore<70)
    .sort((a,b)=>a.AccuracyScore-b.AccuracyScore)
    .slice(0,n)
    .map(w=>w.Word);
}
const sections=[
  {emoji:"🎯",en:"Quick Coaching",  min:80,max:120},
  {emoji:"🔬",en:"Phoneme Profile", min:70,max:110},
  {emoji:"🪜",en:"Common Pitfalls", min:80,max:120},
  {emoji:"⚖️",en:"Comparisons",     min:90,max:130},
  {emoji:"🌍",en:"Did You Know?",   min:80,max:130},
  {emoji:"🤝",en:"Reassurance",     min:40,max:70}   // shorter on purpose
];

function safeMax(model,prompt){
  const used=countTokens(prompt,model);
  return Math.max(100, Math.min(900, TOK_LIMIT[model]-used-50));
}

/* ---------- JSON sanitiser ---------- */
function cleanRaw(raw){
  if(raw.startsWith("```")) raw=raw.replace(/^```[a-z]*\s*/i,"").replace(/```$/,"");
  raw=raw.replace(/[“”]/g,'"').replace(/[‘’]/g,"'");
  const brace=raw.lastIndexOf("}");
  return brace!==-1?raw.slice(0,brace+1):raw;
}

/* ---------- main handler ---------- */
export default async function handler(req,res){
  /* CORS */
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  res.setHeader("Content-Type","application/json; charset=utf-8");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(req.method!=="POST")    return res.status(405).json({error:"Only POST allowed"});

  try{
    const {referenceText, azureResult, firstLang=""}=req.body;
    const langCode=firstLang.trim().toLowerCase();
    const l1Label =langs[langCode]||"Universal";
    const worst   =worstPhoneme(azureResult);
    const badList =worstWords(azureResult);
    const universal=universallyHard.has(worst);

    /* ----- build prompts ----- */
    const rangeLines=sections.map((s,i)=>
        `${i+1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`).join("\n");
    const SYSTEM=`
You are the world's leading bilingual pronunciation coach.

Output EXACTLY:
{
 "sections":[{"title":"","titleL1":"","en":"","l1":""}]
}

Provide 6 sections in order:
${rangeLines}

• "title"   = emoji+English title
• "titleL1" = title in learner's L1 (no emoji)
• "en"      = English advice
• "l1"      = same advice in L1 (blank if Universal)

Respond in *pure JSON* – no markdown, no extra text.`.trim();

    const USER=JSON.stringify({
      worstPhoneme:worst,
      worstWords:badList,
      sampleText:referenceText,
      universal,
      langCode,
      l1Label
    });

    /* ── STEP 1: draft generation with gpt-4o ── */
    const draftResp=await openai.chat.completions.create({
      model:"gpt-4o",
      temperature:0.6,
      max_tokens:1800,
      response_format:{type:"json_object"},
      messages:[
        {role:"system",content:SYSTEM},
        {role:"user",  content:USER}
      ]
    });

    let raw=cleanRaw(draftResp.choices[0].message.content||"");
    let payload;

    /* ── try to parse; if it fails → repair ── */
    try{
      payload=JSON.parse(raw);
    }catch{
      // use mini model only to *repair* (cheap & quick)
      const repairPrompt=`
You will be given a snippet that *should* be valid JSON but is broken.
Return the corrected JSON ONLY. Do not add or remove keys – just fix
quotes / commas / brackets / escapes until it parses.
`;
      const repaired=await openai.chat.completions.create({
        model:"gpt-4o-mini",
        temperature:0,
        max_tokens:safeMax("gpt-4o-mini",repairPrompt+raw),
        response_format:{type:"json_object"},
        messages:[
          {role:"system",content:repairPrompt},
          {role:"user",  content:raw.slice(0,4000)}   // safety trim
        ]
      });
      raw=cleanRaw(repaired.choices[0].message.content||"");
      payload=JSON.parse(raw);   // if this still fails it'll throw → catch below
    }

    if(!Array.isArray(payload.sections)||payload.sections.length!==6)
      throw new Error("Invalid sections array.");

    return res.status(200).json({sections:payload.sections});

  }catch(err){
    console.error("pronunciation-gpt error:",err);
    return res.status(500).json({error:err.message||"AI feedback failed."});
  }
}
