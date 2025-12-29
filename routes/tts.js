// /api/tts.js  — Azure REST v1 proxy with smart style fallbacks & rich headers
export default async function handler(req, res) {
  // Basic CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Let browser JS read our custom headers:
  res.setHeader("Access-Control-Expose-Headers",
    "X-Style-Used, X-Style-Requested, X-Style-Fallback, X-Style-Message, X-Azure-Region"
  );

  if (req.method === "OPTIONS") return res.status(204).end();

  const key = process.env.AZURE_SPEECH_KEY || process.env.AZURE_TTS_KEY;
  const region =
    process.env.AZURE_SPEECH_REGION || process.env.AZURE_REGION || "eastus";

  const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const voicesEndpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;

  // GET ?voices=1 => proxy voice list with styles/roles
  if (req.method === "GET") {
    if (String(req.query.voices || "") === "1") {
      try {
        const r = await fetch(voicesEndpoint, {
          method: "GET",
          headers: {
            "Ocp-Apim-Subscription-Key": key,
            "Ocp-Apim-Subscription-Region": region,
          },
        });
        const json = await r.json();
        return res.status(200).json({ voices: json });
      } catch (e) {
        console.error("[voices] fetch failed", e);
        return res.status(500).json({ error: "voices fetch failed" });
      }
    }
    return res.status(200).send("OK");
  }

  if (req.method !== "POST")
    return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const body = req.body || {};
    const {
      text,
      voice,
      ssml,
      // numeric knobs (ints OK): -30..+30 for ratePct, -12..+12 for pitchSt
      ratePct,
      pitchSt,
      style,
      styledegree,
      role,
    } = body;

    if (!key || !region)
      return res.status(500).json({ error: "Server TTS not configured" });
    if (!voice) return res.status(400).json({ error: "missing voice" });
    if (!text && !ssml) return res.status(400).json({ error: "missing text or ssml" });

    // Normalize style names a bit
    const STYLE_ALIASES = {
      "customer-service": "customerservice",
      customerservice: "customerservice",
      assistant: "chat",
      // newscast variants tried below
      newscaster: "newscast",
      news: "newscast",
    };

    function normalizeStyle(s) {
      if (!s) return "";
      const t = String(s).trim();
      return STYLE_ALIASES[t] || t;
    }

    function buildProsody(openRatePct, openPitchSt) {
      const r = Number.isFinite(openRatePct) ? Math.round(openRatePct) : 0;
      const p = Number.isFinite(openPitchSt) ? Math.round(openPitchSt) : 0;
      const rateAttr = r === 0 ? "" : ` rate="${r > 0 ? `+${r}%` : `${r}%`}"`;
      const pitchAttr = p === 0 ? "" : ` pitch="${p > 0 ? `+${p}st` : `${p}st`}"`;
      if (!rateAttr && !pitchAttr) return null; // no prosody wrapper needed
      return { open: `<prosody${rateAttr}${pitchAttr}>`, close: `</prosody>` };
    }

    const safe = (s = "") =>
      String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

    const hdrBase = {
      "Ocp-Apim-Subscription-Key": key,
      "Ocp-Apim-Subscription-Region": region,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "lux-pronunciation-tool",
    };

    async function speak(ssmlXml) {
      const r = await fetch(endpoint, { method: "POST", headers: hdrBase, body: ssmlXml });
      let detail = "";
      if (!r.ok) {
        try { detail = await r.text(); } catch {}
        console.warn("🔻 AZURE ERROR", r.status, detail ? `(body ${detail.length}b)` : "(no body)");
        return { ok: false, status: r.status, detail };
      }
      const buf = Buffer.from(await r.arrayBuffer());
      return { ok: true, buf };
    }

    function baseSpeakTag(inner, withMstts = false) {
      // Put mstts on <speak> for max compatibility; keep xml:lang on both speak & voice
      const ns = withMstts
        ? `xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US"`
        : `xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"`;
      return `<speak version="1.0" ${ns}><voice name="${voice}" xml:lang="en-US">${inner}</voice></speak>`;
    }

    // If client provided raw SSML, just pass it through
    if (ssml) {
      const first = await speak(ssml);
      if (!first.ok) return res.status(first.status).json({ error: "Azure TTS error", detail: first.detail });
      res.setHeader("X-Azure-Region", region);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "audio/mpeg");
      return res.status(200).send(first.buf);
    }

    // Build expressive attempt (if style requested) with careful fallbacks
    const requestedStyle = normalizeStyle(style);
    const prosody = buildProsody(ratePct, pitchSt);
    const textXml = safe(text);
    let usedStyle = "";
    let fallback = "";
    let msg = "";

    // helper to build inner XML for a given style/role combo
    function innerFor(styleName, includeRole = true, includeDegree = true) {
      const roleAttr = includeRole && role ? ` role="${role}"` : "";
      const degreeAttr =
        includeDegree && Number.isFinite(styledegree) && styledegree > 0 ? ` styledegree="${styledegree}"` : "";
      const content = prosody ? `${prosody.open}${textXml}${prosody.close}` : textXml;
      if (!styleName) return content; // neutral path
      return `<mstts:express-as style="${styleName}"${degreeAttr}${roleAttr}>${content}</mstts:express-as>`;
    }

    // 1) If a style was requested, try it, then aliases/variants
    if (requestedStyle) {
      const variants = [];
      // base normalized
      variants.push({ style: requestedStyle, deg: true, role: true });
      // newscast sometimes requires a variant
      if (requestedStyle === "newscast") {
        variants.push({ style: "newscast-casual", deg: true, role: true });
        variants.push({ style: "newscast-formal", deg: true, role: true });
      }
      // customerservice hyphen form (just in case)
      if (requestedStyle === "customerservice") {
        variants.push({ style: "customer-service", deg: true, role: true });
      }
      // If still grumpy, try dropping role, then degree
      variants.push({ style: requestedStyle, deg: true, role: false });
      variants.push({ style: requestedStyle, deg: false, role: true });
      variants.push({ style: requestedStyle, deg: false, role: false });

      let success = null;
      for (const v of variants) {
        const inner = innerFor(v.style, v.role, v.deg);
        const xml = baseSpeakTag(inner, true);
        const r = await speak(xml);
        console.log("🔸 SSML SENT TO AZURE:", xml);
        if (r.ok) {
          usedStyle = v.style;
          success = r;
          break;
        }
      }

      if (success) {
        res.setHeader("X-Style-Requested", requestedStyle);
        res.setHeader("X-Style-Used", usedStyle || "neutral");
        res.setHeader("X-Azure-Region", region);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "audio/mpeg");
        if (usedStyle !== requestedStyle) {
          fallback = "variant";
          msg = `Using '${usedStyle}' (closest available) for ${voice}.`;
          res.setHeader("X-Style-Fallback", fallback);
          res.setHeader("X-Style-Message", msg);
        }
        return res.status(200).send(success.buf);
      }

      // 2) Expressive failed => neutral retry
      const neutralInner = innerFor("");
      const neutralXml = baseSpeakTag(neutralInner, true); // keep mstts ns harmlessly
      const n = await speak(neutralXml);
      console.log("↩️  Retrying neutral…\n", neutralXml);
      if (n.ok) {
        usedStyle = "neutral";
        fallback = "unsupported";
        msg = `Style '${requestedStyle}' isn’t available for ${voice}. Playing neutral; rate/pitch still applied.`;
        res.setHeader("X-Style-Requested", requestedStyle);
        res.setHeader("X-Style-Used", usedStyle);
        res.setHeader("X-Style-Fallback", fallback);
        res.setHeader("X-Style-Message", msg);
        res.setHeader("X-Azure-Region", region);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "audio/mpeg");
        return res.status(200).send(n.buf);
      }

      // 3) Even neutral failed (very rare) — surface Azure error
      return res.status(400).json({ error: "Azure TTS error", detail: n.detail || "" });
    }

    // No style requested => neutral path
    const content = prosody ? `${prosody.open}${safe(text)}${prosody.close}` : safe(text);
    const neutralXml = baseSpeakTag(content, false);
    const r = await speak(neutralXml);
    console.log("🔸 SSML SENT TO AZURE:", neutralXml);
    if (!r.ok) return res.status(r.status).json({ error: "Azure TTS error", detail: r.detail });

    res.setHeader("X-Style-Requested", "");
    res.setHeader("X-Style-Used", "neutral");
    res.setHeader("X-Azure-Region", region);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "audio/mpeg");
    return res.status(200).send(r.buf);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
}
