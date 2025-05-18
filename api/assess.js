import formidable from "formidable";
import fs from "fs/promises";
import path from "path";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Only POST allowed");
  }

  const form = new formidable.IncomingForm({
    uploadDir: "/tmp",
    keepExtensions: true,
  });

  try {
    const [fields, files] = await form.parse(req);

    const referenceText = fields.text;
    const audioFile = files.audio;

    if (!audioFile || !audioFile.filepath) {
      return res.status(400).json({ error: "No audio file uploaded" });
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
    return res.status(200).json(data);
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

