// /api/tts.js
export default async function handler(req, res) {
  // --- CORS (so your sandbox can call this) ---
  res.setHeader("Access-Control-Allow-Origin", "*"); // or your specific origin
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end(); // preflight OK
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { text, rate = "0%", voice = "en-US-AvaNeural", ssml } = req.body || {};

    if (!voice) {
      return res.status(400).json({ error: "Missing voice" });
    }
    if (!text && !ssml) {
      return res.status(400).json({ error: "Missing text or ssml" });
    }

    const key = process.env.AZURE_SPEECH_KEY || process.env.AZURE_TTS_KEY;
    const region = process.env.AZURE_SPEECH_REGION || process.env.AZURE_REGION;
    if (!key || !region) {
      return res.status(500).json({ error: "Server TTS not configured" });
    }

    const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

    // --- Build the request body ---
    let body;
    let contentType = "application/ssml+xml";

    if (ssml) {
      // Already a full SSML string from the client
      body = ssml;
    } else {
      // Legacy: wrap plain text in minimal SSML
      const safe = (s = "") =>
        s
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&apos;");

      body = `
        <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
          <voice name="${voice}">
            <prosody rate="${rate}">${safe(text)}</prosody>
          </voice>
        </speak>`.trim();
    }

    // --- Call Azure ---
    const azureRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": contentType,
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "LuxPronunciationTool",
      },
      body,
    });

    if (!azureRes.ok) {
      const detail = await azureRes.text().catch(() => "");
      return res.status(azureRes.status).json({ error: "Azure TTS error", detail });
    }

    const buf = Buffer.from(await azureRes.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buf);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
