// /api/pronunciation-gpt.js

export const config = {
  api: { bodyParser: true, externalResolver: true }
};

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const universallyHard = new Set(["θ", "ð", "ɹ"]);

function guessLikelyL1(ipa) {
  const map = {
    "θ": "Spanish, French, Portuguese, German, Arabic, Japanese, Chinese, Russian, Hindi, Korean",
    "ð": "Spanish, French, Portuguese, German, Arabic, Japanese, Chinese, Russian, Hindi, Korean",
    "ɹ": "Japanese, Korean, Russian, German, French, Chinese, Arabic, Spanish, Portuguese, Hindi",
    // add others as needed...
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
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  if (req.method !== "POST")
    return res.status(405).json({ error: "Only POST" });

  // CORS for the actual POST response
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    const { referenceText, azureResult, firstLang = "" } = req.body;
    const worst   = findWorstPhoneme(azureResult);
    const badList = findWorstWords(azureResult);
    const l1Guess = guessLikelyL1(worst);
    const isUniversal = universallyHard.has(worst);

    // MAIN ENGLISH FEEDBACK
    const systemPrompt = `
You are a friendly American-English pronunciation coach AND linguistics nerd.

Create feedback as a set of clear markdown sections, **customized for the user's first language if provided (use language code: "${firstLang}")**. 
Include as much cross-linguistic and phonetic insight as possible, relating English sounds to ${firstLang || "universal learners"}.

Return these sections:
1. 🎯 Quick Coaching
2. 🔬 Phoneme Profile
3. 🤝 Reassurance (make it L1-specific; mention common errors speakers of "${firstLang}" make with "${worst}")
4. 🪜 Common Pitfalls for "${firstLang || "universal"}"
5. 💪 "${firstLang || "Universal"}" Super-Power
6. 🧠 Did You Know?
7. 🌍 "${firstLang || "Universal"}" Spotlight

All sections ≤130 words each, in **English**. Keep the advice extremely relevant for speakers of "${firstLang || "universal"}".
    `.trim();

    const userMsg = `
JSON input:
{
  "worstPhoneme": "${worst}",
  "worstWords": ${JSON.stringify(badList)},
  "sampleText": ${JSON.stringify(referenceText)},
  "isUniversallyDifficult": ${isUniversal}
}
    `.trim();

    // 1. Main feedback (English)
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.7,
      max_tokens: 600,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userMsg }
      ]
    });

    const feedback = completion.choices[0].message.content;

    // 2. Translation, only if user picked a language
    let translated = "";
    if (firstLang && !["universal", ""].includes(firstLang)) {
      // Compose a prompt for translation
      const translatePrompt = `
Translate the following English text into the language indicated by this language code: "${firstLang}".
Keep the formatting, and make the translation natural and clear for a language learner. Do not add explanations.

English text:
${feedback}
      `.trim();

      // Use GPT-4o-mini for translation (much cheaper)
      const translationResult = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.4,
        max_tokens: 900,
        messages: [
          { role: "system", content: "You are a professional translator." },
          { role: "user",   content: translatePrompt }
        ]
      });
      translated = translationResult.choices[0]?.message?.content?.trim() || "";
    }

    // Return both English and L1 translation
    res.status(200).json({
      feedback,      // Always in English
      translation: translated // In L1 if provided, else ""
    });
  } catch (err) {
    console.error("pronunciation-gpt error:", err);
    res.status(500).json({ error: "AI feedback failed to generate." });
  }
}
