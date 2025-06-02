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
Here is an English learner’s pronunciation analysis.

Reference text: "${referenceText}"
Azure analysis (JSON): ${JSON.stringify(azureResult)}

Please explain the analysis results in clear, supportive, practical English for an adult learner. Highlight the most important patterns, suggest concrete practice tips, and encourage the learner. Focus on what to do next, not just what went wrong.
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
