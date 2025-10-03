// /api/tts.js
// - GET  ?voices=1  -> proxy Azure voices list (capabilities for styles/roles)
// - POST JSON       -> build SSML on server. Omits zero-valued prosody attrs.
//                     If 400 with style, retry neutral and set X-Style-Fallback.

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*"); // tighten to your origin if desired
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const REGION = process.env.AZURE_SPEECH_REGION || process.env.AZURE_REGION || "eastus";
    const KEY    = process.env.AZURE_SPEECH_KEY    || process.env.AZURE_TTS_KEY;

    if (!REGION || !KEY) {
      return res.status(500).json({ error: "Server TTS not configured" });
    }

    // ---------- GET: voices list ----------
    if (req.method === "GET") {
      if (String(req.query?.voices || "") !== "1") {
        return res.status(400).json({ error: "Bad request" });
      }
      const voicesUrl = `https://${REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
      const vr = await fetch(voicesUrl, {
        method: "GET",
        headers: { "Ocp-Apim-Subscription-Key": KEY, "Ocp-Apim-Subscription-Region": REGION },
      });
      if (!vr.ok) {
        const t = await vr.text().catch(() => "");
        console.error("🔻 AZURE VOICES ERROR", vr.status, t.slice(0, 300));
        return res.status(vr.status).json({ error: "voices list failed" });
      }
      const all = await vr.json();
      const enUS = all.filter(v => v.Locale === "en-US");
      return res.status(200).json(enUS);
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST, OPTIONS");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // ---------- POST: synth ----------
    let bodyData = req.body;
    if (typeof bodyData === "string") { try { bodyData = JSON.parse(bodyData); } catch {} }

    const {
      ssml,
      text,
      voice,
      ratePct,      // number, e.g. 0, +5, -10
      pitchSt,      // number, semitones
      style,        // string or ""
      styledegree,  // number
      role          // optional
    } = bodyData || {};

    if (!voice) return res.status(400).json({ error: "missing voice" });
    if (!ssml && (!text || typeof text !== "string" || !text.trim())) {
      return res.status(400).json({ error: "missing text or ssml" });
    }

    // Helpers
    const endpoint = `https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;

    const STYLE_SYNONYMS = {
      "customer-service": "customerservice",
      "customer_service": "customerservice",
      customerservice: "customerservice",
      news: "newscast",
      newscaster: "newscast",
    };

    const normStyle = (s = "") => {
      if (!s) return "";
      const wanted = (STYLE_SYNONYMS[s] || s).toLowerCase();
      return wanted === "newscast" ? "newscast" : wanted;
    };

    const esc = (s = "") =>
      s.replace(/&/g, "&amp;")
       .replace(/</g, "&lt;")
       .replace(/>/g, "&gt;")
       .replace(/"/g, "&quot;")
       .replace(/'/g, "&apos;");

    // Build SSML.
    // IMPORTANT: only include mstts namespace when style is present,
    // and OMIT zero-valued rate/pitch entirely to avoid 400s.
    function buildSSML() {
      if (ssml) return String(ssml);

      const r = Number.isFinite(ratePct) ? Math.round(ratePct) : 0;
      const p = Number.isFinite(pitchSt) ? Math.round(pitchSt) : 0;

      const rateAttr  = r === 0 ? "" : ` rate="${r > 0 ? `+${r}%` : `${r}%`}"`;
      const pitchAttr = p === 0 ? "" : ` pitch="${p > 0 ? `+${p}st` : `${p}st`}"`;

      const s = normStyle(style || "");
      const deg = Math.min(2, Math.max(0.01, Number(styledegree || 1)));
      const roleAttr = role ? ` role="${role}"` : "";

      // Neutral path (no style): no mstts namespace, and only add <prosody> if we have attrs.
      if (!s) {
        const prosodyOpen = (rateAttr || pitchAttr) ? `<prosody${rateAttr}${pitchAttr}>` : "";
        const prosodyClose = prosodyOpen ? `</prosody>` : "";
        const inner = prosodyOpen ? `${prosodyOpen}${esc(text)}${prosodyClose}` : esc(text);
        const xml =
          `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">` +
          `<voice name="${voice}">` + inner + `</voice></speak>`;
        return xml;
      }

      // Styled path
      const prosodyOpen = `<prosody${rateAttr}${pitchAttr}>`;
      const inner =
        `<mstts:express-as style="${s}" styledegree="${deg}"${roleAttr}>` +
        `${prosodyOpen}${esc(text)}</prosody>` +
        `</mstts:express-as>`;

      const xml =
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">` +
        `<voice name="${voice}" xmlns:mstts="https://www.w3.org/2001/mstts">` +
        inner +
        `</voice></speak>`;
      return xml;
    }

    const callAzure = async (xml) => {
      console.log("🔸 SSML SENT TO AZURE:\n", xml);
      const r = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": KEY,
          "Ocp-Apim-Subscription-Region": REGION, // some tenants require region header
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
          "User-Agent": "lux-pronunciation-tool",
        },
        body: xml,
      });
      return r;
    };

    // First attempt (exact request)
    const firstXml = buildSSML();
    let r = await callAzure(firstXml);

    // If a style was requested and Azure returns 400, retry neutral.
    const requestedStyle = normStyle(style || "");
    if (!r.ok && r.status === 400 && requestedStyle) {
      const neutralXml = firstXml
        .replace(/<mstts:express-as[^>]*>/, "")
        .replace(/<\/mstts:express-as>/, "")
        // if no rate/pitch remained, also remove empty <prosody></prosody> just in case
        .replace(/<prosody>\s*([^]*?)\s*<\/prosody>/, "$1");
      console.warn("🔻 AZURE ERROR 400 (will retry neutral)");
      console.log("↩️  Retrying without express-as…\n", neutralXml);

      const r2 = await callAzure(neutralXml);
      if (r2.ok) {
        const buf = Buffer.from(await r2.arrayBuffer());
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Style-Fallback", requestedStyle);
        return res.status(200).send(buf);
      } else {
        const t2 = await r2.text().catch(() => "");
        console.error("🔻 AZURE ERROR (retry)", r2.status, t2.slice(0, 500) || "(no body)");
        return res.status(r2.status).json({ error: "Azure TTS error (retry)", detail: t2 });
      }
    }

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error("🔻 AZURE ERROR", r.status, t.slice(0, 500) || "(no body)");
      return res.status(r.status).json({ error: "Azure TTS error", detail: t });
    }

    // Success
    const audio = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(audio);

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
}
