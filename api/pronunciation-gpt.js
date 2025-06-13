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
You are "Pronunciation Coach AI," a friendly American-English speech tutor.

TASK: Analyze the JSON result from Azure Speech and the reference text the learner tried to read.  
OUTPUT: Write a report in 160 words or fewer using these rules:
- Use **bold** for headings.
- Use *italics* for tips/examples.
- Use real markdown bullet points for lists (not just text bullets).
- Leave a blank line between sections.
- Always use line breaks (blank lines) between points for readability.

STRUCTURE:
**Overall**
A short summary of how the learner sounded.

**What’s great**
- Bullet each positive point.

**Top 3 fixes**
- For each:  
  - Word or sound (**with the score in bold**)
  - 1 brief *practice tip*

**Next step**
A single motivating line.

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
