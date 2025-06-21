// /api/pronunciation-gpt.js

export const config = {
  api: { bodyParser: true, externalResolver: true }
};

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Set of universally difficult sounds
const universallyHard = new Set([
  "θ", "ð", "ɹ"
]);

// Map for major world languages, used for section labels and translation
const langMap = {
  "es": "Spanish",
  "fr": "French",
  "pt": "Portuguese",
  "zh": "Mandarin Chinese",
  "ja": "Japanese",
  "ko": "Korean",
  "ar": "Arabic",
  "ru": "Russian",
  "de": "German",
  "hi": "Hindi",
  "mr": "Marathi",
  "universal": "Universal (all learners)",
  "": ""
};

function guessLikelyL1(ipa) {
  const map = {
    "θ": "Spanish, French, Portuguese, German, Arabic, Japanese, Chinese, Russian, Hindi, Korean",
    "ð": "Spanish, French, Portuguese, German, Arabic, Japanese, Chinese, Russian, Hindi, Korean",
    "ɹ": "Japanese, Korean, Russian, German, French, Chinese, Arabic, Spanish, Portuguese, Hindi",
    "l": "Japanese, Korean, Chinese, Hindi",
    "w": "German, Japanese, Korean, Chinese, Russian, Arabic",
    "v": "Spanish, Japanese, Korean, Arabic, Hindi, Portuguese",
    "ʃ": "Spanish, Portuguese, Japanese, Chinese, Arabic, Russian",
    "tʃ": "Spanish, Portuguese, French, Arabic, Japanese, Russian, Chinese, Korean",
    "dʒ": "Japanese, Russian, Chinese, Portuguese, Hindi, Arabic, Korean",
    "z": "Japanese, Chinese, Korean, Arabic, Portuguese",
    "s": "Portuguese, Japanese, Chinese, Russian",
    "ŋ": "French, Japanese, Russian, Spanish, Hindi, Arabic, Chinese",
    "h": "French, Japanese, Russian, Spanish, Portuguese, Chinese, Hindi",
    "f": "Japanese, Korean, Arabic, Hindi, Russian, Chinese",
    "u": "Japanese, Chinese, Spanish, Portuguese, Russian",
  };
  return map[ipa] || "Portuguese, Arabic, Korean, Russian, French, Japanese, Spanish, German, Hindi, and Chinese";
}

function norm(sym) {
  const alias = { dh: "ð", th: "θ", r: "ɹ" };
  return alias[sym] || sym;
}
function findWorstPhoneme(res) {
  const tally = {};
  res?.NBest?.[0]?.Words?.forEach(w =>
    w.Phonemes?.forEach(p => {
      if (p.AccuracyScore < 85) {
        const k = norm(p.Phoneme);
        tally[k] = (tally[k] || 0) + 1;
      }
    })
  );
  return Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}
function findWorstWords(res, n = 3) {
  return (res?.NBest?.[0]?.Words || [])
    .filter(w => w.AccuracyScore < 70)
    .sort((a, b) => a.AccuracyScore - b.AccuracyScore)
    .slice(0, n)
    .map(w => w.Word);
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // --- Handle preflight CORS ---
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }
  // --- CORS for the actual POST response
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    // Get all POST fields
    const { referenceText, azureResult, firstLang = "" } = req.body;

    const worst   = findWorstPhoneme(azureResult);      // e.g. "θ"
    const badList = findWorstWords(azureResult);
    const l1Guess = guessLikelyL1(worst);
    const isUniversal = universallyHard.has(worst);

    // Section label helper for L1
    const l1Label = langMap[firstLang] || (firstLang ? firstLang : "Universal");

    // Compose the SYSTEM PROMPT:
    const systemPrompt = `
You are an expert American-English pronunciation coach and linguist.

Generate feedback for a language learner, interleaving English and their first language (L1) for each section, as described below.

**SECTION RULES:**
- For EACH section, always show the English version first, then on the next line, the L1 translation in this format: <span style="color:#888;font-style:italic">L1 translation here.</span>
- Never put all English and then all L1 at the bottom; always alternate section by section.
- If no L1 is provided, or the L1 is not supported, ONLY show the English.
- Do NOT use auto-detect—use the exact language code provided.

**FEEDBACK SECTIONS:**
Respond in these sections, always with the specified headings:

## 🎯 Quick Coaching
## 🔬 Phoneme Profile
## 🤝 Reassurance
## 🪜 Common Pitfalls for ${firstLang || "Universal"}
## 💪 ${firstLang || "Universal"} Super-Power
## 🧠 Did You Know?
## 🌍 ${firstLang || "Universal"} Spotlight

**FORMATTING:**
- Each section: max 2 sentences per language, clear and concise.
- Show the English first, then the translation as described.
- If you do not support the selected L1, skip the translation for that section.
- For code, use only markdown and inline HTML (no extra spaces, no double breaks).

**TRANSLATE the English into the following target language code:** "${firstLang || ""}"

- For each heading, present English first, then the L1 translation line with the inline style.
- Do not introduce or explain the sections; just show the headings and the text, alternated as described.

**Total output length ≤ 180 words.**
    `.trim();

    const userMsg = `
JSON input:
{
  "worstPhoneme": "${worst}",
  "worstWords": ${JSON.stringify(badList)},
  "sampleText": ${JSON.stringify(referenceText)},
  "isUniversallyDifficult": ${isUniversal},
  "firstLang": "${firstLang}",
  "l1Label": "${l1Label}",
  "l1Guess": "${l1Guess}"
}
    `.trim();

    // Call GPT-4o-mini for cost-effective feedback
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // cheaper, but excellent at this
      temperature: 0.6,
      max_tokens: 850,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userMsg }
      ]
    });

    // Return markdown for rendering
    res.status(200).json({ feedback: completion.choices[0].message.content });
  } catch (err) {
    console.error("pronunciation-gpt error:", err);
    res.status(500).json({ error: "AI feedback failed to generate." });
  }
}
