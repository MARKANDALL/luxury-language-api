// api/pronunciation-gpt.js
//
//  Backend helper for pronunciation feedback
//  • Calculates token counts with @dqbd/tiktoken
//  • Builds English feedback with GPT-4o
//  • Optionally translates with GPT-4o-mini
//  • Adds CORS headers so the browser can fetch it
//------------------------------------------------------------------

import OpenAI from 'openai';
import { encoding_for_model } from '@dqbd/tiktoken';

// ───────── Config ────────────────────────────────────────────────
const MODEL_SECTIONS   = process.env.MODEL_SECTIONS  || 'gpt-4o';
const MODEL_TRANSLATE  = process.env.MODEL_TRANSLATE || 'gpt-4o-mini';
const MAX_SECTION_TOK  = +(process.env.MAX_SECTION_TOKENS  || 250);   // per section, per lang
const MAX_PROMPT_TOK   = +(process.env.MAX_PROMPT_TOKENS   || 13500); // safety: 16k-128k ctx

const openai = new OpenAI();

// ───────── Token helpers ─────────────────────────────────────────
const cache = new Map();
function countTok(model, str) {
  if (!cache.has(model)) cache.set(model, encoding_for_model(model));
  return cache.get(model).encode(str).length;
}
function trimTok(model, str, lim) {
  const enc = cache.get(model) || encoding_for_model(model);
  let toks = enc.encode(str);
  if (toks.length <= lim) return str;
  toks = toks.slice(0, lim - 1);
  return enc.decode(toks) + '…';
}

// ───────── Section builder ───────────────────────────────────────
async function buildEnglish(referenceText, azureJson) {
  const sys =
    'You are an ESL pronunciation coach. Respond ONLY with valid JSON.';
  const user = `Reference text: "${referenceText}"
Azure JSON (truncated):\n${JSON.stringify(azureJson).slice(0, 2000)}…
Return an array of EXACTLY six objects (title, titleL1, en).`;

  if (countTok(MODEL_SECTIONS, sys + user) > MAX_PROMPT_TOK)
    throw new Error('Prompt too long; clip first.');

  const { choices } = await openai.chat.completions.create({
    model: MODEL_SECTIONS,
    temperature: 0.7,
    response_format: { type: 'json_object' }, // <= forces JSON
    max_tokens: 4096,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ]
  });
  return JSON.parse(choices[0].message.content);
}

// ───────── Translator ────────────────────────────────────────────
async function translate(sections, target) {
  if (!target) return sections;

  sections.forEach(s => {
    s.en = trimTok(MODEL_TRANSLATE, s.en, MAX_SECTION_TOK);
  });

  const sys = `Translate field "en" to ${target}. Return same objects with new key "l1".`;
  const user = JSON.stringify(sections);

  const { choices } = await openai.chat.completions.create({
    model: MODEL_TRANSLATE,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    max_tokens: 2048,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ]
  });
  return JSON.parse(choices[0].message.content);
}

// ───────── ISO-name map for <select id="l1Select"> ───────────────
const l1Map = {
  ko: 'Korean', ar: 'Arabic', pt: 'Portuguese', ja: 'Japanese',
  fr: 'French', ru: 'Russian', de: 'German',  es: 'Spanish',
  zh: 'Chinese (Mandarin)', hi: 'Hindi',      mr: 'Marathi'
};

// ───────── DEFAULT EXPORT FOR VERCEL ─────────────────────────────
export default async function handler(req, res) {
  // Allow browser calls from Codesandbox, localhost, etc.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { referenceText = '', azureResult = {}, firstLang = '' } = req.body;

    const english  = await buildEnglish(referenceText, azureResult);
    const finalSec = await translate(english, l1Map[firstLang]);

    res.status(200).json({ sections: finalSec });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
}
