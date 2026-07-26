// test/practice-pod.contract.test.js
// Contract test for the Practice-Pod route on /api/router?route=practice-pod.
// Mirrors word-image.contract.test.js: hermetic — OpenAI is mocked, so no network
// is ever reached. Covers the happy verb path, the invariants the frontend builds
// against (exactly one wordType from the closed set, at most 5 lines, easiest-to-
// hardest order preserved), the depth-2 rule, and every graceful-degradation path
// the contract promises (missing word, missing key, malformed model JSON, a thin
// ladder, a model-call failure). The two most important assertions are the length
// cap and the shape of the empty result: the drawer must never receive a sixth
// rung, and must never receive anything but { ok, wordType:"other", lines:[],
// reason } when generation fails.
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

// A well-formed ladder of n rungs, numbered so order is checkable.
function ladder(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) {
    lines.push({ text: `Can you bring it here ${i}?`, focus: `foco ${i}` });
  }
  return lines;
}

function modelReply(obj) {
  return { choices: [{ message: { content: JSON.stringify(obj) } }] };
}

// Default: a verb classified as such, with a full 5-rung ladder.
const { createSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(),
}));

vi.mock("openai", () => ({
  OpenAI: class {
    constructor(opts) {
      // Mirror the real openai v4 constructor, which throws synchronously when the
      // API key is missing. This makes the init-error degradation path genuinely
      // testable (the route constructs the client inside its init guard).
      if (!opts || !opts.apiKey) {
        throw new Error("The OPENAI_API_KEY environment variable is missing or empty");
      }
      this.chat = { completions: { create: createSpy } };
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  createSpy.mockClear();
  createSpy.mockResolvedValue(modelReply({ wordType: "verb", lines: ladder(5) }));
  process.env.ADMIN_TOKEN = "test_admin_token";
  process.env.OPENAI_API_KEY = "test_openai_key";
});

async function client() {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  return request(mkServer(handler));
}

function post(api, bodyOverrides = {}, withToken = true) {
  const req = api.post("/api/router?route=practice-pod");
  if (withToken) req.set("x-admin-token", "test_admin_token");
  return req.send({ word: "bring", lang: "en", l1: "es", level: "B1", uid: "", ...bodyOverrides });
}

// The system prompt and the JSON payload the model was handed on call N.
const systemPromptOf = (n) => createSpy.mock.calls[n][0].messages[0].content;
const userPayloadOf = (n) => JSON.parse(createSpy.mock.calls[n][0].messages[1].content);

describe("practice-pod contract", () => {
  it("happy path: a verb returns wordType verb and a 5-rung ladder in order", async () => {
    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.wordType).toBe("verb");
    expect(Array.isArray(r.body.lines)).toBe(true);
    expect(r.body.lines.length).toBe(5);

    // Every rung is exactly { text, focus } — no extra keys leak to the frontend.
    for (const line of r.body.lines) {
      expect(Object.keys(line).sort()).toEqual(["focus", "text"]);
      expect(typeof line.text).toBe("string");
      expect(typeof line.focus).toBe("string");
      expect(line.text.length).toBeGreaterThan(0);
      expect(line.focus.length).toBeGreaterThan(0);
    }

    // The model's order IS the ladder order (easiest to hardest) — never re-sorted.
    expect(r.body.lines.map((l) => l.focus)).toEqual([
      "foco 1",
      "foco 2",
      "foco 3",
      "foco 4",
      "foco 5",
    ]);
    expect(r.body.lines[0]).toEqual({ text: "Can you bring it here 1?", focus: "foco 1" });

    // Classification and generation are ONE call, not two.
    expect(createSpy).toHaveBeenCalledTimes(1);

    // Cheap-model config, mirroring word-image: temperature 0, JSON object out.
    const args = createSpy.mock.calls[0][0];
    expect(args.temperature).toBe(0);
    expect(args.response_format).toEqual({ type: "json_object" });
    expect(args.model).toBe("gpt-4.1-mini");

    // The word and its language reach the model.
    expect(userPayloadOf(0).word).toBe("bring");
    expect(userPayloadOf(0).language).toBe("English");
  });

  it("wordType is echoed for each of the five allowed kinds", async () => {
    const api = await client();
    for (const t of ["verb", "noun", "adjective", "phrase", "other"]) {
      createSpy.mockResolvedValueOnce(modelReply({ wordType: t, lines: ladder(5) }));
      const r = await post(api, { word: t });
      expect(r.body.wordType).toBe(t);
      expect(r.body.lines.length).toBe(5);
    }
  });

  it("caps the ladder at 5 rungs when the model over-generates, keeping the first 5", async () => {
    createSpy.mockResolvedValueOnce(modelReply({ wordType: "verb", lines: ladder(9) }));
    const api = await client();
    const r = await post(api);

    expect(r.body.lines.length).toBe(5);
    expect(r.body.lines.length).toBeLessThanOrEqual(5);
    // The easiest rungs are the ones kept — truncation must come off the hard end,
    // or the ladder would start halfway up.
    expect(r.body.lines.map((l) => l.focus)).toEqual([
      "foco 1",
      "foco 2",
      "foco 3",
      "foco 4",
      "foco 5",
    ]);
  });

  it("returns fewer than 5 rungs rather than padding when the model gives fewer", async () => {
    createSpy.mockResolvedValueOnce(modelReply({ wordType: "noun", lines: ladder(3) }));
    const api = await client();
    const r = await post(api);

    expect(r.body.ok).toBe(true);
    expect(r.body.wordType).toBe("noun");
    expect(r.body.lines.length).toBe(3);
    expect(r.body).not.toHaveProperty("reason");
  });

  it("drops malformed rungs and keeps the good ones, capping the survivors at 5", async () => {
    createSpy.mockResolvedValueOnce(
      modelReply({
        wordType: "verb",
        lines: [
          { text: "Bring it here.", focus: "forma base" },
          { text: "no focus here" }, // missing focus
          { focus: "sin texto" }, // missing text
          { text: 42, focus: "numero" }, // text not a string
          { text: "She brings lunch.", focus: 7 }, // focus not a string
          "just a string", // not an object
          null,
          ["text", "focus"], // an array is not a rung
          { text: "   ", focus: "vacio" }, // whitespace-only text
          { text: "He brought it.", focus: "pasado" },
          { text: "They are bringing it.", focus: "progresivo" },
          { text: "I have brought it.", focus: "perfecto" },
          { text: "Bring it when you can.", focus: "subordinada" },
          { text: "One rung too many.", focus: "extra" },
        ],
      })
    );
    const api = await client();
    const r = await post(api);

    expect(r.body.ok).toBe(true);
    // 6 well-formed rungs survived the filter; the cap keeps the first 5.
    expect(r.body.lines.length).toBe(5);
    expect(r.body.lines.map((l) => l.focus)).toEqual([
      "forma base",
      "pasado",
      "progresivo",
      "perfecto",
      "subordinada",
    ]);
  });

  it("a ladder too thin to climb degrades (fewer than 2 usable rungs)", async () => {
    createSpy.mockResolvedValueOnce(
      modelReply({
        wordType: "verb",
        lines: [{ text: "Bring it here.", focus: "forma base" }, { text: "no focus" }, null],
      })
    );
    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, wordType: "other", lines: [], reason: "bad_model_json" });
  });

  it("lines that are not an array degrade to the empty shape", async () => {
    createSpy.mockResolvedValueOnce(modelReply({ wordType: "verb", lines: "Bring it here." }));
    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, wordType: "other", lines: [], reason: "bad_model_json" });
  });

  it("an unknown wordType normalises to other without losing the ladder", async () => {
    createSpy.mockResolvedValueOnce(modelReply({ wordType: "gerundive", lines: ladder(5) }));
    const api = await client();
    const r = await post(api);

    expect(r.body.ok).toBe(true);
    expect(r.body.wordType).toBe("other");
    expect(r.body.lines.length).toBe(5);
  });

  it("a missing wordType normalises to other without losing the ladder", async () => {
    createSpy.mockResolvedValueOnce(modelReply({ lines: ladder(5) }));
    const api = await client();
    const r = await post(api);

    expect(r.body.wordType).toBe("other");
    expect(r.body.lines.length).toBe(5);
  });

  it("determinism: the same word returns the same ladder", async () => {
    const api = await client();
    const r1 = await post(api);
    const r2 = await post(api);

    expect(r1.body.lines).toEqual(r2.body.lines);
    // Temperature 0 is the determinism knob (a drill that changes every visit is
    // not a drill).
    expect(createSpy.mock.calls[0][0].temperature).toBe(0);
    expect(createSpy.mock.calls[1][0].temperature).toBe(0);
  });

  it("a malformed model response degrades gracefully (reason bad_model_json)", async () => {
    createSpy.mockResolvedValueOnce({
      choices: [{ message: { content: "this is not json at all {" } }],
    });
    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, wordType: "other", lines: [], reason: "bad_model_json" });
  });

  it("repairs slightly-broken model JSON (jsonrepair) and still returns a ladder", async () => {
    // Trailing comma -> JSON.parse fails, jsonrepair rescues it.
    createSpy.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content:
              '{"wordType": "verb", "lines": [{"text": "Bring it here.", "focus": "base"}, {"text": "She brings lunch.", "focus": "tercera persona"},]}',
          },
        },
      ],
    });
    const api = await client();
    const r = await post(api);

    expect(r.body.ok).toBe(true);
    expect(r.body.wordType).toBe("verb");
    expect(r.body.lines.length).toBe(2);
  });

  it("a missing word degrades gracefully (reason no_word, no model call)", async () => {
    const api = await client();
    const r = await post(api, { word: "" });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, wordType: "other", lines: [], reason: "no_word" });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("a whitespace-only word degrades gracefully (reason no_word, no model call)", async () => {
    const api = await client();
    const r = await post(api, { word: "   " });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, wordType: "other", lines: [], reason: "no_word" });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("a missing OPENAI_API_KEY degrades gracefully (reason init_error, never a 500)", async () => {
    // The openai v4 constructor throws synchronously on a missing key; the route
    // must catch that inside its init guard and degrade, never surfacing a 500.
    delete process.env.OPENAI_API_KEY;
    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.status).not.toBe(500);
    expect(r.body).toEqual({ ok: true, wordType: "other", lines: [], reason: "init_error" });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("a model-call failure degrades gracefully (reason model_failed)", async () => {
    createSpy.mockRejectedValueOnce(new Error("openai exploded"));
    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, wordType: "other", lines: [], reason: "model_failed" });
  });

  it("every degradation path returns the same empty shape", async () => {
    const api = await client();

    const cases = [
      [
        "no_word",
        async () => post(api, { word: "" }),
      ],
      [
        "model_failed",
        async () => {
          createSpy.mockRejectedValueOnce(new Error("boom"));
          return post(api);
        },
      ],
      [
        "bad_model_json",
        async () => {
          createSpy.mockResolvedValueOnce({ choices: [{ message: { content: "nope {" } }] });
          return post(api);
        },
      ],
    ];

    for (const [reason, run] of cases) {
      const r = await run();
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, wordType: "other", lines: [], reason });
    }
  });

  it("enforces the admin gate (401 without token, no model call)", async () => {
    const api = await client();
    const r = await post(api, {}, /* withToken */ false);

    expect(r.status).toBe(401);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

// `depth` 2 is the learner asking for a harder set of the SAME word. It must reach
// the model (both as a prompt block and in the payload), must not change the type
// shape, and must not cost a second model call.
describe("practice-pod depth contract", () => {
  it("absent depth takes the depth-1 path: base prompt only", async () => {
    const api = await client();
    const r = await post(api); // no depth key at all

    expect(r.status).toBe(200);
    expect(systemPromptOf(0)).not.toContain("DEPTH: 2");
    expect(userPayloadOf(0).depth).toBe(1);
  });

  it("depth 2 extends the prompt with the harder-set rules, in ONE model call", async () => {
    const api = await client();
    await post(api); // call 0: depth 1
    await post(api, { depth: 2 }); // call 1: depth 2

    // The depth-2 prompt is a superset: same type shapes, extra difficulty rules.
    expect(systemPromptOf(1)).not.toBe(systemPromptOf(0));
    expect(systemPromptOf(1)).toContain(systemPromptOf(0));
    expect(systemPromptOf(1)).toContain("DEPTH: 2");
    expect(systemPromptOf(1)).toContain("Keep the same wordType and the same type shape");
    expect(systemPromptOf(1)).toContain("subordinate clause");
    // Different sentences, not the depth-1 ladder with words bolted on.
    expect(systemPromptOf(1)).toContain("DIFFERENT sentences from the basic ladder");

    // The depth reaches the model in the payload too.
    expect(userPayloadOf(1).depth).toBe(2);

    // One call per request — depth must not add a second one.
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it("depth 2 returns the same contract shape as depth 1", async () => {
    const api = await client();
    const r = await post(api, { depth: 2 });

    expect(r.body.ok).toBe(true);
    expect(r.body.wordType).toBe("verb");
    expect(r.body.lines.length).toBe(5);
    for (const line of r.body.lines) {
      expect(Object.keys(line).sort()).toEqual(["focus", "text"]);
    }
  });

  it("an out-of-range or junk depth falls back to depth 1", async () => {
    const api = await client();
    await post(api, { depth: 3 }); // call 0
    await post(api, { depth: "banana" }); // call 1
    await post(api, { depth: 0 }); // call 2

    for (const n of [0, 1, 2]) {
      expect(systemPromptOf(n)).not.toContain("DEPTH: 2");
      expect(userPayloadOf(n).depth).toBe(1);
    }
  });

  it('depth "2" as a string is honoured (form fields arrive as strings)', async () => {
    const api = await client();
    await post(api, { depth: "2" });

    expect(systemPromptOf(0)).toContain("DEPTH: 2");
    expect(userPayloadOf(0).depth).toBe(2);
  });

  it("depth 2 still degrades gracefully on a bad model response", async () => {
    createSpy.mockResolvedValueOnce({ choices: [{ message: { content: "not json" } }] });
    const api = await client();
    const r = await post(api, { depth: 2 });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, wordType: "other", lines: [], reason: "bad_model_json" });
  });
});

// The prompt carries the three things that make a ladder teachable: the language
// the lines are written in, the level they are pitched at, and the language the
// `focus` captions are written in (the learner's L1 when that is useful).
describe("practice-pod prompt contract", () => {
  it("the focus captions are written in the learner's L1 when it differs from lang", async () => {
    const api = await client();
    await post(api, { lang: "en", l1: "es" });

    expect(userPayloadOf(0).focusLanguage).toBe("Spanish");
    expect(userPayloadOf(0).language).toBe("English");
    expect(systemPromptOf(0)).toContain("Spanish. This is a caption for the app UI");
  });

  it("the focus captions fall back to the target language when l1 matches or is absent", async () => {
    const api = await client();
    await post(api, { lang: "es", l1: "es" }); // call 0: same language
    await post(api, { lang: "en", l1: "" }); // call 1: no l1
    await post(api, { lang: "en", l1: "universal" }); // call 2: unknown l1

    expect(userPayloadOf(0).focusLanguage).toBe("Spanish");
    expect(userPayloadOf(0).language).toBe("Spanish");
    expect(userPayloadOf(1).focusLanguage).toBe("English");
    expect(userPayloadOf(2).focusLanguage).toBe("English");
  });

  it("an unlisted l1 code is passed through as the focus language", async () => {
    const api = await client();
    await post(api, { lang: "en", l1: "ja" });

    expect(userPayloadOf(0).focusLanguage).toBe("ja");
  });

  it("the CEFR level reaches the prompt, defaulting to B1 when absent or junk", async () => {
    const api = await client();
    await post(api, { level: "A2" }); // call 0
    await post(api, { level: "" }); // call 1
    await post(api, { level: "wizard" }); // call 2
    await post(api, { level: "c1" }); // call 3: lowercase is normalised

    expect(userPayloadOf(0).level).toBe("A2");
    expect(systemPromptOf(0)).toContain("CEFR A2. Real speech");
    expect(userPayloadOf(1).level).toBe("B1");
    expect(userPayloadOf(2).level).toBe("B1");
    expect(userPayloadOf(3).level).toBe("C1");
  });

  it("the type-shaped ladder rules are all present in the prompt", async () => {
    const api = await client();
    await post(api);

    const sys = systemPromptOf(0);
    // The closed wordType set the frontend switches on.
    expect(sys).toContain('"verb" | "noun" | "adjective" | "phrase" | "other"');
    // Exactly five rungs, ordered easiest to hardest, each containing the word.
    expect(sys).toContain("EXACTLY 5 objects");
    expect(sys).toContain("easiest to hardest");
    expect(sys).toContain("inflected form of it");
    // One rule per type.
    expect(sys).toContain("base form, third person, past, progressive, perfect");
    expect(sys).toContain("singular, plural");
    expect(sys).toContain("attributive, then predicative, then comparative");
    expect(sys).toContain("chunk-to-whole build-up");
    // The focus label is UI metadata, not practice material.
    expect(sys).toContain("not practice material");
  });

  it("a Spanish request gets the Spanish-specific register and agreement rules", async () => {
    const api = await client();
    await post(api, { word: "traer", lang: "es", l1: "en" });

    const sys = systemPromptOf(0);
    expect(userPayloadOf(0).language).toBe("Spanish");
    expect(userPayloadOf(0).focusLanguage).toBe("English");
    // tú-register for verbs, gender/number agreement for adjectives.
    expect(sys).toContain("tú, not usted");
    expect(sys).toContain("gender and number agreement");
  });
});
