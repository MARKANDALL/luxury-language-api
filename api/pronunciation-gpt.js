// api/pronunciation-gpt.js
// GPT-powered pronunciation feedback, multi-section, token-safe, multi-lingual

import OpenAI from "openai";

// Load tiktoken safely (with fallback)
let encoding_for_model, safeTokenCount;
try {
  ({ encoding_for_model } = await import("@dqbd/tiktoken"));
  safeTokenCount = (model, str) =>
    encoding_for_model(model).encode(str).length;
} catch {
  // fallback: crude ~4 chars/token
  console.warn("[WARN] tiktoken not found – using rough count");
  safeTokenCount = (_model, str) => Math.ceil(str.length / 4);
}

// ---------------------------------------------------------------------
// Config & helpers
// ---------------------------------------------------------------------
const MODEL_SECTIONS = process.env.MODEL_SECTIONS || "gpt-4o";
const MODEL_TRANSLATE = process.env.MODEL_TRANSLATE || "gpt-4o-mini";
const MAX_SECTION_TOKENS = +(process.env.MAX_SECTION_TOKENS || 250); // per section
const MAX_PROMPT_TOKENS = +(process.env.MAX_PROMPT_TOKENS || 13500); // for prompt

const openai = new OpenAI();

// Trim a string to max tokens for a given model
function trimToTokens(model, str, max) {
  const enc = encoding_for_model ? encoding_for_model(model) : null;
  if (!enc) return str.slice(0, max * 4) + "…";
  let tokens = enc.encode(str);
  if (tokens.length <= max) return str;
  tokens = tokens.slice(0, max - 1);
  return enc.decode(tokens) + "…";
}

// Safe JSON parse with error
function safeJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    throw new Error("Model did not return valid JSON");
  }
}

// Map code to language name for translation
function mapLang(code) {
  const table = {
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
    mr: "Marathi"
  };
  return table[code] || "";
}

// ---------------------------------------------------------------------
// 1️⃣  Build the English sections
// ---------------------------------------------------------------------
async function buildEnglishSections({ referenceText, azureJson }) {
  const sys = `You are an ESL pronunciation coach. Produce EXACTLY six JSON objects, each with keys: title, titleL1, en. Do NOT include l1 in this step. Respond ONLY with a JSON array.`;
  const user = `Reference text: "${referenceText}"
Azure JSON (shortened):\n${JSON.stringify(azureJson).slice(0, 2000)}…\n\nReturn six sections: 🎯 Quick Coaching, 🔬 Phoneme Profile, 🪜 Common Pitfalls, ⚖️ Comparisons, 🌍 Did You Know?, 🤝 Reassurance.`;

  // Token guard
  const usedTokens = safeTokenCount
    ? safeTokenCount(MODEL_SECTIONS, sys + user)
    : (sys + user).length / 4;
  if (usedTokens > MAX_PROMPT_TOKENS) {
    throw new Error(`Prompt would be ${usedTokens} tokens – clip or split first.`);
  }

  const resp = await openai.chat.completions.create({
    model: MODEL_SECTIONS,
    response_format: { type: "json_array" },
    temperature: 0.7,
    max_tokens: 4096,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });

  const raw = resp.choices[0].message.content.trim();
  const parsed = safeJSON(raw);
  if (!Array.isArray(parsed)) throw new Error("GPT did not return an array");
  return parsed;
}

// ---------------------------------------------------------------------
// 2️⃣  Translate the English sections (only if needed)
// ---------------------------------------------------------------------
async function translateSections(sections, targetCode) {
  // If nothing to translate or the input isn’t an array, exit early
  if (!targetCode || !Array.isArray(sections)) return sections;

  // truncate long English bodies to stay inside cheap-model limits
  sections.forEach(sec => {
    sec.en = trimToTokens(MODEL_TRANSLATE, sec.en, MAX_SECTION_TOKENS);
  });

  const sys = `Translate the field "en" into ${targetCode}. 
Return the SAME array shape with a new key l1 (translation). 
Leave other keys untouched.`;
  const user = JSON.stringify(sections);

  const resp = await openai.chat.completions.create({
    model: MODEL_TRANSLATE,
    response_format: { type: "json_array" },
    temperature: 0.3,
    max_tokens: 2048,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });

  return safeJSON(resp.choices[0].message.content.trim());
}

// ---------------------------------------------------------------------
// 3️⃣  Public API handler (Vercel)
// ---------------------------------------------------------------------
export default async function handler(req, res) {
  // CORS headers for browser fetches
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  try {
    const { referenceText, azureResult, firstLang = "" } = req.body;
    const englishSections = await buildEnglishSections({
      referenceText,
      azureJson: azureResult
    });
    const finalSections = await translateSections(
      englishSections,
      mapLang(firstLang)
    );
    res.json({ sections: finalSections });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
}
