// /api/pronunciation-gpt.js

export const config = {
  api: { bodyParser: true, externalResolver: true }
};

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const L1_MAP = {
  ko: "Korean",
  ar: "Arabic",
  pt: "Portuguese",
  ja: "Japanese",
  fr: "French",
  ru: "Russian",
  de: "German",
  es: "Spanish",
  zh: "Mandarin Chinese",
  hi: "Hindi",
  mr: "Marathi",
  universal: "Universal (all learners)",
  "": "",
};

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

const universallyHard = new Set(["θ", "ð", "ɹ"]);
function guessLikelyL1(ipa) {
  const map = {
    "θ": "Spanish, French, Portuguese, German, Arabic, Japanese, Chinese, Russian, Hindi, Korean",
    "ð": "Spanish, French, Portuguese, German, Arabic, Japanese, Chinese, Russian, Hindi, Korean",
    "ɹ": "Japanese, Korean, Russian, German, French, Chinese, Arabic, Spanish, Portuguese, Hindi",
  };
  return map[ipa] || "Portuguese, Arabic, Korean, Russian, French, Japanese, Spanish, German, Hindi, and Chinese";
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    const {
      referenceText = "",
      azureResult,
      firstLang = "",
    } = req.body;

    const l1Code = firstLang || req.body.l1 || req.body.l1Code || "";
    const l1Name = L1_MAP[l1Code] || l1Code || "Universal";
    const worstPhoneme = findWorstPhoneme(azureResult);
    const worstWords = findWorstWords(azureResult);
    const isUniversal = universallyHard.has(worstPhoneme);

    // 1. English Feedback
    const systemPrompt = `
You are an expert American-English pronunciation coach.
Respond in detailed, concise, user-friendly markdown with these sections:

### 🎯 Quick Coaching
### 🔬 Phoneme Profile
### 🤝 Reassurance
### 🪜 Common Pitfalls for ${l1Name}
### 💪 ${l1Name} Super-Power
### 🧠 Did You Know?
### 🌍 ${l1Name} Spotlight

Base all guidance on the user's worst phoneme: "${worstPhoneme}", these words: ${JSON.stringify(worstWords)}, and their first language: "${l1Name}".
Keep it ≤ 180 words per section.
If their L1 is "Universal" or blank, use general tips.
`;

    const userPrompt = `
Input:
{
  "worstPhoneme": "${worstPhoneme}",
  "worstWords": ${JSON.stringify(worstWords)},
  "sampleText": ${JSON.stringify(referenceText)},
  "isUniversallyDifficult": ${isUniversal},
  "firstLang": "${l1Code}",
  "firstLangName": "${l1Name}"
}
`.trim();

    // 1st Call: English output
    const feedbackRes = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.7,
      max_tokens: 700,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt }
      ],
    });

    const feedbackMarkdown = feedbackRes.choices[0].message.content;

    // 2. Translate to L1 if needed
    let translationMarkdown = "";
    if (l1Code && l1Code !== "universal" && l1Code !== "") {
      const translatePrompt = `
You are a professional linguist and translator.

- Translate the following markdown feedback to ${l1Name}.
- Retain the markdown structure and ALL section headings.
- Do not translate words or sounds in quotation marks or IPA.
- If the section heading mentions "${l1Name}", do not translate the heading.
- Do NOT use any language other than ${l1Name}.
- If you cannot translate, return "(translation unavailable)" under each section.

--- BEGIN MARKDOWN ---

${feedbackMarkdown}

--- END MARKDOWN ---
      `.trim();

      const translationRes = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.6,
        max_tokens: 850,
        messages: [
          { role: "system", content: translatePrompt }
        ]
      });
      translationMarkdown = translationRes.choices[0].message.content;
    }

    res.status(200).json({
      english: feedbackMarkdown,
      l1: translationMarkdown,
      l1Code,
      l1Name,
    });
  } catch (err) {
    console.error("pronunciation-gpt error:", err);
    res.status(500).json({ error: "AI feedback failed to generate." });
  }
}
