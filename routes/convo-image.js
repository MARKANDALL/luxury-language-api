// routes/convo-image.js
// Generates a mid-conversation illustration via GPT prompt → DALL-E 3.
// Endpoint: POST /api/convo-image

import OpenAI from "openai";

const openai = new OpenAI();

// Locked art style — single source of truth for visual consistency
const ART_STYLE = "warm watercolor illustration with soft lighting, gentle brushstrokes, muted natural palette";

const SAFETY_SYSTEM = `You are an art director for a language learning app called Lux. Given a conversation scenario and recent dialogue, write a 1–2 sentence image description that captures the current mood and setting.

Style: ${ART_STYLE}. No text overlays or lettering of any kind.

STRICT RULES:
- Never include human faces, heads, or identifiable people
- Show hands, objects, environments, textures, and atmosphere instead
- Never depict violence, weapons, blood, or injury
- Never depict sexual or suggestive content
- Never depict drugs, alcohol, or illegal activity
- Focus on the SETTING and EMOTIONAL TONE, not the people
- Include sensory details: light quality, textures, objects on surfaces, weather
- Keep descriptions grounded in the scenario's physical environment`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { scenarioHidden, roles, transcript, tone } = req.body;

    if (!scenarioHidden || !transcript) {
      return res.status(400).json({ error: "Missing scenarioHidden or transcript" });
    }

    // Step 1: GPT writes a safe image description
    const promptResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 120,
      temperature: 0.8,
      messages: [
        { role: "system", content: SAFETY_SYSTEM },
        {
          role: "user",
          content: [
            `Scenario setting: ${scenarioHidden.slice(0, 600)}`,
            `Characters: ${(roles || []).map(r => `${r.label}: ${r.personality || ""}`).join("; ").slice(0, 300)}`,
            `Tone of conversation: ${tone || "neutral"}`,
            `Recent dialogue:\n${transcript.slice(-1200)}`,
            `\nDescribe one scene for a ${ART_STYLE}.`,
          ].join("\n\n"),
        },
      ],
    });

    const imageDescription = promptResponse.choices?.[0]?.message?.content;
    if (!imageDescription) {
      return res.status(500).json({ error: "GPT returned empty description" });
    }

    // Step 2: DALL-E generates the image
    const imageResponse = await openai.images.generate({
      model: "dall-e-3",
      prompt: `${ART_STYLE}. ${imageDescription}. No text, no words, no letters, no faces.`,
      n: 1,
      size: "1024x1024",
      quality: "standard",
    });

    const imageUrl = imageResponse.data?.[0]?.url;
    if (!imageUrl) {
      return res.status(500).json({ error: "DALL-E returned no image" });
    }

    res.json({ imageUrl, description: imageDescription });
  } catch (err) {
    // Content policy rejection or other OpenAI error — fail silently for the user
    console.error("[convo-image] generation failed:", err?.message || err);
    res.status(500).json({ error: "Image generation failed" });
  }
}