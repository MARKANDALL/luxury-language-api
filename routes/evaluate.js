// /api/evaluate.js

import formidable from "formidable";
import fs from "fs/promises";
import { createReadStream } from "fs";
import wav from "node-wav";
import sdk from "microsoft-cognitiveservices-speech-sdk";

export const config = { api: { bodyParser: false } };

// Util for Azure
function recognizePronunciationFromFile(filePath, referenceText) {
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.AZURE_SPEECH_KEY,
      process.env.AZURE_REGION
    );
    speechConfig.speechRecognitionLanguage = "en-US";
    // Pronunciation config
    const pronConfig = new sdk.PronunciationAssessmentConfig(
      referenceText,
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Phoneme,
      true // Enable miscue
    );
    // Open the file as a stream
    const pushStream = sdk.AudioInputStream.createPushStream();
    createReadStream(filePath)
      .on("data", (arrayBuffer) => pushStream.write(arrayBuffer))
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

// Main handler
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    // 1. Parse form data
    const form = new formidable.IncomingForm();
    const data = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    // 2. Get audio file & reference text
    const audioFile = data.files.audio?.filepath || data.files.audio?.path;
    const referenceText = data.fields.text || "";

    if (!audioFile) {
      res.status(400).json({ error: "No audio file uploaded" });
      return;
    }
    if (!referenceText) {
      res.status(400).json({ error: "No reference text provided" });
      return;
    }

    // 3. Log audio file info
    try {
      const buf = await fs.readFile(audioFile);
      const info = wav.decode(buf);
      console.log(
        "[AUDIO INFO]",
        `Sample rate: ${info.sampleRate} Hz, Channels: ${info.channelData.length}, Bit depth: ${
          info.bitDepth || "unknown"
        }, Duration: ${(buf.length / (info.sampleRate * info.channelData.length * 2)).toFixed(2)} s`
      );
    } catch (e) {
      console.warn("[AUDIO INFO] Could not decode WAV header:", e);
    }

    // 4. Send to Azure for evaluation
    let azureResultRaw;
    try {
      azureResultRaw = await recognizePronunciationFromFile(
        audioFile,
        referenceText
      );
    } catch (err) {
      res.status(500).json({ error: "Azure Speech error: " + err.message });
      return;
    }

    // 5. Parse Azure result
    let azureResult;
    try {
      azureResult = JSON.parse(azureResultRaw.json);
    } catch (e) {
      res.status(500).json({ error: "Could not parse Azure JSON result" });
      return;
    }

    // 6. Return Azure result as-is (or post-process as you wish)
    res.status(200).json(azureResult);
  } catch (err) {
    res.status(500).json({ error: "Server error: " + err.message });
  }
}
