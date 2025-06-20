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
    /* 1. Parse upload */
    const { files } = await new Promise((ok, fail) =>
      formidable({ multiples: false }).parse(req, (e, flds, fls) =>
        e ? fail(e) : ok({ fields: flds, files: fls })
      )
    );
    let inputFile = files.audio ?? Object.values(files)[0];
    if (Array.isArray(inputFile)) inputFile = inputFile[0];
    if (!inputFile) throw new Error("No file uploaded.");

    const inPath = inputFile.filepath || inputFile.path;
    const wavPath = path.join(tmpdir(), `${Date.now()}.wav`);

    /* 2. ffmpeg -> wav */
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

    /* 3. Azure */
    const region = process.env.AZURE_REGION || process.env.AZURE_SPEECH_REGION;
    const key = process.env.AZURE_SPEECH_KEY || process.env.AZURE_KEY;
    if (!region || !key) throw new Error("Azure env vars missing.");

    const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
    speechConfig.setProperty("SpeechServiceResponse_OutputFormat", "Detailed");
    speechConfig.setProperty("EnableAudioProsodyData", "True");

    const recognizer = new sdk.SpeechRecognizer(
      speechConfig,
      sdk.AudioConfig.fromWavFileInput(await fs.readFile(wavPath))
    );

    const result = await new Promise((ok, fail) =>
      recognizer.recognizeOnceAsync(r =>
        r.errorDetails ? fail(new Error(r.errorDetails)) : ok(r)
      )
    );
    if (!result.json) throw new Error("Azure returned no JSON.");
    const data = JSON.parse(result.json);

    /* 4. Build enriched payload */
    const core = extractPronunciationAndProsody(data);
    const enriched = {
      ...core,
      referenceText: data.DisplayText ?? "",
      duration: data.Duration ?? null
    };

    console.error("RESPONSE PAYLOAD:", enriched); // debug
    res.status(200).json(enriched);
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}

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
