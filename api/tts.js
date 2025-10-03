// /api/tts.js
// - GET  ?voices=1  -> proxy Azure voices list for your region (capabilities for style/role)
// - POST (JSON)     -> build SSML and synthesize. On 400 with style, retry neutral and add X-Style-Fallback header.

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*"); // consider locking to your origin
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const REGION =
      process.env.AZURE_SPEECH_REGION ||
      process.env.AZURE_REGION ||
      "eastus";
    const KEY =
      process.env.AZURE_SPEECH_KEY ||
      process.env.AZURE_TTS_KEY;

    if (!REGION || !KEY) {
      return res.status(500).json({ error: "Server TTS not configured" });
    }

    // GET voices capabilities (no body)
    if (req.method === "GET") {
      const wantsVoices = String(req.query?.voices || "") === "1";
      if (!wantsVoices) {
        return res.status(400).json({ error: "Bad request" });
      }
      const voicesUrl = `https://${REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
      const vr = await fetch(voicesUrl, {
        method: "GET",
        headers: { "Ocp-Apim-Subscription-Key": KEY },
      });
      if (!vr.ok) {
        const t = await vr.text().catch(() => "");
        console.error("🔻 AZURE VOICES ERROR", vr.status, t.slice(0, 300));
        return res.status(vr.status).json({ error: "voices list failed" });
      }
      const json = await vr.json();
      // Return en-US only (you can broaden later)
      const enUS = json.filter((v) => v.Locale === "en-US");
      return res.status(200).json(enUS);
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST, OPTIONS");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Parse body
    const { ssml, text, voice, ratePct, pitchSt, style, styledegree, role } = req.body || {};
    if (!voice) return res.status(400).json({ error: "missing voice" });
    if (!ssml && (!text || typeof text !== "string" || !text.trim())) {
      return res.status(400).json({ error: "missing text or ssml" });
    }

    // Helper: build SSML on the server (so logs show exactly what Azure receives)
    function escapeXml(s = "") {
      return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
    }

    const STYLE_SYNONYMS = {
      "customer-service": "customerservice",
      "customer_service": "customerservice",
      customerservice: "customerservice",
      news: "newscast",
      newscaster: "newscast",
    };

    function normalizeStyle(label = "", styleList = []) {
      if (!label) return "";
      const wanted = (STYLE_SYNONYMS[label] || label).toLowerCase();
      if (wanted === "newscast") {
        // If variants exist for this voice list call, pick formal over casual on the fly
        // (We don't have voice-specific list here; client filters already. Keep generic.)
        return "newscast"; // Azure still accepts "newscast" for many voices
      }
      return wanted;
    }

    function buildSSMLServer() {
      if (ssml) return String(ssml);

      const rPct = Math.round(Number(ratePct || 0));
      const rate = rPct === 0 ? "0%" : rPct > 0 ? `+${rPct}%` : `${rPct}%`;
      const pSt = Number(pitchSt || 0);
      const pitch = pSt === 0 ? "0st" : pSt > 0 ? `+${pSt}st` : `${pSt}st`;

      const rawStyle = (style || "").trim();
      const normStyle = normalizeStyle(rawStyle);
      const deg = Math.min(2, Math.max(0.01, Number(styledegree || 1)));
      const roleAttr = role ? ` role="${role}"` : "";

      const ns =
        'xmlns="http://www.w3.org/2001/10/synthesis" ' +
        'xmlns:mstts="https://www.w3.org/2001/mstts" ' +
        'xml:lang="en-US"';

      const inner = normStyle
        ? `<mstts:express-as style="${normStyle}" styledegree="${deg}"${roleAttr}><prosody rate="${rate}" pitch="${pitch}">${escapeXml(
            text
          )}</prosody></mstts:express-as>`
        : `<prosody rate="${rate}" pitch="${pitch}">${escapeXml(text)}</prosody>`;

      return `<speak version="1.0" ${ns}><voice name="${voice}">${inner}</voice></speak>`;
    }

    const endpoint = `https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;

    async function synth(ssmlToSend) {
      console.log("🔸 SSML SENT TO AZURE:\n", ssmlToSend);
      const r = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": KEY,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
          "User-Agent": "lux-pronunciation-tool",
        },
        body: ssmlToSend,
      });
      return r;
    }

    // 1) First attempt (as requested)
    const firstSSML = buildSSMLServer();
    let r = await synth(firstSSML);

    // 2) If Azure 400 and a style was requested, retry neutral so UI can still play audio
    const requestedStyle =
      (STYLE_SYNONYMS[(style || "").trim()] || (style || "").trim()) || "";
    if (!r.ok && r.status === 400 && requestedStyle) {
      console.warn("🔻 AZURE ERROR 400 (will retry neutral)");
      const neutralSSML = buildSSMLServer().replace(
        /<mstts:express-as[^>]*>/,
        ""
      ).replace(
        /<\/mstts:express-as>/,
        ""
      );
      console.log("↩️  Retrying without express-as…\n", neutralSSML);
      const r2 = await synth(neutralSSML);
      if (r2.ok) {
        const audioBuffer = Buffer.from(await r2.arrayBuffer());
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Style-Fallback", requestedStyle);
        return res.status(200).send(audioBuffer);
      } else {
        const t2 = await r2.text().catch(() => "");
        console.error("🔻 AZURE ERROR (retry)", r2.status, t2.slice(0, 300));
        return res.status(r2.status).json({ error: "Azure TTS error (retry)", detail: t2 });
      }
    }

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error("🔻 AZURE ERROR", r.status, t.slice(0, 300));
      return res.status(r.status).json({ error: "Azure TTS error", detail: t });
    }

    // Success
    const audioBuffer = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(audioBuffer);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
}
