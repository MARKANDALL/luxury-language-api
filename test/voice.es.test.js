// test/voice.es.test.js
// es-MX flip contract for the Voice Mirror synth (lib/voice.js synthesizeSpeech).
//   (1) ENGLISH BYTE-IDENTICAL — threading pack:"es" must NOT change the request
//       sent to ElevenLabs vs pack:"en" (or no pack). Same URL, headers, model,
//       and voice_settings; the ONLY difference between en and es is the `text`.
//   (2) The model stays eleven_multilingual_v2 (which infers Spanish from the
//       Spanish text) and we NEVER send a `language_code` — multilingual_v2
//       rejects it, so sending one would break Spanish playback.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { synthesizeSpeech } from "../lib/voice.js";

const ENGLISH = "The rainbow is a division of white light.";
const SPANISH = "Por la mañana, el cielo se pinta de colores suaves.";

function mockFetch() {
  const calls = [];
  global.fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async arrayBuffer() {
        return new Uint8Array([1, 2, 3]).buffer;
      },
    };
  });
  return calls;
}

describe("voice mirror synth es-MX flip", () => {
  const prevKey = process.env.ELEVENLABS_API_KEY;

  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = "test-key";
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = prevKey;
    vi.restoreAllMocks();
  });

  it("always uses eleven_multilingual_v2 and never sends language_code (en + es)", async () => {
    for (const [pack, text] of [["en", ENGLISH], ["es", SPANISH]]) {
      const calls = mockFetch();
      await synthesizeSpeech({ voiceId: "v1", text, pack });
      const body = JSON.parse(calls[0].init.body);
      expect(body.model_id).toBe("eleven_multilingual_v2");
      expect(body).not.toHaveProperty("language_code");
      expect(body.text).toBe(text);
    }
  });

  it("pack:\"es\" produces a byte-identical request to pack:\"en\" except for text", async () => {
    const callsEs = mockFetch();
    await synthesizeSpeech({ voiceId: "v1", text: SPANISH, pack: "es" });
    const es = callsEs[0];

    const callsEn = mockFetch();
    await synthesizeSpeech({ voiceId: "v1", text: SPANISH, pack: "en" });
    const en = callsEn[0];

    // Same endpoint + headers + method regardless of pack.
    expect(es.url).toBe(en.url);
    expect(es.init.method).toBe(en.init.method);
    expect(es.init.headers).toEqual(en.init.headers);
    // Same JSON body (same text here) — proves pack does not leak into the request.
    expect(es.init.body).toBe(en.init.body);
  });

  it("defaults to English behavior when pack is omitted (byte-identical body)", async () => {
    const withPack = mockFetch();
    await synthesizeSpeech({ voiceId: "v1", text: ENGLISH, pack: "en" });

    const noPack = mockFetch();
    await synthesizeSpeech({ voiceId: "v1", text: ENGLISH });

    expect(withPack[0].init.body).toBe(noPack[0].init.body);
  });
});
