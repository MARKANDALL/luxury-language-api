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

// The cached scene inventory, which sceneInventory reads. Every test that does
// not set it gets null back and exercises the description-only path, exactly as
// before this mock existed.
const { sbRow } = vi.hoisted(() => ({ sbRow: { value: null } }));
vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: sbRow.value, error: null }),
      };
      return chain;
    },
  }),
}));

// v MUST be INV_V (101) or the route rejects the row as not an inventory.
function scene(entries) {
  sbRow.value = { v: 101, targets: entries };
}

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

// Which gate refused. The two log lines are deliberately distinct in the route
// so a real round says which half is doing the work; here it lets a test insist
// that a claim refusal was not a noun refusal wearing its clothes.
let untruthsFired = false;
vi.spyOn(console, "log").mockImplementation((...a) => {
  if (String(a[0] || "").includes("invented word(s)")) untruthsFired = true;
});

beforeEach(() => {
  createSpy.mockReset();
  sbRow.value = null;
  untruthsFired = false;
  process.env.ADMIN_TOKEN = TOKEN;
  process.env.OPENAI_API_KEY = "sk-test";
});

// Mark's classroom, as boxes. The poster is on the LEFT WALL; the whiteboard is
// across the middle of the frame. They share no pixels, which is the whole
// point: "a colorful poster on the whiteboard" is not a near miss, it is two
// things in different places joined by a word nobody supplied.
const CLASSROOM = [
  { id: 0, gloss: "a colorful poster", granularity: "object", box: { x: 0.04, y: 0.14, w: 0.1, h: 0.16 }, point: { x: 0.09, y: 0.22 } },
  { id: 1, gloss: "a whiteboard", granularity: "object", box: { x: 0.34, y: 0.12, w: 0.4, h: 0.3 }, point: { x: 0.54, y: 0.27 } },
  { id: 2, gloss: "a beige cardigan", granularity: "object", box: { x: 0.3, y: 0.5, w: 0.14, h: 0.2 }, point: { x: 0.37, y: 0.6 } },
  { id: 3, gloss: "a clock", granularity: "object", box: { x: 0.36, y: 0.03, w: 0.06, h: 0.07 }, point: { x: 0.39, y: 0.065 } },
];

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

  it("shows the writer the scene instead of only judging it afterwards", async () => {
    // THE BUG UNDERNEATH BOTH OF MARK'S INVENTED DETAILS. sceneInventory has
    // been read on every request since v15A and buildUser took two parameters
    // while the call site passed three, so the inventory was dropped in silence.
    // The gate could refuse a lie; nothing ever gave the writer the truth, and a
    // still carries no description, so the writer was working from five bare
    // nouns and had to guess.
    scene(CLASSROOM);
    createSpy.mockResolvedValue(reply({ sentences: ["A poster hangs.", "A clock is there."] }));
    await post({ words: ["a poster", "a clock"], imageKey: "k1" });

    const user = createSpy.mock.calls[0][0].messages[1].content;
    expect(user).toContain("a colorful poster");
    expect(user).toContain("a whiteboard");
  });

  it("stays the cheap call: no photograph, no bigger budget", async () => {
    // The scene costs input tokens, and the rail that says this is a text call
    // has to survive that.
    scene(CLASSROOM);
    createSpy.mockResolvedValue(reply({ sentences: ["A poster hangs.", "A clock is there."] }));
    await post({ words: ["a poster", "a clock"], imageKey: "k1" });

    const req = createSpy.mock.calls[0][0];
    expect(JSON.stringify(req.messages)).not.toContain("image_url");
    expect(req.max_tokens).toBeLessThanOrEqual(500);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("REFUSES a relation the boxes do not support", async () => {
    // MARK'S SENTENCE, VERBATIM. Both nouns are in the scene, so the noun gate
    // passes it, and it is false: the poster is on the wall.
    scene(CLASSROOM);
    createSpy.mockResolvedValue(
      reply({
        sentences: [
          "A colorful poster on the whiteboard is bright.",
          "A clock is small.",
        ],
      }),
    );
    const r = await post({ words: ["a poster", "a clock"], imageKey: "k1" });
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toBe("invented_scene");
    // And for the RIGHT reason. Every noun in that sentence is in the scene, so
    // the noun gate passes it; what is false is the word BETWEEN two true nouns,
    // which is the whole finding.
    expect(untruthsFired).toBe(false);
  });

  it("SERVES the same relation when the boxes do support it", async () => {
    // The rail that stops the gate refusing honest recaps. Same sentence, poster
    // box inside the whiteboard box.
    scene([
      { id: 0, gloss: "a colorful poster", box: { x: 0.4, y: 0.16, w: 0.08, h: 0.1 }, point: { x: 0.44, y: 0.21 } },
      { id: 1, gloss: "a whiteboard", box: { x: 0.34, y: 0.12, w: 0.4, h: 0.3 }, point: { x: 0.54, y: 0.27 } },
    ]);
    createSpy.mockResolvedValue(
      reply({ sentences: ["A colorful poster on the whiteboard is bright.", "It is small."] }),
    );
    const r = await post({ words: ["a poster", "a whiteboard"], imageKey: "k1" });
    expect(r.body.ok).toBe(true);
  });

  it("ABSTAINS when the other side of the relation is not in the scene", async () => {
    // "the poster on the wall", where the wall is a known thing the inventory
    // never boxed. The noun gate allows it; the claim gate cannot place it, so it
    // must ABSTAIN rather than refuse. Half the relations in a natural recap land
    // here and none of them is this function's business.
    scene([...CLASSROOM, { id: 4, gloss: "a wall", granularity: "surface", point: { x: 0.5, y: 0.4 } }]);
    createSpy.mockResolvedValue(
      reply({ sentences: ["A colorful poster on the wall is bright.", "A clock is small."] }),
    );
    const r = await post({ words: ["a poster", "a clock"], imageKey: "k1" });
    expect(r.body.ok).toBe(true);
  });

  it("ABSTAINS on a chained preposition rather than judging the wrong pair", async () => {
    // FOUND ON THE FIRST LIVE RUN. "a colorful poster on the wall above the
    // green chalkboard" is true, and the gate refused it: the nearest noun
    // before "above" is the wall, which is the OBJECT of "on", and the wall's
    // box does sit lower than the chalkboard's. It was judging a pair the
    // sentence never asserted.
    //
    // A false refusal is worse than the invention it prevents: the invention
    // costs one wrong detail, refusing costs the whole recap every time.
    scene([
      ...CLASSROOM,
      { id: 4, gloss: "a classroom wall", granularity: "surface", box: { x: 0, y: 0, w: 1, h: 0.35 }, point: { x: 0.5, y: 0.17 } },
    ]);
    createSpy.mockResolvedValue(
      reply({
        sentences: [
          "A colorful poster is on the wall above the whiteboard.",
          "A clock is small.",
        ],
      }),
    );
    const r = await post({ words: ["a poster", "a clock"], imageKey: "k1" });
    expect(r.body.ok).toBe(true);
  });

  it("ABSTAINS when a gloss carries its own preposition", async () => {
    // ALSO FOUND LIVE. "a glass of water" keys on "water", so "...next to a
    // woman in a blue shirt" was judged as "water in shirt" and a true recap was
    // refused. The head of that gloss is the object of the gloss's own
    // preposition and belongs to neither side of the sentence's claim.
    scene([
      { id: 0, gloss: "a glass of water", box: { x: 0.02, y: 0.79, w: 0.07, h: 0.17 }, point: { x: 0.06, y: 0.88 } },
      { id: 1, gloss: "a blue shirt", box: { x: 0.74, y: 0.05, w: 0.26, h: 0.9 }, point: { x: 0.87, y: 0.4 } },
    ]);
    createSpy.mockResolvedValue(
      reply({ sentences: ["A glass of water is there.", "It is near a woman in a blue shirt."] }),
    );
    const r = await post({ words: ["a glass of water", "a blue shirt"], imageKey: "k1" });
    expect(r.body.ok).toBe(true);
  });

  it("is inert with no inventory, so the description-only path is unchanged", async () => {
    createSpy.mockResolvedValue(
      reply({ sentences: ["A mug sits on the counter.", "The counter is clean."] }),
    );
    const r = await post({ words: ["a mug", "a counter"], description: "A cafe counter with a mug on it." });
    expect(r.body.ok).toBe(true);
  });

  it("carries the claim rules in the prompt, for what boxes cannot settle", async () => {
    // GAZE IS NOT CHECKABLE AND NEVER WILL BE from this context. "She looks at
    // them carefully" was Mark's second invented detail, and nothing in the
    // inventory records who is looking where: there is no gaze field, and action
    // glosses are unattributed strings. It is prevented in the system turn, not
    // caught in code, and this test says so rather than leaving a gap that reads
    // like coverage.
    scene(CLASSROOM);
    createSpy.mockResolvedValue(reply({ sentences: ["A poster hangs.", "A clock is there."] }));
    await post({ words: ["a poster", "a clock"], imageKey: "k1" });

    const system = createSpy.mock.calls[0][0].messages[0].content;
    expect(system).toContain("A RELATION IS A CLAIM");
    expect(system).toContain("AN ACTION IS A CLAIM AND ITS OBJECT IS A SECOND ONE");
    expect(system).toContain("OMIT WHAT YOU CANNOT SUPPORT");
    // And SENTENCE_GUIDE stays about grammar, which the test above this one
    // guards from the other direction.
    expect(system).not.toContain("hyponym");
  });

  it("does not catch a gaze claim, and must not pretend to", async () => {
    scene(CLASSROOM);
    createSpy.mockResolvedValue(
      reply({ sentences: ["A clock is small.", "She looks at them carefully."] }),
    );
    const r = await post({ words: ["a clock", "a poster"], imageKey: "k1" });
    // Served. Prompt-prevented, not code-caught: the honest boundary, written
    // down so the next reader does not assume the gate covers it.
    expect(r.body.ok).toBe(true);
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
