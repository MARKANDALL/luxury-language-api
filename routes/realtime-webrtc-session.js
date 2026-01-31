// routes/realtime-webrtc-session.js
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
  const model = (req.query?.model || "gpt-realtime").toString();
  const requestedVoice = (req.query?.voice || "marin").toString();

  // Voice fallback: try requested voice first; if it fails and it's not marin, retry marin.
  const primaryVoice = requestedVoice;
  const fallbackVoice = primaryVoice === "marin" ? null : "marin";

  const attempt1 = await callRealtime({ apiKey, offerSDP, model, voice: primaryVoice });
  let final = attempt1;

  if (!attempt1.ok && fallbackVoice) {
    const attempt2 = await callRealtime({ apiKey, offerSDP, model, voice: fallbackVoice });
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

async function callRealtime({ apiKey, offerSDP, model, voice }) {
  const sessionConfig = JSON.stringify({
    type: "realtime",
    model,
    audio: { output: { voice } },
  });

  // FormData is available in modern Node runtimes on Vercel.
  // If your runtime lacks it, you'll see an exception and it will show in Vercel logs.
  const fd = new FormData();
  fd.set("sdp", offerSDP);
  fd.set("session", sessionConfig);

  try {
    const r = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: fd,
    });

    const text = await r.text();
    return { ok: r.ok, status: r.status, text, voice };
  } catch (e) {
    return {
      ok: false,
      status: 500,
      text: `Realtime call error: ${e?.message || String(e)}`,
      voice,
    };
  }
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
