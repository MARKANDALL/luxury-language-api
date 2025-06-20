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
  /* CORS */
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  try {
    /* 1. Parse multipart upload + reference text */
    const { fields, files } = await new Promise((ok, fail) =>
      formidable({ multiples: false }).parse(req, (e, flds, fls) =>
        e ? fail(e) : ok({ fields: flds, files: fls })
      )
    );
    const referenceText = fields.text ?? "";           // <-- sent from frontend FormData
    let inputFile = files.audio ?? Object.values(files)[0];
    if (Array.isArray(inputFile)) inputFile = inputFile[0];
    if (!inputFile) throw new Error("No audio uploaded.");
    const inPath = inputFile.filepath || inputFile.path;

    /* 2. Convert WebM ➜ 16-kHz mono WAV */
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

    /* 3. Azure Speech setup */
    const region = process.env.AZURE_REGION || process.env.AZURE_SPEECH_REGION;
    const key    = process.env.AZURE_SPEECH_KEY || process.env.AZURE_KEY;
    if (!region || !key) throw new Error("Azure env vars missing.");

    const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
    speechConfig.setProperty("SpeechServiceResponse_OutputFormat", "Detailed");
    speechConfig.setProperty("EnableAudioProsodyData", "True");

    /* 3a. Enable Pronunciation-Assessment */
    const paConfig = sdk.PronunciationAssessmentConfig.fromJSON({
      ReferenceText: referenceText,
      GradingSystem: "HundredMark",
      Granularity:   "Phoneme",
      EnableProsodyAssessment: true
    });
    const audioConfig = sdk.AudioConfig.fromWavFileInput(await fs.readFile(wavPath));
    const recognizer  = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    paConfig.applyTo(recognizer);                      // <-- activates scoring

    /* 4. Recognize & score */
    const result = await new Promise((ok, fail) =>
      recognizer.recognizeOnceAsync(r =>
        r.errorDetails ? fail(new Error(r.errorDetails)) : ok(r)
      )
    );
    if (!result.json) throw new Error("Azure returned no JSON.");
    const data = JSON.parse(result.json);

    /* 5. Build payload expected by your UI */
    const core = extractPronunciationAndProsody(data);
    const enriched = {
      ...core,
      referenceText,
      duration: data.Duration ?? null
    };
    res.status(200).json(enriched);
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}

/* Helper */
function extractPronunciationAndProsody(data) {
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
    words: enriched
  };
}
