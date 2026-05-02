// routes/convo-image.js
// Generates a mid-conversation illustration via Gemini (Nano Banana Pro).
// Accepts character portrait references for face/style consistency.
// Endpoint: POST /api/convo-image

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ── Portrait cache (avoids refetching the same image every request) ─────────
const _portraitCache = new Map();

/**
 * Fetch an image from a URL and return base64 + mime type.
 * Caches results in memory for the lifetime of the serverless instance.
 */
async function fetchImageAsBase64(url) {
  if (_portraitCache.has(url)) return _portraitCache.get(url);

  try {
    const res = await fetch(url);
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await res.arrayBuffer());
    const result = { base64: buffer.toString("base64"), mimeType: contentType };
    _portraitCache.set(url, result);
    return result;
  } catch {
    return null;
  }
}

// ── Config ──────────────────────────────────────────────────────────────────

// Where to fetch character portraits from.
// In production this should be your deployed frontend URL.
// Falls back to localhost for dev.
const FRONTEND_BASE = process.env.FRONTEND_URL || "http://localhost:3000";

const SAFETY_PROMPT = `STRICT RULES for the image:
- Show the characters described below in the scene, maintaining their appearance from the reference photos provided
- Never depict violence, weapons, blood, or injury
- Never depict sexual or suggestive content
- Never depict drugs, alcohol, or illegal activity
- No text overlays or lettering of any kind
- Include sensory details: light quality, textures, objects on surfaces
- Keep the scene grounded in the scenario's physical environment`;

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY not configured" });
  }

  try {
    const { scenarioHidden, roles, transcript, tone, scenarioId, roleIds } = req.body;

    if (!scenarioHidden || !transcript) {
      return res.status(400).json({ error: "Missing scenarioHidden or transcript" });
    }

    // ── Build reference image parts (character portraits) ─────────────────
    const imageParts = [];

    if (scenarioId && roleIds && Array.isArray(roleIds)) {
      for (const roleId of roleIds) {
        const portraitUrl = `${FRONTEND_BASE}/assets/characters/${scenarioId}-${roleId}.jpg`;
        const imgData = await fetchImageAsBase64(portraitUrl);
        if (imgData) {
          imageParts.push({
            inlineData: {
              mimeType: imgData.mimeType,
              data: imgData.base64,
            },
          });
        }
      }
    }

    // Also try to fetch the scene image
    if (scenarioId) {
      // Scene images can be .webp or .jpg — try webp first
      for (const ext of ["webp", "jpg"]) {
        const sceneUrl = `${FRONTEND_BASE}/convo-img/${scenarioId}.${ext}`;
        const sceneData = await fetchImageAsBase64(sceneUrl);
        if (sceneData) {
          imageParts.push({
            inlineData: {
              mimeType: sceneData.mimeType,
              data: sceneData.base64,
            },
          });
          break;
        }
      }
    }

    // ── Build the text prompt ─────────────────────────────────────────────
    const characterDescriptions = (roles || [])
      .map(r => `${r.label}: ${r.personality || ""}`)
      .join("\n");

    const textPrompt = [
      `Generate an image for a language learning app conversation scene.`,
      ``,
      `Scenario: ${scenarioHidden.slice(0, 800)}`,
      ``,
      `Characters in the scene:`,
      characterDescriptions,
      ``,
      `Tone of the conversation: ${tone || "neutral"}`,
      ``,
      `What's happening in the conversation right now:`,
      transcript.slice(-1500),
      ``,
      imageParts.length > 0
        ? `Use the reference photos provided to maintain the characters' appearances. Place them in the scene described above, interacting naturally.`
        : `Show the characters described above in the scene, interacting naturally.`,
      ``,
      SAFETY_PROMPT,
    ].join("\n");

    // ── Call Gemini ──────────────────────────────────────────────────────
    const contents = [
      ...imageParts,
      { text: textPrompt },
    ];

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash-exp",
      contents: contents,
      config: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    });

    // ── Extract image from response ─────────────────────────────────────
    const parts = response?.candidates?.[0]?.content?.parts || [];
    let imageData = null;
    let description = "";

    for (const part of parts) {
      if (part.inlineData?.data) {
        imageData = part.inlineData;
      }
      if (part.text) {
        description = part.text;
      }
    }

    if (!imageData) {
      return res.status(500).json({ error: "Gemini returned no image" });
    }

    // Return as a data URI — frontend img.src accepts this directly
    const dataUri = `data:${imageData.mimeType || "image/png"};base64,${imageData.data}`;

    res.json({ imageUrl: dataUri, description });
  } catch (err) {
    console.error("[convo-image] generation failed:", err?.message || err);
    res.status(500).json({ error: "Image generation failed" });
  }
}