// pronunciation-gpt.js  (full file)
import OpenAI from "openai";
import { encoding_for_model } from "@dqbd/tiktoken";

const openai = new OpenAI();

const MODEL_SECTIONS  = process.env.MODEL_SECTIONS  || "gpt-4o";       // big
const MODEL_TRANSLATE = process.env.MODEL_TRANSLATE || "gpt-4o-mini";  // cheap
const TOK_SECT = +(process.env.MAX_SECTION_TOKENS || 250);
const TOK_PROM = +(process.env.MAX_PROMPT_TOKENS  || 13500);

// ---------- helpers ----------------------------------------------------------
const encCache = new Map();
const enc = m => {
  if (!encCache.has(m)) encCache.set(m, encoding_for_model(m));
  return encCache.get(m);
};
const count = (m, s) => enc(m).encode(s).length;
const clip  = (m, s, max) =>
  count(m, s) <= max ? s : enc(m).decode(enc(m).encode(s).slice(0, max - 1)) + "…";

const mapLang = c =>
  ({ ko:"Korean", ar:"Arabic", pt:"Portuguese", ja:"Japanese", fr:"French",
     ru:"Russian", de:"German", es:"Spanish", zh:"Chinese (Mandarin)",
     hi:"Hindi",   mr:"Marathi" }[c] || "");

// ---------- 1) English sections ---------------------------------------------
async function buildSections ({ referenceText, azureJson }) {
  const sys =
`You are an ESL pronunciation coach.
Respond ONLY with valid JSON.  ←← includes the magic word`;

  const user = `Reference text: "${referenceText}"
Azure JSON (shortened):
${JSON.stringify(azureJson).slice(0, 2000)} …
Return an ARRAY (length 6) of objects:
[{title, titleL1, en}, …] using these titles:
🎯 Quick Coaching, 🔬 Phoneme Profile, 🪜 Common Pitfalls, ⚖️ Comparisons, 🌍 Did You Know?, 🤝 Reassurance`;

  if (count(MODEL_SECTIONS, sys + user) > TOK_PROM)
    throw new Error("Prompt too large, clip first.");

  const { choices } = await openai.chat.completions.create({
    model: MODEL_SECTIONS,
    temperature: 0.7,
    max_tokens: 4096,
    response_format: { type: "json_object" },
    messages: [{ role:"system", content: sys }, { role:"user", content: user }]
  });

  const data = JSON.parse(choices[0].message.content);
  if (!Array.isArray(data)) throw new Error("Model did not return an array");
  return data;
}

// ---------- 2) translate -----------------------------------------------------
async function translate (sections, target) {
  if (!target) return sections;                 // nothing to do
  if (!Array.isArray(sections)) throw new Error("translate() expects array");

  const trimmed = sections.map(obj => ({
    ...obj,
    en: clip(MODEL_TRANSLATE, obj.en, TOK_SECT)
  }));

  const sys =
`Translate the field "en" into ${target}.
Return the SAME array shape with an added "l1" key.
Respond ONLY with valid JSON.`;                 // magic word again

  const { choices } = await openai.chat.completions.create({
    model: MODEL_TRANSLATE,
    temperature: 0.2,
    max_tokens: 2048,
    response_format: { type: "json_object" },
    messages: [{ role:"system", content: sys },
               { role:"user",   content: JSON.stringify(trimmed) }]
  });

  return JSON.parse(choices[0].message.content);
}

// ---------- 3) serverless handler -------------------------------------------
export default async function handler (req, res) {
  // CORS – allow Codesandbox
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { referenceText, azureResult, firstLang = "" } = req.body || {};
    const english = await buildSections({ referenceText, azureJson: azureResult });
    const final   = await translate(english, mapLang(firstLang));
    res.status(200).json({ sections: final });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
}
