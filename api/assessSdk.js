import formidable from "formidable";
import fs from "fs/promises";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { tmpdir } from "os";
import path from "path";
import sdk from "microsoft-cognitiveservices-speech-sdk";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ——— tell Vercel / Next.js not to parse the body for us ———
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  /* ─────────────────── CORS pre-flight ─────────────────── */
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Only POST allowed" });

  /* ─── simple diagnostics (shows in Vercel logs) ─── */
  console.log("[/api/assessSdk] called");
  console.log("Incoming headers:", req.headers);
  console.log("AZURE_SPEECH_KEY set? ", !!process.env.AZURE_SPEECH_KEY);
  console.log("AZURE_SPEECH_REGION :", process.env.AZURE_SPEECH_REGION);

  /* ───────────── parse multipart form (text + blob) ───────────── */
  const form = formidable({ multiples: false });

  form.parse(req, async (err, fields, files) => {
    try {
      if (err) throw err;

      const referenceText = Array.isArray(fields.text)
        ? fields.text[0]
        : fields.text;
      const audioFile = files.audio?.[0] ?? files.audio;

      if (!referenceText || !audioFile) {
        return res
          .status(400)
          .json({ error: "Missing text or audio" });
      }

      /* ─── 1. convert to 16 kHz mono WAV PCM (Azure needs this) ─── */
      const inputPath = audioFile.filepath;
      const outputPath = path.join(
        tmpdir(),
        `converted_${Date.now()}.wav`
      );

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions([
            "-ar 16000", // sample-rate
            "-ac 1",     // mono
            "-f wav",
            "-sample_fmt s16",
          ])
          .on("end", resolve)
          .on("error", reject)
          .save(outputPath);
      });

      const audioBuffer = await fs.readFile(outputPath);

      /* ─── 2. configure Azure Speech SDK ─── */
      const speechConfig = sdk.SpeechConfig.fromSubscription(
        process.env.AZURE_SPEECH_KEY,
        process.env.AZURE_SPEECH_REGION
      );
      speechConfig.speechRecognitionLanguage = "en-US";

      const paConfig = new sdk.PronunciationAssessmentConfig(
        referenceText,
        sdk.PronunciationAssessmentGradingSystem.HundredMark,
        sdk.PronunciationAssessmentGranularity.Phoneme,
        true // include miscues
      );
      // if you’re on SDK ≥ 1.44 these exist:
      paConfig.enableProsodyAssessment();
      paConfig.enableContentAssessmentWithTopic("");

      const pushStream = sdk.AudioInputStream.createPushStream();
      pushStream.write(audioBuffer);
      pushStream.close();

      const audioConfig =
        sdk.AudioConfig.fromStreamInput(pushStream);
      const recognizer = new sdk.SpeechRecognizer(
        speechConfig,
        audioConfig
      );
      paConfig.applyTo(recognizer);

      /* ─── 3. run once, return JSON to client ─── */
      recognizer.recognizeOnceAsync(
        (result) => {
          if (result.reason === sdk.ResultReason.RecognizedSpeech) {
            const detailJson = result.properties.get(
              sdk.PropertyId.SpeechServiceResponse_JsonResult
            );
            return res
              .status(200)
              .json(JSON.parse(detailJson));
          }

          // non-success but no hard error
          console.error(
            "[Azure-result]",
            JSON.stringify(result, null, 2)
          );
          return res
            .status(500)
            .json({ error: "Recognition failed", detail: result });
        },
        (err) => {
          // SDK threw
          console.error("[Azure-error]", err);
          res
            .status(500)
            .json({ error: err.toString() });
        }
      );
    } catch (e) {
      // any synchronous / conversion error
      console.error("[handler-error]", e);
      res.status(500).json({ error: e.message });
    }
  });
}
