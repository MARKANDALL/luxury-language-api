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
  // --- CORS headers ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).end("Method Not Allowed");
    return;
  }

  try {
    // --- 1. Parse incoming WebM file with formidable ---
    const form = formidable({ multiples: false });
    const files = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => (err ? reject(err) : resolve(files)));
    });
    const inputFile = Object.values(files)[0];

    // --- LOGGING for debugging upload/file path issues ---
    console.log("inputFile:", inputFile);

    // --- Check for file presence and path validity ---
    if (!inputFile) throw new Error("No file uploaded (files is empty).");

    // Support both `.filepath` and `.path` for compatibility
    const inPath = inputFile.filepath || inputFile.path;
    console.log("inPath:", inPath); // LOGGING

    if (!inPath) throw new Error("No valid file path in upload (missing .filepath and .path).");

    const wavPath = path.join(tmpdir(), `${Date.now()}.wav`);

    // --- 2. ffmpeg: Convert WebM to 16kHz mono WAV ---
    await new Promise((resolve, reject) => {
      ffmpeg(inPath)
        .inputFormat("webm")
        .audioCodec("pcm_s16le")
        .audioFrequency(16000)
        .audioChannels(1)
        .format("wav")
        .save(wavPath)
        .on("end", resolve)
        .on("error", reject);
    });

    // --- 3. Azure Speech Config ---
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.AZURE_SPEECH_KEY,
      process.env.AZURE_REGION
    );
    speechConfig.setProperty("SpeechServiceResponse_OutputFormat", "Detailed");
    speechConfig.setProperty("EnableAudioProsodyData", "True");

    // --- 4. Load WAV and analyze ---
    const wavData = await fs.readFile(wavPath);
    const audioConfig = sdk.AudioConfig.fromWavFileInput(wavData);
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    const result = await new Promise((resolve, reject) => {
      recognizer.recognizeOnceAsync(r => (r.errorDetails ? reject(r) : resolve(r)));
    });

    if (!result || !result.json) throw new Error("No recognition result.");
    const data = JSON.parse(result.json);

    // --- 5. Extract prosody and core scoring ---
    const payload = extractPronunciationAndProsody(data);

    res.status(200).json(payload);
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}

// --- Helper: extract word-level and prosody data ---
function extractPronunciationAndProsody(data) {
  const nbest = (data.NBest && data.NBest[0]) || {};
  const words = nbest.Words || [];
  const prosody = nbest.AudioProsodyData || [];

  // For each word, find prosody segments whose offset is within word offset & duration
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
    overallScore: nbest.PronunciationAssessment
      ? nbest.PronunciationAssessment.OverallScore
      : null,
    words: enriched,
  };
}
