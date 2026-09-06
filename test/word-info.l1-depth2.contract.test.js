// test/word-info.l1-depth2.contract.test.js
// Contract test for the two Word Motor card additions on
// /api/router?route=word-info:
//
//   1. The FIRST-PAINT L1 BLOCK (card v5). When the learner's L1 is one of the
//      two languages this route can write in (en|es) and differs from the
//      language being taught, the ordinary depth-1 card also carries
//      card.l1 = { translation, definitionL1, sentenceL1 } — so the card renders
//      the whole "In this sentence" zone in the learner's language with no
//      second round trip and no button.
//
//      v4 added pronunciation { syllables, l1Tip } and the cognate flag. v5 makes
//      the bottom line a translation of the REAL sentence the client sent, and
//      drops depth 1's generated `example` entirely (depth 2 still has one) —
//      the card was showing an invented sentence beside the bubble the learner
//      was actually reading.
//
//   2. DEPTH 2 ("Show me more examples"), the card's one optional expansion.
//      Round 2 makes it a TWO-COLUMN block, so every field is a pair:
//      { definitionFull, definitionFullL1, synonyms[], synonymsL1[],
//        example:{en,l1} } — one example, not two. It follows the
//      house degradation contract (practice-pod's): ALWAYS 200, never throw,
//      with a `reason` code naming what went wrong — and it never writes a
//      word_taps row, because the tap that opened the card already logged one.
//
// Hermetic, mirroring practice-pod.contract.test.js: OpenAI and Supabase are both
// mocked, so no network and no database is ever reached.
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

const { createSpy, insertSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  insertSpy: vi.fn(() => Promise.resolve({ error: null })),
}));

vi.mock("openai", () => ({
  OpenAI: class {
    constructor(opts) {
      // The real openai v4 constructor throws synchronously on a missing key.
      // Mirroring that is what makes the init-error degradation path testable.
      if (!opts || !opts.apiKey) {
        throw new Error("The OPENAI_API_KEY environment variable is missing or empty");
      }
      this.chat = { completions: { create: createSpy } };
    }
  },
}));

// Cache always MISSES here, so every depth-1 call reaches the model and we are
// asserting on a freshly composed card rather than a fixture.
vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: () => ({
    from(table) {
      if (table === "word_taps") return { insert: insertSpy };
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: null }),
        upsert: () => ({ then: () => ({ catch: () => {} }) }),
      };
      return chain;
    },
  }),
}));

function modelReply(obj) {
  return { choices: [{ message: { content: JSON.stringify(obj) } }] };
}

// A complete v4 depth-1 answer.
const FULL_CARD = {
  unit: "merge",
  pos: "verb",
  ipa: "mɜːrdʒ",
  def: "to join together into one thing",
  l1Translation: "fusionarse",
  cefr: "B2",
  freq: "common",
  collocations: ["merge with"],
  trap: "",
  definitionL1: "Unirse para formar una sola cosa.",
  sentenceL1: "Los dos ríos se fusionan cerca del puente.",
  syllables: "MERGE",
  l1Tip: "The final ge is a soft j sound, not a hard g.",
  cognate: false,
};

// A complete depth-2 answer.
const FULL_MORE = {
  definitionFull: "To come together and become one. Used for roads, rivers and companies.",
  definitionFullL1: "Unirse y convertirse en uno. Se usa para caminos, ríos y empresas.",
  synonyms: ["combine", "join", "blend"],
  // Synonyms of the SPANISH equivalent, not translations of the English list.
  synonymsL1: ["unir", "juntar", "fusionar"],
  example: { en: "The two lanes merge ahead.", l1: "Los dos carriles se fusionan más adelante." },
};

beforeEach(() => {
  vi.resetModules();
  createSpy.mockClear();
  insertSpy.mockClear();
  createSpy.mockResolvedValue(modelReply(FULL_CARD));
  process.env.ADMIN_TOKEN = "test_admin_token";
  process.env.OPENAI_API_KEY = "test_openai_key";
});

async function client() {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  return request(mkServer(handler));
}

function post(api, bodyOverrides = {}, withToken = true) {
  const req = api.post("/api/router?route=word-info");
  if (withToken) req.set("x-admin-token", "test_admin_token");
  return req.send({
    word: "merge",
    sentence: "Two rivers merge here.",
    lang: "en",
    l1: "es",
    level: "B1",
    uid: "u-1",
    surface: "convo-ai",
    ...bodyOverrides,
  });
}

const systemPromptOf = (n) => createSpy.mock.calls[n][0].messages[0].content;

