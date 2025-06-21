// /api/pronunciation-gpt.js

export const config = {
  api: { bodyParser: true, externalResolver: true }
};

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const universallyHard = new Set(["θ", "ð", "ɹ"]);

// L1 language codes to readable names for translation & display
const languageMap = {
  "ko": "Korean",
  "ar": "Arabic",
  "pt": "Portuguese",
  "ja": "Japanese",
  "fr": "French",
  "ru": "Russian",
  "de": "German",
  "es": "Spanish",
  "zh": "Chinese",
  "hi": "Hindi",
  "mr": "Marathi",
  "universal": "Universal (all learners)",
  "": "Universal (all learners)"
};

// IPA-to-likely-difficulty map (expand as you wish)
function guessLikelyL1(ipa) {
  const map = {
    "θ": "Spanish, French, Portuguese, German, Arabic, Japanese, Chinese, Russian, Hindi, Korean",
    "ð": "Spanish, French, Portuguese, German, Arabic, Japanese, Chinese, Russian, Hindi, Korean",
    "ɹ": "Japanese, Korean, Russian, German, French, Chinese, Arabic, Spanish, Portuguese, Hindi",
    "l": "Japanese, Korean, Chinese, Hindi",
    "w": "German, Japanese, Korean, Chinese, Russian, Arabic",
    "v": "Spanish, Japanese, Korean, Arabic, Hindi, Portuguese",
    // ... etc.
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
  // Handle CORS for preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }
  // CORS for POST
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    // Pull firstLang from req.body (from your frontend FormData)
    const { referenceText, azureResult, firstLang = "" } = req.body;
    const worst   = findWorstPhoneme(azureResult);      // e.g. "θ"
    const badList = findWorstWords(azureResult);        // ["the", "air"]
    const l1Guess = guessLikelyL1(worst);
    const isUniversal = universallyHard.has(worst);

    // Determine language for translation
    const l1Code = (firstLang || "").toLowerCase();
    const l1Name = languageMap[l1Code] || "Universal (all learners)";

    // Build system prompt: now fully L1 aware, and gives bilingual output!
    const systemPrompt = `
You are an expert American-English pronunciation coach and linguist. 
The user is a non-native speaker; their first language is "${l1Name}". 
They want feedback about a specific problematic English sound and word(s).

## FEEDBACK RULES ##
1. **ALWAYS** generate two versions for each section: (A) in English, and (B) a native-quality translation into "${l1Name}" on the *very next line*, in parentheses, in that language. 
2. The translation line must be visually lighter: *wrap in <span style="color:#888;font-style:italic"></span> tags.*
3. Use their first language for cultural/phonetic context and advice wherever relevant.
4. If the first language is missing or "universal", reply only in English.
5. TOTAL length ≤220 words, but include at least 6 sections:
   - Quick Coaching (≤2 tips, both lines)
   - Phoneme Profile (details & bullet list, both lines)
   - L1 Caution Zone (what makes this sound hard for speakers of "${l1Name}", both lines)
   - Reassurance (if "universal": "This sound is hard for most learners worldwide…", else focus on "${l1Name}")
   - Did You Know? (trivia or linguistic fact about the sound, both lines)
   - World Language Spotlight (short, ONLY about the L1 selected, both lines)

6. Section headings must be H3s ("### Heading").
7. Always be friendly, clear, and positive.

## EXAMPLES OF FORMAT ##
### Quick Coaching

(Tip in English.)  
<span style="color:#888;font-style:italic">Translation in ${l1Name}.</span>

### Phoneme Profile

(...)

### L1 Caution Zone

(...)

### Reassurance

(...)

### Did You Know?

(...)

### World Language Spotlight

(...)

----

### CONTEXT ###
- Problem phoneme: ${worst}
- Problem words: ${JSON.stringify(badList)}
- User's sample: ${JSON.stringify(referenceText)}
- Is "universally difficult" sound: ${isUniversal}
- L1: ${l1Name}
- If no L1 given, respond only in English as a general coach.
`.trim();

    // Compose user message
    const userMsg = `
JSON input:
{
  "worstPhoneme": "${worst}",
  "worstWords": ${JSON.stringify(badList)},
  "sampleText": ${JSON.stringify(referenceText)},
  "isUniversallyDifficult": ${isUniversal},
  "firstLang": "${l1Name}"
}
    `.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.65,
      max_tokens: 750,
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
