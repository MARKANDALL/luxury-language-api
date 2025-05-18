import formidable from "formidable";
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

      // LOG output for debugging
      console.log("FIELDS:", fields);
      console.log("FILES:", files);

      // Try both direct and array access for audio file
      const referenceText = fields.text;
      let audioFile = files.audio;
      if (Array.isArray(audioFile)) {
        audioFile = audioFile[0];
      }

      if (!referenceText || !audioFile) {
        return res.status(400).json({ error: "Missing text or audio" });
      }

      // Try both .filepath and .path for compatibility
      const audioPath = audioFile.filepath || audioFile.path;
      if (!audioPath) {
        return res.status(400).json({ error: "No file path found in upload" });
      }

      const audioData = await fs.readFile(audioPath);

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
