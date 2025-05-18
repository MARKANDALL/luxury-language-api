import formidable from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Only POST allowed");
  }

  const form = new formidable.IncomingForm();

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "Form parsing error" });

    const referenceText = fields.text;
    const audioFilePath = files.audio.filepath;

    const audioData = fs.readFileSync(audioFilePath);

    const result = await fetch(
      "https://eastus.api.cognitive.microsoft.com/speechtotext/v3.1/evaluations",
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY,
          "Content-Type": "audio/wav",
          "Pronunciation-Assessment": JSON.stringify({
            referenceText: referenceText,
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
  });
}
