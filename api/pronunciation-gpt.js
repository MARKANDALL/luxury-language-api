// Vercel config for proper CORS/OPTIONS handling
export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // ...rest of your code...
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  // Set CORS headers for the actual request
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    const { referenceText, azureResult } = req.body;

const prompt = `
You are “Pronunciation Coach AI”, a friendly American-English speech tutor.

TASK ► Analyse the JSON result I supply from Azure Speech plus the reference text the learner tried to read.  
OUTPUT ► Write a report in 160 words or fewer, formatted in simple markdown (**bold**, *italics*, a few • bullets).  
TONE ► Encouraging, practical, NEVER mention you are an AI or reference your own process.  
STRUCTURE ►

**Overall**
1 sentence that sums up how the learner sounded (e.g. “Clear and confident, with a few tricky sounds to polish.”).

**What’s great**
• 1–2 bullets pointing out strongest areas (high fluency, clear rhythm, etc.).

**Top 3 fixes**
For each:  
• word or sound + score in ( )  
• 1 short tip *exactly how to practise* (mouth shape, minimal pair, slow → fast, etc.).

**Next step**
End with a single motivating sentence (max 15 words).

Reference text: "${referenceText}"
Azure analysis (JSON): ${JSON.stringify(azureResult)}
`;


    const completion = await openai.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "gpt-4o",
      max_tokens: 400,
    });

    const feedback = completion.choices[0].message.content;
    res.status(200).json({ feedback });
  } catch (err) {
    console.error("Error in pronunciation-gpt endpoint:", err);
    res.status(500).json({ error: "AI feedback failed to generate." });
  }
}
