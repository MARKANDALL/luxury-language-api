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
    // --- Parse fields and file ---
    const { fields, files } = await new Promise((ok, fail) =>
      formidable({ multiples: false }).parse(req, (e, flds, fls) =>
        e ? fail(e) : ok({ fields: flds, files: fls })
      )
    );

    // --- Handle referenceText safely ---
    let referenceTextRaw = fields.text || "";
    let referenceText = referenceTextRaw;
    if (typeof referenceTextRaw !== "string") referenceText = String(referenceTextRaw);
    if (referenceText.trim().startsWith("[")) referenceText = JSON.parse(referenceText)[0];

    let inputFile = files.audio ?? Object.values(files)[0];
    if (Array.isArray(inputFile)) inputFile = inputFile[0];
    if (!inputFile) throw new Error("No file uploaded – check front-end FormData field name.");
    const inPath = inputFile.filepath || inputFile.path;
    if (!inPath) throw new Error("Upload missing .filepath/.path property.");

    // --- Convert to 16kHz mono WAV ---
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

    // --- Azure config ---
    const region = process.env.AZURE_REGION || process.env.AZURE_SPEECH_REGION || "eastus";
    const key = process.env.AZURE_SPEECH_KEY || process.env.AZURE_KEY;
    if (!region || !key)
      throw new Error("Azure env vars missing – check AZURE_REGION/AZURE_SPEECH_REGION and AZURE_SPEECH_KEY/AZURE_KEY.");

    const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
    speechConfig.setProperty("SpeechServiceResponse_OutputFormat", "Detailed");
    speechConfig.setProperty("EnableAudioProsodyData", "True");

    // --- Attach PronunciationAssessmentConfig (FIXED ENUMS) ---
    const pronConfig = new sdk.PronunciationAssessmentConfig(
      referenceText,
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGradingMode.Pronunciation,
      "en-US"
    );
    const audioConfig = sdk.AudioConfig.fromWavFileInput(
      await fs.readFile(wavPath)
    );
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    pronConfig.applyTo(recognizer);

    // --- Recognize speech ---
    const result = await new Promise((ok, fail) =>
      recognizer.recognizeOnceAsync(r =>
        r.errorDetails ? fail(new Error(r.errorDetails)) : ok(r)
      )
    );

    if (!result.json) throw new Error("Azure returned no JSON payload.");
    const data = JSON.parse(result.json);
    const nbest = data.NBest?.[0] ?? {};
    const words = nbest.Words ?? [];
    const prosody = nbest.AudioProsodyData ?? [];
    const duration = data.Duration ?? null;

    const enrichedWords = words.map(w => {
      const seg = prosody.filter(
        p => p.Offset >= w.Offset && p.Offset <= w.Offset + w.Duration
      );
      const avgPitch =
        seg.length > 0 ? seg.reduce((s, p) => s + p.Pitch, 0) / seg.length : null;
      return { ...w, avgPitch };
    });

    const payload = {
      accuracyScore: nbest.PronunciationAssessment?.AccuracyScore ?? null,
      fluencyScore: nbest.PronunciationAssessment?.FluencyScore ?? null,
      completenessScore: nbest.PronunciationAssessment?.CompletenessScore ?? null,
      words: enrichedWords,
      referenceText,
      duration
    };

    console.error("RESPONSE PAYLOAD:", payload);
    res.status(200).json(payload);
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}
