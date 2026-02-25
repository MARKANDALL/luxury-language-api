/* =============================================================================
   FILE: routes/tts/speak.js
   ONE-LINE: Azure REST + Speech SDK (dynamic import) speaking helpers with timings fallback.
============================================================================= */

export function makeTtsEndpoints(region) {
  return {
    endpoint: `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    voicesEndpoint: `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
  };
}

export function makeHdrBase({ key, region }) {
  return {
    "Ocp-Apim-Subscription-Key": key,
    "Ocp-Apim-Subscription-Region": region,
    "Content-Type": "application/ssml+xml",
    "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
    "User-Agent": "lux-pronunciation-tool",
  };
}

// For GET voices proxy (kept behavior: returns JSON regardless of r.ok; caller wraps try/catch)
export async function fetchVoicesJson({ voicesEndpoint, key, region }) {
  const r = await fetch(voicesEndpoint, {
    method: "GET",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Ocp-Apim-Subscription-Region": region,
    },
  });
  return await r.json();
}

export async function speakRest({ endpoint, hdrBase, ssmlXml }) {
  const r = await fetch(endpoint, { method: "POST", headers: hdrBase, body: ssmlXml });
  let detail = "";
  if (!r.ok) {
    try {
      detail = await r.text();
    } catch (err) {
      console.warn("[tts:speakRest] failed to read Azure error body", err);
          }
    console.warn("🔻 AZURE ERROR", r.status, detail ? `(body ${detail.length}b)` : "(no body)");
    return { ok: false, status: r.status, detail };
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return { ok: true, buf };
}

export async function speakSDK({ key, region, ssmlXml }) {
  let synthesizer = null;
  try {
    // IMPORTANT: dynamic import so router.js can always load even if SDK is missing/broken.
    const mod = await import("microsoft-cognitiveservices-speech-sdk");
    const sdk = mod?.default || mod;
    if (!sdk?.SpeechConfig || !sdk?.SpeechSynthesizer) {
      return { ok: false, status: 500, detail: "Speech SDK import succeeded but shape was unexpected" };
    }

    const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
    // Match the REST output format you already use:
    speechConfig.speechSynthesisOutputFormat =
      sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;

    synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    const wordBoundaries = [];
    synthesizer.wordBoundary = (_s, e) => {
      try {
        wordBoundaries.push({
          text: e.text,
          audioOffset: e.audioOffset,
          duration: e.duration,
          textOffset: e.textOffset,
          wordLength: e.wordLength,
          boundaryType: e.boundaryType,
        });
      } catch (err) {
      console.warn("[tts:speakRest] failed to read Azure error body", err);
    }
    };

    const result = await new Promise((resolve, reject) => {
      synthesizer.speakSsmlAsync(ssmlXml, resolve, reject);
    });

    if (synthesizer) synthesizer.close();
    synthesizer = null;

    if (!result || result.reason !== sdk.ResultReason.SynthesizingAudioCompleted || !result.audioData) {
      const detail = result && result.errorDetails ? String(result.errorDetails) : "synthesis failed";
      return { ok: false, status: 400, detail };
    }

    const buf = Buffer.from(result.audioData);
    return { ok: true, buf, wordBoundaries };
  } catch (e) {
    try {
      if (synthesizer) synthesizer.close();
    } catch (err) {
      console.warn("[tts:speakRest] failed to read Azure error body", err);
    }
    const detail = e && e.message ? String(e.message) : String(e || "sdk error");
    return { ok: false, status: 500, detail };
  }
}

export async function speak({ wantTimings, endpoint, hdrBase, key, region, ssmlXml }) {
  if (!wantTimings) return speakRest({ endpoint, hdrBase, ssmlXml });

  // Timings requested: try SDK first; if it fails, fall back to REST but still return JSON (empty boundaries).
  const sdkTry = await speakSDK({ key, region, ssmlXml });
  if (sdkTry?.ok) return sdkTry;

  const restTry = await speakRest({ endpoint, hdrBase, ssmlXml });
  if (restTry?.ok) {
    restTry.wordBoundaries = [];
    restTry.timingsFallback = true;
    restTry.timingsError = sdkTry?.detail || "SDK unavailable";
    return restTry;
  }
  return sdkTry; // SDK error is more informative at this point
}
