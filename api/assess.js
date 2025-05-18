import { formidable } from "formidable";
import fs from "fs/promises";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Only POST allowed");
  }

  const form = formidable();

  form.parse(req, async (err, fields, files) => {
    try {
      if (err) throw err;

      // Debug: log fields and files
      console.log('FIELDS:', fields);
      console.log('FILES:', files);

      const referenceText = fields.text;
      let audioFile = files.audio;

      // Formidable sometimes returns files as arrays or objects
      if (Array.isArray(audioFile)) {
        audioFile = audioFile[0];
      }

      if (!referenceText || !audioFile || !audioFile.filepath) {
        return res.status(400).json({ error: "Missing text or audio" });
      }

      const audioData = await fs.readFile(audioFile.filepath);

      const result = await fetch(
        "https://eastus.api.cognitive.microsoft.com/speechtotext/v3.1/evaluations",
        {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY,
            "Content-Type": "audio/wav",
            "Pronunciation-Assessment": JSON.stringify({
              referenceText,
              gradingSystem: "HundredMark",
              dimension: "Comprehensive",
              enableMiscue: true,
            }),
          },
          body: audioData,
        }
      );

      const data = await result.json();
      res.status(200).json(data);
    } catch (error) {
      console.error("API ERROR:", error);
      res.status(500).json({ error: "Server error", details: error.message });
    }
  });
}
