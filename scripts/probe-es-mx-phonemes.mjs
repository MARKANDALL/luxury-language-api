// THROWAWAY PROBE: calls Azure Speech pronunciation assessment with
// locale es-MX and PhonemeAlphabet "IPA" to see whether Azure returns
// real Spanish IPA phoneme labels or empty strings.
//
// Self-contained: synthesizes a Spanish phrase via Azure TTS, converts
// it to 16 kHz mono WAV via ffmpeg, then feeds it to pronunciation
// assessment. No external audio file needed.
//
// Usage:
//   node --env-file=.env scripts/probe-es-mx-phonemes.mjs
//
// Or with your own WAV:
//   node --env-file=.env scripts/probe-es-mx-phonemes.mjs my-audio.wav "el cafe esta caliente"

import fs from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const region = process.env.AZURE_SPEECH_REGION || process.env.AZURE_REGION || "eastus";
const key = process.env.AZURE_SPEECH_KEY;

if (!key) {
  console.error("ERROR: AZURE_SPEECH_KEY not set. Check your .env file.");
  process.exit(1);
}

const referenceText = process.argv[3] || "el cafe esta caliente";
let wavPath = process.argv[2] || null;

// If no WAV provided, synthesize one via Azure TTS
if (!wavPath) {
  console.log("No audio file provided -- synthesizing via Azure TTS...");
  console.log(`Text: "${referenceText}"`);
  console.log("");

  const ttsEndpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const ssml = [
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-MX">',
    '  <voice name="es-MX-DaliaNeural">',
    `    <prosody rate="-10%">${referenceText}</prosody>`,
    "  </voice>",
    "</speak>",
  ].join("\n");

  const ttsRes = await fetch(ttsEndpoint, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "riff-16khz-16bit-mono-pcm",
      "User-Agent": "lux-probe",
    },
    body: ssml,
  });

  if (!ttsRes.ok) {
    const detail = await ttsRes.text().catch(() => "(no body)");
    console.error(`TTS failed: HTTP ${ttsRes.status}`);
    console.error(detail);
    console.error("");
    console.error("Fallback: provide your own WAV file:");
    console.error("  node --env-file=.env scripts/probe-es-mx-phonemes.mjs <path-to-wav> [referenceText]");
    console.error("");
    console.error("The WAV must be mono 16 kHz 16-bit PCM, a few seconds of spoken");
    console.error("Mexican Spanish matching the reference text.");
    process.exit(1);
  }

  const audioBuf = Buffer.from(await ttsRes.arrayBuffer());
  wavPath = path.join(tmpdir(), `lux_probe_tts_${Date.now()}.wav`);
  fs.writeFileSync(wavPath, audioBuf);
  console.log(`TTS audio saved: ${wavPath} (${audioBuf.length} bytes)`);
  console.log("");
}

if (!fs.existsSync(wavPath)) {
  console.error(`ERROR: file not found: ${wavPath}`);
  process.exit(1);
}

// Ensure 16 kHz mono PCM WAV (Azure requirement)
const convertedPath = path.join(tmpdir(), `lux_probe_converted_${Date.now()}.wav`);

// Find ffmpeg -- try the project's bundled copy first, then system PATH
let ffmpegBin = "ffmpeg";
try {
  const installerPkg = JSON.parse(
    fs.readFileSync(
      path.join("node_modules", "@ffmpeg-installer", "ffmpeg", "package.json"),
      "utf8"
    )
  );
  const installerPath = path.join(
    "node_modules",
    "@ffmpeg-installer",
    "ffmpeg",
    installerPkg.main || ""
  );
  // The installer exports a .path property; read the module to get it
  const { path: ffPath } = await import("@ffmpeg-installer/ffmpeg");
  if (ffPath && fs.existsSync(ffPath)) ffmpegBin = ffPath;
} catch {
  // fall through to system ffmpeg
}

try {
  execSync(
    `"${ffmpegBin}" -y -i "${wavPath}" -ar 16000 -ac 1 -f wav -sample_fmt s16 "${convertedPath}"`,
    { stdio: "pipe" }
  );
  wavPath = convertedPath;
} catch (err) {
  console.warn("ffmpeg conversion skipped (may already be correct format):", err.message);
}

