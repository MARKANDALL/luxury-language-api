// /api/pronunciation-gpt.js
// -------------------------------------------------
export const config = { api: { bodyParser: true, externalResolver: true } };

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const universallyHard = new Set(["θ", "ð", "ɹ"]);
const langMap = {
  es: "Spanish", fr: "French", pt: "Portuguese", zh: "Chinese",
  ja: "Japanese", ko: "Korean", ar: "Arabic", ru: "Russian",
  de: "German", hi: "Hindi", mr: "Marathi",
  universal: "Universal", "": "Universal"
};

const alias = { dh: "ð", th: "θ", r: "ɹ" };
const norm  = (sym) => alias[sym] || sym;

function worstPhoneme(json) {
  const tally = {};
  json?.NBest?.[0]?.Words?.forEach((w) =>
    w.Phonemes?.forEach((p) => {
      if (p.AccuracyScore < 85) {
        const k = norm(p.Phoneme);
        tally[k] = (tally[k] || 0) + 1;
      }
    })
  );
  return Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function worstWords(json, n = 3) {
  return (json?.NBest?.[0]?.Words || [])
    .filter((w) => w.AccuracyScore < 70)
    .sort((a, b) => a.AccuracyScore - b.AccuracyScore)
    .slice(0, n)
    .map((w) => w.Word);
}

const sectionMeta = [
  { emoji: "🎯", en: "Quick Coaching",      min: 40, max: 60 },
  { emoji: "🔬", en: "Phoneme Profile",     min: 40, max: 60 },
  { emoji: "🤝", en: "Reassurance",         min: 25, max: 40 },
  { emoji: "🪜", en: "Common Pitfalls",     min: 40, max: 55 },
  { emoji: "💪", en: "L1 Super-Power",      min: 25, max: 40 },
  { emoji: "🧠", en: "Did You Know?",       min: 25, max: 30 },
  { emoji: "🌍", en: "L1 Spotlight",        min: 30, max: 50 }
];

export default async function handler(req, res) {
  // Bulletproof CORS setup
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  try {
    const { referenceText, azureResult, firstLang = "" } = req.body;

    const targetLangCode = firstLang.trim().toLowerCase();
    const l1Label = langMap[targetLangCode] || "Universal";

    const worst = worstPhoneme(azureResult);
    const badList = worstWords(azureResult);
    const universal = universallyHard.has(worst);

    const rangesStr = sectionMeta
      .map((s, i) => `${i + 1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} words`)
      .join("\n");

    const systemPrompt = `
You are the best bilingual pronunciation coach. Respond ONLY with valid JSON exactly matching this structure:

{
  "sections":[
    { "title":"", "titleL1":"", "en":"", "l1":"" }, (exactly 7 sections)
  ]
}

Use these 7 section titles, with emoji and translate titles into learner's first language (omit emojis from translations):

${rangesStr}

IMPORTANT:
- Strictly respect the word limits.
- Return complete valid JSON only, no text outside JSON.
- If firstLang is "Universal", leave "l1" fields empty.
`.trim();

    const userPrompt = {
      worstPhoneme: worst,
      worstWords: badList,
      sampleText: referenceText,
      universal,
      firstLang: targetLangCode,
      l1Label
    };

    let attempts = 0;
    const maxRetries = 2;
    let payload;

    while (attempts <= maxRetries) {
      attempts++;
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.55,
        max_tokens: 950, // slightly reduced for reliability
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(userPrompt) }
        ]
      });

      const textResponse = completion.choices[0].message.content;

      try {
        payload = JSON.parse(textResponse);
        if (Array.isArray(payload.sections) && payload.sections.length === 7) {
          return res.status(200).json(payload);  // Success case
        } else {
          throw new Error("Invalid JSON structure or missing sections.");
        }
      } catch (error) {
        console.error(`Attempt ${attempts} - JSON parse error:`, error.message, textResponse);
        if (attempts > maxRetries) {
          return res.status(500).json({
            error: "GPT JSON parsing failed after retries.",
            details: error.message,
            rawResponse: textResponse
          });
        }
      }
    }
  } catch (e) {
    console.error("[pronunciation-gpt.js] General error:", e);
    res.status(500).json({ error: "AI feedback failed.", details: e.message });
  }
}
