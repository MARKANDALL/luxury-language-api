// /api/tts.js
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { text, rate = "0%", voice = "en-US-AvaNeural", ssml } = req.body || {};
    if (!voice) return res.status(400).json({ error: "Missing voice" });
    if (!text && !ssml) return res.status(400).json({ error: "Missing text or ssml" });

    const key    = process.env.AZURE_SPEECH_KEY || process.env.AZURE_TTS_KEY;
    const region = process.env.AZURE_SPEECH_REGION || process.env.AZURE_REGION;
    if (!key || !region) return res.status(500).json({ error: "Server TTS not configured" });

    const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

    // Build SSML (or wrap plain text)
    let body;
    if (ssml) {
      body = ssml;
    } else {
      const safe = (s="") => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
                              .replace(/"/g,"&quot;").replace(/'/g,"&apos;");
      body = `
        <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
          <voice name="${voice}">
            <prosody rate="${rate}">${safe(text)}</prosody>
          </voice>
        </speak>`.trim();
    }

    // Log the SSML sent
    console.log("🔸 SSML SENT TO AZURE:\n", body);

    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "LuxPronunciationTool",
      },
      body,
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("🔻 AZURE ERROR", r.status, detail);
      return res.status(r.status).json({ error: "Azure TTS error", detail });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buf);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
