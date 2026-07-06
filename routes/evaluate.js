// /api/evaluate.js

import formidable from "formidable";
import { createReadStream } from "fs";
import sdk from "microsoft-cognitiveservices-speech-sdk";

export const config = { api: { bodyParser: false } };

function createForm() {
  // Formidable v3+: default export is callable: formidable(opts)
  // Formidable v2/older: may expose IncomingForm constructor
  if (typeof formidable === "function") {
    return formidable({ multiples: false, keepExtensions: true });
  }
  if (typeof formidable?.IncomingForm === "function") {
    return new formidable.IncomingForm({ multiples: false, keepExtensions: true });
  }
  if (typeof formidable?.formidable === "function") {
    return formidable.formidable({ multiples: false, keepExtensions: true });
  }
  throw new Error("Formidable API not found (IncomingForm/formidable).");
}

// Util for Azure
function recognizePronunciationFromFile(filePath, referenceText, recognitionLang = "en-US") {
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.AZURE_SPEECH_KEY,
      process.env.AZURE_SPEECH_REGION || process.env.AZURE_REGION
    );
    speechConfig.speechRecognitionLanguage = recognitionLang;

    const pronConfig = new sdk.PronunciationAssessmentConfig(
      referenceText,
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Phoneme,
      true // Enable miscue
    );

    const pushStream = sdk.AudioInputStream.createPushStream();
    createReadStream(filePath)
      .on("data", (chunk) => pushStream.write(chunk))
      .on("end", () => pushStream.close())
      .on("error", (err) => reject(err));

    const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    pronConfig.applyTo(recognizer);

    recognizer.recognizeOnceAsync(
      (result) => {
        recognizer.close();
        resolve(result);
      },
      (err) => {
        recognizer.close();
        reject(err);
      }
    );
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const form = createForm();
    const data = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    const audioObj = Array.isArray(data.files?.audio) ? data.files.audio[0] : data.files?.audio;
    const audioFile = audioObj?.filepath || audioObj?.path;

    const referenceTextRaw = data.fields?.text;
    const referenceText = Array.isArray(referenceTextRaw)
      ? String(referenceTextRaw[0] || "")
      : String(referenceTextRaw || "");

    // es-MX flip: honor a pack/locale multipart field if the frontend sends one.
    // Absent → en-US (byte-identical to today). pack:"es" or locale starting with
    // "es" → es-MX so Azure assesses against Spanish phonemes. Mirrors routes/assess.js.
    const packRaw = data.fields?.pack;
    const localeRaw = data.fields?.locale;
    const packField = (Array.isArray(packRaw) ? packRaw[0] : packRaw || "").toString().trim().toLowerCase();
    const localeField = (Array.isArray(localeRaw) ? localeRaw[0] : localeRaw || "").toString().trim().toLowerCase();
    const recognitionLang =
      packField === "es" || localeField.startsWith("es") ? "es-MX" : "en-US";

    if (!audioFile) {
      res.status(400).json({ error: "No audio file uploaded" });
      return;
    }
    if (!referenceText.trim()) {
      res.status(400).json({ error: "No reference text provided" });
      return;
    }

    let azureResultRaw;
    try {
      azureResultRaw = await recognizePronunciationFromFile(audioFile, referenceText, recognitionLang);
    } catch (err) {
      res.status(500).json({ error: "Azure Speech error: " + (err?.message || String(err)) });
      return;
    }

    let azureResult;
    try {
      azureResult = JSON.parse(azureResultRaw.json);
    } catch {
      res.status(500).json({ error: "Could not parse Azure JSON result" });
      return;
    }

    res.status(200).json(azureResult);
  } catch (err) {
    res.status(500).json({ error: "Server error: " + (err?.message || String(err)) });
  }
}
