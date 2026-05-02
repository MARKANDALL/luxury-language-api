// routes/convo-image.js
// Generates a mid-conversation illustration via Gemini (Nano Banana).
// Accepts character portrait references for face/style consistency.
// Endpoint: POST /api/convo-image

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ── Portrait cache (avoids refetching the same image every request) ─────────
const _portraitCache = new Map();

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

const FRONTEND_BASE = process.env.FRONTEND_URL || "http://localhost:3000";

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY not configured" });
  }

  try {
    const { scenarioHidden, desc, more, roles, transcript, tone, scenarioId, roleIds } = req.body;

    if (!scenarioHidden || !transcript) {
      return res.status(400).json({ error: "Missing scenarioHidden or transcript" });
    }

    // ── Build reference image parts ─────────────────────────────────────
    const imageParts = [];

    if (scenarioId && roleIds && Array.isArray(roleIds)) {
      for (const roleId of roleIds) {
        const portraitUrl = `${FRONTEND_BASE}/assets/characters/${scenarioId}-${roleId}.jpg`;
        const imgData = await fetchImageAsBase64(portraitUrl);
        if (imgData) {
          imageParts.push({
            inlineData: { mimeType: imgData.mimeType, data: imgData.base64 },
          });
        }
      }
    }

    // Scene image
    if (scenarioId) {
      for (const ext of ["webp", "jpg"]) {
        const sceneUrl = `${FRONTEND_BASE}/convo-img/${scenarioId}.${ext}`;
        const sceneData = await fetchImageAsBase64(sceneUrl);
        if (sceneData) {
          imageParts.push({
            inlineData: { mimeType: sceneData.mimeType, data: sceneData.base64 },
          });
          break;
        }
      }
    }

    // ── Build character descriptions ────────────────────────────────────
    const characterBlock = (roles || [])
      .map(r => {
        const lines = [`${r.label}:`];
        if (r.npc) lines.push(`  Appearance: ${r.npc}`);
        if (r.personality) lines.push(`  Personality: ${r.personality}`);
        return lines.join("\n");
      })
      .join("\n\n");

    // ── Build the prompt ────────────────────────────────────────────────
    const textPrompt = `Create a photorealistic image for a language learning app.

SCENE SETTING:
${scenarioHidden.slice(0, 1000)}

ENVIRONMENT DETAILS:
${(more || "").slice(0, 600)}

CHARACTERS IN THIS SCENE:
${characterBlock}

WHAT IS HAPPENING RIGHT NOW:
${transcript.slice(-1500)}

Conversation tone: ${tone || "neutral"}

${imageParts.length > 0 ? "Reference photos of the characters are provided. Match their faces, hair, clothing style, and approximate age from the reference photos as closely as possible." : ""}

IMAGE RULES:
- Photorealistic style, natural lighting, as if captured by a professional photographer
- Characters must be positioned logically within the physical space:
  * Customers stay on the customer side of counters, desks, and service areas
  * Workers stay on the worker side of counters, desks, and service areas
  * Drivers sit in the driver's seat, passengers in the passenger seat
  * Patients sit on exam tables or chairs, doctors stand or sit across from them
  * People in phone calls are shown in their own environment, not merged into one scene
- Show the characters interacting naturally — eye contact, gestures, body language
- Include environmental details from the scene setting: furniture, objects, lighting, weather
- Camera angle: medium shot, slightly above eye level, showing both characters and their surroundings
- No text, words, letters, signs with readable text, or watermarks
- No violence, weapons, blood, sexual content, or anything inappropriate
- No extra fingers, no distorted hands — if hands are not central to the scene, keep them out of frame or naturally positioned at sides`;

    // ── Call Gemini ──────────────────────────────────────────────────────
    const contents = [
      ...imageParts,
      { text: textPrompt },
    ];

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-image",
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

    const dataUri = `data:${imageData.mimeType || "image/png"};base64,${imageData.data}`;

    res.json({ imageUrl: dataUri, description });
  } catch (err) {
    console.error("[convo-image] generation failed:", err?.message || err);
    res.status(500).json({ error: "Image generation failed" });
  }
}