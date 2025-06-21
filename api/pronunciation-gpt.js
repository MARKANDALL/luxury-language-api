// /api/pronunciation-gpt.js

export const config = {
  api: { bodyParser: true, externalResolver: true },
};

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Map language codes to English names
 */
const L1_MAP = {
  "ko": "Korean",
  "ar": "Arabic",
  "pt": "Portuguese",
  "ja": "Japanese",
  "fr": "French",
  "ru": "Russian",
  "de": "German",
  "es": "Spanish",
  "zh": "Mandarin Chinese",
  "hi": "Hindi",
  "mr": "Marathi",
  "universal": "Universal (all learners)",
  "": "",
};

/**
 * Utility: Normalize phoneme keys (for Azure/IPA mapping)
 */
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

/**
 * IPA-to-L1-language map for feedback context
 */
const universallyHard = new Set(["θ", "ð", "ɹ"]);

function guessLikelyL1(ipa) {
  const map = {
    "θ": "Spanish, French, Portuguese, German, Arabic, Japanese, Chinese, Russian, Hindi, Korean",
    "ð": "Spanish, French, Portuguese, German, Arabic, Japanese, Chinese, Russian, Hindi, Korean",
    "ɹ": "Japanese, Korean, Russian, German, French, Chinese, Arabic, Spanish, Portuguese, Hindi",
    // ... expand as needed
  };
  return map[ipa] || "Portuguese, Arabic, Korean, Russian, French, Japanese, Spanish, German, Hindi, and Chinese";
}

// ---------------- API HANDLER ----------------
export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  // CORS for actual POST
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    const {
      referenceText = "",
      azureResult,
      firstLang = "",
    } = req.body;

    // Support both legacy and new: sometimes sent as "firstLang" (code), sometimes as "l1" or "l1Code"
    const l1Code = firstLang || req.body.l1 || req.body.l1Code || "";
    const l1Name = L1_MAP[l1Code] || l1Code || "Universal";

    const worstPhoneme = findWorstPhoneme(azureResult);
    const worstWords = findWorstWords(azureResult);
    const l1Guess = guessLikelyL1(worstPhoneme);
    const isUniversal = universallyHard.has(worstPhoneme);

    // --- SYSTEM PROMPT for GPT-4o ---
    const systemPrompt = `
You are an expert American-English pronunciation coach and a professional translator.

The user's first language (L1) code: "${l1Code}".
The user's first language (L1) name: "${l1Name}".

######## RULES ########
- If L1 is "" or "universal": feedback in English only.
- Otherwise, for every section:
    1. First line: write in the user's L1 (${l1Name}). If you don't know it, say "(translation unavailable)".
    2. Second line: English translation (paraphrase) wrapped as
       <span style="color:#888;font-style:italic"> ... </span>
- Strictly use the L1 language. Do not substitute with Portuguese or any other language.

######## SECTIONS ########
Respond with these seven sections, with these markdown H3 headings:
### 🎯 Quick Coaching
### 🔬 Phoneme Profile
### 🤝 Reassurance
### 🪜 Common Pitfalls for ${l1Name}
### 💪 ${l1Name} Super-Power
### 🧠 Did You Know?
### 🌍 ${l1Name} Spotlight

######## CONTENT ########
- Quick Coaching: 1-2 practical tips about the most difficult sound ★<worstPhoneme>★ and the worst words.
- Phoneme Profile: 3-4 sentences: (IPA, class, mouth description, example)
- Reassurance: If isUniversallyDifficult, begin "This sound is difficult for most learners worldwide ...". Else, begin "Many ${l1Name} speakers ...".
- Common Pitfalls: 2-3 bullet points on common mistakes for ${l1Name} speakers.
- ${l1Name} Super-Power: 1-2 sentences on strengths of ${l1Name} speakers learning English pronunciation.
- Did You Know?: 1-2 fun facts or linguistic trivia.
- ${l1Name} Spotlight: ≤20 words about ${l1Name} (phonetics, fun fact, etc).
- Limit L1 lines to ≤180 words (English lines don’t count). Be concise.
- Only use HTML for the English "subtitle" line as shown above.

######## EXAMPLES ########
If L1 is "es" (Spanish):
### 🎯 Quick Coaching
Aprende a colocar la lengua entre los dientes para el sonido "th".
<span style="color:#888;font-style:italic">Try putting your tongue between your teeth for "th".</span>
Evita decir "de" en vez de "the".
<span style="color:#888;font-style:italic">Avoid "de" for "the".</span>

If L1 is "" or "universal":
### 🎯 Quick Coaching
Try putting your tongue between your teeth for "th".
Avoid "de" for "the".

If you do not know the L1, write: (translation unavailable)
`.trim();

    // --- USER PROMPT (always send worst/words/sample/isUniversal/L1 for max context) ---
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

    // --- GPT-4o completion ---
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.7,
      max_tokens: 700,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
    });

    res.status(200).json({ feedback: completion.choices[0].message.content });
  } catch (err) {
    console.error("pronunciation-gpt error:", err);
    res.status(500).json({ error: "AI feedback failed to generate." });
  }
}
