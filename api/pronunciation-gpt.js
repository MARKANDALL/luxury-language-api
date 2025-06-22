// /api/pronunciation-gpt.js
export const config = { api: { bodyParser: true, externalResolver: true } };

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- helpers ---------- */
const universallyHard = new Set(["θ", "ð", "ɹ"]);

const langMap = {
  es: "Spanish",
  fr: "French",
  pt: "Portuguese",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ar: "Arabic",
  ru: "Russian",
  de: "German",
  hi: "Hindi",
  mr: "Marathi",
  universal: "Universal",
  "": "Universal",
};

const alias = { dh: "ð", th: "θ", r: "ɹ" };
const norm = (sym) => alias[sym] || sym;

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

/* ---------- handler ---------- */
export default async function handler(req, res) {
  // CORS
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  if (req.method !== "POST")
    return res.status(405).json({ error: "Only POST allowed" });

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const { referenceText, azureResult, firstLang = "" } = req.body;

    const targetLangCode = firstLang.trim().toLowerCase();
    const l1Label = langMap[targetLangCode] || targetLangCode || "Universal";

    const worst   = worstPhoneme(azureResult);
    const badList = worstWords(azureResult);
    const universal = universallyHard.has(worst);

    // ----- EMOJI section titles -----
    const sections = [
      "🎯 Quick Coaching",
      "🔬 Phoneme Profile",
      "🤝 Reassurance",
      `🪜 Common Pitfalls for ${l1Label}`,
      `💪 ${l1Label} Super-Power`,
      "🧠 Did You Know?",
      `🌍 ${l1Label} Spotlight`
    ];

    // ----- SYSTEM PROMPT with PER-SECTION WORD LIMITS -----
    const system = `
You are a bilingual pronunciation coach.

Output JSON:
{
  "sections": [
    { "title":"", "en":"", "l1":"" },
    ...
  ]
}

For each section below, output an object with:
- title: (as in the list/order below, including emoji and language name if shown)
- en: English feedback or tip for that section.
- l1: L1 translation for that section, OR "" if Universal.

Use these instructions for **content length and style**:

1. 🎯 Quick Coaching:
   - Max 45 words, min 32, plain, actionable, 2–3 sentences.
2. 🔬 Phoneme Profile:
   - 45–65 words. Briefly describe the main technical issue and what to do with the mouth/tongue/etc; give one example.
3. 🤝 Reassurance:
   - 25–40 words, one concise supportive paragraph.
4. 🪜 Common Pitfalls for [LANG]:
   - 40–55 words **or** exactly 3 concise bullets (≤12 words each). Use what fits best.
5. 💪 [LANG] Super-Power:
   - 30–45 words, motivational, connect native-language strengths to English pronunciation.
6. 🧠 Did You Know?:
   - 20–35 words, light/interesting fact, 1–2 sentences max.
7. 🌍 [LANG] Spotlight:
   - 18–30 words, cultural/linguistic trivia, very brief.

— For each, the L1 string should be a **single translation line** in the user's language (target: ≈70% of English word count, always ≤45 words).
— L1 should be plain, no extra commentary.
— For Universal, leave l1 as "".
— All tips should be specific, practical, and student-friendly, not generic.

Do NOT add any other keys besides "title", "en", and "l1".
Order and titles **must match** this list:
${sections.map((t) => `- "${t}"`).join("\n")}

Respond only with the JSON.
    `.trim();

    const user = {
      worstPhoneme: worst,
      worstWords: badList,
      sampleText: referenceText,
      universal,
      firstLang: targetLangCode,
      l1Label
    };

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.55,
      max_tokens: 1200,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: JSON.stringify(user) }
      ]
    });

    let payload;
    try {
      payload = JSON.parse(completion.choices[0].message.content);
      if (!Array.isArray(payload.sections)) throw "bad shape";
    } catch (_) {
      return res.status(500).json({ error: "Bad AI JSON shape." });
    }

    res.status(200).json(payload);
  } catch (e) {
    console.error("pronunciation-gpt error:", e);
    res.status(500).json({ error: "AI feedback failed." });
  }
}
