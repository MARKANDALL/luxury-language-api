/* ---------- /api/evaluate.js (Vercel serverless) ---------- */
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
    /* ---------- 1. Parse multipart ---------- */
    const { fields, files } = await new Promise((ok, fail) =>
      formidable({
        uploadDir: tmpdir(),
        keepExtensions: true,
        multiples: false,
      }).parse(req, (e, flds, fls) => (e ? fail(e) : ok({ fields: flds, files: fls })))
    );

    console.error("FORMIDABLE FILES OBJECT:", files);

    let inputFile = files.audio ?? Object.values(files)[0];
    if (Array.isArray(inputFile)) inputFile = inputFile[0];
    if (!inputFile) throw new Error("No file uploaded – field name should be ‘audio’.");

    const inPath =
      inputFile.filepath ||
      inputFile.path ||
      inputFile._writeStream?.path ||
      null;
    if (!inPath) throw new Error("Upload missing .filepath/.path property.");
    console.error("Resolved inPath:", inPath);

    /* ---------- 2. Convert to 16-kHz mono WAV ---------- */
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

    /* ---------- 3. Azure Speech ---------- */
    const region = process.env.AZURE_REGION || process.env.AZURE_SPEECH_REGION;
    const key = process.env.AZURE_SPEECH_KEY || process.env.AZURE_KEY;
    console.error("ENV CHECK → REGION:", region, "KEY PRESENT:", !!key);
    if (!region || !key)
      throw new Error("Azure env vars missing – set AZURE_REGION & AZURE_SPEECH_KEY.");

    const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
    speechConfig.setProperty("SpeechServiceResponse_OutputFormat", "Detailed");
    speechConfig.setProperty("EnableAudioProsodyData", "True");

    /* clean reference text (string only) */
    const refRaw = fields.text ?? "";
    const referenceText = Array.isArray(refRaw) ? refRaw[0] : String(refRaw);

    const audioConfig = sdk.AudioConfig.fromWavFileInput(await fs.readFile(wavPath));
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    /* apply Pronunciation-Assessment *to the recognizer* */
    const paCfg = new sdk.PronunciationAssessmentConfig(
      referenceText.trim(),
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Phoneme
    );
    paCfg.applyTo(recognizer);

    const result = await new Promise((ok, fail) =>
      recognizer.recognizeOnceAsync(r =>
        r.errorDetails ? fail(new Error(r.errorDetails)) : ok(r)
      )
    );

    if (!result.json) throw new Error("Azure returned no JSON payload.");
    const data = JSON.parse(result.json);

    /* ---------- 4. Enrich → respond ---------- */
    const payload = enrich(data);
    payload.referenceText = referenceText;
    console.error("RESPONSE PAYLOAD:", payload);
    res.status(200).json(payload);
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}

/* helper: prosody + per-word avgPitch */
function enrich(data) {
  const nb = data.NBest?.[0] ?? {};
  const words = nb.Words ?? [];
  const prosody = nb.AudioProsodyData ?? [];

  const detailed = words.map(w => {
    const seg = prosody.filter(
      p => p.Offset >= w.Offset && p.Offset <= w.Offset + w.Duration
    );
    const avgPitch = seg.length ? seg.reduce((s, p) => s + p.Pitch, 0) / seg.length : null;
    return { ...w, avgPitch };
  });

  return {
    overallScore: nb.PronunciationAssessment?.OverallScore ?? null,
    words: detailed,
    duration: nb.Duration ?? null,
  };
}
