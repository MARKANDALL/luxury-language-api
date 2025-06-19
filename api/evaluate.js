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
    // 1. Parse incoming file with formidable
    const form = formidable({ multiples: false });
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
    });

    // LOG: see the full files object
    console.error("FORMIDABLE FILES OBJECT:", files);

    // Use the field "audio" if present, or fallback to any field.
    let inputFile;
    if (files.audio) {
      inputFile = Array.isArray(files.audio) ? files.audio[0] : files.audio;
    } else {
      // fallback: pick the first field if you ever switch back to "file"
      const firstField = Object.values(files)[0];
      inputFile = Array.isArray(firstField) ? firstField[0] : firstField;
    }

    console.error("SELECTED inputFile:", inputFile);

    if (!inputFile) {
      throw new Error("No file uploaded (files object is empty): " + JSON.stringify(files));
    }

    const inPath = inputFile.filepath || inputFile.path;
    console.error("inputFile.filepath:", inputFile.filepath);
    console.error("inputFile.path:", inputFile.path);
    console.error("Resolved inPath:", inPath);

    if (!inPath) {
      throw new Error(
        "No valid file path in upload (missing .filepath and .path). InputFile: " +
        JSON.stringify(inputFile)
      );
    }

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
        .on("error", err => {
          console.error("ffmpeg error:", err);
          reject(err);
        });
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