const audioBuffer = fs.readFileSync(wavPath);

if (audioBuffer.length === 0) {
  console.error("ERROR: audio file is empty (0 bytes).");
  process.exit(1);
}

const locale = "es-MX";

const pronAssessmentParams = {
  ReferenceText: referenceText,
  GradingSystem: "HundredMark",
  Granularity: "Phoneme",
  Dimension: "Comprehensive",
  EnableMiscue: true,
  Language: locale,
  PhonemeAlphabet: "IPA",
};

const pronAssessmentHeader = Buffer.from(
  JSON.stringify(pronAssessmentParams),
  "utf8"
).toString("base64");

const endpoint =
  `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
  `?language=${locale}&format=detailed`;

console.log("--- PROBE: Azure es-MX pronunciation assessment with IPA alphabet ---");
console.log(`Locale:          ${locale}`);
console.log(`PhonemeAlphabet: IPA`);
console.log(`ReferenceText:   ${referenceText}`);
console.log(`Audio file:      ${wavPath} (${audioBuffer.length} bytes)`);
console.log(`Region:          ${region}`);
console.log("");

try {
  const azureRes = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
      "Pronunciation-Assessment": pronAssessmentHeader,
      Accept: "application/json",
    },
    body: audioBuffer,
  });

  const raw = await azureRes.text();

  if (!azureRes.ok) {
    console.error(`Azure returned HTTP ${azureRes.status}`);
    console.error(raw);
    process.exit(1);
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    console.error("Azure returned non-JSON:");
    console.error(raw);
    process.exit(1);
  }

  console.log("=== RAW AZURE RESPONSE (full JSON) ===");
  console.log(JSON.stringify(json, null, 2));
  console.log("");

  // Extract phoneme summary
  const nbest = json.NBest?.[0];
  if (!nbest) {
    console.log("=== SUMMARY ===");
    console.log("No NBest results returned.");
    process.exit(0);
  }

  const words = nbest.Words || [];
  let totalPhonemes = 0;
  let nonEmptyCount = 0;
  let emptyCount = 0;
  const phonemeLabels = [];

  console.log("=== PER-WORD PHONEME DETAIL ===");
  for (const w of words) {
    const phList = w.Phonemes || [];
    const labels = phList.map((ph) => {
      totalPhonemes++;
      const label = ph.Phoneme || "";
      if (label.length > 0) {
        nonEmptyCount++;
        phonemeLabels.push(label);
      } else {
        emptyCount++;
      }
      const score = ph.PronunciationAssessment?.AccuracyScore ?? "?";
      return `${label || "(empty)"}:${score}`;
    });
    console.log(`  "${w.Word}" => [${labels.join(", ")}]`);
  }
  console.log("");

  console.log("=== PHONEME SUMMARY ===");
  console.log(`Locale sent:            ${locale}`);
  console.log(`PhonemeAlphabet sent:    IPA`);
  console.log(`Total words:            ${words.length}`);
  console.log(`Total phonemes:         ${totalPhonemes}`);
  console.log(`Non-empty labels:       ${nonEmptyCount}`);
  console.log(`Empty labels:           ${emptyCount}`);
  console.log(`Unique labels:          [${[...new Set(phonemeLabels)].join(", ")}]`);
  console.log("");

  if (nonEmptyCount > 0 && emptyCount === 0) {
    console.log("ANSWER: YES -- Azure returned non-empty IPA phoneme labels for es-MX.");
    console.log("The G2P fallback layer (g2p-spec.js) may NOT be needed.");
  } else if (nonEmptyCount > 0 && emptyCount > 0) {
    console.log("ANSWER: PARTIAL -- some phoneme labels are non-empty, some are empty.");
    console.log("The G2P fallback layer may be needed for the gaps.");
  } else {
    console.log("ANSWER: NO -- all phoneme labels are empty even with PhonemeAlphabet: IPA.");
    console.log("The G2P fallback layer (g2p-spec.js) IS needed to derive labels.");
  }
} catch (err) {
  console.error("Fetch error:", err.message || err);
  process.exit(1);
} finally {
  // Clean up temp files
  try { if (convertedPath) fs.unlinkSync(convertedPath); } catch {}
}
