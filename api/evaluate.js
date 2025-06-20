/* ---------- evaluate.js  (Vercel Serverless Function) ---------- */
import formidable from "formidable";
import fs from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import sdk from "microsoft-cognitiveservices-speech-sdk";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/* Vercel: disable Next-JS bodyParser so we can parse multipart */
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  /* ----------- CORS ----------- */
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  try {
    /* -------- 1. Parse multipart (store file in tmp dir) -------- */
    const form = formidable({
      multiples: false,
      uploadDir: tmpdir(),    // guarantees .filepath
      keepExtensions: true,
      maxFileSize: 15 * 1024 * 1024, // 15 MB safety
    });

    const { fields, files } = await new Promise((ok, fail) =>
      form.parse(req, (err, flds, fls) => (err ? fail(err) : ok({ fields: flds, files: fls })))
    );

    console.error("FORMIDABLE FILES OBJECT:", files);

    /* prefer “audio”, else first file */
    let inputFile = files.audio ?? Object.values(files)[0];
    if (Array.isArray(inputFile)) inputFile = inputFile[0];
    if (!inputFile) throw new Error("No file uploaded – check front-end field name ‘audio’.");

    /* Formidable v2/v3 => .filepath  |   Node-Busboy => .path      */
    let inPath =
      inputFile.filepath ||
      inputFile.path ||
      inputFile._writeStream?.path || // fallback (rare)
      null;

    if (!inPath) {
      /* last-resort: write the buffer ourselves */
      if (inputFile.toBuffer) {
        const buf = await inputFile.toBuffer();
        inPath = path.join(tmpdir(), `${Date.now()}.webm`);
        await fs.writeFile(inPath, buf);
      }
    }

    if (!inPath) throw new Error("Upload missing .filepath/.path property.");

    console.error("Resolved inPath:", inPath);

    /* -------- 2. Convert WebM/whatever ➜ 16 kHz mono WAV -------- */
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

    /* -------- 3. Azure Speech -------- */
    const region = process.env.AZURE_REGION || process.env.AZURE_SPEECH_REGION;
    const key = process.env.AZURE_SPEECH_KEY || process.env.AZURE_KEY;

    console.error("ENV CHECK → REGION:", region, "KEY PRESENT:", !!key);
    if (!region || !key)
      throw new Error("Azure env vars missing – set AZURE_REGION & AZURE_SPEECH_KEY.");

    const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
    speechConfig.setProperty("SpeechServiceResponse_OutputFormat", "Detailed");
    speechConfig.setProperty("EnableAudioProsodyData", "True");

    /* sanitize reference text: always a plain string */
    const referenceTextRaw = fields.text ?? "";
    const referenceText = Array.isArray(referenceTextRaw)
      ? referenceTextRaw[0]
      : String(referenceTextRaw);
    speechConfig.setProperty(
      sdk.PropertyId.SpeechServiceConnection_RecoLanguage,
      "en-US"
    );
    const paConfigJson = {
      ReferenceText: referenceText.trim(),
      GradingSystem: "HundredMark",
      Granularity: "Phoneme",
      Dimension: "Comprehensive",
    };
    sdk.PronunciationAssessmentConfig.fromJSON(JSON.stringify(paConfigJson)).applyTo(speechConfig);

    const audioConfig = sdk.AudioConfig.fromWavFileInput(await fs.readFile(wavPath));
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    const result = await new Promise((ok, fail) =>
      recognizer.recognizeOnceAsync(r =>
        r.errorDetails ? fail(new Error(r.errorDetails)) : ok(r)
      )
    );

    if (!result.json) throw new Error("Azure returned no JSON payload.");
    const data = JSON.parse(result.json);

    /* -------- 4. Augment + respond -------- */
    const payload = enrichPronunciationAndProsody(data);
    payload.referenceText = referenceText; // pass back clean text
    res.status(200).json(payload);
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}

/* ---------- helper ---------- */
function enrichPronunciationAndProsody(data) {
  const nbest = data.NBest?.[0] ?? {};
  const words = nbest.Words ?? [];
  const prosody = nbest.AudioProsodyData ?? [];

  const enriched = words.map(w => {
    const seg = prosody.filter(
      p => p.Offset >= w.Offset && p.Offset <= w.Offset + w.Duration
    );
    const avgPitch =
      seg.length ? seg.reduce((s, p) => s + p.Pitch, 0) / seg.length : null;
    return { ...w, avgPitch };
  });

  return {
    overallScore: nbest.PronunciationAssessment?.OverallScore ?? null,
    words: enriched,
    duration: nbest.Duration ?? null,
  };
}
