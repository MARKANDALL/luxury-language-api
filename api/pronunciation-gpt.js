// ---------------------------------------------------------------------------
//  api/pronunciation-gpt.js
//  Generates 6 ESL-pronunciation feedback sections, optionally translates them.
//  Uses GPT-4o for content, GPT-4o-mini for translation.
// ---------------------------------------------------------------------------

import OpenAI from "openai";
import { encoding_for_model } from "@dqbd/tiktoken";

// ---------- config ---------------------------------------------------------
const MODEL_SECTIONS   = process.env.MODEL_SECTIONS  || "gpt-4o";       // big ctx
const MODEL_TRANSLATE  = process.env.MODEL_TRANSLATE || "gpt-4o-mini";  // cheap
const MAX_SEC_TOKENS   = +(process.env.MAX_SECTION_TOKENS || 250);      // per sec
const MAX_PROMPT_TOK   = +(process.env.MAX_PROMPT_TOKENS  || 13500);

const openai = new OpenAI();

// ---------- token helpers --------------------------------------------------
const encCache = new Map();
function countTokens(model, str) {
  const enc =
    encCache.get(model) ?? encCache.set(model, encoding_for_model(model)).get(model);
  return enc.encode(str).length;
}
function trimToTokens(model, str, max) {
  const enc =
    encCache.get(model) ?? encCache.set(model, encoding_for_model(model)).get(model);
  let ids = enc.encode(str);
  if (ids.length <= max) return str;
  ids = ids.slice(0, max - 1);
  return enc.decode(ids) + "…";
}

// ---------- build EN sections ---------------------------------------------
async function buildSections({ referenceText, azureJson }) {
  const system = `You are an ESL pronunciation coach.
Return **one JSON object** with a single key "sections".
"sections" must be an array with exactly six items and each item must have:
"title", "titleL1", "en" (English body). Do NOT include any other keys.`;

  const user = `Reference text: "${referenceText}"
Azure JSON (truncated): ${JSON.stringify(azureJson).slice(0, 2000)} …
Provide the six sections in this order:
1 🎯 Quick Coaching
2 🔬 Phoneme Profile
3 🪜 Common Pitfalls
4 ⚖️ Comparisons
5 🌍 Did You Know?
6 🤝 Reassurance`;

  // guard prompt length
  const used = countTokens(MODEL_SECTIONS, system + user);
  if (used > MAX_PROMPT_TOK)
    throw new Error(`Prompt would be ${used} tokens (>${MAX_PROMPT_TOK})`);

  const resp = await openai.chat.completions.create({
    model: MODEL_SECTIONS,
    temperature: 0.6,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const raw = resp.choices[0].message.content.trim();
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.sections))
    throw new Error("Model did not return sections array");
  return parsed.sections;
}

// ---------- optional translation ------------------------------------------
async function translateSections(sections, target) {
  if (!target || !Array.isArray(sections)) return sections; // nothing to do

  // squash long English
  sections.forEach((s) => (s.en = trimToTokens(MODEL_TRANSLATE, s.en, MAX_SEC_TOKENS)));

  const sys = `Translate ONLY the "en" field of each object to ${target}.
Respond with the same top-level array shape, adding a new key "l1"
for the translation. Leave all other fields untouched.`;
  const resp = await openai.chat.completions.create({
    model: MODEL_TRANSLATE,
    temperature: 0.3,
    max_tokens: 2048,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify(sections) },
    ],
  });
  const out = JSON.parse(resp.choices[0].message.content.trim());
  return Array.isArray(out) ? out : sections;
}

// ---------- simple L1 map --------------------------------------------------
const L1_MAP = {
  ko: "Korean",
  ar: "Arabic",
  pt: "Portuguese",
  ja: "Japanese",
  fr: "French",
  ru: "Russian",
  de: "German",
  es: "Spanish",
  zh: "Chinese (Mandarin)",
  hi: "Hindi",
  mr: "Marathi",
};

// ---------- Vercel / Express style handler --------------------------------
export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      // CORS pre-flight
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      return res.status(200).end();
    }

    const { referenceText = "", azureResult = {}, firstLang = "" } = req.body || {};

    const enSections = await buildSections({ referenceText, azureJson: azureResult });
    const final = await translateSections(enSections, L1_MAP[firstLang]);

    res.setHeader("Access-Control-Allow-Origin", "*"); // CORS for browser
    return res.status(200).json({ sections: final });
  } catch (err) {
    console.error(err);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).json({ error: String(err) });
  }
}
