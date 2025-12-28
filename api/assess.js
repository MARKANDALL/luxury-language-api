// /api/assess.js
import formidable from "formidable";
import fs from "fs/promises";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { tmpdir } from "os";
import path from "path";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const config = { api: { bodyParser: false } };

function firstOf(v) {
  return Array.isArray(v) ? v[0] : v;
}

function getFile(f) {
  if (!f) return null;
  return Array.isArray(f) ? f[0] : f;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const region =
    process.env.AZURE_SPEECH_REGION ||
    process.env.AZURE_REGION ||
    "eastus";

  const enableProsody =
    String(process.env.ENABLE_PROSODY || "").toLowerCase() === "true";

  console.log("[FeatureFlag] ENABLE_PROSODY:", enableProsody);

  if (!process.env.AZURE_SPEECH_KEY) {
    return res.status(500).json({ error: "missing_env", detail: "AZURE_SPEECH_KEY is not set" });
  }

  // Allow empty files so we can return a clean 400 ourselves (instead of formidable throwing)
  const form = formidable({
    multiples: false,
    allowEmptyFiles: true,
    minFileSize: 0,
    maxFileSize: 15 * 1024 * 1024, // 15MB safety
  });

  let outputPath = null;
  let inputPath = null;

  try {
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) return reject(err);
        resolve({ fields, files });
      });
    });

    // Inputs
    const referenceText = firstOf(fields?.text) || "";
    const audioFile = getFile(files?.audio);

    inputPath = audioFile?.filepath || audioFile?.path || null;
    const size = Number(audioFile?.size || 0);

    if (!referenceText.trim()) {
      return res.status(400).json({ error: "bad_request", detail: "Missing text" });
    }

    if (!inputPath) {
      return res.status(400).json({ error: "bad_request", detail: "Missing audio file" });
    }

    if (size <= 0) {
      // IMPORTANT: this is your requested behavior
      return res.status(400).json({ error: "empty_audio", detail: "Audio upload was empty (0 bytes)" });
    }

    // Convert to 16 kHz mono WAV
    outputPath = path.join(tmpdir(), `converted_${Date.now()}_${Math.random().toString(16).slice(2)}.wav`);

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(["-ar 16000", "-ac 1", "-f wav", "-sample_fmt s16"])
        .on("end", resolve)
        .on("error", reject)
        .save(outputPath);
    });

    const audioBuffer = await fs.readFile(outputPath);

    const pronAssessmentParams = {
      ReferenceText: referenceText,
      GradingSystem: "HundredMark",
      Granularity: "Phoneme",
      Dimension: "Comprehensive",
      EnableMiscue: true,
      Language: "en-US",
      ...(enableProsody && { EnableProsodyAssessment: true }),
    };

    const pronAssessmentHeader = Buffer.from(
      JSON.stringify(pronAssessmentParams),
      "utf8"
    ).toString("base64");

    const endpoint =
      `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
      `?language=en-US&format=detailed`;

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

    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      return res.status(azureRes.status).json({
        error: "azure_non_json",
        status: azureRes.status,
        raw: raw.slice(0, 2000), // keep logs sane
      });
    }

    if (azureRes.status >= 400) {
      return res.status(azureRes.status).json({
        error: "azure_error",
        status: azureRes.status,
        json,
      });
    }

    return res.status(200).json(json);
  } catch (e) {
    // If formidable still throws something with an httpCode, reflect it cleanly
    const httpCode = Number(e?.httpCode || 0);
    if (httpCode >= 400 && httpCode < 500) {
      return res.status(httpCode).json({
        error: "bad_request",
        detail: e?.message || String(e),
        code: e?.code || null,
      });
    }

    console.error("[/api/assess] error:", e);
    return res.status(500).json({ error: "server_error", detail: e?.message || String(e) });
  } finally {
    // Cleanup temp files
    if (outputPath) {
      try { await fs.rm(outputPath, { force: true }); } catch {}
    }
    if (inputPath) {
      try { await fs.rm(inputPath, { force: true }); } catch {}
    }
  }
}
