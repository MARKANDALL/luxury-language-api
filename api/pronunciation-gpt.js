// /api/pronunciation-gpt.js

export const config = {
  api: { bodyParser: true, externalResolver: true }
};

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 1. Add “universally difficult” sounds
const universallyHard = new Set([
  "θ", "ð", "ɹ" // TH (think/this) and American R
]);

// 2. Make a broad IPA-to-L1-language map (include all major world languages)
function guessLikelyL1(ipa) {
  const map = {
    "θ": "Spanish, French, Portuguese, German, Arabic, Japanese, Chinese, Russian, Hindi, Korean",
    "ð": "Spanish, French, Portuguese, German, Arabic, Japanese, Chinese, Russian, Hindi, Korean",
    "ɹ": "Japanese, Korean, Russian, German, French, Chinese, Arabic, Spanish, Portuguese, Hindi", // American R
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
    // Feel free to expand further!
  };
  // Always return at least all top world languages for missing keys
  return map[ipa] || "Portuguese, Arabic, Korean, Russian, French, Japanese, Spanish, German, Hindi, and Chinese";
}

// 3. Utility: Normalize phoneme keys if needed (e.g., th/dh → θ/ð)
function norm(sym) {
  const alias = { dh: "ð", th: "θ", r: "ɹ" }; // extend as needed
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

// 4. Handler
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
    const { referenceText, azureResult } = req.body;
    const worst   = findWorstPhoneme(azureResult);      // e.g. "θ"
    const badList = findWorstWords(azureResult);        // ["the", "air"]
    const l1Guess = guessLikelyL1(worst);
    const isUniversal = universallyHard.has(worst);

const systemPrompt = `
You are a friendly American-English pronunciation coach AND linguistics nerd.

Respond in EXACTLY five markdown sections, in this order:

## 🎯 Quick Coaching
## 🔬 Phoneme Profile
## 🤝 Reassurance
## 🧠 Did You Know?
## 🌍 World Language Spotlight

Formatting rules you MUST follow
- Put every heading on its own line (two hash marks and a space).
- Leave **one blank line** after each heading before its content.
- If you need a list, start each item with "- ".
- TOTAL length ≤130 words.

Section-specific rules
- **Quick Coaching**: ≤2 short sentences; actionable tip about ★<worst phoneme>★ and the lowest-scoring words.
- **Phoneme Profile**: 3–4 sentences.  
  1. Name IPA + technical tag (e.g. “voiceless dental fricative”).  
  2. State its family (fricatives/stops/etc.) and *why* that family is named so.  
  3. Plain-English mouth description + one common word.  
  4. (Optional) 2-4 bullet items listing other English sounds in the same family.
- **Reassurance**:  
  · If the sound is nearly universal (English TH or American R), write:  
    “This sound is difficult for most learners worldwide …”  
  · Otherwise begin: “Many <language list> speakers …”
- **Did You Know?**: 1–2 sentences of fun linguistics/historical trivia tied to the target sound or word.
- **World Language Spotlight**: 1 surprising fact (≤25 words) unrelated to the learner’s error.

Example layout you MUST imitate:

## 🎯 Quick Coaching

(Sentence 1.)  
(Sentence 2.)

## 🔬 Phoneme Profile

(Sentence 1.)  
- item  
- item

## 🤝 Reassurance

(Sentence 1.)

## 🧠 Did You Know?

(Sentence 1.)  
(Sentence 2.)

## 🌍 World Language Spotlight

(Sentence 1.)
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

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",   // or "gpt-4o-mini" if you want to use the lighter version
      temperature: 0.7,
      max_tokens: 400,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userMsg }
      ]
    });

    res.status(200).json({ feedback: completion.choices[0].message.content });
  } catch (err) {
    console.error("pronunciation-gpt error:", err);
    res.status(500).json({ error: "AI feedback failed to generate." });
  }
}
