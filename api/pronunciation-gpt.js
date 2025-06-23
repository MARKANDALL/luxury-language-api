// pronunciation-gpt.js — backend helper for GPT-based pronunciation feedback
// -----------------------------------------------------------------------------
// Dependencies: npm install openai @dqbd/tiktoken
// -----------------------------------------------------------------------------

import OpenAI from 'openai';
import { encoding_for_model } from '@dqbd/tiktoken';  // <-- CORRECTED IMPORT

const MODEL_SECTIONS = process.env.MODEL_SECTIONS || 'gpt-4o';
const MODEL_TRANSLATE = process.env.MODEL_TRANSLATE || 'gpt-4o-mini';
const MAX_SECTION_TOKENS = +(process.env.MAX_SECTION_TOKENS || 250);
const MAX_PROMPT_TOKENS = +(process.env.MAX_PROMPT_TOKENS || 13500);

const openai = new OpenAI();

// Token-count helper
const encCache = new Map();
function getEncoding(model) {
  if (encCache.has(model)) return encCache.get(model);
  const enc = encoding_for_model(model);
  encCache.set(model, enc);
  return enc;
}

function countTokens(model, str) {
  const enc = getEncoding(model);
  return enc.encode(str).length;
}

// JSON-safe helper
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    throw new Error('Model did not return valid JSON');
  }
}

// Map language codes from frontend to translator names
function mapLang(code) {
  const table = {
    ko: 'Korean',
    ar: 'Arabic',
    pt: 'Portuguese',
    ja: 'Japanese',
    fr: 'French',
    ru: 'Russian',
    de: 'German',
    es: 'Spanish',
    zh: 'Chinese (Mandarin)',
    hi: 'Hindi',
    mr: 'Marathi',
  };
  return table[code] || '';
}

// Trim text to fit token limits
function trimToTokens(model, str, max) {
  const enc = getEncoding(model);
  let tokens = enc.encode(str);
  if (tokens.length <= max) return str;
  tokens = tokens.slice(0, max - 1);
  return enc.decode(tokens) + "…";
}

// 1️⃣ Build English feedback sections
async function buildEnglishSections({ referenceText, azureJson }) {
  const sys = `You are an ESL pronunciation coach. Produce EXACTLY six JSON objects, each with keys: title, titleL1, en. Do NOT include l1.`;
  const user = `Reference text: "${referenceText}"
Azure JSON (shortened):
${JSON.stringify(azureJson).slice(0, 2000)}…

Return six sections: 🎯 Quick Coaching, 🔬 Phoneme Profile, 🪜 Common Pitfalls, ⚖️ Comparisons, 🌍 Did You Know?, 🤝 Reassurance.`;

  const usedTokens = countTokens(MODEL_SECTIONS, sys + user);
  if (usedTokens > MAX_PROMPT_TOKENS) {
    throw new Error(`Prompt too large (${usedTokens} tokens).`);
  }

  const resp = await openai.chat.completions.create({
    model: MODEL_SECTIONS,
    temperature: 0.7,
    max_tokens: 4096,
    response_format: { type: 'json_object' }, // <-- ADDED TO GUARANTEE JSON
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
  });

  return safeJsonParse(resp.choices[0].message.content.trim());
}

// 2️⃣ Translate English to user's L1 (if requested)
async function translateSections(sections, targetCode) {
  if (!targetCode) return sections;

  sections.forEach(s => {
    s.en = trimToTokens(MODEL_TRANSLATE, s.en, MAX_SECTION_TOKENS);
  });

  const sys = `Translate the field "en" into ${targetCode}. Return the SAME array shape with a new key l1.`;
  const user = JSON.stringify(sections);

  const resp = await openai.chat.completions.create({
    model: MODEL_TRANSLATE,
    temperature: 0.3,
    max_tokens: 2048,
    response_format: { type: 'json_object' }, // <-- ALSO ADDED HERE
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
  });

  return safeJsonParse(resp.choices[0].message.content.trim());
}

// Main export function (Vercel handler)
export async function handler(req, res) {
  try {
    const { referenceText, azureResult, firstLang = '' } = req.body;
    const englishSections = await buildEnglishSections({ referenceText, azureJson: azureResult });
    const finalSections = await translateSections(englishSections, mapLang(firstLang));
    res.json({ sections: finalSections });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
}
