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
  /* ---------- CORS ---------- */
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  try {
    /* ---------- 1  Parse multipart ---------- */
    const { fields, files } = await new Promise((ok, fail) =>
      formidable({ multiples: false }).parse(req, (e, flds, fls) =>
        e ? fail(e) : ok({ fields: flds, files: fls })
      )
    );

    const inFile =
      files.audio ??
      Object.values(files)[0] ??
      (() => {
        throw new Error("No audio uploaded.");
      })();

    const inPath = inFile.filepath || inFile.path;
    if (!inPath) throw new Error("Upload missing .filepath/.path property.");

    /* ---------- 2  Convert to 16 kHz mono WAV ---------- */
    const wavPath = path.join(tmpdir(), `${Date.now()}.wav`);
    await new Promise((ok, fail) =>
      ffmpeg(inPath)
        .inputFormat("webm") // clients send WebM (MediaRecorder)
        .audioCodec("pcm_s16le")
        .audioFrequency(16000)
        .audioChannels(1)
        .format("wav")
        .save(wavPath)
        .on("end", ok)
        .on("error", fail)
    );

    /* ---------- 3  Azure Speech setup ---------- */
    const region = process.env.AZURE_REGION || process.env.AZURE_SPEECH_REGION;
    const key = process.env.AZURE_SPEECH_KEY || process.env.AZURE_KEY;
    if (!region || !key)
      throw new Error("Azure env vars missing – set AZURE_REGION & AZURE_SPEECH_KEY.");

    const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
    speechConfig.speechRecognitionLanguage = "en-US";
    speechConfig.setProperty("SpeechServiceResponse_OutputFormat", "Detailed");
    speechConfig.setProperty("EnableAudioProsodyData", "True");

    /* ---------- 4  Pronunciation-assessment config ---------- */
    let referenceText = (fields.text ?? "").toString().trim();
    // if the front-end accidentally sent '["text"]', fix it:
    if (/^\s*\[\s*".+"\s*\]\s*$/.test(referenceText))
      referenceText = JSON.parse(referenceText)[0];

    const pronCfg = new sdk.PronunciationAssessmentConfig(
      referenceText,
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Phoneme,
      true /* enable miscue */
    );

    const audioConfig = sdk.AudioConfig.fromWavFileInput(await fs.readFile(wavPath));
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    pronCfg.applyTo(recognizer);

    /* ---------- 5  Run recognition ---------- */
    const result = await new Promise((ok, fail) =>
      recognizer.recognizeOnceAsync(r =>
        r.errorDetails ? fail(new Error(r.errorDetails)) : ok(r)
      )
    );

    const detailed = JSON.parse(result.properties.getProperty(
      sdk.PropertyId.SpeechServiceResponse_JsonResult
    ));

    /* ---------- 6  Trim payload for the UI ---------- */
    const best = detailed.NBest?.[0] ?? {};
    const payload = {
      overallScore: best.PronunciationAssessment?.OverallScore ?? null,
      words: best.Words ?? [],
      referenceText,
      duration: detailed.Duration ?? null,
      ProsodyAssessment: detailed.ProsodyAssessment ?? null,
      ContentAssessment: detailed.ContentAssessment ?? null
    };

    console.log("RESPONSE PAYLOAD:", JSON.stringify(payload).slice(0, 500));
    res.status(200).json(payload);
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}