// ── 1) The first-paint L1 block (card v4) ───────────────────────────────────

describe("word-info depth 1 — the first-paint L1 block", () => {
  it("carries card.l1 with the translation, definition and translated example", async () => {
    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.card).toMatchObject({
      unit: "merge",
      def: "to join together into one thing",
      l1Translation: "fusionarse",
      v: 5,
      l1: {
        translation: "fusionarse",
        definitionL1: "Unirse para formar una sola cosa.",
        sentenceL1: "Los dos ríos se fusionan cerca del puente.",
      },
    });
  });

  it("bumps the card version to 5 so stale v4 cache rows cannot serve the old shape", async () => {
    const api = await client();
    const r = await post(api);
    expect(r.body.card.v).toBe(5);
  });

  it("translates the REAL sentence the client sent, and invents nothing", async () => {
    const api = await client();
    const r = await post(api);
    // Round 3 item 4: the card used to show a model-written example next to a
    // translation of that invented example, while the bubble the learner was
    // reading said something else. sentenceL1 translates what was actually sent.
    expect(r.body.card.l1.sentenceL1).toBe("Los dos ríos se fusionan cerca del puente.");
    // Depth 1 no longer generates an example at all — depth 2 owns those.
    expect(r.body.card.example).toBeUndefined();

    const prompt = systemPromptOf(0);
    expect(prompt).toContain('"sentenceL1"');
    expect(prompt).toContain("Spanish");
    expect(prompt).toMatch(/the GIVEN sentence/);
    expect(prompt).toMatch(/Do NOT write a new or better\s+sentence/);
    expect(prompt).toMatch(/do NOT gloss only the word/);
    // The generated-example rule is gone from depth 1 with the field it governed.
    expect(prompt).not.toContain("Do not reuse the given sentence");
  });

  it("inverts with the pack: an English L1 under the Spanish pack asks for English", async () => {
    const api = await client();
    const r = await post(api, {
      lang: "es",
      l1: "en",
      sentence: "Los dos ríos se fusionan.",
    });
    expect(systemPromptOf(0)).toContain('the SAME meaning as "def", written in English');
    expect(r.body.card.l1).not.toBeNull();
  });

  it("gives an L1 the route cannot write in the translation ALONE (card.l1 is null)", async () => {
    const api = await client();
    const r = await post(api, { l1: "fr" });

    expect(r.status).toBe(200);
    expect(r.body.card.l1).toBeNull();
    // The single-word translation it has always had is untouched.
    expect(r.body.card.l1Translation).toBe("fusionarse");
    // And the model is told to leave the two new fields empty rather than
    // answering them in the wrong language.
    expect(systemPromptOf(0)).toContain('- "definitionL1": empty string ""');
  });

  it("gives a universal L1 no block and no translation", async () => {
    const api = await client();
    const r = await post(api, { l1: "universal" });
    expect(r.body.card.l1).toBeNull();
    expect(r.body.card.l1Translation).toBe("");
  });

  it("gives no block when the L1 IS the language being taught", async () => {
    const api = await client();
    const r = await post(api, { lang: "en", l1: "en" });
    // Nothing to translate into: the two would be the same language.
    expect(r.body.card.l1).toBeNull();
  });

  it("length-caps the block's fields", async () => {
    const api = await client();
    createSpy.mockResolvedValueOnce(
      modelReply({ ...FULL_CARD, definitionL1: "x".repeat(500), sentenceL1: "y".repeat(500) })
    );
    const r = await post(api);
    expect(r.body.card.l1.definitionL1.length).toBe(160);
    // A real sentence is longer than a definition, so its cap is looser (400).
    expect(r.body.card.l1.sentenceL1.length).toBe(400);
  });

  it("still 502s an empty card, so depth 1's failure contract is unchanged", async () => {
    const api = await client();
    createSpy.mockResolvedValueOnce(modelReply({ ...FULL_CARD, def: "" }));
    const r = await post(api);
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, error: "empty_card" });
  });

  it("holds the first-paint definition to one short clause by instruction", async () => {
    const api = await client();
    await post(api);
    const prompt = systemPromptOf(0);
    // Round 2: it came out short by luck before; the prompt now says so.
    expect(prompt).toContain("HARD LIMIT 12 WORDS");
    expect(prompt).toMatch(/One clause only/);
    expect(prompt).toMatch(/Do NOT put an example/);
  });

  it("asks for the translation as a WORD, not as a definition", async () => {
    const api = await client();
    await post(api);
    // A carry-over bug this round: the model was answering l1Translation with a
    // whole definition, so the card printed the same sentence twice.
    expect(systemPromptOf(0)).toMatch(/NOT a definition and NOT an\s+explanation/);
  });
});

