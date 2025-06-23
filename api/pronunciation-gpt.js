// api/pronunciation-gpt.js  ---------------------------------------------------
// 1) counts tokens safely
// 2) builds six English sections with GPT-4o
// 3) cheaply translates with GPT-4o-mini
// 4) answers CORS pre-flights
// ---------------------------------------------------------------------------

import OpenAI from 'openai';

// ─────────────────────────────────────────────────────────────────────────────
// Try to load tiktoken; fall back to rough estimate if not present
let tokenCount;
try {
  const { encoding_for_model } = await import('tiktoken');
  const encCache = new Map();
  tokenCount = (model, str) => {
    if (!encCache.has(model)) encCache.set(model, encoding_for_model(model));
    return encCache.get(model).encode(str).length;
  };
} catch {
  console.warn('[WARN] tiktoken missing – using rough ¼-chars heuristic');
  tokenCount = (_m, str) => Math.ceil(str.length / 4);
}
// ─────────────────────────────────────────────────────────────────────────────

const openai = new OpenAI();

const MODEL_SECTIONS   = process.env.MODEL_SECTIONS   || 'gpt-4o';
const MODEL_TRANSLATE  = process.env.MODEL_TRANSLATE  || 'gpt-4o-mini';
const MAX_SECTION_TOK  = +(process.env.MAX_SECTION_TOKENS  || 250);
const MAX_PROMPT_TOK   = +(process.env.MAX_PROMPT_TOKENS   || 13500);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mapLang = (code)=>({
  ko:'Korean', ar:'Arabic', pt:'Portuguese', ja:'Japanese', fr:'French',
  ru:'Russian', de:'German', es:'Spanish', zh:'Chinese (Mandarin)',
  hi:'Hindi', mr:'Marathi'
}[code]||'');

const safeJSON = (txt)=>{
  try{ return JSON.parse(txt); }
  catch(e){ throw new Error('Model did not return valid JSON'); }
};

const trimToTokens = (model,str,max)=>{
  const toks = tokenCount(model,str);
  if (toks <= max) return str;
  // keep ~max-1 tokens
  const sliceLen = Math.floor(str.length * (max-1)/toks);
  return str.slice(0,sliceLen) + '…';
};

// ---------------------------------------------------------------------------
// 1⃣  Build English feedback
// ---------------------------------------------------------------------------
async function buildEnglish({referenceText, azureJson}){
  const sys = `You are an ESL pronunciation coach.
Return EXACTLY six JSON objects in an array.
Keys: title, titleL1, en.  Do NOT include "l1" now.`;
  const user = `Reference text: "${referenceText}"
Azure JSON (truncated):\n${JSON.stringify(azureJson).slice(0,2000)}\n
Sections required (use these emojis):
🎯 Quick Coaching, 🔬 Phoneme Profile, 🪜 Common Pitfalls,
⚖️ Comparisons, 🌍 Did You Know?, 🤝 Reassurance`;

  const used = tokenCount(MODEL_SECTIONS, sys + user);
  if (used > MAX_PROMPT_TOK)
    throw new Error(`Prompt would be ${used} tokens – shorten first.`);

  const {choices:[{message:{content}}]} =
    await openai.chat.completions.create({
      model: MODEL_SECTIONS,
      temperature: 0.7,
      max_tokens: 4096,
      messages:[{role:'system',content:sys},{role:'user',content:user}]
    });

  return safeJSON(content.trim());
}

// ---------------------------------------------------------------------------
// 2⃣  Translate into l1 when needed
// ---------------------------------------------------------------------------
async function translateSections(sections,target){
  if (!target) return sections;

  // clip overly long English chunks
  sections.forEach(s=>{
    s.en = trimToTokens(MODEL_TRANSLATE,s.en,MAX_SECTION_TOK);
  });

  const sys = `Translate the field "en" into ${target}.
Return the SAME array with a new field "l1".`;
  const user = JSON.stringify(sections);

  const {choices:[{message:{content}}]} =
    await openai.chat.completions.create({
      model: MODEL_TRANSLATE,
      temperature: 0.3,
      max_tokens: 2048,
      messages:[{role:'system',content:sys},{role:'user',content:user}]
    });

  return safeJSON(content.trim());
}

// ---------------------------------------------------------------------------
// 3⃣  Vercel / Express handler
// ---------------------------------------------------------------------------
function setCORS(res){
  res.setHeader('Access-Control-Allow-Origin','*');            // adjust if needed
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
}

export default async function handler(req,res){
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try{
    const {referenceText='', azureResult={}, firstLang=''} = req.body||{};
    const eng = await buildEnglish({referenceText, azureJson:azureResult});
    const out = await translateSections(eng, mapLang(firstLang));
    res.json({sections:out});
  }catch(err){
    console.error(err);
    res.status(500).json({error:String(err)});
  }
}

// ---------------------------------------------------------------------------
// End of file
// ---------------------------------------------------------------------------
