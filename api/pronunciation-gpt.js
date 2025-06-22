// api/pronunciation-gpt.js
export const config = { api: { bodyParser: true, externalResolver: true } };

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* Helper utilities unchanged */
const universallyHard = new Set(["θ", "ð", "ɹ"]);
const langMap = {
  es: "Spanish", fr: "French", pt: "Portuguese", zh: "Chinese",
  ja: "Japanese", ko: "Korean", ar: "Arabic", ru: "Russian",
  de: "German", hi: "Hindi", mr: "Marathi", universal: "Universal", "": "Universal"
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

/* NEW Updated section metadata: 6 sections total */
const sectionMeta = [
  { emoji: "🎯", en: "Quick Coaching", min: 80, max: 120 },
  { emoji: "🔬", en: "Phoneme Profile", min: 90, max: 130 },
  { emoji: "🪜", en: "Common Pitfalls", min: 80, max: 120 },
  { emoji: "⚖️", en: "Comparisons", min: 90, max: 130 },
  { emoji: "🌍", en: "Did You Know?", min: 80, max: 120 }, // merged with L1 Spotlight
  { emoji: "🤝", en: "Reassurance", min: 50, max: 90 }
];

export default async function handler(req, res) {
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
      .map((s, i) => `${i + 1}. ${s.emoji} ${s.en} — ${s.min}-${s.max} EN words`)
      .join("\n");

    const system = `
You are the world's leading expert bilingual pronunciation coach and linguist.

❏ Output exactly:
{
  "sections": [
    {"title":"", "titleL1":"", "en":"", "l1":""},
    ...
  ]
}

❏ Provide exactly 6 sections, in this order:
${rangesStr}

• "title": emoji + English title above (fixed)
• "titleL1": Title translated to learner's L1 (no emoji)
• "en": English coaching (respect word limits above, be rich & specific, never generic)
• "l1": Same text translated to learner's L1. Leave blank if firstLang = "Universal".

❏ Sections explained:
1. Quick Coaching: Direct advice how to pronounce difficult phoneme or word.
2. Phoneme Profile: Precise articulation details, tongue/lip positions, airflow.
3. Common Pitfalls: Typical mistakes by L1 speakers, specific solutions.
4. Comparisons: Explicitly compare English sound/word shape vs learner's L1, similarities & differences clearly stated.
5. Did You Know?: Engaging facts linking phoneme to L1 & global language context.
6. Reassurance: Warm encouragement, remind learner errors are natural.

No markdown or HTML, just plain text.
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
      temperature: 0.6,
      max_tokens: 1800,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) }
      ]
    });

    let payload;
    try {
      payload = JSON.parse(completion.choices[0].message.content);
      if (!Array.isArray(payload.sections)) throw "Invalid GPT response format.";
    } catch (err) {
      console.error("GPT JSON parse error:", err);
      return res.status(500).json({ error: "Bad AI JSON shape." });
    }

    res.status(200).json(payload);
  } catch (e) {
    console.error("pronunciation-gpt error:", e);
    res.status(500).json({ error: "AI feedback failed." });
  }
}
