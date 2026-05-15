// routes/convo-image-luma.js
// Generates mid-conversation illustrations via Luma Uni-1.1 API.
// Drop-in alternate to the Gemini path in convo-image.js — same request/response contract.
// Selected when LUX_IMAGE_PROVIDER=luma; convo-image.js dispatches here.
// Endpoint surface stays POST /api/convo-image — frontend is unaware of the swap.

const LUMA_API_BASE = "https://agents.lumalabs.ai/v1";
const LUMA_MODEL = process.env.LUMA_IMAGE_MODEL || "uni-1-max"; // "uni-1" or "uni-1-max"
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 180000; // 3 min — Luma claims ~31s avg but uni-1-max with refs runs longer under load
const FRONTEND_BASE = process.env.FRONTEND_URL || "http://localhost:3000";

// ── Image cache (per-process; cleared on restart) ──────────────────────────
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

async function fetchAsLumaRef(url) {
  const data = await fetchImageAsBase64(url);
  if (!data) return null;
  return { data: data.base64, media_type: data.mimeType };
}

// ── Luma API helpers ───────────────────────────────────────────────────────

async function lumaCreateGeneration({ prompt, image_ref, model, aspect_ratio }) {
  const body = {
    prompt,
    model,
    type: "image",
    aspect_ratio,
    ...(image_ref && image_ref.length > 0 ? { image_ref } : {}),
  };
  const res = await fetch(`${LUMA_API_BASE}/generations`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.LUMA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Luma create failed [${res.status}]: ${text}`);
  }
  return res.json();
}

async function lumaGetGeneration(id) {
  const res = await fetch(`${LUMA_API_BASE}/generations/${id}`, {
    headers: { "Authorization": `Bearer ${process.env.LUMA_API_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Luma poll failed [${res.status}]: ${text}`);
  }
  return res.json();
}

async function lumaPollUntilDone(id) {
  const start = Date.now();
  let polls = 0;
  let lastState = "queued";
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    polls++;
    const gen = await lumaGetGeneration(id);
    if (gen.state !== lastState) {
      console.log(`[convo-image-luma] Job ${id.slice(0, 8)}: ${lastState} → ${gen.state} (poll ${polls}, ~${polls * POLL_INTERVAL_MS / 1000}s elapsed)`);
      lastState = gen.state;
    }
    if (gen.state === "completed") {
      console.log(`[convo-image-luma] ✅ Completed after ${polls} polls (~${polls * POLL_INTERVAL_MS / 1000}s)`);
      return gen;
    }
    if (gen.state === "failed") {
      throw new Error(`Luma generation failed: ${gen.failure_code || "?"} - ${gen.failure_reason || "?"}`);
    }
  }
  throw new Error(`Luma generation timed out after ${POLL_TIMEOUT_MS}ms (last state: ${lastState})`);
}

async function downloadImageAsDataUri(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download Luma output: ${res.status}`);
  const contentType = res.headers.get("content-type") || "image/png";
  const buffer = Buffer.from(await res.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

// ── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!process.env.LUMA_API_KEY) {
    return res.status(500).json({ error: "LUMA_API_KEY not configured" });
  }

  try {
    const { scenarioHidden, desc, more, roles, transcript, tone, scenarioId, roleIds, imageCount, visualHistory, imageDirection, isClosingShot, closingImageHint, imageNotes } = req.body;

    if (!scenarioHidden || !transcript) {
      return res.status(400).json({ error: "Missing scenarioHidden or transcript" });
    }

    const shotNum = imageCount || 0;

    // ── Build reference images (max 9 for Luma) + labels ──────────────
    const imageRefs = [];
    const refLabels = [];

    if (scenarioId && roleIds && Array.isArray(roleIds)) {
      // Character portraits — ALWAYS include
      let idx = 0;
      for (const roleId of roleIds) {
        const ref = await fetchAsLumaRef(`${FRONTEND_BASE}/assets/characters/${scenarioId}-${roleId}.jpg`);
        if (ref) {
          imageRefs.push(ref);
          const role = (roles || [])[idx];
          refLabels.push(`Reference ${imageRefs.length}: Portrait of ${role?.label || roleId} — match this person's face, hair, body type, and clothing exactly.`);
        }
        idx++;
      }

      // Video stills — full set early, taper to one later
      const stillsToInclude = shotNum <= 2 ? [1, 2, 3] : [1];
      for (const n of stillsToInclude) {
        const ref = await fetchAsLumaRef(`${FRONTEND_BASE}/assets/stills/${scenarioId}-${n}.jpg`);
        if (ref) {
          imageRefs.push(ref);
          refLabels.push(`Reference ${imageRefs.length}: Scene still — match the spatial layout, camera framing, and visual mood.`);
        }
      }
    }

    // Scene establishing image
    if (scenarioId && imageRefs.length < 9) {
      for (const ext of ["webp", "jpg"]) {
        const ref = await fetchAsLumaRef(`${FRONTEND_BASE}/convo-img/${scenarioId}.${ext}`);
        if (ref) {
          imageRefs.push(ref);
          refLabels.push(`Reference ${imageRefs.length}: Establishing shot of the environment — match the setting, lighting, and overall aesthetic.`);
          break;
        }
      }
    }

    // Hard cap at 9 (Luma limit)
    while (imageRefs.length > 9) { imageRefs.pop(); refLabels.pop(); }

    // ── Character descriptions ─────────────────────────────────────────
    const characterBlock = (roles || [])
      .map(r => {
        const lines = [`${r.label}:`];
        if (r.npc) lines.push(`  Appearance: ${r.npc}`);
        if (r.personality) lines.push(`  Personality: ${r.personality}`);
        return lines.join("\n");
      })
      .join("\n\n");

    // ── Shot direction (parallels Gemini path, condensed for Luma's 6k prompt cap) ──
    let shotDirection;
    if (isClosingShot) {
      shotDirection = `CLOSING SHOT — wide cinematic pullback. The interaction has ended or is ending. Show the environment with breathing room. Final-frame quality — contemplative, complete. Warm lighting for positive endings, cooler tones for tense ones. Shot on Hasselblad, Kodak Portra 400, shallow DOF on environment.${closingImageHint ? ` Specifically: ${closingImageHint}` : ""}`;
    } else if (shotNum === 0) {
      shotDirection = "Wide establishing shot — both characters visible, space between them, full setting. Camera pulled back to orient viewer. Hasselblad, natural daylight, Kodak Portra 400.";
    } else if (shotNum === 1) {
      shotDirection = "Medium two-shot — both characters visible, focused on the interaction. Body language emphasized, rule of thirds, shallow DOF on characters.";
    } else if (shotNum === 2) {
      shotDirection = "Close-up on the AI character — facial expression and hands engaged in the action (writing, pouring, gesturing). Tight framing, bokeh background.";
    } else if (shotNum === 3) {
      shotDirection = "Over-the-shoulder from the learner's perspective — show what they see. Leading lines toward the AI character.";
    } else if (shotNum === 4) {
      shotDirection = "Wide shot, scene progressed — environmental storytelling from a new angle, reflecting any state changes.";
    } else {
      const altShots = [
        "Close-up on hands or objects central to the scene (documents, cups, instruments). Macro detail, shallow DOF.",
        "Medium shot, new angle — different perspective from prior shots. Fresh composition.",
        "Emotional-tone close-up — framing matches the mood, cinematic color grading.",
      ];
      shotDirection = altShots[shotNum % altShots.length];
    }

    // ── Context weighting ──────────────────────────────────────────────
    const scenarioSlice = shotNum === 0 ? 1000 : shotNum <= 2 ? 400 : 200;
    const transcriptSlice = shotNum === 0 ? 200 : shotNum <= 2 ? 1500 : 2000;

    // ── Visual continuity ──────────────────────────────────────────────
    let visualContinuityBlock = "";
    if (visualHistory && visualHistory.trim()) {
      visualContinuityBlock = `\nVISUAL CONTINUITY (what's already happened in prior images):\n${visualHistory}\nPreserve state changes — bandages stay applied, documents stay handed over, position changes persist.`;
    }

    // ── Final prompt ───────────────────────────────────────────────────
    const prompt = `Photorealistic image for a language learning app.

SCENE: ${scenarioHidden.slice(0, scenarioSlice)}

ENVIRONMENT: ${(more || "").slice(0, shotNum === 0 ? 600 : 200)}

CHARACTERS:
${characterBlock}

CURRENT MOMENT IN THE CONVERSATION:
${transcript.slice(-transcriptSlice)}

Tone: ${tone || "neutral"}

${imageDirection ? `DIRECTOR'S NOTE (highest priority — exact contents of this image):\n${imageDirection}\n` : ""}
SHOT: ${shotDirection}
${visualContinuityBlock}
${refLabels.length > 0 ? `\nREFERENCE IMAGES (provided in this exact order):\n${refLabels.join("\n")}\n` : ""}
RULES:
- Photorealistic style, natural lighting, cinematic quality, Kodak Portra 400 palette
- Characters positioned logically in the physical space: customers on customer side of counters, drivers in driver seats, patients on exam tables/chairs. Phone-call scenes: each character in their own environment — NEVER merged into one scene
- Natural interaction — eye contact, gestures, body language between characters
- Characters NEVER look at the camera — they look at each other or relevant objects
- Consistent lighting across all images in the conversation
- NO text, words, letters, readable signs, watermarks, chat bubbles, UI overlays, phone screens with readable text
- NO violence, weapons, blood, sexual content
- Hands in natural positions (at sides, holding objects, or out of frame)${imageNotes ? `\n\nSCENARIO-SPECIFIC GUIDANCE:\n${imageNotes}` : ""}`;

    // ── Submit + poll + download ───────────────────────────────────────
    console.log(`[convo-image-luma] Creating ${LUMA_MODEL} job: ${imageRefs.length} refs, shot ${shotNum}, prompt ${prompt.length} chars`);
    const job = await lumaCreateGeneration({
      prompt,
      image_ref: imageRefs,
      model: LUMA_MODEL,
      aspect_ratio: "16:9",
    });

    console.log(`[convo-image-luma] Job ${job.id} (${job.state}), polling...`);
    const completed = await lumaPollUntilDone(job.id);
    const outputUrl = completed.output?.[0]?.url;
    if (!outputUrl) {
      throw new Error(`Luma returned no output URL: ${JSON.stringify(completed)}`);
    }

    console.log(`[convo-image-luma] ✅ Downloading output...`);
    const dataUri = await downloadImageAsDataUri(outputUrl);

    res.json({
      imageUrl: dataUri,
      description: `[Luma ${LUMA_MODEL}] shot ${shotNum}`,
    });
  } catch (err) {
    console.error("[convo-image-luma] generation failed:", err?.message || err);
    res.status(500).json({ error: "Image generation failed", details: err?.message });
  }
}