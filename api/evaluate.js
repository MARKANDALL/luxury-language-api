// api/evaluate.js — Node runtime, CORS enabled, full rewrite 18 Jun 2025

import formidable from "formidable";
import fs from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import sdk from "microsoft-cognitiveservices-speech-sdk";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  // --- Add CORS headers to all responses ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // --- Respond immediately to OPTIONS (CORS preflight) ---
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).end("Method Not Allowed");
    return;
  }

  try {
    // 1. Save incoming WebM to temp
    const form = formidable({ multiples: false });
    const [{ filepath: inPath }] = await new Promise((ok, fail) =>
      form.parse(req, (e, _fields, files) => (e ? fail(e) : ok(Object.values(files))))
    );

    const wavPath = path.join(tmpdir(), `${Date.now()}.wav`);

    // 2. Convert → 16 kHz mono WAV (Azure wants this)
    await new Promise((ok, fail) =>
      ffmpeg(inPath)
        .outputOptions("-ar 16000", "-ac 1")
        .toFormat("wav")
        .save(wavPath)
        .on("end", ok)
        .on("error", fail)
    );

    // 3. Azure Pronunciation + Prosody
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.AZURE_SPEECH_KEY,
      process.env.AZURE_REGION
    );
    speechConfig.setProperty("SpeechServiceResponse_OutputFormat", "Detailed");
    speechConfig.setProperty("EnableAudioProsodyData", "True");

    const audioConfig = sdk.AudioConfig.fromWavFileInput(await fs.readFile(wavPath));
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    const result = await new Promise((ok, fail) =>
      recognizer.recognizeOnceAsync(r => (r.errorDetails ? fail(r) : ok(r)))
    );

    // 4. Parse core + prosody into lean JSON
    const payload = extractPronunciationAndProsody(JSON.parse(result.json));

    res.status(200).json(payload);
  } catch (err) {
    // Return error info to frontend (for debugging)
    res.status(500).json({ error: err.message || "Server error" });
  }
}

// ---------- helper ----------
function extractPronunciationAndProsody(data) {
  const words = data.NBest[0].Words || [];
  const prosody = data.NBest[0].AudioProsodyData || [];

  // Map pitch points to words (nearest-timestamp match)
  const enriched = words.map(w => {
    const segment = prosody.filter(
      p => p.Offset >= w.Offset && p.Offset <= w.Offset + w.Duration
    );
    const avgPitch = segment.length
      ? segment.reduce((s, p) => s + p.Pitch, 0) / segment.length
      : null;
    return { ...w, avgPitch };
  });

  return {
    overallScore: data.NBest[0].PronunciationAssessment.OverallScore,
    words: enriched,
  };
}
