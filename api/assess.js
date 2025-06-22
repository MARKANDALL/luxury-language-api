// /api/assess.js
import formidable from "formidable";
import fs from "fs/promises";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { tmpdir } from "os";
import path from "path";

// Use the local ffmpeg binary
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  // -- CORS HEADERS FOR ALL REQUESTS --
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // -- Handle preflight (OPTIONS) requests --
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  // -- Handle POST requests: parse incoming form data (audio + text) --
  const form = formidable({ multiples: false });
  form.parse(req, async (err, fields, files) => {
    try {
      if (err) throw err;

      // Always ensure referenceText is a string (not an array)
      let referenceText = fields.text;
      if (Array.isArray(referenceText)) referenceText = referenceText[0];

      const audioFile = files.audio?.[0] || files.audio;
      if (!referenceText || !audioFile) {
        return res.status(400).json({ error: "Missing text or audio" });
      }

      // -- Convert audio to 16KHz mono WAV --
      const inputPath = audioFile.filepath;
      const outputPath = path.join(tmpdir(), `converted_${Date.now()}.wav`);

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions([
            "-ar 16000",
            "-ac 1",
            "-f wav",
            "-sample_fmt s16"
          ])
          .on("end", resolve)
          .on("error", reject)
          .save(outputPath);
      });

      const audioBuffer = await fs.readFile(outputPath);

      // -- Azure Pronunciation Assessment Parameters --
      const pronAssessmentParams = {
        ReferenceText: referenceText,
        GradingSystem: "HundredMark",
        Granularity: "Phoneme",
        Dimension: "Comprehensive",
        EnableMiscue: true,
        Language: "en-US",
      };
      const pronAssessmentHeader = Buffer.from(
        JSON.stringify(pronAssessmentParams),
        "utf8"
      ).toString("base64");

      const endpoint =
        "https://eastus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed";

      const result = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY,
          "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
          "Pronunciation-Assessment": pronAssessmentHeader,
          "Accept": "application/json",
        },
        body: audioBuffer,
      });

      const text = await result.text();

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return res.status(result.status).json({
          error: "Azure returned non-JSON response",
          status: result.status,
          raw: text,
        });
      }

      if (result.status >= 400) {
        return res.status(result.status).json({
          error: "Azure error",
          status: result.status,
          json,
        });
      }

      // -- Always return valid Azure assessment JSON --
      return res.status(200).json(json);
    } catch (error) {
      res.status(500).json({ error: "Server error", details: error.message });
    }
  });
}
