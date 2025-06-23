// pronunciation.js – small, self‑contained backend helper that
// 1) counts tokens before every call
// 2) generates the six English feedback sections with GPT‑4o (128k context)
// 3) translates them with GPT‑4o‑mini (cheap) when the user picked a first‑language (l1)
// -----------------------------------------------------------------------------
// Environment variables expected
//   OPENAI_API_KEY             – your key
//   MODEL_SECTIONS (optional)  – default "gpt-4o"
//   MODEL_TRANSLATE (optional) – default "gpt-4o-mini"
//   MAX_SECTION_TOKENS         – default  250  (per language, per section)
//   MAX_PROMPT_TOKENS          – default 13500 (safety buffer for the sections call)
//
// Requires: npm i openai tiktoken
// -----------------------------------------------------------------------------
import OpenAI from 'openai';
import { encoding_for_model } from 'tiktoken';

//--------------------------------------------------------------------
// 🔧  Config & helpers
//--------------------------------------------------------------------
const MODEL_SECTIONS  = process.env.MODEL_SECTIONS  || 'gpt-4o';      // big window
const MODEL_TRANSLATE = process.env.MODEL_TRANSLATE || 'gpt-4o-mini'; // cheap window
const MAX_SECTION_TOKENS = +(process.env.MAX_SECTION_TOKENS || 250);  // per sec / per lang
const MAX_PROMPT_TOKENS  = +(process.env.MAX_PROMPT_TOKENS  || 13500);

const openai = new OpenAI();

// simple tokenizer wrapper -----------------------------------------------------
const encCache = new Map();
function getEncoding(model){
  if(encCache.has(model)) return encCache.get(model);
  const enc = encoding_for_model(model);
  encCache.set(model, enc);
  return enc;
}
function countTokens(model, str){
  const enc = getEncoding(model);
  return enc.encode(str).length;
}
//--------------------------------------------------------------------
// 1️⃣  Build the English sections
//--------------------------------------------------------------------
export async function buildEnglishSections({referenceText, azureJson}){
  const sys = `You are an ESL pronunciation coach. Produce EXACTLY six JSON objects, each with keys: title, titleL1, en. Do NOT include l1 in this step.`;
  const user = `Reference text: "${referenceText}"
Azure JSON (shortened):\n${JSON.stringify(azureJson).slice(0,2000)}…\n\nReturn six sections: 🎯 Quick Coaching, 🔬 Phoneme Profile, 🪜 Common Pitfalls, ⚖️ Comparisons, 🌍 Did You Know?, 🤝 Reassurance.`;

  // token‑count guard ----------------------------------------------------------
  const usedTokens = countTokens(MODEL_SECTIONS, sys + user);
  if(usedTokens > MAX_PROMPT_TOKENS){
    throw new Error(`Prompt would be ${usedTokens} tokens – clip or split first.`);
  }

  const resp = await openai.chat.completions.create({
    model: MODEL_SECTIONS,
    temperature: 0.7,
    max_tokens: 4096,               // plenty of room for reply
    messages:[{role:'system',content:sys},{role:'user',content:user}],
  });
  const raw = resp.choices[0].message.content.trim();
  return safeJsonParse(raw);
}
//--------------------------------------------------------------------
// 2️⃣  Translate each .en to .l1 if needed
//--------------------------------------------------------------------
export async function translateSections(sections,targetCode){
  if(!targetCode) return sections; // nothing to do

  // squash long English bodies to stay inside cheap‑model limits
  sections.forEach(s=>{
    s.en = trimToTokens(MODEL_TRANSLATE,s.en,MAX_SECTION_TOKENS);
  });

  const sys = `Translate the field \"en\" into ${targetCode}. Return the SAME array shape with a new key l1 (translation). Leave other keys untouched.`;
  const user = JSON.stringify(sections);

  const resp = await openai.chat.completions.create({
    model: MODEL_TRANSLATE,
    temperature: 0.3,
    max_tokens: 2048,
    messages:[{role:'system',content:sys},{role:'user',content:user}],
  });
  return safeJsonParse(resp.choices[0].message.content.trim());
}
//--------------------------------------------------------------------
// 3️⃣  Public handler (Express style)
//--------------------------------------------------------------------
export async function handler(req,res){
  try{
    const {referenceText, azureResult, firstLang='' } = req.body;
    const englishSections = await buildEnglishSections({referenceText, azureJson:azureResult});
    const finalSections   = await translateSections(englishSections, mapLang(firstLang));
    res.json({sections:finalSections});
  }catch(err){
    console.error(err);
    res.status(500).json({error:String(err)});
  }
}
//--------------------------------------------------------------------
// 🔸  Utility helpers
//--------------------------------------------------------------------
function safeJsonParse(str){
  try{ return JSON.parse(str); }catch{ throw new Error('Model did not return valid JSON'); }
}

function trimToTokens(model,str,max){
  const enc = getEncoding(model);
  let tokens = enc.encode(str);
  if(tokens.length<=max) return str;
  tokens = tokens.slice(0,max-1);
  return enc.decode(tokens)+"…";
}

// Map your <select id="l1Select"> value to an ISO language code the translator understands
function mapLang(code){
  const table={ko:'Korean',ar:'Arabic',pt:'Portuguese',ja:'Japanese',fr:'French',ru:'Russian',de:'German',es:'Spanish',zh:'Chinese (Mandarin)',hi:'Hindi',mr:'Marathi'};
  return table[code]||''; // empty string ➜ no translation
}

// -----------------------------------------------------------------------------
//  End of file – drop this into /api/pronunciation.js (or .ts) and wire it up
// -----------------------------------------------------------------------------
