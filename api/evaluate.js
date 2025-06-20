// api/evaluate.js

import formidable from "formidable";
import fs from "fs/promises";
import sdk from "microsoft-cognitiveservices-speech-sdk";

export const config = {
  api: { bodyParser: false },
};

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable();
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

function enrich(data) {
  // Optional: add helper fields, e.g. avgPitch per word
  try {
    const words = [];
    const nbest = data?.NBest?.[0];
    if (nbest && Array.isArray(nbest.Words)) {
      for (const w of nbest.Words) {
        // For now, just return as-is; you can add avgPitch or more here later
        words.push(w);
      }
    }
    return { words };
  } catch (e) {
    return { words: [] };
  }
}

export default async function handler(req, res) {
  try {
    // 1. Parse audio + referenceText
    const { fields, files } = await parseForm(req);
    if (!files.audio?.[0]?.filepath) {
      throw new Error("Upload missing .filepath/.path property.");
    }
    const inPath = files.audio[0].filepath;
    const referenceText = fields.text?.[0] || fields.text || "";

    console.error("FORMIDABLE FILES OBJECT:", files);
    console.error("Resolved inPath:", inPath);
    console.error("ENV CHECK → REGION:", process.env.AZURE_REGION, "KEY PRESENT:", !!process.env.AZURE_SPEECH_KEY);

    // 2. Read file buffer
    const audioBuffer = await fs.readFile(inPath);

    // 3. Azure setup
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.AZURE_SPEECH_KEY,
      process.env.AZURE_REGION
    );
    speechConfig.speechRecognitionLanguage = "en-US";
    const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);

    const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);
    pushStream.write(audioBuffer);
    pushStream.close();

    const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);

    // 4. Pronunciation assessment config
    const pronConfig = new sdk.PronunciationAssessmentConfig(
      referenceText,
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Phoneme,
      true
    );
    pronConfig.enableProsodyAssessment = true;
    pronConfig.enableContentAssessment = true;
    // Leave other advanced configs as default

    // 5. Start recognizer
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    pronConfig.applyTo(recognizer);

    const data = await new Promise((resolve, reject) => {
      recognizer.recognizeOnceAsync(
        (result) => {
          if (
            result.reason === sdk.ResultReason.RecognizedSpeech &&
            result.properties
          ) {
            try {
              const json = JSON.parse(
                result.properties.getProperty(
                  sdk.PropertyId.SpeechServiceResponse_JsonResult
                )
              );
              resolve(json);
            } catch (err) {
              reject(
                new Error("Could not parse Azure response: " + err.message)
              );
            }
          } else {
            reject(
              new Error(
                "Speech recognition failed: " +
                  (result.errorDetails || result.reason)
              )
            );
          }
        },
        (err) => reject(err)
      );
    });

    // 6. Build response: send original Azure data plus helper fields
    const payload = {
      ...data,
      referenceText,
      enrichedWords: enrich(data).words,
      overallScore: data?.NBest?.[0]?.PronunciationAssessment?.OverallScore ?? null,
      duration: data?.NBest?.[0]?.Duration ?? null,
    };

    console.error("RESPONSE PAYLOAD:", payload);
    res.status(200).json(payload);
  } catch (error) {
    console.error("API error:", error);
    res
      .status(500)
      .json({ error: error.message || "Unknown error occurred." });
  }
}
