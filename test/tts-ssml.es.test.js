// test/tts-ssml.es.test.js
// es-MX flip contract for the TTS SSML builder.
//   (1) ENGLISH BYTE-IDENTICAL — every English voice (and any unparseable/missing
//       voice) still emits xml:lang="en-US" on the <speak> namespace and the
//       <voice> tag, exactly as before the flip.
//   (2) The es-MX flip works: an es-MX voice adopts xml:lang="es-MX" so Azure
//       speaks Mexican Spanish. Voice selection is handled on the frontend; here
//       the locale is derived from the voice name it sends.
import { describe, it, expect } from "vitest";
import { baseSpeakTag, localeFromVoice } from "../routes/tts/ssml.js";

// Faithful copy of the pre-flip builder (always en-US) to prove byte-identity.
function headBaseSpeakTag({ voice, inner, withMstts = false }) {
  const ns = withMstts
    ? `xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US"`
    : `xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"`;
  return `<speak version="1.0" ${ns}><voice name="${voice}" xml:lang="en-US">${inner}</voice></speak>`;
}

describe("tts ssml es-MX flip", () => {
  const englishOrOther = [
    "en-US-JennyNeural",
    "en-US-GuyNeural",
    "en-GB-RyanNeural",
    "en-AU-NatashaNeural",
    "SomeCustomClonedVoice",
    "",
  ];

  it("English / unparseable voices stay byte-identical to the pre-flip en-US output", () => {
    for (const voice of englishOrOther) {
      for (const withMstts of [true, false]) {
        const inner = "<p>hi</p>";
        expect(baseSpeakTag({ voice, inner, withMstts })).toBe(
          headBaseSpeakTag({ voice, inner, withMstts })
        );
      }
    }
  });

  it("an es-MX voice emits xml:lang=\"es-MX\" on both speak and voice tags", () => {
    const xml = baseSpeakTag({ voice: "es-MX-DaliaNeural", inner: "<p>hola</p>", withMstts: false });
    expect(xml).toContain(`xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-MX"`);
    expect(xml).toContain(`<voice name="es-MX-DaliaNeural" xml:lang="es-MX">`);
    expect(xml).not.toContain("en-US");
  });

  it("localeFromVoice: English → en-US, es-MX → es-MX, junk → null", () => {
    expect(localeFromVoice("en-US-JennyNeural")).toBe("en-US");
    expect(localeFromVoice("en-GB-RyanNeural")).toBe("en-US");
    expect(localeFromVoice("es-MX-DaliaNeural")).toBe("es-MX");
    expect(localeFromVoice("es-ES-ElviraNeural")).toBe("es-ES");
    expect(localeFromVoice("NotAVoice")).toBe(null);
    expect(localeFromVoice("")).toBe(null);
  });

  it("an explicit lang argument overrides the voice-derived locale", () => {
    const xml = baseSpeakTag({ voice: "en-US-JennyNeural", inner: "<p>hola</p>", lang: "es-MX" });
    expect(xml).toContain(`xml:lang="es-MX"`);
  });
});
