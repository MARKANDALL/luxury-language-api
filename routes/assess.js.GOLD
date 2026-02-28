// /api/assess.js  (backend)
import formidable from "formidable";
import fs from "fs/promises";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { tmpdir } from "os";
import path from "path";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const config = { api: { bodyParser: false } };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}

function pickFirst(v) {
  return Array.isArray(v) ? v[0] : v;
}

export default async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const region =
    process.env.AZURE_SPEECH_REGION ||
    process.env.AZURE_REGION ||
    "eastus";

  const key = process.env.AZURE_SPEECH_KEY;
  if (!key) return res.status(500).json({ error: "Missing AZURE_SPEECH_KEY" });

  const enableProsody =
    String(process.env.ENABLE_PROSODY || "").toLowerCase() === "true";

  console.log("[FeatureFlag] ENABLE_PROSODY:", enableProsody);

  let inputPath = null;
  let outputPath = null;

  try {
    // IMPORTANT: allowEmptyFiles:true so Formidable doesn't throw (1010) before we can 400 it.
    const form = formidable({
      multiples: false,
      allowEmptyFiles: true,
      maxFileSize: 15 * 1024 * 1024, // 15MB safety
    });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, flds, fls) => (err ? reject(err) : resolve({ fields: flds, files: fls })));
    });

    let referenceText = pickFirst(fields?.text);
    referenceText = typeof referenceText === "string" ? referenceText.trim() : "";

    const audioFile = files?.audio?.[0] || files?.audio;
    inputPath = audioFile?.filepath || audioFile?.path || null;
    const size = Number(audioFile?.size ?? 0);

    if (!referenceText) return res.status(400).json({ error: "Missing text" });
    if (!inputPath) return res.status(400).json({ error: "Missing audio" });

    // Empty/zero-byte audio => 400 (NOT 500)
    if (!Number.isFinite(size) || size <= 0) {
      return res.status(400).json({ error: "Empty audio" });
    }

    // Convert to 16 kHz mono WAV (Azure expects PCM-ish)
    outputPath = path.join(tmpdir(), `lux_assess_${Date.now()}_${Math.random().toString(16).slice(2)}.wav`);

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

    const pronAssessmentHeader = Buffer.from(JSON.stringify(pronAssessmentParams), "utf8").toString("base64");

    const endpoint = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`;

    const azureRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
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
      return res.status(502).json({
        error: "Azure returned non-JSON",
        status: azureRes.status,
        raw,
      });
    }

    if (!azureRes.ok) {
      return res.status(azureRes.status).json({
        error: "Azure error",
        status: azureRes.status,
        json,
      });
    }

    return res.status(200).json(json);
  } catch (e) {
    // If formidable still throws, map empty-file-ish cases to 400
    const msg = String(e?.message || e);
    if (msg.includes("allowEmptyFiles is false") || msg.includes("file size should be greater than 0")) {
      return res.status(400).json({ error: "Empty audio" });
    }

    console.error("[/api/assess] error:", e);
    return res.status(500).json({ error: "Server error", details: String(e?.message || e) });
  } finally {
    // cleanup temp files
    if (outputPath) {
try { await fs.rm(outputPath, { force: true }); }
      catch (err) { console.warn("[/api/assess] cleanup: failed to remove outputPath", err); }
     }
     if (inputPath) {    }
    if (inputPath) {
try { await fs.rm(outputPath, { force: true }); }
      catch (err) { console.warn("[/api/assess] cleanup: failed to remove outputPath", err); }
     }
     if (inputPath) {    }
  }
}
