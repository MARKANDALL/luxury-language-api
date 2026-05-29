// test-es-mx-phonemes.js
// Run: node test-es-mx-phonemes.js
// Speaks into mic, assesses pronunciation in es-MX, dumps raw phoneme JSON.
// Save in C:\dev\luxury-language-api\ (where the Speech SDK is already installed).

const sdk = require("microsoft-cognitiveservices-speech-sdk");

const key = process.env.AZURE_SPEECH_KEY || "YOUR_KEY_HERE";
const region = process.env.AZURE_SPEECH_REGION || "eastus";
const referenceText = "El perro del niño corre hacia la caja roja";

const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
speechConfig.speechRecognitionLanguage = "es-MX";

const audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

const pronConfig = new sdk.PronunciationAssessmentConfig(
  referenceText,
  sdk.PronunciationAssessmentGradingSystem.HundredMark,
  sdk.PronunciationAssessmentGranularity.Phoneme,
  false
);
pronConfig.applyTo(recognizer);

console.log("\n=== Azure es-MX Pronunciation Assessment Test ===");
console.log(`Reference: "${referenceText}"`);
console.log("Speak the sentence now...\n");

recognizer.recognizeOnceAsync((result) => {
  if (result.reason === sdk.ResultReason.RecognizedSpeech) {
    const pronResult = sdk.PronunciationAssessmentResult.fromResult(result);
    console.log("=== OVERALL SCORES ===");
    console.log("Accuracy:", pronResult.accuracyScore);
    console.log("Fluency:", pronResult.fluencyScore);
    console.log("Completeness:", pronResult.completenessScore);
    console.log("Pronunciation:", pronResult.pronunciationScore);
    console.log();

    // Raw JSON for the full detail
    const json = JSON.parse(result.properties.getProperty(
      sdk.PropertyId.SpeechServiceResponse_JsonResult
    ));

    const words = json.NBest?.[0]?.Words || [];
    console.log("=== PER-WORD + PHONEME DETAIL ===\n");
    for (const w of words) {
      console.log(`Word: "${w.Word}" | Accuracy: ${w.PronunciationAssessment?.AccuracyScore}`);
      const phonemes = w.Phonemes || [];
      if (phonemes.length === 0) {
        console.log("  (no phoneme data returned)");
      }
      for (const p of phonemes) {
        const name = p.Phoneme || "(empty)";
        const score = p.PronunciationAssessment?.AccuracyScore ?? "N/A";
        console.log(`  Phoneme: "${name}" | Score: ${score} | Offset: ${p.Offset} | Duration: ${p.Duration}`);
      }
      console.log();
    }

    // Also dump the raw NBest[0] for full inspection
    console.log("=== RAW JSON (first NBest) ===");
    console.log(JSON.stringify(json.NBest?.[0], null, 2));
  } else {
    console.log("Recognition failed:", result.reason);
    console.log("Error detail:", result.errorDetails);
  }
  recognizer.close();
});