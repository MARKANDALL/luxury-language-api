import formidable from "formidable";
import fs from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import sdk from "microsoft-cognitiveservices-speech-sdk";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  // --- CORS headers ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  try {
    // --- 1. Parse multipart upload ---
    const { files } = await new Promise((ok, fail) =>
      formidable({ multiples: false }).parse(req, (e, flds, fls) =>
        e ? fail(e) : ok({ fields: flds, files: fls })
      )
    );

    console.error("FORMIDABLE FILES OBJECT:", files);

    let inputFile =
      files.audio ?? // prefer “audio” field
      Object.values(files)[0]; // fallback

    if (Array.isArray(inputFile)) inputFile = inputFile[0];
    if (!inputFile)
      throw new Error("No file uploaded – check front-end FormData field name.");

    const inPath = inputFile.filepath || inputFile.path;
    if (!inPath) throw new Error("Upload missing .filepath/.path property.");

    console.error("Resolved inPath:", inPath);

    // --- 2. Convert to 16 kHz mono WAV ---
    const wavPath = path.join(tmpdir(), `${Date.now()}.wav`);
    await new Promise((ok, fail) =>
      ffmpeg(inPath)
        .inputFormat("webm")
        .audioCodec("pcm_s16le")
        .audioFrequency(16000)
        .audioChannels(1)
        .format("wav")
        .save(wavPath)
        .on("end", ok)
        .on("error", fail)
    );

    // --- 3. Azure Speech Config ---
    const region = process.env.AZURE_REGION || process.env.AZURE_SPEECH_REGION;
    const key = process.env.AZURE_SPEECH_KEY || process.env.AZURE_KEY;

    console.error(
      "ENV CHECK → REGION:", region,
      "KEY PRESENT:", !!key
    );

    if (!region || !key) {
      throw new Error(
        "Azure env vars missing – check AZURE_REGION or AZURE_SPEECH_REGION and AZURE_SPEECH_KEY."
      );
    }

    const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
    speechConfig.setProperty("SpeechServiceResponse_OutputFormat", "Detailed");
    speechConfig.setProperty("EnableAudioProsodyData", "True");

    const audioConfig = sdk.AudioConfig.fromWavFileInput(
      await fs.readFile(wavPath)
    );
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    const result = await new Promise((ok, fail) =>
      recognizer.recognizeOnceAsync(r =>
        r.errorDetails ? fail(new Error(r.errorDetails)) : ok(r)
      )
    );

    if (!result.json) throw new Error("Azure returned no JSON payload.");
    const data = JSON.parse(result.json);

    // --- 4. Build response ---
    res.status(200).json(extractPronunciationAndProsody(data));
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}

// --- Helper: extract word-level and prosody data ---
function extractPronunciationAndProsody(data) {
  const nbest = data.NBest?.[0] ?? {};
  const words = nbest.Words ?? [];
  const prosody = nbest.AudioProsodyData ?? [];

  const enriched = words.map(w => {
    const seg = prosody.filter(
      p => p.Offset >= w.Offset && p.Offset <= w.Offset + w.Duration
    );
    const avgPitch =
      seg.length > 0 ? seg.reduce((s, p) => s + p.Pitch, 0) / seg.length : null;
    return { ...w, avgPitch };
  });

  return {
    overallScore: nbest.PronunciationAssessment?.OverallScore ?? null,
    words: enriched,
  };
}