// ── 1b) v4: pronunciation + the cognate flag ────────────────────────────────

describe("word-info depth 1 — pronunciation and cognate (v4)", () => {
  it("returns the syllable split and the L1-specific tip", async () => {
    const api = await client();
    const r = await post(api);
    expect(r.body.card.pronunciation).toEqual({
      syllables: "MERGE",
      l1Tip: "The final ge is a soft j sound, not a hard g.",
    });
  });

  it("asks the model for a stressed-syllable split and ONE L1 trap", async () => {
    const api = await client();
    await post(api);
    const prompt = systemPromptOf(0);
    expect(prompt).toContain('"syllables"');
    expect(prompt).toContain("ar·RANGE");
    expect(prompt).toMatch(/SINGLE most likely\s+pronunciation trap/);
    expect(prompt).toContain("Spanish");
  });

  it("nulls l1Tip when there is no L1 to be specific about", async () => {
    const api = await client();
    // universal: nothing L1-specific can be said, so the card hides the line
    // rather than printing an empty one.
    const uni = await post(api, { l1: "universal" });
    expect(uni.body.card.pronunciation.l1Tip).toBeNull();
    // …and the syllable split still stands, because that is not L1-specific.
    expect(uni.body.card.pronunciation.syllables).toBe("MERGE");

    const fr = await post(api, { l1: "fr" });
    expect(fr.body.card.pronunciation.l1Tip).toBeNull();
  });

  it("falls back to the unit when the model returns no syllable split", async () => {
    const api = await client();
    createSpy.mockResolvedValueOnce(modelReply({ ...FULL_CARD, syllables: "" }));
    const r = await post(api);
    expect(r.body.card.pronunciation.syllables).toBe("merge");
  });

  it("strips characters that do not belong in a syllable split", async () => {
    const api = await client();
    // Digits and brackets are not part of a syllable split, and stripping them
    // must not leave the whitespace that surrounded them behind.
    createSpy.mockResolvedValueOnce(modelReply({ ...FULL_CARD, syllables: "ar·RANGE (stress 2)" }));
    const r = await post(api);
    expect(r.body.card.pronunciation.syllables).toBe("ar·RANGE stress");
  });

  it("carries cognate:true straight through, and demands form AND meaning", async () => {
    const api = await client();
    createSpy.mockResolvedValueOnce(modelReply({ ...FULL_CARD, cognate: true }));
    const r = await post(api);
    expect(r.body.card.cognate).toBe(true);
    expect(systemPromptOf(0)).toMatch(/shares BOTH form and meaning/);
    // A false friend is explicitly NOT a cognate — that is the trap line's job.
    expect(systemPromptOf(0)).toMatch(/false for false\s+friends/);
  });

  it("is always false for an L1 the route cannot compare against", async () => {
    const api = await client();
    createSpy.mockResolvedValue(modelReply({ ...FULL_CARD, cognate: true }));
    expect((await post(api, { l1: "universal" })).body.card.cognate).toBe(false);
    expect((await post(api, { l1: "fr" })).body.card.cognate).toBe(false);
    expect((await post(api, { lang: "en", l1: "en" })).body.card.cognate).toBe(false);
  });

  it("coerces a non-boolean cognate to false rather than passing it on", async () => {
    const api = await client();
    createSpy.mockResolvedValueOnce(modelReply({ ...FULL_CARD, cognate: "yes" }));
    const r = await post(api);
    expect(r.body.card.cognate).toBe(false);
  });
});

// ── 2) Depth 2 — "Show me more examples" ────────────────────────────────────

