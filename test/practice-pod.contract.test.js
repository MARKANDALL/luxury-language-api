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

// The exact shape the drawer degrades to. The two off-language fields ride along
// on every failure as well, so the frontend reads them unconditionally on EVERY
// response: nothing was translated, so `offLanguage` is false and the practice
// word is whatever the learner sent. Default "bring" matches post()'s default body.
const emptyShape = (reason, practiceWord = "bring") => ({
  ok: true,
  wordType: "other",
  offLanguage: false,
  practiceWord,
  lines: [],
  reason,
});

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
    expect(r.body).toEqual(emptyShape("bad_model_json"));
  });

  it("lines that are not an array degrade to the empty shape", async () => {
    createSpy.mockResolvedValueOnce(modelReply({ wordType: "verb", lines: "Bring it here." }));
    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.body).toEqual(emptyShape("bad_model_json"));
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
    expect(r.body).toEqual(emptyShape("bad_model_json"));
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
    // No word came in, so there is no practice word to echo back — an empty
    // string, never undefined and never a stray default.
    expect(r.body).toEqual(emptyShape("no_word", ""));
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("a whitespace-only word degrades gracefully (reason no_word, no model call)", async () => {
    const api = await client();
    const r = await post(api, { word: "   " });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject(emptyShape("no_word", ""));
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
    expect(r.body).toEqual(emptyShape("init_error"));
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("a model-call failure degrades gracefully (reason model_failed)", async () => {
    createSpy.mockRejectedValueOnce(new Error("openai exploded"));
    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.body).toEqual(emptyShape("model_failed"));
  });

  it("every degradation path returns the same empty shape", async () => {
    const api = await client();

    // [reason, the practice word the failure should echo back, how to trigger it]
    const cases = [
      [
        "no_word",
        "",
        async () => post(api, { word: "" }),
      ],
      [
        "model_failed",
        "bring",
        async () => {
          createSpy.mockRejectedValueOnce(new Error("boom"));
          return post(api);
        },
      ],
      [
        "bad_model_json",
        "bring",
        async () => {
          createSpy.mockResolvedValueOnce({ choices: [{ message: { content: "nope {" } }] });
          return post(api);
        },
      ],
    ];

    for (const [reason, practiceWord, run] of cases) {
      const r = await run();
      expect(r.status).toBe(200);
      expect(r.body).toEqual(emptyShape(reason, practiceWord));
      // The frontend reads these two on every response, so neither may be missing
      // from a failure — and a failure translated nothing, so the flag is false.
      expect(r.body.offLanguage).toBe(false);
      expect(r.body.offLanguage).not.toBeUndefined();
      expect(typeof r.body.practiceWord).toBe("string");
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
    expect(r.body).toEqual(emptyShape("bad_model_json"));
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

// Off-language saves. Found in production 2026-07-26: a Spanish speaker learning
// English (lang "en", l1 "es") saved the Spanish adjective "redondeada" and got a
// structurally perfect ladder in English frames with the Spanish word jammed
// inside — "The table is redondeada." — which is neither English practice nor
// Spanish practice. The route now asks whether the saved word is actually in the
// target language and, when it is not, practises the translation instead. The two
// fields the frontend reads for this (`offLanguage`, `practiceWord`) are on EVERY
// response, success or degradation, so it never has to branch on their presence.
describe("practice-pod off-language contract", () => {
  // A ladder whose rungs are built around `w`, so a test can prove which word the
  // lines actually practise.
  function ladderOn(w, n = 5) {
    const lines = [];
    for (let i = 1; i <= n; i++) {
      lines.push({ text: `The table is ${w} ${i}.`, focus: `foco ${i}` });
    }
    return lines;
  }

  it("an in-language word is not flagged and practises itself", async () => {
    createSpy.mockResolvedValueOnce(
      modelReply({ offLanguage: false, practiceWord: "bring", wordType: "verb", lines: ladder(5) })
    );
    const api = await client();
    const r = await post(api, { word: "bring", lang: "en", l1: "es" });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.offLanguage).toBe(false);
    // The normal case: practiceWord IS the input word, so the frontend can read
    // one field unconditionally instead of falling back to `word` itself.
    expect(r.body.practiceWord).toBe("bring");
    expect(r.body.wordType).toBe("verb");
    expect(r.body.lines.length).toBe(5);
  });

  it("the production case: a Spanish word on the English side is translated and the ladder practises the translation", async () => {
    createSpy.mockResolvedValueOnce(
      modelReply({
        offLanguage: true,
        practiceWord: "rounded",
        wordType: "adjective",
        lines: ladderOn("rounded"),
      })
    );
    const api = await client();
    const r = await post(api, { word: "redondeada", lang: "en", l1: "es" });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.offLanguage).toBe(true);
    expect(r.body.practiceWord).toBe("rounded");
    // Classification follows the translation: "redondeada" and "rounded" are both
    // adjectives here, but it is the English word's part of speech the ladder needs.
    expect(r.body.wordType).toBe("adjective");

    // The whole point of the fix: the lines practise the ENGLISH word, and the
    // Spanish original appears in none of them. "The table is redondeada." was the
    // production bug verbatim.
    expect(r.body.lines.length).toBe(5);
    for (const line of r.body.lines) {
      expect(line.text).toContain("rounded");
      expect(line.text).not.toContain("redondeada");
    }
  });

  it("a cognate is treated as in-language, not translated", async () => {
    // hospital / animal / real / natural are valid in both languages. Flagging one
    // off-language would translate a word that needed no translating.
    for (const w of ["hospital", "animal", "real", "natural"]) {
      createSpy.mockResolvedValueOnce(
        modelReply({ offLanguage: false, practiceWord: w, wordType: "noun", lines: ladderOn(w) })
      );
      const api = await client();
      const r = await post(api, { word: w, lang: "en", l1: "es" });

      expect(r.body.offLanguage).toBe(false);
      expect(r.body.practiceWord).toBe(w);
      expect(r.body.lines.length).toBe(5);
    }
  });

  it("a proper noun passes through unchanged", async () => {
    createSpy.mockResolvedValueOnce(
      modelReply({
        offLanguage: false,
        practiceWord: "Barcelona",
        wordType: "noun",
        lines: ladderOn("Barcelona"),
      })
    );
    const api = await client();
    const r = await post(api, { word: "Barcelona", lang: "en", l1: "es" });

    expect(r.body.offLanguage).toBe(false);
    expect(r.body.practiceWord).toBe("Barcelona");
  });

  it("works in the other direction too: an English word saved on the Spanish side", async () => {
    createSpy.mockResolvedValueOnce(
      modelReply({
        offLanguage: true,
        practiceWord: "estante",
        wordType: "noun",
        lines: ladderOn("estante"),
      })
    );
    const api = await client();
    const r = await post(api, { word: "shelf", lang: "es", l1: "en" });

    expect(r.body.offLanguage).toBe(true);
    expect(r.body.practiceWord).toBe("estante");
    for (const line of r.body.lines) expect(line.text).not.toContain("shelf");
  });

  it("both fields are present on every successful response, and lines keep their exact shape", async () => {
    const api = await client();
    const r = await post(api);

    expect(r.body).toHaveProperty("offLanguage");
    expect(r.body).toHaveProperty("practiceWord");
    // The rung shape is untouched by this change — still exactly { text, focus }.
    for (const line of r.body.lines) {
      expect(Object.keys(line).sort()).toEqual(["focus", "text"]);
    }
  });

  it("the degradation shape carries both new fields, echoing the input word", async () => {
    createSpy.mockRejectedValueOnce(new Error("openai exploded"));
    const api = await client();
    const r = await post(api, { word: "redondeada", lang: "en", l1: "es" });

    // A failed request translated nothing, so the flag is false and the practice
    // word is the word the learner actually sent — not a stray "" or undefined.
    expect(r.body).toEqual(emptyShape("model_failed", "redondeada"));
    expect(r.body.offLanguage).toBe(false);
    expect(r.body.practiceWord).toBe("redondeada");
  });

  it("offLanguage is never undefined in ANY returned shape", async () => {
    const api = await client();

    const shapes = [
      // Success, in-language.
      async () => post(api),
      // Success, off-language.
      async () => {
        createSpy.mockResolvedValueOnce(
          modelReply({ offLanguage: true, practiceWord: "rounded", wordType: "adjective", lines: ladder(5) })
        );
        return post(api, { word: "redondeada" });
      },
      // Success, but the model never mentioned offLanguage at all.
      async () => {
        createSpy.mockResolvedValueOnce(modelReply({ wordType: "verb", lines: ladder(5) }));
        return post(api);
      },
      // Degradation: no word.
      async () => post(api, { word: "" }),
      // Degradation: model call failed.
      async () => {
        createSpy.mockRejectedValueOnce(new Error("boom"));
        return post(api);
      },
      // Degradation: unparseable JSON.
      async () => {
        createSpy.mockResolvedValueOnce({ choices: [{ message: { content: "nope {" } }] });
        return post(api);
      },
      // Degradation: a ladder too thin to climb.
      async () => {
        createSpy.mockResolvedValueOnce(modelReply({ wordType: "verb", lines: ladder(1) }));
        return post(api);
      },
    ];

    for (const run of shapes) {
      const r = await run();
      expect(r.status).toBe(200);
      expect(r.body.offLanguage).not.toBeUndefined();
      expect(typeof r.body.offLanguage).toBe("boolean");
      expect(r.body.practiceWord).not.toBeUndefined();
      expect(typeof r.body.practiceWord).toBe("string");
    }
  });

  it("a missing or unusable practiceWord falls back to the input word, never an empty chip", async () => {
    const api = await client();

    const junk = [
      undefined, // the model never returned the key
      null,
      "", // empty string
      "   ", // whitespace only
      42, // not a string
      { word: "rounded" }, // an object
      ["rounded"], // an array
    ];

    for (const bad of junk) {
      createSpy.mockResolvedValueOnce(
        modelReply({ offLanguage: false, practiceWord: bad, wordType: "verb", lines: ladder(5) })
      );
      const r = await post(api, { word: "bring" });

      expect(r.body.practiceWord).toBe("bring");
      expect(r.body.lines.length).toBe(5); // a bad practiceWord never costs the ladder
    }
  });

  it("a practiceWord with surrounding whitespace is trimmed", async () => {
    createSpy.mockResolvedValueOnce(
      modelReply({ offLanguage: true, practiceWord: "  rounded \n", wordType: "adjective", lines: ladder(5) })
    );
    const api = await client();
    const r = await post(api, { word: "redondeada" });

    expect(r.body.practiceWord).toBe("rounded");
    expect(r.body.offLanguage).toBe(true);
  });

  it("an over-long practiceWord is capped at the same 60 chars as the input word", async () => {
    createSpy.mockResolvedValueOnce(
      modelReply({
        offLanguage: true,
        practiceWord: "x".repeat(200),
        wordType: "other",
        lines: ladder(5),
      })
    );
    const api = await client();
    const r = await post(api, { word: "redondeada" });

    expect(r.body.practiceWord.length).toBe(60);
  });

  it("a loosely-typed offLanguage is coerced, and a missing one never reads as true", async () => {
    const api = await client();

    // [what the model returned, what the route must report]
    const cases = [
      [true, true],
      ["true", true],
      ["TRUE", true],
      ["yes", true],
      ["1", true],
      [1, true],
      [false, false],
      // The trap: Boolean("false") is TRUE. A model that answers with the string
      // "false" must not flip the flag on.
      ["false", false],
      ["no", false],
      ["0", false],
      [0, false],
      [undefined, false], // the model never returned the key
      [null, false],
      ["", false],
      ["banana", false],
      [{}, false],
      [[], false],
    ];

    for (const [given, expected] of cases) {
      createSpy.mockResolvedValueOnce(
        modelReply({ offLanguage: given, practiceWord: "rounded", wordType: "verb", lines: ladder(5) })
      );
      const r = await post(api, { word: "redondeada" });

      expect(r.body.offLanguage).toBe(expected);
      expect(typeof r.body.offLanguage).toBe("boolean");
    }
  });

  it("offLanguage cannot be true unless a translation actually happened", async () => {
    const api = await client();

    // The flag promises the word WAS translated. A model that raises it while
    // handing back the original word (or nothing usable, or a bare change of case)
    // has translated nothing — reporting true would put "we translated this"
    // chrome above the untouched word.
    const liars = [
      "bring", // the original, unchanged
      "  bring  ", // the original with whitespace
      "BRING", // a bare change of case is not a translation
      undefined, // no practice word at all -> falls back to the original
      "", // ditto
    ];

    for (const claimed of liars) {
      createSpy.mockResolvedValueOnce(
        modelReply({ offLanguage: true, practiceWord: claimed, wordType: "verb", lines: ladder(5) })
      );
      const r = await post(api, { word: "bring" });

      expect(r.body.offLanguage).toBe(false);
      // The ladder still ships — a bad flag is not worth failing a good ladder over.
      expect(r.body.lines.length).toBe(5);
    }

    // ...and the flag DOES survive when the words genuinely differ.
    createSpy.mockResolvedValueOnce(
      modelReply({ offLanguage: true, practiceWord: "rounded", wordType: "verb", lines: ladder(5) })
    );
    const good = await post(api, { word: "redondeada" });
    expect(good.body.offLanguage).toBe(true);
  });

  it("an off-language word still degrades to the empty shape when the ladder is unusable", async () => {
    createSpy.mockResolvedValueOnce(
      modelReply({ offLanguage: true, practiceWord: "rounded", wordType: "adjective", lines: ladder(1) })
    );
    const api = await client();
    const r = await post(api, { word: "redondeada" });

    // Degradation always reports the INPUT word and a false flag, even when the
    // model had already decided the word was off-language: nothing shipped, so
    // there is no translation to advertise.
    expect(r.body).toEqual(emptyShape("bad_model_json", "redondeada"));
  });

  it("depth 2 carries both fields through unchanged", async () => {
    createSpy.mockResolvedValueOnce(
      modelReply({
        offLanguage: true,
        practiceWord: "rounded",
        wordType: "adjective",
        lines: ladderOn("rounded"),
      })
    );
    const api = await client();
    const r = await post(api, { word: "redondeada", depth: 2 });

    expect(r.body.offLanguage).toBe(true);
    expect(r.body.practiceWord).toBe("rounded");
    expect(r.body.lines.length).toBe(5);
    // Still ONE model call — the off-language check rides along in the same call.
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("detecting the off-language word costs no extra model call", async () => {
    createSpy.mockResolvedValueOnce(
      modelReply({ offLanguage: true, practiceWord: "rounded", wordType: "adjective", lines: ladder(5) })
    );
    const api = await client();
    await post(api, { word: "redondeada" });

    // Classification, translation and generation are ONE judgement, not three.
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});

// The off-language judgement is made by the model, so the rules that govern it
// have to actually reach the prompt: what counts as off-language, what does not
// (cognates, proper nouns), and which language the learner's own words come from.
describe("practice-pod off-language prompt contract", () => {
  it("the off-language rules and the new output keys are all in the prompt", async () => {
    const api = await client();
    await post(api, { word: "redondeada", lang: "en", l1: "es" });

    const sys = systemPromptOf(0);
    // The route asks for the flag and the practice word by name...
    expect(sys).toContain("offLanguage");
    expect(sys).toContain("practiceWord");
    // ...as part of the SAME response, not a second call.
    expect(sys).toContain('"offLanguage": false, "practiceWord": "..."');
    // Translate into the target language, one natural everyday equivalent.
    expect(sys).toContain("single most natural everyday equivalent");
    // The two judgement rules that keep it from over-firing.
    expect(sys).toContain("COGNATES AND SHARED SPELLINGS ARE NOT OFF-LANGUAGE");
    expect(sys).toContain("PROPER NOUNS ARE NOT OFF-LANGUAGE");
    // The ladder is built on the practice word, and the original is kept out of it.
    expect(sys).toContain("PRACTICE WORD itself or an inflected form of it");
    expect(sys).toContain("the saved word must not appear in the lines");
    // wordType follows the translation.
    expect(sys).toContain("Classify practiceWord, NOT the word as saved");
  });

  it("the learner's own language is named in the prompt and the payload", async () => {
    const api = await client();
    await post(api, { word: "redondeada", lang: "en", l1: "es" });

    expect(userPayloadOf(0).learnerLanguage).toBe("Spanish");
    expect(systemPromptOf(0)).toContain("The learner's own language is Spanish");
  });

  it("with no usable l1 the prompt says the source language is unknown rather than guessing", async () => {
    const api = await client();
    await post(api, { word: "redondeada", lang: "en", l1: "" }); // call 0: no l1
    await post(api, { word: "redondeada", lang: "en", l1: "universal" }); // call 1
    await post(api, { word: "bring", lang: "en", l1: "en" }); // call 2: l1 === lang

    for (const n of [0, 1, 2]) {
      expect(userPayloadOf(n).learnerLanguage).toBe(null);
      expect(systemPromptOf(n)).toContain("own language is not known here");
      // The off-language check still runs — it just cannot name a likely source.
      expect(systemPromptOf(n)).toContain("COGNATES AND SHARED SPELLINGS ARE NOT OFF-LANGUAGE");
    }
  });

  it("an unlisted l1 code is named in the prompt as given", async () => {
    const api = await client();
    await post(api, { word: "hon", lang: "en", l1: "ja" });

    expect(userPayloadOf(0).learnerLanguage).toBe("ja");
    expect(systemPromptOf(0)).toContain("The learner's own language is ja");
  });

  it("the target language is what the word is judged against, in both directions", async () => {
    const api = await client();
    await post(api, { word: "shelf", lang: "es", l1: "en" }); // call 0
    await post(api, { word: "redondeada", lang: "en", l1: "es" }); // call 1

    expect(systemPromptOf(0)).toContain("The learner is learning Spanish.");
    expect(systemPromptOf(0)).toContain("Is the WORD a word in Spanish?");
    expect(systemPromptOf(1)).toContain("The learner is learning English.");
    expect(systemPromptOf(1)).toContain("Is the WORD a word in English?");
  });

  it("depth 2 pins the off-language judgement to the depth-1 one", async () => {
    const api = await client();
    await post(api, { word: "redondeada", depth: 2 });

    // A harder ladder must be a harder ladder for the SAME practice word, or the
    // learner's second pull would silently swap the word under them.
    expect(systemPromptOf(0)).toContain("same offLanguage, same practiceWord");
  });
});
