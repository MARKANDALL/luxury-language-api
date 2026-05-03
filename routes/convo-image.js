// routes/convo-image.js
// Generates a mid-conversation illustration via Gemini (Nano Banana).
// Accepts character portrait references + video stills for spatial/style consistency.
// Endpoint: POST /api/convo-image

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ── Image cache (avoids refetching the same image every request) ────────────
const _imageCache = new Map();

async function fetchImageAsBase64(url) {
  if (_imageCache.has(url)) return _imageCache.get(url);

  try {
    const res = await fetch(url);
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await res.arrayBuffer());
    const result = { base64: buffer.toString("base64"), mimeType: contentType };
    _imageCache.set(url, result);
    return result;
  } catch {
    return null;
  }
}

/** Fetch an image and return it as an inline data part for Gemini, or null */
async function fetchAsPart(url) {
  const data = await fetchImageAsBase64(url);
  if (!data) return null;
  return { inlineData: { mimeType: data.mimeType, data: data.base64 } };
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
    const { scenarioHidden, desc, more, roles, transcript, tone, scenarioId, roleIds, imageCount } = req.body;

    if (!scenarioHidden || !transcript) {
      return res.status(400).json({ error: "Missing scenarioHidden or transcript" });
    }

    // ── Build reference image parts ─────────────────────────────────────
    const imageParts = [];

    if (scenarioId && roleIds && Array.isArray(roleIds)) {
      // Character portraits
      for (const roleId of roleIds) {
        const part = await fetchAsPart(`${FRONTEND_BASE}/assets/characters/${scenarioId}-${roleId}.jpg`);
        if (part) imageParts.push(part);
      }

      // Video stills (3 per scenario: 1s, 4s, 7s)
      for (const n of [1, 2, 3]) {
        const part = await fetchAsPart(`${FRONTEND_BASE}/assets/stills/${scenarioId}-${n}.jpg`);
        if (part) imageParts.push(part);
      }
    }

    // Scene image
    if (scenarioId) {
      for (const ext of ["webp", "jpg"]) {
        const part = await fetchAsPart(`${FRONTEND_BASE}/convo-img/${scenarioId}.${ext}`);
        if (part) {
          imageParts.push(part);
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

    // ── Shot direction based on image count ─────────────────────────────
    const shotNum = imageCount || 0;
    let shotDirection;
    if (shotNum === 0) {
      shotDirection = "SHOT DIRECTION: Wide establishing shot. Show the full environment — both characters, the space between them, and the setting. Pull the camera back to orient the viewer.";
    } else if (shotNum === 1) {
      shotDirection = "SHOT DIRECTION: Medium two-shot. Both characters visible, focused on the interaction. Emphasize body language and the space between them.";
    } else if (shotNum === 2) {
      shotDirection = "SHOT DIRECTION: Close-up on the AI character. Focus on their facial expression and what their hands are doing — writing, pouring, checking, gesturing.";
    } else if (shotNum === 3) {
      shotDirection = "SHOT DIRECTION: Over-the-shoulder from the learner's perspective. Show what they see — the other person's face, the objects between them, the environment from their viewpoint.";
    } else if (shotNum === 4) {
      shotDirection = "SHOT DIRECTION: Wide shot showing the scene has progressed. If documents were exchanged, show them. If the setting shifted, reflect that. Environmental storytelling.";
    } else {
      // Alternate between close-ups and medium shots for shots 5+
      const altShots = [
        "SHOT DIRECTION: Close-up on hands or objects central to the scene — documents, coffee cups, medical instruments, phone screens. The characters' faces may be partially visible.",
        "SHOT DIRECTION: Medium shot from a new angle. Show both characters but from a different perspective than earlier — side angle, slightly lower, or slightly higher.",
        "SHOT DIRECTION: Focus on the emotional tone. If the conversation is tense, show tight framing and shadows. If warm, show open body language and soft lighting.",
      ];
      shotDirection = altShots[shotNum % altShots.length];
    }

    // ── Adjust context weighting based on image count ────────────────────
    const scenarioSlice = shotNum === 0 ? 1000 : shotNum <= 2 ? 400 : 200;
    const transcriptSlice = shotNum === 0 ? 200 : shotNum <= 2 ? 1500 : 2000;

    // ── Build the prompt ────────────────────────────────────────────────
    const textPrompt = `Create a photorealistic image for a language learning app.

SCENE SETTING:
${scenarioHidden.slice(0, scenarioSlice)}

ENVIRONMENT DETAILS:
${(more || "").slice(0, shotNum === 0 ? 600 : 200)}

CHARACTERS IN THIS SCENE:
${characterBlock}

WHAT IS HAPPENING RIGHT NOW:
${transcript.slice(-transcriptSlice)}

Conversation tone: ${tone || "neutral"}

${shotDirection}

${imageParts.length > 0 ? "Reference photos and video stills of the characters and scene are provided. Match the characters' faces, clothing, and the environment's layout, lighting, and camera angles from these references as closely as possible." : ""}

IMAGE RULES:
- Photorealistic style matching the reference photos provided, natural lighting
- Characters must be positioned logically within the physical space:
  * Customers stay on the customer side of counters, desks, and service areas
  * Workers stay on the worker side of counters, desks, and service areas
  * Drivers sit in the driver's seat, passengers in the passenger seat
  * Patients sit on exam tables or chairs, doctors stand or sit across from them
  * People in phone calls are shown in their own environment, NOT merged into one scene
- Show the characters interacting naturally — eye contact, gestures, body language
- Include environmental details from the scene setting: furniture, objects, lighting, weather
- No text, words, letters, signs with readable text, watermarks, chat bubbles, or UI elements
- No violence, weapons, blood, sexual content, or anything inappropriate
- Hands should be in natural resting positions — at sides, holding relevant objects, or out of frame
- Do NOT render text messages, chat interfaces, phone screens showing text, or any UI overlay`;

    // ── Call Gemini ──────────────────────────────────────────────────────
    const contents = [
      ...imageParts,
      { text: textPrompt },
    ];

    const response = await ai.models.generateContent({
      model: "gemini-3-pro-image-preview",
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