describe("word-info depth 2 — more examples", () => {
  beforeEach(() => {
    createSpy.mockResolvedValue(modelReply(FULL_MORE));
  });

  it("returns both columns: paired definitions, paired synonyms, one example", async () => {
    const api = await client();
    const r = await post(api, { depth: 2 });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      depth: 2,
      definitionFull: FULL_MORE.definitionFull,
      definitionFullL1: FULL_MORE.definitionFullL1,
      synonyms: ["combine", "join", "blend"],
      synonymsL1: ["unir", "juntar", "fusionar"],
    });
    // ONE example now, not two: two pairs of two columns is four cells of prose.
    expect(r.body.example).toEqual({
      en: "The two lanes merge ahead.",
      l1: "Los dos carriles se fusionan más adelante.",
    });
    expect(r.body.examples).toBeUndefined();
    expect(r.body.reason).toBeUndefined();
  });

  it("asks for synonymsL1 as synonyms OF THE EQUIVALENT, not translations", async () => {
    const api = await client();
    await post(api, { depth: 2 });
    const prompt = systemPromptOf(0);
    expect(prompt).toMatch(/NOT translations of the "synonyms" list/);
    // The prompt carries the worked example the card was specified against.
    expect(prompt).toContain("proyecto");
    expect(prompt).toContain("programa");
  });

  it("writes NO word_taps row — the tap that opened the card already logged one", async () => {
    const api = await client();
    await post(api, { depth: 2 });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("a depth-1 call to the same word DOES still log its tap", async () => {
    const api = await client();
    createSpy.mockResolvedValueOnce(modelReply(FULL_CARD));
    await post(api);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy.mock.calls[0][0]).toMatchObject({ word: "merge", surface: "convo-ai" });
  });

  it("caps BOTH synonym lists at 4 and drops junk entries", async () => {
    const api = await client();
    createSpy.mockResolvedValueOnce(
      modelReply({
        definitionFull: "A fuller definition.",
        definitionFullL1: "Una definición más completa.",
        synonyms: ["one", "two", "three", "four", "five", "a phrase that is far too long to be a synonym", ""],
        synonymsL1: ["uno", "dos", "tres", "cuatro", "cinco"],
        example: { en: "First kept sentence.", l1: "Primera." },
      })
    );
    const r = await post(api, { depth: 2 });

    expect(r.body.synonyms).toEqual(["one", "two", "three", "four"]);
    expect(r.body.synonymsL1).toEqual(["uno", "dos", "tres", "cuatro"]);
    expect(r.body.example).toEqual({ en: "First kept sentence.", l1: "Primera." });
  });

  it("drops the example entirely when the target sentence is missing", async () => {
    const api = await client();
    createSpy.mockResolvedValueOnce(
      modelReply({ ...FULL_MORE, example: { en: "", l1: "una traducción huérfana" } })
    );
    const r = await post(api, { depth: 2 });
    // An L1 sentence with nothing to sit beside is half a row, so it is dropped.
    expect(r.body.example).toEqual({ en: "", l1: "" });
  });

  it("blanks the whole L1 column when there is no L1 the route can write in", async () => {
    const api = await client();
    const r = await post(api, { depth: 2, l1: "fr" });
    expect(r.body.example.l1).toBe("");
    expect(r.body.definitionFullL1).toBe("");
    expect(r.body.synonymsL1).toEqual([]);
    // …and the prompt asked for it that way rather than for French.
    expect(systemPromptOf(0)).toContain('"l1": ""');
  });

  it("asks for the pairs in the learner's language when it can write in it", async () => {
    const api = await client();
    await post(api, { depth: 2 });
    expect(systemPromptOf(0)).toContain("that SAME sentence in Spanish");
  });

  it("degrades to 200 + reason model_failed when the model call throws", async () => {
    const api = await client();
    createSpy.mockRejectedValueOnce(new Error("openai exploded"));
    const r = await post(api, { depth: 2 });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      depth: 2,
      definitionFull: "",
      definitionFullL1: "",
      synonyms: [],
      synonymsL1: [],
      example: { en: "", l1: "" },
      reason: "model_failed",
    });
  });

  it("degrades to 200 + reason bad_model_json when the answer cannot be repaired", async () => {
    const api = await client();
    createSpy.mockResolvedValueOnce({ choices: [{ message: { content: "not json at all {{{" } }] });
    const r = await post(api, { depth: 2 });
    expect(r.status).toBe(200);
    expect(r.body.reason).toBe("bad_model_json");
    expect(r.body.example).toEqual({ en: "", l1: "" });
    expect(r.body.synonymsL1).toEqual([]);
  });

  it("degrades to 200 + reason init_error when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const api = await client();
    const r = await post(api, { depth: 2 });
    expect(r.status).toBe(200);
    expect(r.body.reason).toBe("init_error");
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("degrades to 200 + reason empty_more when the model returns nothing usable", async () => {
    const api = await client();
    createSpy.mockResolvedValueOnce(modelReply({ definitionFull: "", synonyms: [], examples: [] }));
    const r = await post(api, { depth: 2 });
    expect(r.status).toBe(200);
    expect(r.body.reason).toBe("empty_more");
  });

  it("still enforces the admin gate (401, no model call)", async () => {
    const api = await client();
    const r = await post(api, { depth: 2 }, false);
    expect(r.status).toBe(401);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("still 400s a depth-2 call with no word", async () => {
    const api = await client();
    const r = await post(api, { depth: 2, word: "" });
    expect(r.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });
});
