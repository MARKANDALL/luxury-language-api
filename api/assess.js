import formidable from "formidable";
import fs from "fs/promises";

export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Only POST allowed");
  }

  const form = formidable();
  form.parse(req, async (err, fields, files) => {
    try {
      if (err) throw err;
      const audioFile = Array.isArray(files.audio) ? files.audio[0] : files.audio;
      if (!audioFile) {
        return res.status(400).json({ error: "Missing audio file", debug: { files } });
      }
      let audioData;
      if (audioFile.filepath) {
        audioData = await fs.readFile(audioFile.filepath);
      } else if (audioFile.buffer) {
        audioData = audioFile.buffer;
      } else {
        return res.status(400).json({ error: "Audio file missing buffer or path", debug: { audioFile } });
      }

      // Standard Azure speech-to-text (no pronunciation, just to check pipeline)
      const url = "https://eastus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US";
      const result = await fetch(url, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY,
          "Content-Type": "audio/wav"
        },
        body: audioData,
      });

      const rawText = await result.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (e) {
        return res.status(500).json({ error: "Azure did not return JSON", raw: rawText });
      }
      return res.status(200).json(data);
    } catch (error) {
      console.error("API ERROR:", error);
      res.status(500).json({ error: "Server error", details: error.message });
    }
  });
}
