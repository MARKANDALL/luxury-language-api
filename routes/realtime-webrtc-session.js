// POST /api/realtime/webrtc/session
// Receives browser offer SDP (text/plain or application/sdp) and returns answer SDP from OpenAI Realtime.
//
// Uses OpenAI "unified interface" SDP exchange via /v1/realtime/calls.
//
// 2026-07-06 CHANGE (the user exists): input audio transcription is now enabled in the
// session config. Until now the learner's spoken turns were never transcribed, so their
// own words never appeared in the thread and there was nothing to score a turn against.
// Whisper-family transcription (gpt-4o-mini-transcribe) now runs server-side on the
// user's audio; the frontend receives conversation.item.input_audio_transcription.*
// events and renders user bubbles. An optional ?lang=es|en|... query knob passes an
// ISO-639-1 language hint for better accuracy (omit for auto-detect). This transcript
// also becomes the reference text for per-turn pronunciation scoring (the turn flag).

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

// ISO-639-1 style language hint ("es", "en", also tolerates "es-MX" -> "es").
// Returns null when absent/invalid so we fall back to Whisper auto-detect.
function sanitizeLang(v) {
  const s = (v || "").toString().trim().toLowerCase();
  const m = s.match(/^([a-z]{2})(?:-[a-z]{2})?$/i);
  return m ? m[1] : null;
}

async function handler(req, res) {
  try {
    // CORS

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

    if (!expected || token !== expected) {
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
    const model =
      (req.query?.model || "gpt-realtime-mini").toString().trim() ||
      "gpt-realtime-mini";

    const requestedVoice =
      (req.query?.voice || "marin").toString().trim() || "marin";

    const speed = clampNumber(req.query?.speed, 0.85, 0.25, 1.5);

    const maxOutputTokens = clampInt(
      req.query?.max_output_tokens ?? req.query?.maxOutputTokens,
      250,
      1,
      4096
    );

    // Optional transcription language hint (es pack passes ?lang=es)
    const lang = sanitizeLang(req.query?.lang);

    // Voice fallback: try requested voice first; if it fails and it's not marin, retry marin.
    const primaryVoice = requestedVoice;
    const fallbackVoice = primaryVoice === "marin" ? null : "marin";

    // NOTE: Start in Tap (create_response: false). Frontend toggles via session.update later.
    const sessionConfig = {
      type: "realtime",
      model,
      max_output_tokens: maxOutputTokens,
      audio: {
        output: { voice: primaryVoice, speed },
        input: {
          // ✅ User-speech transcription (the learner's words, rendered as user bubbles
          //    + the reference text for per-turn scoring).
          transcription: {
            model: "gpt-4o-mini-transcribe",
            ...(lang ? { language: lang } : {}),
          },
          turn_detection: {
            type: "server_vad",
            create_response: false,
            interrupt_response: true,
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      },
      output_modalities: ["audio"],
    };

    const attempt1 = await callRealtime({ apiKey, offerSDP, sessionConfig });
    let final = attempt1;
    let usedVoice = primaryVoice;

    if (!attempt1.ok && fallbackVoice) {
      const attempt2 = await callRealtime({
        apiKey,
        offerSDP,
        sessionConfig: {
          ...sessionConfig,
          audio: {
            ...(sessionConfig.audio || {}),
            output: { voice: fallbackVoice, speed },
          },
        },
      });
      if (attempt2.ok) {
        final = attempt2;
        usedVoice = fallbackVoice;
      }
    }

    res.setHeader("X-Voice-Requested", primaryVoice);
    res.setHeader("X-Voice-Used", usedVoice);
    res.setHeader("X-Model-Used", model);

    if (!final.ok) {
      res.status(final.status || 500);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.end(final.text || "Realtime SDP exchange failed");
    }

    // Success: return answer SDP text
    res.status(200);
    res.setHeader("Content-Type", "application/sdp; charset=utf-8");
    return res.end(final.text);
  } catch (err) {
    console.error("webrtc/session fatal:", err?.stack || err);
    res.status(500).json({
      error: "webrtc/session fatal",
      message: err?.message || String(err),
      stack: err?.stack ? String(err.stack).slice(0, 2000) : null,
    });
  }
}

export default handler;

async function callRealtime({ apiKey, offerSDP, sessionConfig }) {
  const sessionJson = JSON.stringify(sessionConfig);

  // ✅ CRITICAL: send as plain multipart *fields* (strings), not Blob+filename “file parts”
  const fd = new FormData();
  fd.set("sdp", offerSDP);
  fd.set("session", sessionJson);

  try {
    const req = new Request("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });

    const r = await fetch(req);

    const text = await r.text();

    return { ok: r.ok, status: r.status, text, voice: sessionConfig?.audio?.output?.voice };
  } catch (e) {
    return {
      ok: false,
      status: 500,
      text: `Realtime call error: ${e?.message || String(e)}`,
      voice: sessionConfig?.audio?.output?.voice,
    };
  }
}

function readTextBody(req) {
  if (typeof req.body === "string") return Promise.resolve(req.body);

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 2_000_000) reject(new Error("Body too large"));
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}