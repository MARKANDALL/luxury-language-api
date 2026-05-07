// routes/convo-image.js
// Generates a mid-conversation illustration via Gemini.
// Accepts character portrait references + video stills for spatial/style consistency.
// Visual continuity: receives accumulated narrator lines to maintain scene coherence.
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
    const { scenarioHidden, desc, more, roles, transcript, tone, scenarioId, roleIds, imageCount, visualHistory, imageDirection, isClosingShot, closingImageHint, imageNotes } = req.body;

    if (!scenarioHidden || !transcript) {
      return res.status(400).json({ error: "Missing scenarioHidden or transcript" });
    }

    const shotNum = imageCount || 0;

    // ── Build reference image parts ─────────────────────────────────────
    const imageParts = [];

    if (scenarioId && roleIds && Array.isArray(roleIds)) {
      // Character portraits — ALWAYS include for face consistency
      for (const roleId of roleIds) {
        const part = await fetchAsPart(`${FRONTEND_BASE}/assets/characters/${scenarioId}-${roleId}.jpg`);
        if (part) imageParts.push(part);
      }

      // Video stills — reduce on later images so text-based shot directions take effect
      // Opening + first 2 images: all 3 stills (strong spatial anchoring)
      // Images 3-4: only 1 still (maintain setting, allow composition freedom)
      // Images 5+: 1 still (face/clothing anchor only)
      let stillsToInclude;
      if (shotNum <= 2) {
        stillsToInclude = [1, 2, 3];
      } else {
        stillsToInclude = [1];
      }

      for (const n of stillsToInclude) {
        const part = await fetchAsPart(`${FRONTEND_BASE}/assets/stills/${scenarioId}-${n}.jpg`);
        if (part) imageParts.push(part);
      }
    }

    // Scene image — always include for environment reference
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
    let shotDirection;

    if (isClosingShot) {
      shotDirection = `SHOT DIRECTION — CLOSING SHOT (final image of the conversation):
Wide cinematic pullback. The camera lingers on the scene after the interaction has ended or is about to end. Show the environment with more breathing room — the characters may be further apart, one turning to leave, or both settling into a final moment together. This should feel like the last frame of a film — contemplative, quiet, complete.
- If the conversation ended naturally: show the aftermath — an empty chair, a receipt on the counter, both characters at ease, one waving goodbye.
- If one character is leaving: show them walking away with the environment prominent, the other character smaller in frame or watching.
- If it ended abruptly or negatively: the AI character alone in frame, the space where the other person was now empty.
The mood should match the final tone of the conversation. Warm lighting for positive endings, cooler tones for tense or unresolved ones. Shot on Hasselblad, Kodak Portra 400, shallow depth of field on the environment.${closingImageHint ? `\nSCENARIO-SPECIFIC CLOSING: ${closingImageHint}` : ""}`;
    } else if (shotNum === 0) {
      shotDirection = "SHOT DIRECTION: Wide establishing shot. Show the full environment — both characters, the space between them, and the setting. Pull the camera back to orient the viewer. Shot on Hasselblad, natural daylight, Kodak Portra 400 color palette.";
    } else if (shotNum === 1) {
      shotDirection = "SHOT DIRECTION: Medium two-shot. Both characters visible, focused on the interaction. Emphasize body language and the space between them. Rule of thirds composition, shallow depth of field on the characters.";
    } else if (shotNum === 2) {
      shotDirection = "SHOT DIRECTION: Close-up on the AI character. Focus on their facial expression and what their hands are doing — writing, pouring, checking, gesturing. Tight framing, bokeh background.";
    } else if (shotNum === 3) {
      shotDirection = "SHOT DIRECTION: Over-the-shoulder from the learner's perspective. Show what they see — the other person's face, the objects between them, the environment from their viewpoint. Leading lines toward the AI character.";
    } else if (shotNum === 4) {
      shotDirection = "SHOT DIRECTION: Wide shot showing the scene has progressed. If documents were exchanged, show them. If the setting shifted, reflect that. Environmental storytelling. Pull back to show the full scene from a new angle.";
    } else {
      // Alternate between close-ups and medium shots for shots 5+
      const altShots = [
        "SHOT DIRECTION: Close-up on hands or objects central to the scene — documents, coffee cups, medical instruments, phone screens. The characters' faces may be partially visible. Macro-style detail, shallow depth of field.",
        "SHOT DIRECTION: Medium shot from a new angle. Show both characters but from a different perspective than earlier — side angle, slightly lower, or slightly higher. Fresh composition, avoid repeating any previous framing.",
        "SHOT DIRECTION: Focus on the emotional tone. If the conversation is tense, show tight framing and shadows. If warm, show open body language and soft lighting. Cinematic color grading matching the mood.",
      ];
      shotDirection = altShots[shotNum % altShots.length];
    }

    // ── Adjust context weighting based on image count ────────────────────
    const scenarioSlice = shotNum === 0 ? 1000 : shotNum <= 2 ? 400 : 200;
    const transcriptSlice = shotNum === 0 ? 200 : shotNum <= 2 ? 1500 : 2000;

    // ── Visual continuity block ─────────────────────────────────────────
    let visualContinuityBlock = "";
    if (visualHistory && visualHistory.trim()) {
      visualContinuityBlock = `
VISUAL CONTINUITY — WHAT HAS ALREADY HAPPENED IN PREVIOUS IMAGES:
${visualHistory}

IMPORTANT: Maintain visual continuity with the above. If a bandage was applied, it should still be visible. If a document was handed over, it should be in the recipient's hands or on the surface. If a character moved to a new position, they should still be there. Do NOT revert to an earlier state of the scene.`;
    }

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

