import formidable from "formidable";
import fs from "fs/promises";

export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Only POST allowed");
  }

  const form = formidable({ multiples: false });

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(400).json({ error: "Parse error", details: err.message });

    const referenceText = fields.text;
    const audioFile = files.audio;

    // ADD THIS LOGIC
    let audioBuffer;
    if (audioFile?.filepath) {
      audioBuffer = await fs.readFile(audioFile.filepath);
    } else if (audioFile?.buffer) {
      audioBuffer = audioFile.buffer;
    } else {
      return res.status(400).json({ error: "Audio file missing buffer or path", debug: audioFile });
    }

    try {
      const result = await fetch(
        "https://eastus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed",
        {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY,
            "Content-Type": "audio/wav"
          },
          body: audioBuffer
        }
      );

      const data = await result.json();
      res.status(200).json(data);
    } catch (e) {
      res.status(500).json({ error: "Azure request failed", details: e.message });
    }
  });
}
