import formidable from "formidable";
import fs from "fs/promises";

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const form = formidable({ multiples: false });
  form.parse(req, async (err, fields, files) => {
    try {
      if (err) throw err;
      const referenceText = fields.text;
      const audioFile = files.audio?.[0] || files.audio;
      if (!referenceText || !audioFile) {
        return res.status(400).json({ error: "Missing text or audio" });
      }
      let audioBuffer;
      if (audioFile.filepath) {
        audioBuffer = await fs.readFile(audioFile.filepath);
      } else if (audioFile._writeStream && audioFile._writeStream.path) {
        audioBuffer = await fs.readFile(audioFile._writeStream.path);
      } else {
        return res.status(400).json({ error: "Audio file missing buffer or path", debug: audioFile });
      }

      // Build Pronunciation-Assessment header
      const pronAssessmentParams = {
        ReferenceText: referenceText,
        GradingSystem: "HundredMark",
        Granularity: "Phoneme",
        Dimension: "Comprehensive",
        EnableMiscue: true,
      };
      const pronAssessmentHeader = Buffer.from(JSON.stringify(pronAssessmentParams)).toString("base64");

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

      let data;
      try {
        data = await result.json();
        return res.status(200).json(data);
      } catch (jsonErr) {
        const text = await result.text();
        return res.status(500).json({
          error: "Azure did not return JSON",
          status: result.status,
          statusText: result.statusText,
          raw: text,
        });
      }
    } catch (error) {
      console.error("API ERROR:", error);
      res.status(500).json({ error: "Server error", details: error.message });
    }
  });
}
