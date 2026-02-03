// POST /api/realtime/webrtc/session
// Receives browser offer SDP (text/plain or application/sdp) and returns answer SDP from OpenAI Realtime.
//
// Uses OpenAI "unified interface" SDP exchange via /v1/realtime/calls.

export const config = {
  api: {
    bodyParser: false, // we need the raw SDP text
    externalResolver: true,
  },
};

function clampNumber(v, fallback, min, max) {
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-token");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-Voice-Requested, X-Voice-Used, X-Model-Used"
  );

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // ADMIN_TOKEN gate (cost-control)
  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();

  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();

  console.log("webrtc/session auth", {
    hasExpected: !!expected,
    tokenLen: token ? token.length : 0,
  });

  // TEMP: If ADMIN_TOKEN is unset, keep the endpoint open for testing.
  // When you set ADMIN_TOKEN later, token becomes required.
  if (expected && token !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const apiKey = (process.env.OPENAI_API_KEY || "").toString().trim();
  if (!apiKey) {
    return res.status(500).json({ error: "missing_openai_api_key" });
  }

  // Read offer SDP as raw text
  const offerSDP = await readTextBody(req);
  if (!offerSDP || offerSDP.trim().length < 20) {
    return res.status(400).json({ error: "missing_offer_sdp" });
  }

  // Config knobs (optional)
  // Defaults: cost-controlled by default
  const model =
    (req.query?.model || "gpt-realtime-mini").toString().trim() ||
    "gpt-realtime-mini";

  const requestedVoice =
    (req.query?.voice || "marin").toString().trim() || "marin";

  // Realtime supports audio.output.speed: 0.25–1.5, default 1.0 (between turns only)
  // Lux Streaming default is intentionally slower.
  // NOTE: Realtime's documented default is 1.0, but we set 0.85 as our product default.
  const speed = clampNumber(req.query?.speed, 0.85, 0.25, 1.5);

  // Hard cap tokens per assistant response (safety/cost control)
  // Allow override, but clamp safely.
  const maxOutputTokens = clampInt(
    req.query?.max_output_tokens ?? req.query?.maxOutputTokens,
    250,
    1,
    4096
  );

  // Voice fallback: try requested voice first; if it fails and it's not marin, retry marin.
  const primaryVoice = requestedVoice;
  const fallbackVoice = primaryVoice === "marin" ? null : "marin";

  // NOTE: Start in Tap (create_response: false). The frontend toggles per UI.
  const sessionConfig = JSON.stringify({
    type: "realtime",
    model,
    max_output_tokens: maxOutputTokens,
    audio: {
      output: { voice: primaryVoice, speed },
      input: {
        turn_detection: {
          type: "server_vad",
          create_response: false, // default TAP; frontend toggles to true for AUTO
          interrupt_response: true,
        },
      },
    },
    output_modalities: ["audio"],
  });

  const attempt1 = await callRealtime({
    apiKey,
    offerSDP,
    sessionConfig,
  });
  let final = attempt1;

  if (!attempt1.ok && fallbackVoice) {
    const base = JSON.parse(sessionConfig);
    base.audio = { ...(base.audio || {}), output: { voice: fallbackVoice, speed } };
    const attempt2 = await callRealtime({
      apiKey,
      offerSDP,
      sessionConfig: JSON.stringify(base),
    });
    if (attempt2.ok) final = attempt2;
  }

  res.setHeader("X-Voice-Requested", primaryVoice);
  res.setHeader("X-Voice-Used", final.voice || primaryVoice);
  res.setHeader("X-Model-Used", model);

  if (!final.ok) {
    // Preserve status + text for debugging in the frontend error path
    res.status(final.status || 500);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end(final.text || "Realtime SDP exchange failed");
  }

  // Success: return answer SDP text
  res.status(200);
  res.setHeader("Content-Type", "application/sdp; charset=utf-8");
  return res.end(final.text);
}

export default handler;

import { Blob } from "buffer";

async function callRealtime({ apiKey, offerSDP, sessionConfig }) {
  const fd = new FormData();

  // ✅ REQUIRED: send these as multipart "file parts"
  fd.append("sdp", new Blob([offerSDP], { type: "application/sdp" }), "offer.sdp");
  fd.append("session", new Blob([sessionConfig], { type: "application/json" }), "session.json");

  const r = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  });

  const text = await r.text();
  return { ok: r.ok, status: r.status, text, voice: JSON.parse(sessionConfig).audio.output.voice };
}

function readTextBody(req) {
  // In some environments, req.body may already be present; prefer it if it's a string.
  if (typeof req.body === "string") return Promise.resolve(req.body);

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 2_000_000) {
        reject(new Error("Body too large"));
      }
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
