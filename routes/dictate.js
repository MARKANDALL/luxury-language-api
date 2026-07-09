// routes/dictate.js (backend)
// Plain speech-to-text for DICTATION into the convo compose box.
// Mirrors routes/assess.js (formidable -> ffmpeg 16kHz mono WAV -> Azure),
// but WITHOUT pronunciation assessment: no reference text, no Pronunciation-
// Assessment header. Returns { text } — the recognized transcript.
//
// Language follows the pack: pack="es" or locale starting with "es" -> es-MX,
// otherwise en-US. Registered via api/router.js under route "dictate".
import formidable from "formidable";
import fs from "fs/promises";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { tmpdir } from "os";
import path from "path";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const config = { api: { bodyParser: false } };

function pickFirst(v) {
  return Array.isArray(v) ? v[0] : v;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const region =
    process.env.AZURE_SPEECH_REGION ||
    process.env.AZURE_REGION ||
    "eastus";

  const key = process.env.AZURE_SPEECH_KEY;
  if (!key) return res.status(500).json({ error: "Missing AZURE_SPEECH_KEY" });

  let inputPath = null;
  let outputPath = null;

  try {
    const form = formidable({
      multiples: false,
      allowEmptyFiles: true,
      maxFileSize: 15 * 1024 * 1024, // 15MB safety
    });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, flds, fls) => (err ? reject(err) : resolve({ fields: flds, files: fls })));
    });

    // Language follows the pack (same rule as assess.js). Absent -> en-US.
    const packField = (pickFirst(fields?.pack) || "").toString().trim().toLowerCase();
    const localeField = (pickFirst(fields?.locale) || "").toString().trim().toLowerCase();
    const dictateLang =
      packField === "es" || localeField.startsWith("es") ? "es-MX" : "en-US";

    const audioFile = files?.audio?.[0] || files?.audio;
    inputPath = audioFile?.filepath || audioFile?.path || null;
    const size = Number(audioFile?.size ?? 0);

    if (!inputPath) return res.status(400).json({ error: "Missing audio" });
    if (!Number.isFinite(size) || size <= 0) {
      return res.status(400).json({ error: "Empty audio" });
    }

    // Convert to 16 kHz mono WAV (Azure expects PCM-ish)
    outputPath = path.join(tmpdir(), `lux_dictate_${Date.now()}_${Math.random().toString(16).slice(2)}.wav`);

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(["-ar 16000", "-ac 1", "-f wav", "-sample_fmt s16"])
        .on("end", resolve)
        .on("error", reject)
        .save(outputPath);
    });

    const audioBuffer = await fs.readFile(outputPath);

    // Plain STT endpoint (detailed so we can read DisplayText). No pronunciation header.
    const endpoint = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${dictateLang}&format=detailed`;

    const azureRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
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

    // Pull the best transcript out of Azure's detailed response.
    // Prefer DisplayText; fall back to NBest[0].Display/Lexical.
    const nbest = Array.isArray(json?.NBest) ? json.NBest[0] : null;
    const text =
      (typeof json?.DisplayText === "string" && json.DisplayText) ||
      (nbest && (nbest.Display || nbest.Lexical)) ||
      "";

    // RecognitionStatus of "Success" with empty text can happen on silence.
    return res.status(200).json({ text: String(text).trim(), status: json?.RecognitionStatus || "" });
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("allowEmptyFiles is false") || msg.includes("file size should be greater than 0")) {
      return res.status(400).json({ error: "Empty audio" });
    }

    console.error("[/api/dictate] error:", e);
    return res.status(500).json({ error: "Server error", details: String(e?.message || e) });
  } finally {
    if (outputPath) { try { await fs.rm(outputPath, { force: true }); } catch (err) { console.warn("[/api/dictate] cleanup outputPath", err); } }
    if (inputPath)  { try { await fs.rm(inputPath,  { force: true }); } catch (err) { console.warn("[/api/dictate] cleanup inputPath", err); } }
  }
}