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

  const form = formidable({});
  form.parse(req, async (err, fields, files) => {
    try {
      if (err) throw err;

      const referenceText = fields.text;
      const audioFile = files.audio;

      if (!referenceText || !audioFile) {
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

      // Instead of assuming JSON, let's capture whatever Azure returns
      const rawText = await result.text();
      console.log("AZURE RAW RESPONSE:", rawText);

      let data;
      try {
        data = JSON.parse(rawText);
      } catch (e) {
        // If not JSON, send back the raw response so we can debug
        return res.status(500).json({ error: "Azure did not return JSON", raw: rawText });
      }
      return res.status(200).json(data);
    } catch (error) {
      console.error("API ERROR:", error);
      res.status(500).json({ error: "Server error", details: error.message });
    }
  });
}
