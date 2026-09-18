// routes/assess.js (backend)
import formidable from "formidable";
import fs from "fs/promises";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { tmpdir } from "os";
import path from "path";
import {
  recordTrackEnabled,
  runRecordTrack,
  recordFromDictate,
} from "../lib/record-track.js";

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

  const enableProsody =
    String(process.env.ENABLE_PROSODY || "").toLowerCase() === "true";

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

    // es-MX flip: honor a pack/locale multipart field if the frontend sends one.
    // Absent → en-US (byte-identical to today). pack:"es" or locale starting
    // with "es" → es-MX so Azure returns Spanish phonemes automatically.
    const packField = (pickFirst(fields?.pack) || "").toString().trim().toLowerCase();
    const localeField = (pickFirst(fields?.locale) || "").toString().trim().toLowerCase();
    const assessLang =
      packField === "es" || localeField.startsWith("es") ? "es-MX" : "en-US";

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
      NBestPhonemeCount: 3,
      Dimension: "Comprehensive",
      EnableMiscue: true,
      Language: assessLang,
      ...(enableProsody && { EnableProsodyAssessment: true }),
    };

    const pronAssessmentHeader = Buffer.from(JSON.stringify(pronAssessmentParams), "utf8").toString("base64");

    const endpoint = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${assessLang}&format=detailed`;

    // THE RECORD TRACK (LUX_RECORD_TRACK, default off).
    //
    // The scripted assessment above aligns against referenceText and therefore
    // cannot report off-script speech as itself. When the flag is on, plain STT
    // runs on the SAME buffer, in parallel, inside this request, so the row can
    // carry what was actually said as well as how it scored.
    //
    // It rides back on the response under a namespaced key, the same way
    // __scrutiny already crosses the wire (core/scoring/scrutiny.js:66). The
    // client posts the whole Azure result to /api/attempt untouched, so the
    // record reaches the persistence layer with no frontend change.
    //
    // A pro-dictate turn already transcribed this clip through /api/dictate
    // before calling assess, and forwards that transcript as the `record`
    // field, so it costs no second Azure call.
    const wantRecord = recordTrackEnabled();
    const priorTranscript = pickFirst(fields?.record);

    const [azureRes, record] = await Promise.all([
      fetch(endpoint, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
          "Pronunciation-Assessment": pronAssessmentHeader,
          Accept: "application/json",
        },
        body: audioBuffer,
      }),
      wantRecord
        ? recordFromDictate(priorTranscript) ||
          runRecordTrack({ audioBuffer, language: assessLang, region, key })
        : null,
    ]);

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

    // Attached only when the flag is on AND a record came back. With the flag
    // off the response object is untouched, so it is byte-identical to before.
    if (record) json.__luxRecord = record;

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
    if (outputPath) { try { await fs.rm(outputPath, { force: true }); } catch (err) { console.warn("[/api/assess] cleanup outputPath", err); } }
    if (inputPath)  { try { await fs.rm(inputPath,  { force: true }); } catch (err) { console.warn("[/api/assess] cleanup inputPath", err); } }
  }
}