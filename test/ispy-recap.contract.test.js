// test/ispy-recap.contract.test.js
// Contract test for the scene recap on /api/router?route=ispy-recap.
// Hermetic, like word-image.contract.test.js: the model is mocked, so nothing
// here reaches the network.
//
// The promises worth pinning are the ones a reader of the summary cannot check:
//   1. ONE model call, and no image in it. This is the cheap call, and the
//      moment it starts uploading the photograph it stops being one.
//   2. Failure is SOFT. A recap is a flourish on a round already played, so
//      every failure answers 200 and the panel simply shows nothing.
//   3. The missing-word report is honest, including across articles and accents,
//      because "using every found word" is the whole feature.
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

const { createSpy } = vi.hoisted(() => ({ createSpy: vi.fn() }));

vi.mock("openai", () => ({
  OpenAI: class {
    constructor(opts) {
      if (!opts || !opts.apiKey) {
        throw new Error("The OPENAI_API_KEY environment variable is missing or empty");
      }
      this.chat = { completions: { create: createSpy } };
    }
  },
}));

const TOKEN = "test_admin_token";

function reply(obj) {
  return { choices: [{ message: { content: JSON.stringify(obj) } }] };
}

// Through the ROUTER, like convo-image-targets.contract.test.js, because the
// router is what hydrates req.body. A route posted to directly reads an
// undefined body and answers "too_few_words" to everything.
async function client() {
  const mod = await import("../api/router.js");
  return request(mkServer(mod.default || mod));
}

async function post(body, withToken = true) {
  const api = await client();
  const req = api.post("/api/router?route=ispy-recap");
  if (withToken) req.set("x-admin-token", TOKEN);
  return req.send(body);
}

const WORDS = ["a mug", "the window", "a chalkboard"];

beforeEach(() => {
  createSpy.mockReset();
  process.env.ADMIN_TOKEN = TOKEN;
  process.env.OPENAI_API_KEY = "sk-test";
});

