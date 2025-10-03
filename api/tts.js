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

    const safe = (s = "") =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
       .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

    const bodyPrimary = ssml || `
      <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
        <voice name="${voice}">
          <prosody rate="${rate}">${safe(text)}</prosody>
        </voice>
      </speak>`.trim();

    console.log("🔸 SSML SENT TO AZURE:\n", bodyPrimary);

    const callAzure = async (body) => {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Ocp-Apim-Subscription-Region": region, // extra signal; harmless if not needed
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
          "User-Agent": "LuxPronunciationTool",
        },
        body,
      });
      return r;
    };

    // First attempt (whatever client requested)
    let azureRes = await callAzure(bodyPrimary);
    if (!azureRes.ok) {
      // Read whatever Azure returned (sometimes empty)
      const detail = await azureRes.text().catch(() => "");
      console.error("🔻 AZURE ERROR", azureRes.status, detail?.slice(0, 800) || "(no body)");

      // If the request used express-as, retry once without it (keep prosody)
      if (azureRes.status === 400 && bodyPrimary.includes("<mstts:express-as")) {
        const stripped = bodyPrimary
          .replace(/<mstts:express-as[^>]*>/, "")
          .replace(/<\/mstts:express-as>/, "");
        console.log("↩️  Retrying without express-as…\n", stripped);
        azureRes = await callAzure(stripped);
        if (azureRes.ok) {
          const buf = Buffer.from(await azureRes.arrayBuffer());
          res.setHeader("Content-Type", "audio/mpeg");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("X-Style-Fallback", "1");
          return res.status(200).send(buf);
        }
        const detail2 = await azureRes.text().catch(() => "");
        console.error("🔻 AZURE ERROR (retry)", azureRes.status, detail2?.slice(0, 800) || "(no body)");
        return res.status(azureRes.status).json({ error: "Azure TTS error", detail: detail2 || detail || "" });
      }

      // No express-as, just fail through
      return res.status(azureRes.status).json({ error: "Azure TTS error", detail });
    }

    // Success path
    const buf = Buffer.from(await azureRes.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buf);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
