
import formidable from "formidable";
import fs from "fs/promises";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { tmpdir } from "os";
import path from "path";
import sdk from "microsoft-cognitiveservices-speech-sdk";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ——— Next.js / CodeSandbox edge: disable default bodyParser ———
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  // ── CORS for the browser preview pane ─────────────────────────
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Only POST allowed" });
    // ---------- simple diagnostics ----------
  console.log("[/api/assessSdk] called");
  console.log("Incoming headers:", req.headers);
  console.log("AZURE_SPEECH_KEY set? ", !!process.env.AZURE_SPEECH_KEY);
  console.log("AZURE_SPEECH_REGION :", process.env.AZURE_SPEECH_REGION);
  //-----------------------------------------


  // ── 1. Parse the multipart form (text + audio blob) ───────────
  const form = formidable({ multiples: false });
  form.parse(req, async (err, fields, files) => {
    try {
      if (err) throw err;

      // ← reference text
      let referenceText = Array.isArray(fields.text)
        ? fields.text[0]
        : fields.text;

      // ← audio file
      const audioFile = files.audio?.[0] || files.audio;
      if (!referenceText || !audioFile) {
        return res.status(400).json({ error: "Missing text or audio" });
      }

      // ── 2. Convert to 16 kHz mono WAV PCM (Azure requirement) ──
      const inputPath = audioFile.filepath;
      const outputPath = path.join(tmpdir(), `converted_${Date.now()}.wav`);

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions(["-ar 16000", "-ac 1", "-f wav", "-sample_fmt s16"])
          .on("end", resolve)
          .on("error", reject)
          .save(outputPath);
      });

      // Read the converted buffer
      const audioBuffer = await fs.readFile(outputPath);

      // ── 3. Azure Speech-SDK Pronunciation Assessment ───────────
      const speechConfig = sdk.SpeechConfig.fromSubscription(
        process.env.AZURE_SPEECH_KEY,
        process.env.AZURE_SPEECH_REGION // e.g. "eastus"
      );
      speechConfig.speechRecognitionLanguage = "en-US";

      // Pronunciation-Assessment config
      const paConfig = new sdk.PronunciationAssessmentConfig(
        referenceText,
        sdk.PronunciationAssessmentGradingSystem.HundredMark,
        sdk.PronunciationAssessmentGranularity.Phoneme,
        true // enable miscues
      );
      paConfig.enableProsodyAssessment(); // ← NEW
      paConfig.enableContentAssessmentWithTopic(""); // ← NEW

      const pushStream = sdk.AudioInputStream.createPushStream();
      pushStream.write(audioBuffer);
      pushStream.close();

      const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      paConfig.applyTo(recognizer);

recognizer.recognizeOnceAsync(
  (result) => {
    if (result.reason === sdk.ResultReason.RecognizedSpeech) {
      const detailJson = result.properties.get(
        sdk.PropertyId.SpeechServiceResponse_JsonResult
      );   // ← notice, just one closing parenthesis and semicolon
      return res.status(200).json(JSON.parse(detailJson));
    }

    // ‼️ log everything Azure gives us
    console.error('[Azure-result]', JSON.stringify(result, null, 2));

    return res
      .status(500)
      .json({ error: "Recognition failed", detail: result });
  },
  (err) => {
    console.error('[Azure-error]', err); // 👈 this logs SDK and runtime errors!
    res.status(500).json({ error: err.toString() });
  }
);
