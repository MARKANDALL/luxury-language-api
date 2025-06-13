// ───────────────────────────────────────────────────────────────
// /api/pronunciation-gpt.js  – Vercel serverless function
// ───────────────────────────────────────────────────────────────

// Vercel config for proper CORS/OPTIONS handling
export const config = {
  api: { bodyParser: true, externalResolver: true }
};

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ─────── tiny helpers (keep or import your own versions) ─────── */
function norm(sym) {
  const alias = { dh: "ð", th: "θ", r: "ɹ" }; // extend if needed
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
function guessLikelyL1(ipa) {
  const map = {
    "θ": "Spanish / French / Japanese",
    "ð": "Spanish / French / Japanese",
    "ɹ": "Japanese / Korean / French",
    "v": "Spanish / Hindi",
    "ʃ": "Spanish / Italian"
  };
  return map[ipa] || "many language";
}
/* ─────────────────────────────────────────────────────────────── */

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // CORS pre-flight
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

    /* ---------- derive data for the prompt ---------- */
    const worst   = findWorstPhoneme(azureResult);      // e.g. "θ"
    const badList = findWorstWords(azureResult);        // ["the", "air"]
    const l1Guess = guessLikelyL1(worst);               // e.g. "Spanish / French / Japanese"

    const systemPrompt = `
You are a friendly American-English pronunciation coach AND linguistics nerd.

Respond in EXACTLY four markdown sections with these headings:
1) 🎯 Quick Coaching
2) 🤝 Reassurance
3) 🧠 Did You Know?
4) 🌍 World Language Spotlight

Rules:
– Quick Coaching: ≤2 short sentences; actionable tip about ★${worst}★ and words ${badList.join(", ")}.
– Reassurance: 1 sentence beginning “Many ${l1Guess} speakers …” explaining why ★${worst}★ is tricky.
– Did You Know?: 1–2 sentences of fun linguistic or historical trivia related to ★${worst}★ or one of those words.
– World Language Spotlight: 1 surprising fact (≤25 words) unrelated to the learner’s error.
– Use plain English, no heavy jargon; total ≤110 words.
`.trim();

    const userMsg = `
JSON input:
{
  "worstPhoneme": "${worst}",
  "worstWords": ${JSON.stringify(badList)},
  "sampleText": ${JSON.stringify(referenceText)}
}
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      max_tokens: 320,
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
