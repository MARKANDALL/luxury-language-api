// /api/assess.js
import formidable from "formidable";
import fs from "fs/promises";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { tmpdir } from "os";
import path from "path";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Only POST allowed" });

  // Env + flag
  const region =
    process.env.AZURE_SPEECH_REGION ||
    process.env.AZURE_REGION ||
    "eastus";
  const enableProsody =
    String(process.env.ENABLE_PROSODY || "").toLowerCase() === "true";

  console.log("[FeatureFlag] ENABLE_PROSODY:", enableProsody);

  const form = formidable({ multiples: false });

  form.parse(req, async (err, fields, files) => {
    let outputPath; // so we can clean up in finally
    try {
      if (err) throw err;

      // Inputs
      let referenceText = fields.text;
      if (Array.isArray(referenceText)) referenceText = referenceText[0];
      const audioFile = files.audio?.[0] || files.audio;

      if (!referenceText || !audioFile) {
        return res.status(400).json({ error: "Missing text or audio" });
      }

      // Convert to 16 kHz mono WAV
      const inputPath = audioFile.filepath;
      outputPath = path.join(tmpdir(), `converted_${Date.now()}.wav`);

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions(["-ar 16000", "-ac 1", "-f wav", "-sample_fmt s16"])
          .on("end", resolve)
          .on("error", reject)
          .save(outputPath);
      });

      const audioBuffer = await fs.readFile(outputPath);

      // Pronunciation Assessment header (REST)
      const pronAssessmentParams = {
        ReferenceText: referenceText,
        GradingSystem: "HundredMark",
        Granularity: "Phoneme",
        Dimension: "Comprehensive",
        EnableMiscue: true,
        Language: "en-US",
        ...(enableProsody && { EnableProsodyAssessment: true }), // ← Prosody
      };

      const pronAssessmentHeader = Buffer.from(
        JSON.stringify(pronAssessmentParams),
        "utf8"
      ).toString("base64");

      const endpoint = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`;

      const azureRes = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY,
          "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
          "Pronunciation-Assessment": pronAssessmentHeader,
          Accept: "application/json",
        },
        body: audioBuffer,
      });

      const raw = await azureRes.text();

      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        return res.status(azureRes.status).json({
          error: "Azure returned non-JSON response",
          status: azureRes.status,
          raw,
        });
      }

      if (azureRes.status >= 400) {
        return res.status(azureRes.status).json({
          error: "Azure error",
          status: azureRes.status,
          json,
        });
      }

      // Success (ProsodyScore appears when flag is true)
      return res.status(200).json(json);
    } catch (e) {
      console.error("[/api/assess] error:", e);
      return res.status(500).json({ error: "Server error", details: e.message });
    } finally {
      if (outputPath) {
        try {
          await fs.rm(outputPath, { force: true });
        } catch {}
      }
    }
  });
}