describe("ispy-recap", () => {
  it("returns two sentences and joins them into one spoken line", async () => {
    createSpy.mockResolvedValue(
      reply({
        sentences: [
          "A mug sits on the counter beside the window.",
          "Behind it, a chalkboard stands by the window.",
        ],
      }),
    );

    const res = await post({ lang: "en", level: "B1", words: WORDS, description: "A cafe." });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sentences).toHaveLength(2);
    expect(res.body.text).toBe(
      "A mug sits on the counter beside the window. Behind it, a chalkboard stands by the window.",
    );
    expect(res.body.missing).toEqual([]);
    expect(res.body.level).toBe("B1");
  });

  it("makes exactly ONE model call, with no image in it", async () => {
    createSpy.mockResolvedValue(reply({ sentences: ["One.", "Two."] }));
    await post({ lang: "en", level: "B1", words: WORDS });

    expect(createSpy).toHaveBeenCalledTimes(1);
    const [req] = createSpy.mock.calls[0];
    // Every message part is text. An image_url part anywhere here is the cost
    // regression this route exists to avoid.
    const payload = JSON.stringify(req.messages);
    expect(payload).not.toContain("image_url");
    // Small enough to stay the cheap call. Two sentences plus their JSON is a
    // couple of hundred tokens; the rail is here so a future edit that starts
    // asking this route for a paragraph has to come and move it deliberately.
    expect(req.max_tokens).toBeLessThanOrEqual(500);
  });

  it("counts a word as used across its article and its accents", async () => {
    createSpy.mockResolvedValue(
      reply({
        sentences: ["La taza está junto a la ventana.", "Detrás hay un cafe pequeno."],
      }),
    );
    // "una taza" is asked for and "la taza" is written: the head word is there,
    // which is what the learner hears. "el café" is written unaccented, which is
    // the model being sloppy, not the word being absent.
    const res = await post({
      lang: "es",
      level: "A2",
      words: ["una taza", "la ventana", "el café"],
    });

    expect(res.body.ok).toBe(true);
    expect(res.body.missing).toEqual([]);
  });

  it("reports a word the model actually dropped, and still returns the recap", async () => {
    createSpy.mockResolvedValue(
      reply({ sentences: ["A mug sits by the window.", "The light is warm."] }),
    );
    const res = await post({ lang: "en", level: "B1", words: WORDS });

    expect(res.body.ok).toBe(true);
    expect(res.body.missing).toEqual(["a chalkboard"]);
    // Still worth hearing. A second call to patch one noun would double the
    // cost of a flourish.
    expect(res.body.text).toContain("A mug");
  });

  it("asks for two sentences at the round's band, not the picture's", async () => {
    createSpy.mockResolvedValue(reply({ sentences: ["One.", "Two."] }));
    await post({ lang: "en", level: "C1", words: WORDS });

    const system = createSpy.mock.calls[0][0].messages[0].content;
    expect(system).toContain("SENTENCE LEVEL");
    expect(system).toContain("Fluent, well-joined sentences");
    // The band guide here is about grammar. If it ever starts talking about
    // which nouns to pick, it has been crossed with the scan's LEVEL_GUIDE.
    expect(system).not.toContain("hyponym");
  });

  it("falls back to B1 for a band it does not know", async () => {
    createSpy.mockResolvedValue(reply({ sentences: ["One.", "Two."] }));
    const res = await post({ lang: "en", level: "Z9", words: WORDS });
    expect(res.body.level).toBe("B1");
  });

  it("treats es-MX as the Spanish pack", async () => {
    createSpy.mockResolvedValue(reply({ sentences: ["Uno.", "Dos."] }));
    const res = await post({ lang: "es-MX", words: ["la taza", "la ventana"] });
    expect(res.body.lang).toBe("es");
    expect(createSpy.mock.calls[0][0].messages[0].content).toContain("Spanish");
  });

  it("says no, softly, when there is barely anything to recap", async () => {
    const res = await post({ lang: "en", level: "B1", words: ["a mug"] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("too_few_words");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("says no, softly, when the model call fails", async () => {
    createSpy.mockRejectedValue(new Error("upstream is down"));
    const res = await post({ lang: "en", level: "B1", words: WORDS });
    // 200, not 500. A dead recap must never put an error in a finished round.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("model_failed");
  });

  it("says no, softly, when the model answers with nothing usable", async () => {
    createSpy.mockResolvedValue(reply({ sentences: [] }));
    const res = await post({ lang: "en", level: "B1", words: WORDS });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("no_recap");
  });

  it("degrades rather than throwing when there is no API key", async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await post({ lang: "en", level: "B1", words: WORDS });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("init_error");
  });

  it("refuses without the admin token", async () => {
    const res = await post({ lang: "en", level: "B1", words: WORDS }, false);
    expect(res.status).toBe(401);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("DROPS a runaway sentence rather than serving half of one", async () => {
    // This text is read aloud. A sentence trimmed at a character count is heard
    // trimmed mid-word, which is exactly what the first cut of this route did to
    // a wordy C2 pair.
    createSpy.mockResolvedValue(
      reply({ sentences: ["A mug sits by the window.", "x".repeat(500)] }),
    );
    const res = await post({ lang: "en", level: "B1", words: WORDS });
    expect(res.body.ok).toBe(true);
    expect(res.body.sentences).toEqual(["A mug sits by the window."]);
    expect(res.body.text).not.toContain("xxx");
  });

  it("takes at most two sentences, however many it is given", async () => {
    createSpy.mockResolvedValue(
      reply({ sentences: ["One.", "Two.", "Three.", "Four."] }),
    );
    const res = await post({ lang: "en", level: "B1", words: WORDS });
    expect(res.body.sentences).toHaveLength(2);
  });

  it("caps the word list rather than sending a whole vocabulary", async () => {
    createSpy.mockResolvedValue(reply({ sentences: ["One.", "Two."] }));
    const many = Array.from({ length: 30 }, (_, i) => `word${i}`);
    await post({ lang: "en", level: "B1", words: many });
    const user = createSpy.mock.calls[0][0].messages[1].content;
    expect(user).toContain("word9");
    expect(user).not.toContain("word10");
  });
});


// ── The truth gate (v15A item 7) ────────────────────────────────────────────
//
// Filed live: both recap sentences placed a bus interior in a parking lot with
// an elevator, a trash can and a faucet. Reproduced unguided here as a
// passenger waiting on a sidewalk for a bus that "arrives and stops to pick up
// the passenger", for a photograph taken inside the moving bus.
//
// The writer was being asked to describe a photograph it had been told nothing
// about, because a still carries no description. It now receives the cached
// scene inventory, and whatever it writes is checked before it is served:
// better no recap than a confident false one, and the panel already hides the
// box when there is no text.

describe("ispy-recap truth gate", () => {
  it("REFUSES a recap that names something nobody can vouch for", async () => {
    createSpy.mockResolvedValue(
      reply({
        sentences: [
          "A mug sits on the counter.",
          "The barista walks across the parking lot to the elevator.",
        ],
      }),
    );
    const r = await post({ words: ["a mug", "a counter"], description: "A cafe counter with a mug on it." });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toBe("invented_scene");
  });

  it("serves a recap that stays inside the found words and the scene", async () => {
    createSpy.mockResolvedValue(
      reply({ sentences: ["A mug sits on the counter.", "The counter is clean."] }),
    );
    const r = await post({ words: ["a mug", "a counter"], description: "A cafe counter with a mug on it." });
    expect(r.body.ok).toBe(true);
    expect(r.body.text).toContain("mug");
  });

  it("judges only what the recap NAMES, not its grammar", async () => {
    // Determiner-led nouns are the things it names; verbs, adverbs and
    // participles are grammar. Grading grammar produced refusals for "uses",
    // "where", "held" and "along" while the real inventions sat beside them.
    createSpy.mockResolvedValue(
      reply({
        sentences: [
          "A mug sits quietly where the counter has been wiped.",
          "It stood there beside the counter, held steady.",
        ],
      }),
    );
    const r = await post({ words: ["a mug", "a counter"], description: "A cafe counter with a mug on it." });
    expect(r.body.ok).toBe(true);
  });
});
