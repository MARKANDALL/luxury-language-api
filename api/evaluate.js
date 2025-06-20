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
    const { fields, files } = await new Promise((ok, fail) =>
      formidable({ multiples: false }).parse(req, (e, flds, fls) =>
        e ? fail(e) : ok({ fields: flds, files: fls })
      )
    );

    console.error("FORMIDABLE FILES OBJECT:", files);
    // --- Extract referenceText robustly ---
    const referenceTextRaw =
      fields.referenceText ?? fields.text ?? fields.script ?? "";
    // Always coerce to string (should normally be a string already)
    const referenceText =
      typeof referenceTextRaw === "string"
        ? referenceTextRaw
        : JSON.stringify(referenceTextRaw);

    console.error("REFERENCE TEXT:", referenceText);

    if (!referenceText.trim())
      throw new Error(
        "referenceText is required but missing in form fields."
      );

    // --- Get input audio file ---
    let inputFile =
      files.audio ?? Object.values(files)[0]; // fallback
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
        .audioCodec("pcm_s16le")
        .audioFrequency(16000)
        .audioChannels(1)
        .format("wav")
        .save(wavPath)
        .on("end", ok)
        .on("error", fail)
    );

    // --- 3. Azure Speech Config (support both env var names) ---
    const region = process.env.AZURE_REGION || process.env.AZURE_SPEECH_REGION;
    const key = process.env.AZURE_SPEECH_KEY || process.env.AZURE_KEY;
    console.error("ENV CHECK → REGION:", region, "KEY PRESENT:", !!key);
    if (!region || !key) {
      throw new Error("Azure env vars missing – check AZURE_REGION or AZURE_SPEECH_REGION and AZURE_SPEECH_KEY.");
    }

    // --- 4. Build Pronunciation Assessment config ---
    const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
    speechConfig.setProperty("SpeechServiceResponse_OutputFormat", "Detailed");
    speechConfig.setProperty("EnableAudioProsodyData", "True");

    // *** Configure Pronunciation Assessment ***
    const pronConfig = new sdk.PronunciationAssessmentConfig(
      referenceText,
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Phoneme,
      true // Enable miscue detection (optional, true is default)
    );
    // You may want to add additional config here if needed.

    const audioConfig = sdk.AudioConfig.fromWavFileInput(
      await fs.readFile(wavPath)
    );
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    pronConfig.applyTo(recognizer);

    // --- 5. Recognize & parse result ---
    const result = await new Promise((ok, fail) =>
      recognizer.recognizeOnceAsync(r =>
        r.errorDetails ? fail(new Error(r.errorDetails)) : ok(r)
      )
    );

    if (!result.json) throw new Error("Azure returned no JSON payload.");
    const data = JSON.parse(result.json);

    // --- 6. Build and send response ---
    const payload = extractPronunciationAndProsody(data, referenceText, result.duration);
    console.error("RESPONSE PAYLOAD:", payload);
    res.status(200).json(payload);
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}

// --- Helper: extract word-level and prosody data ---
function extractPronunciationAndProsody(data, referenceText, duration) {
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
    referenceText,
    duration,
  };
}
