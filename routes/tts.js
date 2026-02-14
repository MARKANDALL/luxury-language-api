/* =============================================================================
   FILE: routes/tts.js
   ONE-LINE: Azure REST v1 proxy w/ style fallbacks; dynamic SDK timings (router-safe); JSON fallback when timings requested.
============================================================================= */

import {
  normalizeStyle,
  buildProsody,
  safeXml,
  baseSpeakTag,
  innerFor,
} from "./tts/ssml.js";

import {
  makeTtsEndpoints,
  makeHdrBase,
  fetchVoicesJson,
  speak,
} from "./tts/speak.js";

// /api/tts.js  — Azure REST v1 proxy with smart style fallbacks & rich headers
export default async function handler(req, res) {
  // Basic CORS
  // Let browser JS read our custom headers:
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-Style-Used, X-Style-Requested, X-Style-Fallback, X-Style-Message, X-Azure-Region"
  );

  if (req.method === "OPTIONS") return res.status(204).end();

  // P0: ADMIN_TOKEN gate (cost-control for paid Azure TTS proxy)
  function normToken(v) {
    const s = String(v || "").trim();
    return s.replace(/^["'](.*)["']$/, "$1").trim();
  }

  const token = normToken(
    (req.headers["x-admin-token"] || "") ||
    (req.query?.token || "")
  );

  const expected = normToken(process.env.ADMIN_TOKEN);

  if (!expected || token !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const key = process.env.AZURE_SPEECH_KEY || process.env.AZURE_TTS_KEY;
  const region =
    process.env.AZURE_SPEECH_REGION || process.env.AZURE_REGION || "eastus";

  const { endpoint, voicesEndpoint } = makeTtsEndpoints(region);

  const wantTimings = String(req.query?.timings || "") === "1";

  // GET ?voices=1 => proxy voice list with styles/roles
  if (req.method === "GET") {
    if (String(req.query.voices || "") === "1") {
      try {
        const json = await fetchVoicesJson({ voicesEndpoint, key, region });
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

    const hdrBase = makeHdrBase({ key, region });

    function sendAudio(buf, wordBoundaries = [], extra = null) {
      res.setHeader("X-Azure-Region", region);
      res.setHeader("Cache-Control", "no-store");

      if (wantTimings) {
        res.setHeader("Content-Type", "application/json");
        if (extra?.timingsFallback) {
          res.setHeader("X-TTS-Timings", "fallback");
        } else {
          res.setHeader("X-TTS-Timings", "sdk");
        }
        return res.status(200).json({
          audioBase64: Buffer.from(buf).toString("base64"),
          contentType: "audio/mpeg",
          wordBoundaries: Array.isArray(wordBoundaries) ? wordBoundaries : [],
          ...(extra?.timingsFallback
            ? { timingsFallback: true, timingsError: extra?.timingsError || "" }
            : {}),
        });
      }

      res.setHeader("Content-Type", "audio/mpeg");
      return res.status(200).send(buf);
    }

    async function doSpeak(ssmlXml) {
      return speak({
        wantTimings,
        endpoint,
        hdrBase,
        key,
        region,
        ssmlXml,
      });
    }

    // If client provided raw SSML, just pass it through
    if (ssml) {
      const first = await doSpeak(ssml);
      if (!first.ok) return res.status(first.status).json({ error: "Azure TTS error", detail: first.detail });
      return sendAudio(first.buf, first.wordBoundaries, first);
    }

    // Build expressive attempt (if style requested) with careful fallbacks
    const requestedStyle = normalizeStyle(style);
    const prosody = buildProsody(ratePct, pitchSt);
    const textXml = safeXml(text);

    let usedStyle = "";
    let fallback = "";
    let msg = "";

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
        const inner = innerFor({
          textXml,
          prosody,
          role,
          styledegree,
          styleName: v.style,
          includeRole: v.role,
          includeDegree: v.deg,
        });
        const xml = baseSpeakTag({ voice, inner, withMstts: true });

        const r = await doSpeak(xml);
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
        // Region/cache/content-type handled by sendAudio()
        if (usedStyle !== requestedStyle) {
          fallback = "variant";
          msg = `Using '${usedStyle}' (closest available) for ${voice}.`;
          res.setHeader("X-Style-Fallback", fallback);
          res.setHeader("X-Style-Message", msg);
        }
        return sendAudio(success.buf, success.wordBoundaries, success);
      }

      // 2) Expressive failed => neutral retry
      const neutralInner = innerFor({
        textXml,
        prosody,
        role,
        styledegree,
        styleName: "",
      });
      const neutralXml = baseSpeakTag({ voice, inner: neutralInner, withMstts: true }); // keep mstts ns harmlessly
      const n = await doSpeak(neutralXml);
      console.log("↩️  Retrying neutral…\n", neutralXml);

      if (n.ok) {
        usedStyle = "neutral";
        fallback = "unsupported";
        msg = `Style '${requestedStyle}' isn’t available for ${voice}. Playing neutral; rate/pitch still applied.`;
        res.setHeader("X-Style-Requested", requestedStyle);
        res.setHeader("X-Style-Used", usedStyle);
        res.setHeader("X-Style-Fallback", fallback);
        res.setHeader("X-Style-Message", msg);
        return sendAudio(n.buf, n.wordBoundaries, n);
      }

      // 3) Even neutral failed (very rare) — surface Azure error
      return res.status(400).json({ error: "Azure TTS error", detail: n.detail || "" });
    }

    // No style requested => neutral path
    const content = prosody ? `${prosody.open}${safeXml(text)}${prosody.close}` : safeXml(text);
    const neutralXml = baseSpeakTag({ voice, inner: content, withMstts: false });

    const r = await doSpeak(neutralXml);
    console.log("🔸 SSML SENT TO AZURE:", neutralXml);

    if (!r.ok) return res.status(r.status).json({ error: "Azure TTS error", detail: r.detail });

    res.setHeader("X-Style-Requested", "");
    res.setHeader("X-Style-Used", "neutral");
    return sendAudio(r.buf, r.wordBoundaries, r);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
}
