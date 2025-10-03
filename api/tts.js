// file: /api/tts.js
// Supports JSON { text, rate, voice } or { ssml, voice }.
// Logs SSML, calls Azure, and if Azure 400s on express-as, retries once without it.
// Also sanitizes zero-valued prosody attrs (rate="0%", pitch="0st") which can trigger 400s.

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
    // Some runtimes may send stringified JSON; handle either shape.
    let bodyData = req.body;
    if (typeof bodyData === "string") {
      try { bodyData = JSON.parse(bodyData); } catch {}
    }

    const {
      text,
      rate = "+0%", // IMPORTANT: avoid "0%"
      voice = "en-US-AvaNeural",
      ssml
    } = bodyData || {};

    if (!voice) return res.status(400).json({ error: "Missing voice" });
    if (!text && !ssml) return res.status(400).json({ error: "Missing text or ssml" });

    const key    = process.env.AZURE_SPEECH_KEY || process.env.AZURE_TTS_KEY;
    const region = process.env.AZURE_SPEECH_REGION || process.env.AZURE_REGION;
    if (!key || !region) return res.status(500).json({ error: "Server TTS not configured" });

    const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

    const safe = (s = "") =>
      s.replace(/&/g, "&amp;")
       .replace(/</g, "&lt;")
       .replace(/>/g, "&gt;")
       .replace(/"/g, "&quot;")
       .replace(/'/g, "&apos;");

    // Remove zero-valued prosody attrs that can cause 400, or normalize rate="0%" -> "+0%"
    const sanitizeZeroAttrs = (xml) =>
      xml
        .replace(/\s+rate="0%"/g, ' rate="+0%"') // or `.replace(/\s+rate="0%"/g, "")` to omit entirely
        .replace(/\s+pitch="0st"/g, "");        // drop zero pitch

    // Base body: use provided SSML or minimal neutral wrapper
    let bodyPrimary = ssml || `
      <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
        <voice name="${voice}">
          <prosody rate="${rate}">${safe(text)}</prosody>
        </voice>
      </speak>
    `.trim();

    bodyPrimary = sanitizeZeroAttrs(bodyPrimary);

    console.log("🔸 SSML SENT TO AZURE:\n", bodyPrimary);

    const callAzure = async (body) => {
      return await fetch(endpoint, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Ocp-Apim-Subscription-Region": region, // helpful for some tenants
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
          "User-Agent": "LuxPronunciationTool",
        },
        body,
      });
    };

    // First attempt (as-is)
    let azureRes = await callAzure(bodyPrimary);
    if (!azureRes.ok) {
      const detail = await azureRes.text().catch(() => "");
      console.error("🔻 AZURE ERROR", azureRes.status, detail?.slice(0, 800) || "(no body)");

      // If the request used express-as, retry without it (keep prosody attrs, sanitized)
      if (azureRes.status === 400 && bodyPrimary.includes("<mstts:express-as")) {
        let stripped = bodyPrimary;
        // Remove any <mstts:express-as ...> ... </mstts:express-as> pairs
        while (/<mstts:express-as[^>]*>/.test(stripped)) {
          stripped = stripped.replace(/<mstts:express-as[^>]*>/, "").replace(/<\/mstts:express-as>/, "");
        }
        stripped = sanitizeZeroAttrs(stripped);

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

      return res.status(azureRes.status).json({ error: "Azure TTS error", detail });
    }

    // Success
    const buf = Buffer.from(await azureRes.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buf);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