${imageDirection ? `DIRECTOR'S NOTE (HIGHEST PRIORITY — this describes exactly what should be in this image):
${imageDirection}` : ""}

${shotDirection}
${visualContinuityBlock}

${imageParts.length > 0 ? `Reference photos of the characters and scene are provided. Match the characters' faces and clothing from the portrait references. Use the scene/environment references for spatial layout and lighting.${shotNum <= 2 ? " Match camera angles from the video stills closely." : " You have creative freedom for camera angle and composition — follow the SHOT DIRECTION above."}` : ""}

IMAGE RULES:
- Photorealistic style, natural lighting, cinematic quality
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
- Characters should NEVER look directly at the camera — they are in a conversation with each other, not posing for a photo. Eye contact should be between the characters, or looking at objects/environment relevant to the conversation
- Maintain consistent lighting across all images in a conversation. If the first image shows evening light, all subsequent images should show the same time of day and lighting conditions
- Do NOT render text messages, chat interfaces, phone screens showing text, whiteboards with readable text, or any UI overlay${imageNotes ? `

SCENARIO-SPECIFIC IMAGE GUIDANCE:
${imageNotes}` : ""}`;

    // ── Call Gemini with retry + fallback ──────────────────────────────
    const contents = [
      ...imageParts,
      { text: textPrompt },
    ];

    const PRIMARY_MODEL = "gemini-3.1-flash-image-preview";
    const FALLBACK_MODEL = "gemini-3-pro-image-preview";
    const MAX_PRIMARY_RETRIES = 2;
    const RETRY_DELAY_MS = 2000;

    /** Attempt one Gemini image generation call. Returns { response, model } or throws. */
    async function tryGenerate(model) {
      return {
        response: await ai.models.generateContent({
          model,
          contents,
          config: { responseModalities: ["TEXT", "IMAGE"] },
        }),
        model,
      };
    }

    /** Extract imageData + description from a Gemini response. Returns { imageData, description } or null. */
    function extractImage(response) {
      const parts = response?.candidates?.[0]?.content?.parts || [];
      let imageData = null;
      let description = "";
      for (const part of parts) {
        if (part.inlineData?.data) imageData = part.inlineData;
        if (part.text) description = part.text;
      }
      return imageData ? { imageData, description } : null;
    }

    let result = null;
    let usedModel = PRIMARY_MODEL;

    // ── Primary model: retry up to MAX_PRIMARY_RETRIES times ──
    for (let attempt = 1; attempt <= MAX_PRIMARY_RETRIES; attempt++) {
      try {
        const { response, model } = await tryGenerate(PRIMARY_MODEL);
        const extracted = extractImage(response);
        if (extracted) {
          result = extracted;
          usedModel = model;
          break;
        }
        console.warn(`[convo-image] ${PRIMARY_MODEL} attempt ${attempt}: no image in response`);
      } catch (err) {
        const code = err?.status || err?.code || "";
        const msg = err?.message || JSON.stringify(err);
        console.warn(`[convo-image] ${PRIMARY_MODEL} attempt ${attempt} failed (${code}): ${msg}`);
      }
      // Wait before next retry (but not after the last attempt)
      if (!result && attempt < MAX_PRIMARY_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }

    // ── Fallback model: single attempt if primary exhausted ──
    if (!result) {
      console.log(`[convo-image] Primary model exhausted. Falling back to ${FALLBACK_MODEL}`);
      try {
        const { response, model } = await tryGenerate(FALLBACK_MODEL);
        const extracted = extractImage(response);
        if (extracted) {
          result = extracted;
          usedModel = model;
        }
      } catch (err) {
        const msg = err?.message || JSON.stringify(err);
        console.error(`[convo-image] Fallback ${FALLBACK_MODEL} also failed: ${msg}`);
      }
    }

    if (!result) {
      return res.status(500).json({ error: "All image models failed" });
    }

    if (usedModel !== PRIMARY_MODEL) {
      console.log(`[convo-image] ⚡ Used fallback model: ${usedModel}`);
    }

    const dataUri = `data:${result.imageData.mimeType || "image/png"};base64,${result.imageData.data}`;

    res.json({ imageUrl: dataUri, description: result.description });
  } catch (err) {
    console.error("[convo-image] generation failed:", err?.message || err);
    res.status(500).json({ error: "Image generation failed" });
  }
}
