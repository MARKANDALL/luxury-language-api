// api/pronunciation-gpt.js
//
// 1) makes the six English feedback sections            (GPT-4o 128k)
// 2) optionally translates them to the learner’s L1     (GPT-4o-mini)
// ---------------------------------------------------------------------
import OpenAI from "openai";
import { encoding_for_model } from "@dqbd/tiktoken";

// ────────────────────────────────────────────────────────────
// Config (env vars give you overrides in Vercel dashboard)
// ────────────────────────────────────────────────────────────
const MODEL_SECTIONS  = process.env.MODEL_SECTIONS  || "gpt-4o";
const MODEL_TRANSLATE = process.env.MODEL_TRANSLATE || "gpt-4o-mini";
const MAX_SECTION_TOKENS = +(process.env.MAX_SECTION_TOKENS || 250);
const MAX_PROMPT_TOKENS  = +(process.env.MAX_PROMPT_TOKENS  || 13500);

const openai = new OpenAI();

// Small tokenizer helpers -----------------------------------
const encCache = new Map();
function enc(model) {
  if (encCache.has(model)) return encCache.get(model);
  const e = encoding_for_model(model);
  encCache.set(model, e);
  return e;
}
const tokens = (model, text) => enc(model).encode(text).length;
// -----------------------------------------------------------

// 1️⃣ Build the six English-only sections
async function buildEnglish({ referenceText, azureJson }) {
  const sys =
    "You are an ESL pronunciation coach. Return EXACTLY SIX JSON " +
    "objects in an array. Each object has keys: title, titleL1, en. " +
    "Do NOT include any translations in this step.";
  const user = `Reference text: "${referenceText}"
Azure JSON (shortened): ${JSON.stringify(azureJson).slice(0, 2000)}…
Return sections in this order:
🎯 Quick Coaching
🔬 Phoneme Profile
🪜 Common Pitfalls
⚖️ Comparisons
🌍 Did You Know?
🤝 Reassurance`;

  // guard against runaway prompts
  if (tokens(MODEL_SECTIONS, sys + user) > MAX_PROMPT_TOKENS) {
    throw new Error("Prompt too large – clip the Azure JSON first.");
  }

  const resp = await openai.chat.completions.create({
    model: MODEL_SECTIONS,
    temperature: 0.7,
    max_tokens: 4096,
    response_format: { type: "json_array" }, // <─── FORCE ARRAY
    messages: [
      { role: "system", content: sys },
      { role: "user",   content: user },
    ],
  });

  const raw = resp.choices[0].message.content.trim();
  const parsed = JSON.parse(raw);

  // If the model ignored us & sent an object, salvage it:
  return Array.isArray(parsed) ? parsed : Object.values(parsed);
}

// 2️⃣ Translate *.en → *.l1 (if learner picked a first-language)
async function translate(sections, targetLang) {
  if (!targetLang) return sections; // nothing to do

  // trim very long English paragraphs so cheap model never overflows
  sections.forEach(s => {
    const toks = enc(MODEL_TRANSLATE).encode(s.en);
    if (toks.length > MAX_SECTION_TOKENS) {
      s.en = enc(MODEL_TRANSLATE).decode(toks.slice(0, MAX_SECTION_TOKENS - 1)) + "…";
    }
  });

  const sys = `Translate the field "en" into ${targetLang}. 
Return the SAME array shape, adding a key l1.`;
  const resp = await openai.chat.completions.create({
    model: MODEL_TRANSLATE,
    temperature: 0.3,
    max_tokens: 2048,
    response_format: { type: "json_array" },
    messages: [
      { role: "system", content: sys },
      { role: "user",   content: JSON.stringify(sections) },
    ],
  });

  return JSON.parse(resp.choices[0].message.content.trim());
}

// Helper to map dropdown value -> language name
const LANGS = {
  ko: "Korean", ar: "Arabic", pt: "Portuguese", ja: "Japanese",
  fr: "French", ru: "Russian", de: "German",    es: "Spanish",
  zh: "Chinese (Mandarin)", hi: "Hindi", mr: "Marathi",
};
const mapLang = code => LANGS[code] || "";

// ------------------------------------------------------------------
// 3️⃣  **Default export** -- the Vercel Edge Function handler
// ------------------------------------------------------------------
export default async function handler(req, res) {
  // CORS pre-flight  ────────────────────────────────
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    return res.status(200).end();
  }

  try {
    const { referenceText, azureResult, firstLang = "" } = req.body;

    const english = await buildEnglish({ referenceText, azureJson: azureResult });
    const final   = await translate(english, mapLang(firstLang));

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    res.status(200).json({ sections: final });
  } catch (err) {
    console.error(err);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).json({ error: String(err) });
  }
}
