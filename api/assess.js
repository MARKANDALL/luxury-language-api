import formidable from "formidable";
import fs from "fs/promises";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  // --- CORS support for browsers ---
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(200).end();
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).send("Only POST allowed");
  }

  const form = formidable();

  form.parse(req, async (err, fields, files) => {
    try {
      if (err) throw err;

      const referenceText = fields.text;
      const audioFile = files.audio;

      if (!referenceText || !audioFile) {
        return res.status(400).json({ error: "Missing text or audio" });
      }

      const audioData = await fs.readFile(audioFile.filepath);

      // Use the basic Speech-to-Text endpoint for free tier
      const result = await fetch(
        `https://eastus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`,
        {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY,
            "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
            Accept: "application/json",
          },
          body: audioData,
        }
      );

      let data;
      try {
        data = await result.json();
      } catch (e) {
        data = { error: "Azure did not return JSON", raw: await result.text() };
      }
      res.status(200).json(data);
    } catch (error) {
      console.error("API ERROR:", error);
      res.status(500).json({ error: "Server error", details: error.message });
    }
  });
}
