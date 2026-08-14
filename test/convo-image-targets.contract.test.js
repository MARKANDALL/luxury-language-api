// test/convo-image-targets.contract.test.js
// Contract test for the I Spy / Veo veo target route on
// /api/router?route=convo-image-targets. Mirrors word-image.contract.test.js
// (mocked OpenAI) and word-history.contract.test.js (mocked Supabase), so it is
// hermetic: no network, no model, no database.
//
// Beyond the happy path it pins the four promises the game depends on:
//   1. ONE vision call per uncached image, and ZERO on a cache hit.
//   2. Every point lands inside the image.
//   3. Every target can support the whole hint ladder — a real ___ blank that
//      does not leak its own answer, and choices that contain the answer.
//   4. The round is deterministic: the same image always deals the same options.
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

// ── Model mock ──────────────────────────────────────────────────────────────
const { createSpy } = vi.hoisted(() => ({ createSpy: vi.fn() }));

vi.mock("openai", () => ({
  OpenAI: class {
    constructor(opts) {
      // The real openai v4 constructor throws synchronously on a missing key;
      // mirroring that is what makes the init_error degradation testable.
      if (!opts || !opts.apiKey) {
        throw new Error("The OPENAI_API_KEY environment variable is missing or empty");
      }
      this.chat = { completions: { create: createSpy } };
    }
  },
}));

// ── Crop mock ───────────────────────────────────────────────────────────────
//
// The verifier shells out to ffmpeg. These tests are hermetic, so the cut is
// mocked and the interesting thing becomes WHICH boxes were asked about.
const { cropSpy, sizeSpy } = vi.hoisted(() => ({
  cropSpy: vi.fn(),
  sizeSpy: vi.fn(),
}));
vi.mock("../lib/image-crop.js", () => ({
  cropRegion: cropSpy,
  imageSize: sizeSpy,
  // The scan drops its cached source file when it exits. Absent from this mock
  // the handler threw on every request, after the response had already gone out,
  // so the tests passed and the router logged a 500 nobody was reading.
  releaseSource: async () => {},
}));

// ── Supabase mock ───────────────────────────────────────────────────────────
// `enabled:false` simulates missing Supabase env (getSupabaseAdmin throws).
// `row` is what a cache read finds; `upserts` records every cache write.
const { sbState } = vi.hoisted(() => ({
  sbState: {
    enabled: true,
    row: null,
    upserts: [],
    readShouldThrow: false,
    readError: null,
    // Lets a test make the write settle LATER than the handler would like, which
    // is the only way to tell an awaited write from an abandoned one.
    onUpsert: null,
  },
}));

vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: () => {
    if (!sbState.enabled) throw new Error("SUPABASE_URL is required");
    return {
      from(table) {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => {
            if (sbState.readShouldThrow) throw new Error("cache read exploded");
            return { data: sbState.row, error: sbState.readError };
          },
          upsert: (payload, opts) => {
            sbState.upserts.push({ table, payload, opts });
            if (sbState.onUpsert) return sbState.onUpsert(payload);
            return Promise.resolve({ data: null, error: null });
          },
          then: (resolve, reject) => Promise.resolve({ data: null, error: null }).then(resolve, reject),
        };
        return chain;
      },
    };
  },
}));

// ── Fixtures ────────────────────────────────────────────────────────────────

const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

// A well-formed English target set, spread across the picture.
function enTargets() {
  return [
    { label: "a mug", point: { x: 0.31, y: 0.62 }, cloze: "The barista is holding ___.", choices: ["a mug", "a plate", "a kettle", "a spoon"], difficulty: "easy" },
    { label: "an apron", point: { x: 0.48, y: 0.55 }, cloze: "She is wearing ___ over her shirt.", choices: ["an apron", "a scarf", "a jacket", "a hat"], difficulty: "medium" },
    { label: "a jar", point: { x: 0.5, y: 0.78 }, cloze: "The coffee beans are kept in ___.", choices: ["a jar", "a tin", "a sack", "a crate"], difficulty: "easy" },
    { label: "a window", point: { x: 0.86, y: 0.3 }, cloze: "Light comes in through ___.", choices: ["a window", "a door", "a mirror", "a lamp"], difficulty: "easy" },
    { label: "a chalkboard", point: { x: 0.15, y: 0.22 }, cloze: "The prices are written on ___.", choices: ["a chalkboard", "a poster", "a napkin", "a receipt"], difficulty: "hard" },
    { label: "a plant", point: { x: 0.7, y: 0.68 }, cloze: "There is ___ beside the till.", choices: ["a plant", "a basket", "a stool", "a crate"], difficulty: "medium" },
  ];
}

function reply(obj) {
  return { choices: [{ message: { content: JSON.stringify(obj) } }] };
}

// The KINDS of call the route makes on the one client. Tests that care about
// how many times the model was asked to GENERATE must not be counting crop
// checks, and since v7 must not be counting the enumeration pass or the top-up
// either. Detected by a phrase unique to each prompt.
const KIND = {
  // Anchored on the opening line rather than on the question, which is reworded
  // whenever the check gains a new one. When the crop prompt grew its
  // prominence question the old phrase vanished, every crop check was routed to
  // the generation branch, and twelve tests failed for a reason that had nothing
  // to do with the route.
  crop: "a small crop taken from a larger photograph",
  relocalize: "give its bounding box",
  enumerate: "find EVERY separate instance",
  topUp: "Already taken, do NOT return any of these",
  // v8 split generation in two. LOCATE chooses the words and places them;
  // ENRICH writes the round for the ones that survived the crop check. Order
  // matters in this table: the enrich prompt also carries the band text, so it
  // is matched on a phrase only it has.
  enrich: "Someone has already chosen the words this round will teach",
};

function kindOf(req) {
  const text = JSON.stringify(req?.messages || "");
  for (const [name, phrase] of Object.entries(KIND)) if (text.includes(phrase)) return name;
  return "generate";
}

/** Every call of one kind, so a count assertion means what it says. */
function callsOf(kind) {
  return createSpy.mock.calls.filter(([req]) => kindOf(req) === kind);
}

/**
 * Install the model mock for a round whose generation returns `targets`.
 *
 * The route makes five KINDS of call on one client now: generate the set,
 * enumerate every instance of every label, crop-check one box, re-localize a
 * box that failed, and top up a set the crop check left thin. A test that
 * answered all of them with the same canned target list had its verification
 * read {"targets":[...]}, find no "shows", and drop every boxed target.
 *
 * Enumeration and top-up default to finding NOTHING, which is what keeps the
 * other eighty tests about what they were about: with no instances found the
 * route falls back to the boxes generation gave it, and with no extra targets
 * the set is whatever survived. Tests that exercise those two pass opts.
 */
function mockRound(targets, opts = {}) {
  createSpy.mockImplementation((req) => {
    const text = JSON.stringify(req?.messages || "");
    switch (kindOf(req)) {
      case "crop": {
        const shows = typeof opts.shows === "function" ? opts.shows(text) : opts.shows !== false;
        if (!shows) return Promise.resolve(reply({ shows: false, why: "not in crop" }));
        const prom =
          typeof opts.prominence === "function" ? opts.prominence(text) : opts.prominence || "main";
        return Promise.resolve(reply({ shows: true, prominence: prom }));
      }
      case "relocalize":
        return Promise.resolve(reply(opts.relocalized ?? { box: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 } }));
      case "enumerate":
        return Promise.resolve(reply({ items: opts.instances ?? [] }));
      case "topUp":
        return Promise.resolve(modelReply(opts.topUp ?? []));
      case "enrich": {
        // Answered from the SAME fixture the locate call is answered from, so
        // one target list still drives a whole round the way it did when there
        // was one call. applyEnrichment matches on the label, so returning more
        // labels than were asked for is harmless; returning fewer is what a
        // test means when it wants a target dropped for unwritable copy.
        const pool = opts.enrich ?? [...targets, ...(opts.topUp ?? [])];
        return Promise.resolve(
          modelReply(
            pool.map((t) => ({
              label: t.label,
              cloze: t.cloze,
              choices: t.choices,
              aliases: t.aliases,
              americanNote: t.americanNote,
              riddle: t.riddle,
            })),
          ),
        );
      }
      default:
        return Promise.resolve(modelReply(targets));
    }
  });
}

function modelReply(targets) {
  return { choices: [{ message: { content: JSON.stringify({ targets }) } }] };
}

beforeEach(() => {
  vi.resetModules();
  createSpy.mockReset();
  mockRound(enTargets());
  cropSpy.mockReset();
  sizeSpy.mockReset();
  // A crop always cuts, and every crop shows what it claims, unless a test says
  // otherwise. Default-pass keeps the other eighty tests about what they were
  // about instead of about verification.
  cropSpy.mockResolvedValue("data:image/jpeg;base64,QQ==");
  sizeSpy.mockResolvedValue({ w: 1600, h: 900 });
  sbState.enabled = true;
  sbState.row = null;
  sbState.upserts = [];
  sbState.readShouldThrow = false;
  sbState.readError = null;
  sbState.onUpsert = null;
  process.env.ADMIN_TOKEN = "test_admin_token";
  process.env.OPENAI_API_KEY = "test_openai_key";
  delete process.env.LUX_AI_VISION_MODEL;
  delete process.env.LUX_AI_QUICK_MODEL;
  delete process.env.LUX_AI_MODEL;
});

async function client() {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  return request(mkServer(handler));
}

function post(api, bodyOverrides = {}, withToken = true) {
  const req = api.post("/api/router?route=convo-image-targets");
  if (withToken) req.set("x-admin-token", "test_admin_token");
  return req.send({ imageUrl: IMG, description: "A cafe counter.", lang: "en", ...bodyOverrides });
}

// ── Variety on a re-visit ───────────────────────────────────────────────────

describe("convo-image-targets exclusions", () => {
  it("tells the scan which words this picture has already taught", async () => {
    const api = await client();
    await post(api, { exclude: ["chair", "lamp"] });
    const user = callsOf("generate")[0][0].messages[1].content;
    const text = JSON.stringify(user);
    expect(text).toContain("ALREADY been taught");
    expect(text).toContain("- chair");
    expect(text).toContain("- lamp");
  });

  it("says nothing about exclusions when there are none", async () => {
    const api = await client();
    await post(api);
    const text = JSON.stringify(callsOf("generate")[0][0].messages[1].content);
    expect(text).not.toContain("ALREADY been taught");
  });

  it("carries them into the TOP-UP too, where a re-visit reaches for the familiar", async () => {
    // Two targets survive, under the floor, so the top-up runs.
    mockRound(
      [
        { label: "a mug", point: { x: 0.2, y: 0.5 }, cloze: "Holding ___.", choices: ["a mug", "a", "b", "c"] },
        { label: "a plate", point: { x: 0.4, y: 0.5 }, cloze: "Beside ___.", choices: ["a plate", "a", "b", "c"] },
      ],
      { topUp: [] },
    );
    const api = await client();
    await post(api, { exclude: ["chair"] });

    expect(callsOf("topUp")).toHaveLength(1);
    const text = JSON.stringify(callsOf("topUp")[0][0].messages[1].content);
    expect(text).toContain("- chair");
    // And the words this round already holds, in the same list.
    expect(text).toContain("- a mug");
  });

  it("is never part of the cache key, so one learner cannot fork a picture", async () => {
    const api = await client();
    await post(api, { exclude: ["chair"] });
    const key = sbState.upserts.at(-1).payload.image_key;

    sbState.upserts.length = 0;
    const api2 = await client();
    await post(api2, { exclude: ["lamp", "door"] });
    expect(sbState.upserts.at(-1).payload.image_key).toBe(key);
  });

  it("caps a long history rather than sending a paragraph on every request", async () => {
    const many = Array.from({ length: 60 }, (_, i) => `word${i}`);
    const api = await client();
    await post(api, { exclude: many });
    const text = JSON.stringify(callsOf("generate")[0][0].messages[1].content);
    expect(text).toContain("- word0");
    expect(text).not.toContain("- word30");
  });
});

// ── First playable ──────────────────────────────────────────────────────────

describe("convo-image-targets first playable", () => {
  /** Eight targets, enough for a first wave of four and a tail of four. */
  function bigRound() {
    return Array.from({ length: 8 }, (_, i) => ({
      label: `thing${i}`,
      point: { x: 0.1 + i * 0.1, y: 0.5 },
      box: { x: 0.1 + i * 0.1, y: 0.4, w: 0.05, h: 0.1 },
      cloze: `Here is ___ number ${i}.`,
      choices: [`thing${i}`, `other${i}`, `spare${i}`, `extra${i}`],
    }));
  }

  /** The tail keeps running after the response, so the row lands later. */
  async function settled(pred, ms = 2000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 5));
    }
    return false;
  }

  beforeEach(() => mockRound(bigRound()));

  it("answers as soon as the first wave is ready, and says it is not the whole set", async () => {
    const api = await client();
    const r = await post(api, { firstPlayable: true });

    expect(r.status).toBe(200);
    expect(r.body.partial).toBe(true);
    expect(r.body.targets.length).toBeGreaterThanOrEqual(3);
    // The wave, not the pool. The rest is still being checked.
    expect(r.body.targets.length).toBeLessThan(8);
    expect(r.body.scanId).toBe(`${r.body.imageKey}|en|`);
    // Playable means playable: every target it DID serve is a whole one.
    for (const t of r.body.targets) {
      expect(t.cloze).toContain("___");
      expect(t.choices.length).toBeGreaterThanOrEqual(3);
      expect(t.choices[t.answerIndex]).toBe(t.label);
    }
  });

  it("never caches the partial set as if it were the whole scan", async () => {
    const api = await client();
    const r = await post(api, { firstPlayable: true });
    const served = r.body.targets.length;

    // A row written at this moment would serve four targets to every future
    // visit and never be recomputed.
    const wrote = sbState.upserts.length ? sbState.upserts[0].payload.targets.length : 0;
    expect(wrote === 0 || wrote > served).toBe(true);

    // And the tail does land, with more than was served.
    expect(await settled(() => sbState.upserts.length > 0)).toBe(true);
    expect(sbState.upserts.at(-1).payload.targets.length).toBeGreaterThan(served);
  });

  it("the follow-up collects the rest under the scanId it was given", async () => {
    const api = await client();
    const first = await post(api, { firstPlayable: true });
    expect(await settled(() => sbState.upserts.length > 0)).toBe(true);

    // What the tail wrote is what a follow-up reads.
    // Exactly what the tail wrote, stamps included, which is what the next read
    // of that row will find.
    const wrote = sbState.upserts.at(-1).payload;
    sbState.row = { targets: wrote.targets, v: wrote.v, verified: wrote.verified };
    createSpy.mockClear();

    const api2 = await client();
    const again = await api2
      .post("/api/router?route=convo-image-targets")
      .set("x-admin-token", "test_admin_token")
      .send({ scanId: first.body.scanId });

    expect(again.body.targets.length).toBeGreaterThan(first.body.targets.length);
    // A follow-up is a read. It must never start another scan.
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("is OPT-IN: a caller that does not ask for it gets the whole set", async () => {
    const api = await client();
    const r = await post(api);
    expect(r.body.partial).toBeUndefined();
    expect(r.body.scanId).toBeUndefined();
    expect(r.body.targets.length).toBeGreaterThan(4);
  });

  it("does not split a set too small to be worth splitting", async () => {
    mockRound(bigRound().slice(0, 4));
    const api = await client();
    const r = await post(api, { firstPlayable: true });
    // Serving three and chasing one costs an extra enrich call to save nothing.
    expect(r.body.partial).toBeUndefined();
    expect(r.body.targets).toHaveLength(4);
  });

  it("a tail that finds nothing leaves the round exactly as playable as it was", async () => {
    // Everything past the first wave fails its crop check.
    let seen = 0;
    mockRound(bigRound(), { shows: () => ++seen <= 4 });
    const api = await client();
    const r = await post(api, { firstPlayable: true });

    expect(r.body.partial).toBe(true);
    expect(r.body.targets.length).toBeGreaterThanOrEqual(3);
    // No second answer, no error: the learner is already playing.
    expect(r.status).toBe(200);
  });
});

// ── Happy path ──────────────────────────────────────────────────────────────

describe("convo-image-targets contract", () => {
  it("happy path: one vision call turns an image into a playable target set", async () => {
    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.cached).toBe(false);
    expect(r.body.lang).toBe("en");
    expect(r.body.imageKey).toBeTruthy();
    expect(r.body.targets).toHaveLength(6);

    for (const t of r.body.targets) {
      expect(typeof t.label).toBe("string");
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.point.x).toBeGreaterThanOrEqual(0);
      expect(t.point.x).toBeLessThanOrEqual(1);
      expect(t.point.y).toBeGreaterThanOrEqual(0);
      expect(t.point.y).toBeLessThanOrEqual(1);
      expect(t.cloze).toContain("___");
      expect(t.choices.length).toBeGreaterThanOrEqual(3);
      expect(t.choices.length).toBeLessThanOrEqual(4);
      expect(t.choices[t.answerIndex]).toBe(t.label);
      expect(["easy", "medium", "hard"]).toContain(t.difficulty);
    }

    // Exactly ONE model call for the whole set — the cost promise.
    expect(callsOf("generate")).toHaveLength(1);
  });

  it("sends the image as a vision content part at temperature 0", async () => {
    const api = await client();
    await post(api);

    const call = callsOf("generate")[0][0];
    expect(call.temperature).toBe(0);
    expect(call.model).toBe("gpt-4.1-mini");
    expect(call.response_format).toEqual({ type: "json_object" });

    const parts = call.messages[1].content;
    expect(Array.isArray(parts)).toBe(true);
    const image = parts.find((p) => p.type === "image_url");
    expect(image.image_url.url).toBe(IMG);
    // The scene description already on the image record is used for grounding.
    const text = parts.find((p) => p.type === "text").text;
    expect(text).toContain("A cafe counter.");
  });

  it("LUX_AI_VISION_MODEL wins the model chain", async () => {
    process.env.LUX_AI_QUICK_MODEL = "quick-model";
    process.env.LUX_AI_VISION_MODEL = "vision-model";
    const api = await client();
    await post(api);
    expect(callsOf("generate")[0][0].model).toBe("vision-model");
  });

  it("enforces the admin gate (401, no model call)", async () => {
    const api = await client();
    const r = await post(api, {}, /* withToken */ false);
    expect(r.status).toBe(401);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-POST method", async () => {
    const api = await client();
    const r = await api
      .get("/api/router?route=convo-image-targets")
      .set("x-admin-token", "test_admin_token");
    expect(r.status).toBe(405);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

// ── Caching ─────────────────────────────────────────────────────────────────

describe("convo-image-targets cache", () => {
  it("a cache hit returns the stored set and NEVER calls the model", async () => {
    const stored = [
      { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "Holding ___.", choices: ["a mug", "a plate", "a kettle"], answerIndex: 0, difficulty: "easy" },
    ];
    sbState.row = { targets: stored, v: 1 };

    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.body.cached).toBe(true);
    expect(r.body.targets).toEqual(stored);
    expect(createSpy).not.toHaveBeenCalled();
    // It IS written back once, to stamp that it has been examined under the
    // current rules. A set with no boxes has nothing to crop-check, and the
    // stamp is what stops every future read asking the same question again.
    expect(sbState.upserts).toHaveLength(1);
    expect(sbState.upserts[0].payload.verified).toBe(3);
    expect(sbState.upserts[0].payload.targets).toEqual(stored);
  });

  it("a set cached BEFORE aliases existed is still served, not re-billed", async () => {
    // The promise made when aliases were added: adding a field does not
    // invalidate the cache. Every picture anyone has already played would
    // otherwise pay for a fresh vision call.
    const legacy = [
      { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "Holding ___.", choices: ["a mug", "a plate", "a kettle"], answerIndex: 0, difficulty: "easy" },
    ];
    sbState.row = { targets: legacy, v: 1 };

    const api = await client();
    const r = await post(api);

    expect(r.body.cached).toBe(true);
    expect(r.body.targets).toEqual(legacy);
    expect(r.body.targets[0].aliases).toBeUndefined();
    expect(createSpy).not.toHaveBeenCalled();
  });

  // ── The serve-time law ────────────────────────────────────────────────────
  //
  // A cached row is answered against the rules as they are NOW. The fourth
  // playtest was asked "Where is the sand?" from a row written before the
  // no-surfaces rule existed: the prompt had been fixed months of work earlier
  // and nothing ever re-read what was already stored.

  it("a cached surface target is filtered out on read, with no new model call", async () => {
    const stored = [
      { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "Holding ___.", choices: ["a mug", "a plate", "a kettle"], answerIndex: 0 },
      { label: "the sand", point: { x: 0.5, y: 0.8 }, cloze: "Her feet are in ___.", choices: ["the sand", "the grass", "the water", "the snow"], answerIndex: 0 },
      { label: "an apron", point: { x: 0.4, y: 0.5 }, cloze: "She wears ___.", choices: ["an apron", "a scarf", "a hat"], answerIndex: 0 },
      { label: "a chalkboard", point: { x: 0.2, y: 0.2 }, cloze: "Prices on ___.", choices: ["a chalkboard", "a poster", "a receipt"], answerIndex: 0 },
      { label: "a plant", point: { x: 0.7, y: 0.7 }, cloze: "Beside the till, ___.", choices: ["a plant", "a basket", "a crate"], answerIndex: 0 },
    ];
    sbState.row = { targets: stored, v: 1 };

    const api = await client();
    const r = await post(api);

    expect(r.body.cached).toBe(true);
    expect(r.body.targets.map((t) => t.label)).not.toContain("the sand");
    expect(r.body.targets).toHaveLength(4);
    // Four survivors still make a round, so the picture is not re-billed.
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("a cached row gutted below four targets is regenerated once and overwritten", async () => {
    sbState.row = {
      targets: [
        { label: "the sand", point: { x: 0.5, y: 0.8 }, cloze: "Feet in ___.", choices: ["the sand", "the grass", "the snow"], answerIndex: 0 },
        { label: "the sky", point: { x: 0.5, y: 0.1 }, cloze: "Above them, ___.", choices: ["the sky", "the sea", "the roof"], answerIndex: 0 },
        { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "Holding ___.", choices: ["a mug", "a plate", "a kettle"], answerIndex: 0 },
      ],
      v: 1,
    };

    const api = await client();
    const r = await post(api);

    expect(r.body.cached).toBe(false);
    expect(callsOf("generate")).toHaveLength(1); // ONCE, not once per bad target
    expect(sbState.upserts).toHaveLength(1);
    expect(r.body.targets).toHaveLength(6);
  });

  it("a short cached row that loses nothing is served as it stands, not re-billed", async () => {
    // The loop this closes: filter, come up short, regenerate, store the same
    // short set, and pay for it again on every single play of that picture.
    // Nothing was dropped, so asking again buys nothing.
    const stored = [
      { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "Holding ___.", choices: ["a mug", "a plate", "a kettle"], answerIndex: 0 },
      { label: "an apron", point: { x: 0.4, y: 0.5 }, cloze: "She wears ___.", choices: ["an apron", "a scarf", "a hat"], answerIndex: 0 },
    ];
    sbState.row = { targets: stored, v: 1 };

    const api = await client();
    const r = await post(api);

    expect(r.body.cached).toBe(true);
    expect(r.body.targets).toEqual(stored);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("a probe with no image bytes serves the filtered remainder rather than nothing", async () => {
    sbState.row = {
      targets: [
        { label: "the sand", point: { x: 0.5, y: 0.8 }, cloze: "Feet in ___.", choices: ["the sand", "the grass", "the snow"], answerIndex: 0 },
        { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "Holding ___.", choices: ["a mug", "a plate", "a kettle"], answerIndex: 0 },
      ],
      v: 1,
    };

    const api = await client();
    const r = await post(api, { imageUrl: "", imageKey: "convo-7-shot-3" });

    expect(r.body.cached).toBe(true);
    expect(r.body.targets.map((t) => t.label)).toEqual(["a mug"]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("a row stamped with an older schema version is a MISS and is overwritten", async () => {
    sbState.row = { targets: [{ label: "stale" }], v: 0 };
    const api = await client();
    const r = await post(api);

    expect(r.body.cached).toBe(false);
    expect(callsOf("generate")).toHaveLength(1);
    expect(sbState.upserts).toHaveLength(1);
    expect(sbState.upserts[0].payload.v).toBe(1);
  });

  it("an empty cached array is a MISS, not an empty round", async () => {
    sbState.row = { targets: [], v: 1 };
    const api = await client();
    const r = await post(api);
    expect(r.body.cached).toBe(false);
    expect(callsOf("generate")).toHaveLength(1);
  });

  it("writes the cache keyed (image_key, lang, level) with the validated targets", async () => {
    const api = await client();
    const r = await post(api);

    expect(sbState.upserts).toHaveLength(1);
    const { table, payload, opts } = sbState.upserts[0];
    expect(table).toBe("image_targets");
    expect(opts).toEqual({ onConflict: "image_key,lang,level" });
    expect(payload.image_key).toBe(r.body.imageKey);
    expect(payload.lang).toBe("en");
    expect(payload.model).toBe("gpt-4.1-mini");
    expect(payload.targets).toEqual(r.body.targets);
  });

  it("WAITS for the cache write to land before answering", async () => {
    // The regression this route was actually shipped with: the write was
    // scheduled and the handler returned, so the promise was abandoned and the
    // row never appeared. Three calls for one image ran the model three times
    // and left the table empty, and nothing in the response or the logs said
    // so. Recording the call is not enough to catch that, because the abandoned
    // version recorded it too; the write has to settle LATE and still be done
    // by the time the response arrives.
    let landed = false;
    sbState.onUpsert = () =>
      new Promise((resolve) =>
        setTimeout(() => {
          landed = true;
          resolve({ data: null, error: null });
        }, 30)
      );

    const api = await client();
    const r = await post(api);

    expect(landed).toBe(true);
    expect(r.body.targets).toHaveLength(6);
  });

  it("says so when the cache write is rejected instead of swallowing it", async () => {
    // A missing column or an anon-key RLS block comes back in `error`, not as a
    // throw. Unchecked, it is indistinguishable from a working cache.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sbState.onUpsert = () =>
      Promise.resolve({ data: null, error: { message: 'relation "image_targets" does not exist' } });

    const api = await client();
    const r = await post(api);

    expect(r.status).toBe(200);
    expect(r.body.targets).toHaveLength(6); // the round still happens
    expect(warn.mock.calls.flat().join(" ")).toContain("cache write failed");
    warn.mockRestore();
  });

  it("says so when the cache read is rejected instead of treating it as a miss", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sbState.readError = { message: "permission denied for table image_targets" };

    const api = await client();
    const r = await post(api);

    expect(r.body.cached).toBe(false); // still degrades to a fresh call
    expect(warn.mock.calls.flat().join(" ")).toContain("cache read failed");
    warn.mockRestore();
  });

  it("a level joins the cache key and bands the prompt", async () => {
    const api = await client();
    const r = await post(api, { level: "A1" });

    expect(r.body.targets).toHaveLength(6);
    const system = callsOf("generate")[0][0].messages[0].content;
    expect(system).toContain("VOCABULARY LEVEL");
    expect(system).toContain("A1 beginner");

    const { payload, opts } = sbState.upserts[0];
    expect(payload.level).toBe("A1");
    expect(opts).toEqual({ onConflict: "image_key,lang,level" });
  });

  it("no level asked for stores the empty band, which is what old rows hold", async () => {
    const api = await client();
    await post(api);
    expect(sbState.upserts[0].payload.level).toBe("");
    expect(callsOf("generate")[0][0].messages[0].content).not.toContain("VOCABULARY LEVEL");
  });

  it("an unknown level is ignored rather than cached under a junk key", async () => {
    const api = await client();
    await post(api, { level: "Z9" });
    expect(sbState.upserts[0].payload.level).toBe("");
  });

  it("the two ends of the scale are told to lean inward", async () => {
    // A picture holds only so many A1 nouns, and a C2 round of genuinely rare
    // words stops being a game about the scene.
    const api = await client();
    await post(api, { level: "A1" });
    expect(callsOf("generate")[0][0].messages[0].content).toContain("lean up to A2");

    vi.resetModules();
    createSpy.mockClear();
    const api2 = await client();
    await post(api2, { level: "C2" });
    expect(callsOf("generate")[0][0].messages[0].content).toContain("lean down to C1");
  });

  it("a caller-supplied imageKey becomes the cache key", async () => {
    const api = await client();
    const r = await post(api, { imageKey: "convo-7-shot-3" });
    expect(r.body.imageKey).toBe("convo-7-shot-3");
    expect(sbState.upserts[0].payload.image_key).toBe("convo-7-shot-3");
  });

  it("the derived key is stable for the same image and different for another", async () => {
    const api = await client();
    const a = await post(api);
    const b = await post(api);
    const c = await post(api, { imageUrl: IMG + "XX" });
    expect(a.body.imageKey).toBe(b.body.imageKey);
    expect(c.body.imageKey).not.toBe(a.body.imageKey);
  });

  it("en and es are cached as separate rows for the same image", async () => {
    const api = await client();
    const en = await post(api, { lang: "en" });
    const es = await post(api, { lang: "es" });
    expect(en.body.imageKey).toBe(es.body.imageKey);
    expect(sbState.upserts.map((u) => u.payload.lang)).toEqual(["en", "es"]);
  });

  it("runs cacheless when Supabase env is missing", async () => {
    sbState.enabled = false;
    const api = await client();
    const r = await post(api);
    expect(r.status).toBe(200);
    expect(r.body.targets).toHaveLength(6);
    expect(sbState.upserts).toHaveLength(0);
  });

  it("a failing cache read degrades to a fresh model call", async () => {
    sbState.readShouldThrow = true;
    const api = await client();
    const r = await post(api);
    expect(r.body.cached).toBe(false);
    expect(r.body.targets).toHaveLength(6);
  });

  it("an imageKey-only probe that misses returns the empty state, no model call", async () => {
    const api = await client();
    const r = await post(api, { imageUrl: "", imageKey: "convo-7-shot-3" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, targets: [], reason: "no_image", imageKey: "convo-7-shot-3" });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("an imageKey-only probe that HITS still answers from cache", async () => {
    const stored = [
      { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "Holding ___.", choices: ["a mug", "a plate", "a kettle"], answerIndex: 0, difficulty: "easy" },
    ];
    sbState.row = { targets: stored, v: 1 };
    const api = await client();
    const r = await post(api, { imageUrl: "", imageKey: "convo-7-shot-3" });
    expect(r.body.cached).toBe(true);
    expect(r.body.targets).toEqual(stored);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

// ── Model truth ─────────────────────────────────────────────────────────────
//
// The box was a claim nobody checked. The fifth playtest filmed both halves of
// the cost: a zoom that showed trees instead of the parking sign, and a ticket
// that would not accept a tap. The generating call cannot audit itself, because
// it can see the whole picture and the thing it named IS in there somewhere.

describe("convo-image-targets crop verification", () => {
  const boxed = (labels) =>
    labels.map((label, i) => ({
      label,
      point: { x: 0.2 + i * 0.15, y: 0.5 },
      box: { x: 0.2 + i * 0.15, y: 0.45, w: 0.08, h: 0.1 },
      cloze: `Here is ___ number ${i}.`,
      choices: [label, `wrong ${i}a`, `wrong ${i}b`, `wrong ${i}c`],
      difficulty: "medium",
    }));

  it("shows each box to the model ON ITS OWN, once per box", async () => {
    mockRound(boxed(["a kettle", "a ladle", "a colander"]));
    const api = await client();
    await post(api);

    expect(cropSpy).toHaveBeenCalledTimes(3);
    const asked = createSpy.mock.calls
      .map((c) => JSON.stringify(c[0].messages))
      .filter((t) => t.includes(KIND.crop));
    expect(asked).toHaveLength(3);
    // The crop is the ONLY thing sent. If the whole picture went too, the model
    // could see the thing elsewhere in frame and agree for the wrong reason.
    for (const call of createSpy.mock.calls) {
      const text = JSON.stringify(call[0].messages);
      if (!text.includes(KIND.crop)) continue;
      const images = call[0].messages[0].content.filter((c) => c.type === "image_url");
      expect(images).toHaveLength(1);
      expect(images[0].image_url.url).toBe("data:image/jpeg;base64,QQ==");
    }
  });

  it("re-localizes a box the crop refuses, ONCE, and keeps it if the retry passes", async () => {
    let seen = 0;
    mockRound(boxed(["a kettle"]), {
      // First crop fails, the crop of the re-localized box passes.
      shows: () => ++seen > 1,
    });
    const api = await client();
    const r = await post(api);

    expect(r.body.targets).toHaveLength(1);
    expect(r.body.targets[0].box).toEqual({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 });
    // The point follows the box it belongs to, or the marker keeps pointing at
    // where the box used to be.
    expect(r.body.targets[0].point).toEqual({ x: 0.45, y: 0.45 });
    expect(r.body.targets[0].boxOk).toBe(true);
  });

  it("drops a target whose box fails twice", async () => {
    mockRound(boxed(["a kettle", "a ladle"]), { shows: false });
    const api = await client();
    const r = await post(api);
    expect(r.body.targets).toHaveLength(0);
    expect(r.body.reason).toBe("no_valid_targets");
  });

  it("gives up on the target, not the round, when the verifier itself breaks", async () => {
    // A checker that cannot run is not evidence against the picture. Dropping
    // targets when the checker breaks empties rounds for a reason that has
    // nothing to do with what is in them.
    sizeSpy.mockRejectedValue(new Error("ffmpeg missing"));
    mockRound(boxed(["a kettle", "a ladle"]));
    const api = await client();
    const r = await post(api);
    expect(r.body.targets).toHaveLength(2);
    expect(cropSpy).not.toHaveBeenCalled();
  });

  it("checks EVERY instance of a duplicated label, not just the first", async () => {
    mockRound([
      {
        label: "the ticket",
        point: { x: 0.3, y: 0.4 },
        box: { x: 0.28, y: 0.38, w: 0.06, h: 0.05 },
        boxes: [
          { x: 0.28, y: 0.38, w: 0.06, h: 0.05 },
          { x: 0.62, y: 0.41, w: 0.05, h: 0.05 },
        ],
        cloze: "There is ___ under the wiper.",
        choices: ["the ticket", "a leaflet", "a receipt", "a map"],
      },
    ]);
    const api = await client();
    const r = await post(api);

    expect(cropSpy).toHaveBeenCalledTimes(2);
    expect(r.body.targets[0].boxes).toHaveLength(2);
  });

  it("keeps the instances that survive and drops the ones that do not", async () => {
    // A second box that points at a wing mirror would score a tap on the wing
    // mirror, which is worse than not having it.
    let n = 0;
    mockRound(
      [
        {
          label: "the ticket",
          point: { x: 0.3, y: 0.4 },
          boxes: [
            { x: 0.28, y: 0.38, w: 0.06, h: 0.05 },
            { x: 0.62, y: 0.41, w: 0.05, h: 0.05 },
          ],
          cloze: "There is ___ under the wiper.",
          choices: ["the ticket", "a leaflet", "a receipt", "a map"],
        },
      ],
      { shows: () => ++n === 1, relocalized: { absent: true } },
    );
    const api = await client();
    const r = await post(api);

    expect(r.body.targets).toHaveLength(1);
    expect(r.body.targets[0].boxes).toBeUndefined();
    expect(r.body.targets[0].box).toEqual({ x: 0.28, y: 0.38, w: 0.06, h: 0.05 });
  });

  it("asks the prompt for every instance, and forbids a silent pick", async () => {
    const api = await client();
    await post(api);
    const system = callsOf("generate")[0][0].messages[0].content;
    expect(system).toContain('"boxes"');
    expect(system).toContain("Never pick one of several lookalikes silently");
  });
});

describe("convo-image-targets serve-time verification", () => {
  const storedBoxed = [
    { label: "a mug", point: { x: 0.3, y: 0.6 }, box: { x: 0.28, y: 0.55, w: 0.08, h: 0.1 }, cloze: "Holding ___.", choices: ["a mug", "a plate", "a kettle"], answerIndex: 0 },
    { label: "an apron", point: { x: 0.5, y: 0.5 }, box: { x: 0.46, y: 0.45, w: 0.09, h: 0.12 }, cloze: "She wears ___.", choices: ["an apron", "a scarf", "a hat"], answerIndex: 0 },
    { label: "a jar", point: { x: 0.7, y: 0.7 }, box: { x: 0.66, y: 0.66, w: 0.07, h: 0.09 }, cloze: "Beans in ___.", choices: ["a jar", "a tin", "a sack"], answerIndex: 0 },
    { label: "a plant", point: { x: 0.8, y: 0.3 }, box: { x: 0.76, y: 0.26, w: 0.08, h: 0.1 }, cloze: "Beside the till, ___.", choices: ["a plant", "a basket", "a crate"], answerIndex: 0 },
  ];

  it("crop-checks a row that was never examined, then stamps it so it is never re-billed", async () => {
    sbState.row = { targets: storedBoxed, v: 1, verified: null };
    const api = await client();
    const r = await post(api);

    expect(r.body.cached).toBe(true);
    expect(cropSpy).toHaveBeenCalledTimes(4);
    expect(sbState.upserts).toHaveLength(1);
    expect(sbState.upserts[0].payload.verified).toBe(3);
  });

  it("re-examines a row stamped by the older audit, then re-stamps it", async () => {
    // v2 said "the boxes this row carries are right". It could not say "and
    // there are no others", which is exactly what the sixth playtest's one
    // chair box in a room of seven chairs turned out to mean. So a v2 row is
    // stale under the instance law and heals on its next serve.
    sbState.row = { targets: storedBoxed, v: 1, verified: 2 };
    const api = await client();
    const r = await post(api);

    expect(r.body.cached).toBe(true);
    // The CROP CHECK is the evidence that the row was re-examined. It used to
    // be the enumeration call, which v8 removed: the crop is the check that
    // actually looks at the picture, and enumeration was only ever the step
    // that decided what to cut.
    expect(callsOf("crop").length).toBeGreaterThan(0);
    expect(callsOf("enumerate")).toHaveLength(0);
    expect(sbState.upserts).toHaveLength(1);
    expect(sbState.upserts[0].payload.verified).toBe(3);
  });

  it("checks EVERY instance the locate call listed, not just the clearest", async () => {
    // The sixth playtest's classroom: a label the picture holds several of. Only
    // one box was ever audited, so every other chair stayed a rejected tap.
    //
    // v8 gets the instances from the locate call's own "boxes" rather than from
    // a second enumeration request. The guarantee is the same and it costs one
    // call instead of two.
    mockRound([
      {
        label: "a chair",
        point: { x: 0.1, y: 0.7 },
        box: { x: 0.1, y: 0.6, w: 0.12, h: 0.25 },
        boxes: [
          { x: 0.1, y: 0.6, w: 0.12, h: 0.25 },
          { x: 0.3, y: 0.62, w: 0.12, h: 0.25 },
          { x: 0.7, y: 0.7, w: 0.1, h: 0.2 },
        ],
        cloze: "Each pupil has ___.",
        choices: ["a chair", "a stool", "a bench", "a desk"],
      },
    ]);
    const api = await client();
    const r = await post(api);

    const chair = r.body.targets.find((t) => t.label === "a chair");
    expect(chair.boxes).toHaveLength(3);
    expect(chair.box).toEqual({ x: 0.1, y: 0.6, w: 0.12, h: 0.25 });
    // One vision call did the locating. The separate enumeration pass is gone.
    expect(callsOf("enumerate")).toHaveLength(0);
    expect(callsOf("generate")).toHaveLength(1);
  });

  it("keeps only the located instances that survive their own crop check", async () => {
    let seen = 0;
    mockRound(
      [
        {
          label: "a chair",
          point: { x: 0.1, y: 0.7 },
          box: { x: 0.1, y: 0.6, w: 0.12, h: 0.25 },
          boxes: [
            { x: 0.1, y: 0.6, w: 0.12, h: 0.25 },
            { x: 0.3, y: 0.62, w: 0.12, h: 0.25 },
          ],
          cloze: "Each pupil has ___.",
          choices: ["a chair", "a stool", "a bench", "a desk"],
        },
      ],
      // Only the first crop shows a chair.
      { shows: () => ++seen <= 1 },
    );
    const api = await client();
    const r = await post(api);

    const chair = r.body.targets.find((t) => t.label === "a chair");
    expect(chair.boxes).toBeUndefined();
    expect(chair.box).toEqual({ x: 0.1, y: 0.6, w: 0.12, h: 0.25 });
  });

  it("marks a target uncroppable when no instance is more than a sliver of its own crop", async () => {
    // The filmed chair. The box is RIGHT, so it still scores; what it cannot do
    // is be cut out and shown as a picture of a chair.
    mockRound(
      [{ label: "a chair", point: { x: 0.7, y: 0.8 }, box: { x: 0.7, y: 0.7, w: 0.1, h: 0.2 }, cloze: "Each pupil has ___.", choices: ["a chair", "a stool", "a bench", "a desk"] }],
      { shows: () => true, prominence: "edge" },
    );
    const api = await client();
    const r = await post(api);

    const chair = r.body.targets.find((t) => t.label === "a chair");
    expect(chair.boxOk).toBe(true);
    expect(chair.cropOk).toBe(false);
  });

  it("ranks the instance that makes the best crop first, not merely the first one found", async () => {
    mockRound(
      [
        {
          label: "a chair",
          point: { x: 0.7, y: 0.8 },
          box: { x: 0.7, y: 0.7, w: 0.1, h: 0.2 },
          boxes: [
            { x: 0.7, y: 0.7, w: 0.1, h: 0.2 },
            { x: 0.1, y: 0.6, w: 0.12, h: 0.25 },
          ],
          cloze: "Each pupil has ___.",
          choices: ["a chair", "a stool", "a bench", "a desk"],
        },
      ],
      // The first crop is a sliver, the second is the whole chair.
      { prominence: (text) => (text.includes("SECOND") ? "main" : "edge") },
    );
    // Each box cuts a distinguishable crop, so the checker can rate them apart.
    cropSpy.mockImplementation((_url, box) =>
      Promise.resolve(box?.x === 0.1 ? "data:image/jpeg;base64,SECOND" : "data:image/jpeg;base64,FIRST"),
    );
    const api = await client();
    const r = await post(api);

    const chair = r.body.targets.find((t) => t.label === "a chair");
    expect(chair.box).toEqual({ x: 0.1, y: 0.6, w: 0.12, h: 0.25 });
    expect(chair.cropOk).toBe(true);
  });

  it("never re-checks a row already stamped", async () => {
    sbState.row = { targets: storedBoxed, v: 1, verified: 3 };
    const api = await client();
    const r = await post(api);

    expect(r.body.cached).toBe(true);
    expect(cropSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(sbState.upserts).toHaveLength(0);
  });

  it("regenerates when the crop check guts an old row", async () => {
    // The boxes were wrong, so re-serving them is re-serving the bug.
    let n = 0;
    mockRound(enTargets(), { shows: () => ++n > 4, relocalized: { absent: true } });
    sbState.row = { targets: storedBoxed, v: 1, verified: null };
    const api = await client();
    const r = await post(api);

    expect(r.body.cached).toBe(false);
    expect(r.body.targets).toHaveLength(6);
  });
});

// ── Level teeth ─────────────────────────────────────────────────────────────
//
// Asking for C2 and being handed "a first-aid kit" is what these cover. The
// band has to change the vocabulary, not just the label on the request.

describe("convo-image-targets level teeth", () => {
  const withLevel = (labels) =>
    labels.map((label, i) => ({
      label,
      point: { x: 0.2 + i * 0.1, y: 0.4 },
      cloze: `Here is ___ number ${i}.`,
      choices: [label, `other ${i}a`, `other ${i}b`, `other ${i}c`],
      difficulty: "medium",
    }));

  it("every band carries worked examples in the target language, not a description", async () => {
    const api = await client();
    await post(api, { level: "C1" });
    const system = callsOf("generate")[0][0].messages[0].content;
    expect(system).toContain("VOCABULARY LEVEL");
    expect(system).toContain("driftwood");
    expect(system).toContain("a tourniquet");
    expect(system).toContain("MATERIALS");
    expect(system).toContain("PARTS");
  });

  it("the Spanish pack gets Spanish exemplars", async () => {
    const api = await client();
    await post(api, { level: "C1", lang: "es" });
    const system = callsOf("generate")[0][0].messages[0].content;
    expect(system).toContain("el torniquete");
    expect(system).toContain("la gasa");
    expect(system).not.toContain("driftwood");
  });

  it("only C1 and C2 get the self-check, and it names the failure it exists for", async () => {
    const api = await client();
    await post(api, { level: "C2" });
    const c2 = callsOf("generate")[0][0].messages[0].content;
    expect(c2).toContain("LEVEL SELF-CHECK");
    expect(c2).toContain("a first-aid kit");

    vi.resetModules();
    createSpy.mockClear();
    const api2 = await client();
    await post(api2, { level: "B1" });
    expect(callsOf("generate")[0][0].messages[0].content).not.toContain("LEVEL SELF-CHECK");
  });

  it("a basic noun is dropped at C2 and kept at B1", async () => {
    mockRound((withLevel(["a chair", "gauze", "the lapel"])));
    const api = await client();
    const hard = await post(api, { level: "C2" });
    expect(hard.body.targets.map((t) => t.label)).toEqual(["gauze", "the lapel"]);

    vi.resetModules();
    createSpy.mockClear();
    mockRound((withLevel(["a chair", "gauze", "the lapel"])));
    const api2 = await client();
    const easy = await post(api2, { level: "B1" });
    expect(easy.body.targets.map((t) => t.label)).toEqual(["a chair", "gauze", "the lapel"]);
  });

  it("a surface is dropped at EVERY band, level or none", async () => {
    for (const level of ["", "A1", "C2"]) {
      vi.resetModules();
      createSpy.mockClear();
      mockRound((withLevel(["the sand", "a mug"])));
      const api = await client();
      const r = await post(api, level ? { level } : {});
      expect(r.body.targets.map((t) => t.label)).toEqual(["a mug"]);
    }
  });

  it("a modifier does not buy a basic noun its way into a high band", async () => {
    // The first live C2 run answered "a bucket hat" and "a lifeguard shirt":
    // a hat and a shirt with a word in front. Whole-phrase matching saw neither.
    mockRound((withLevel(["a bucket hat", "a lifeguard shirt", "the sandy beach", "a rash guard"]))
    );
    const api = await client();
    const r = await post(api, { level: "C2" });
    expect(r.body.targets.map((t) => t.label)).toEqual(["a rash guard"]);
  });

  it("a PART of a basic object survives the high bands, which is what they are for", async () => {
    mockRound((withLevel(["the brim of the hat", "the hem of the shirt", "a chair"]))
    );
    const api = await client();
    const r = await post(api, { level: "C1" });
    expect(r.body.targets.map((t) => t.label)).toEqual(["the brim of the hat", "the hem of the shirt"]);
  });

  it("Spanish takes its head noun from the FRONT, not the back", async () => {
    // "la playa arenosa" is a beach; "el ala del sombrero" is a brim, not a hat.
    // Reading Spanish from the right, as English is read, gets both backwards.
    mockRound((withLevel(["la playa arenosa", "el ala del sombrero", "la silla plegable", "la gasa"]))
    );
    const api = await client();
    const r = await post(api, { level: "C1", lang: "es" });
    expect(r.body.targets.map((t) => t.label)).toEqual(["el ala del sombrero", "la gasa"]);
  });

  it("a box that is half the picture, or a full-width band, is not an object", async () => {
    mockRound(([
        // Over half the frame: the scene, not a thing in it.
        { label: "a mural", box: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, point: { x: 0.5, y: 0.5 }, cloze: "Painted on it, ___.", choices: ["a mural", "a poster", "a flag", "a sign"] },
        // A full-width strip: a horizon, a floor, a shelf edge. Every tap lands in it.
        { label: "a ledge", box: { x: 0, y: 0.7, w: 0.95, h: 0.08 }, point: { x: 0.5, y: 0.74 }, cloze: "The cup sits on ___.", choices: ["a ledge", "a rail", "a step", "a sill"] },
        { label: "a kettle", box: { x: 0.4, y: 0.4, w: 0.12, h: 0.16 }, point: { x: 0.46, y: 0.48 }, cloze: "Steam rises from ___.", choices: ["a kettle", "a pan", "a jug", "a pot"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets.map((t) => t.label)).toEqual(["a kettle"]);
  });

  it("what the filter rejects is never written to the cache", async () => {
    // Otherwise the two halves disagree: stored, then rejected on every read,
    // and the picture pays for a regeneration that stores the same thing again.
    mockRound((withLevel(["the sky", "a mug", "a chalkboard"])));
    const api = await client();
    await post(api);
    expect(sbState.upserts[0].payload.targets.map((t) => t.label)).toEqual(["a mug", "a chalkboard"]);
  });
});

// ── Validation: the three things that make a target playable ────────────────

describe("convo-image-targets validation", () => {
  it("drops a target whose point is outside the image", async () => {
    mockRound(([
        { label: "a mug", point: { x: 1.4, y: 0.5 }, cloze: "Holding ___.", choices: ["a mug", "a plate", "a kettle", "a spoon"] },
        { label: "a window", point: { x: 0.5, y: -0.2 }, cloze: "Light through ___.", choices: ["a window", "a door", "a mirror", "a lamp"] },
        { label: "a plant", point: { x: 0.7, y: 0.68 }, cloze: "There is ___ here.", choices: ["a plant", "a basket", "a stool", "a crate"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets.map((t) => t.label)).toEqual(["a plant"]);
  });

  it("drops a target whose point is missing or not a number", async () => {
    mockRound(([
        { label: "a mug", cloze: "Holding ___.", choices: ["a mug", "a plate", "a kettle", "a spoon"] },
        { label: "a lamp", point: { x: "left", y: 0.4 }, cloze: "Under ___.", choices: ["a lamp", "a shelf", "a hook", "a fan"] },
        { label: "a plant", point: { x: 0.7, y: 0.68 }, cloze: "There is ___ here.", choices: ["a plant", "a basket", "a stool", "a crate"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets.map((t) => t.label)).toEqual(["a plant"]);
  });

  it("nudges a valid rim point inward so the marker is never half off-image", async () => {
    mockRound(([
        { label: "a mug", point: { x: 0, y: 1 }, cloze: "Holding ___.", choices: ["a mug", "a plate", "a kettle", "a spoon"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].point).toEqual({ x: 0.03, y: 0.97 });
  });

  it("normalizes a long underscore run into the ___ blank", async () => {
    mockRound(([
        { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "The barista is holding ______.", choices: ["a mug", "a plate", "a kettle", "a spoon"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].cloze).toBe("The barista is holding ___.");
  });

  it("blanks the word itself when the model forgot the blank", async () => {
    mockRound(([
        { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "The barista is holding a mug.", choices: ["a mug", "a plate", "a kettle", "a spoon"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].cloze).toBe("The barista is holding a ___");
  });

  it("drops a cloze that leaks its own answer alongside the blank", async () => {
    mockRound(([
        { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "The mug beside ___ is empty.", choices: ["a mug", "a plate", "a kettle", "a spoon"] },
        { label: "a plant", point: { x: 0.7, y: 0.68 }, cloze: "There is ___ here.", choices: ["a plant", "a basket", "a stool", "a crate"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets.map((t) => t.label)).toEqual(["a plant"]);
  });

  it("catches a MULTI-WORD answer leaking into its own cloze", async () => {
    // A single-token comparison would miss this: the head noun is three words,
    // so "taza de cafe" has to be matched as a phrase or the answer ships in
    // plain sight next to its own blank.
    mockRound(([
        { label: "la taza de café", point: { x: 0.3, y: 0.6 }, cloze: "La taza de café está junto a ___.", choices: ["la taza de café", "el plato", "la olla", "la cuchara"] },
        { label: "la planta", point: { x: 0.7, y: 0.68 }, cloze: "Hay ___ aquí.", choices: ["la planta", "la silla", "la cesta", "el cajón"] },
      ])
    );
    const api = await client();
    const r = await post(api, { lang: "es" });
    expect(r.body.targets.map((t) => t.label)).toEqual(["la planta"]);
  });

  it("blanks a MULTI-WORD answer when the model forgot the blank", async () => {
    mockRound(([
        { label: "the coffee cup", point: { x: 0.3, y: 0.6 }, cloze: "She is holding the coffee cup.", choices: ["the coffee cup", "the plate", "the kettle", "the spoon"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].cloze).toBe("She is holding the ___");
  });

  it("drops a target with no usable cloze at all", async () => {
    mockRound(([
        { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "The barista is busy today.", choices: ["a mug", "a plate", "a kettle", "a spoon"] },
        { label: "a plant", point: { x: 0.7, y: 0.68 }, cloze: "There is ___ here.", choices: ["a plant", "a basket", "a stool", "a crate"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets.map((t) => t.label)).toEqual(["a plant"]);
  });

  it("always includes the answer in choices, even when the model omits it", async () => {
    mockRound(([
        { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "Holding ___.", choices: ["a plate", "a kettle", "a spoon"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    const t = r.body.targets[0];
    expect(t.choices).toContain("a mug");
    expect(t.choices[t.answerIndex]).toBe("a mug");
    expect(t.choices).toHaveLength(4);
  });

  it("de-duplicates choices by folded form and drops a target left with too few", async () => {
    mockRound(([
        { label: "la taza", point: { x: 0.3, y: 0.6 }, cloze: "Está sosteniendo ___.", choices: ["La Taza", "la taza", "LA TAZA"] },
        { label: "la planta", point: { x: 0.7, y: 0.68 }, cloze: "Hay ___ aquí.", choices: ["la planta", "la silla", "la cesta", "La Silla"] },
      ])
    );
    const api = await client();
    const r = await post(api, { lang: "es" });
    // "la taza" collapsed to a single choice — no real question left, so it goes.
    // "la planta" keeps 3 distinct options after the duplicate silla is folded away.
    expect(r.body.targets.map((t) => t.label)).toEqual(["la planta"]);
    expect(r.body.targets[0].choices).toHaveLength(3);
  });

  it("drops a second target that names the same thing", async () => {
    mockRound(([
        { label: "la taza", point: { x: 0.3, y: 0.6 }, cloze: "Está sosteniendo ___.", choices: ["la taza", "el plato", "la olla", "la cuchara"] },
        { label: "una taza", point: { x: 0.6, y: 0.4 }, cloze: "Hay ___ en la mesa.", choices: ["una taza", "un plato", "una olla", "una cuchara"] },
        { label: "la planta", point: { x: 0.7, y: 0.68 }, cloze: "Hay ___ aquí.", choices: ["la planta", "la silla", "la cesta", "el cajón"] },
      ])
    );
    const api = await client();
    const r = await post(api, { lang: "es" });
    expect(r.body.targets.map((t) => t.label)).toEqual(["la taza", "la planta"]);
  });

  it("caps the set at 12 targets", async () => {
    const many = [];
    for (let i = 0; i < 16; i++) {
      many.push({
        label: `thing${i}`,
        point: { x: 0.1 + i * 0.05, y: 0.5 },
        cloze: `Here is ___ number ${i}.`,
        choices: [`thing${i}`, `other${i}`, `spare${i}`, `extra${i}`],
      });
    }
    mockRound((many));
    const api = await client();
    const r = await post(api);
    expect(r.body.targets).toHaveLength(12);
  });

  it("puts the marker at the BOX CENTRE when there is a usable box", async () => {
    // The second playtest's grounding failure: a point a little off the
    // calculator read as the desk behind it. The box says which was meant, and
    // its centre beats a separately-estimated point.
    mockRound(([
        {
          label: "a calculator",
          box: { x: 0.4, y: 0.5, w: 0.2, h: 0.1 },
          point: { x: 0.9, y: 0.9 }, // deliberately wrong; the box wins
          cloze: "She is using ___.",
          choices: ["a calculator", "a phone", "a stapler", "a ruler"],
        },
      ])
    );
    const api = await client();
    const r = await post(api);
    const target = r.body.targets[0];
    expect(target.point.x).toBeCloseTo(0.5, 5);
    expect(target.point.y).toBeCloseTo(0.55, 5);
    expect(target.box).toEqual({ x: 0.4, y: 0.5, w: 0.2, h: 0.1 });
  });

  it("falls back to the point when the box is unusable, and omits the box", async () => {
    const bad = [
      { tag: "out of bounds", box: { x: 0.9, y: 0.1, w: 0.4, h: 0.1 } },
      { tag: "a sliver", box: { x: 0.4, y: 0.4, w: 0.001, h: 0.2 } },
      { tag: "the whole picture", box: { x: 0, y: 0, w: 1, h: 1 } },
      { tag: "negative", box: { x: -0.2, y: 0.4, w: 0.2, h: 0.2 } },
      { tag: "not numbers", box: { x: "left", y: 0.4, w: 0.2, h: 0.2 } },
      { tag: "missing", box: undefined },
    ];
    for (const { tag, box } of bad) {
      vi.resetModules();
      createSpy.mockClear();
      mockRound(([
          {
            label: "a mug",
            box,
            point: { x: 0.31, y: 0.62 },
            cloze: "Holding ___.",
            choices: ["a mug", "a plate", "a kettle", "a spoon"],
          },
        ])
      );
      const api = await client();
      const r = await post(api);
      const target = r.body.targets[0];
      expect(target, `box case: ${tag}`).toBeTruthy();
      expect(target.point.x, `box case: ${tag}`).toBeCloseTo(0.31, 5);
      expect(target.box, `box case: ${tag}`).toBeUndefined();
    }
  });

  it("asks LOCATE for the box and ENRICH for the literal cloze, one job each", async () => {
    const api = await client();
    await post(api);
    expect(callsOf("generate")).toHaveLength(1);
    expect(callsOf("enrich")).toHaveLength(1);

    // Locate: what and where, and the quality rules for a box a learner taps.
    const locate = callsOf("generate")[0][0].messages[0].content;
    expect(locate).toContain('"box"');
    expect(locate).toContain("BOUNDING BOX");
    expect(locate).toContain("VISUALLY UNAMBIGUOUS");
    expect(locate).toContain("re-read your own list once");
    expect(locate).toContain("TIGHT");
    expect(locate).toContain("IT MUST CONTAIN THE THING YOU NAMED");
    expect(locate).toContain("NEVER A PERSON'S BODY");
    expect(locate).toContain("NO VAST SURFACES");
    // And it is told, in as many words, not to do the writing. This is the
    // saving: none of those tokens are spent on targets about to be dropped.
    expect(locate).toContain("Do NOT write sentences");
    expect(locate).not.toContain("LITERALLY TRUE OF THIS IMAGE");

    // Enrich: the sentence, and the rule that keeps it about THIS picture.
    const enrich = callsOf("enrich")[0][0].messages[0].content;
    expect(enrich).toContain("LITERALLY TRUE OF THIS IMAGE");
    expect(enrich).toContain('"cloze"');
  });

  it("always offers the bare head noun as an alias", async () => {
    // Dropping the article is the commonest near miss there is, and it must
    // never be graded wrong, whatever the model chose to return.
    mockRound(([
        { label: "a coffee mug", point: { x: 0.3, y: 0.6 }, cloze: "Holding ___.", choices: ["a coffee mug", "a plate", "a kettle", "a spoon"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].aliases).toContain("coffee mug");
  });

  it("keeps the model's own aliases, capped and de-duplicated", async () => {
    mockRound(([
        {
          label: "a computer monitor",
          point: { x: 0.3, y: 0.6 },
          cloze: "She is looking at ___.",
          choices: ["a computer monitor", "a keyboard", "a printer", "a laptop"],
          aliases: ["monitor", "screen", "a display", "MONITOR", "computer screen", "one more", "and another", "yet another", "and one more still"],
        },
      ])
    );
    const api = await client();
    const r = await post(api);
    const aliases = r.body.targets[0].aliases;
    expect(aliases.length).toBeLessThanOrEqual(8);
    expect(aliases).toContain("computer monitor"); // the head noun, added first
    expect(aliases).toContain("screen");
    // "MONITOR" folds to the same thing as "monitor"; only one survives.
    expect(aliases.filter((a) => a.toLowerCase() === "monitor")).toHaveLength(1);
  });

  // ── The usage note ────────────────────────────────────────────────────────

  it("carries a regional usage note when the variants earn one", async () => {
    mockRound(([
        {
          label: "swim trunks",
          point: { x: 0.4, y: 0.6 },
          cloze: "He is wearing ___.",
          choices: ["swim trunks", "a wetsuit", "a towel", "a raincoat"],
          aliases: ["trunks", "a bathing suit", "a swimsuit", "board shorts"],
          americanNote: 'In American English you\'ll usually hear "swim trunks".',
        },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].americanNote).toBe(
      'In American English you\'ll usually hear "swim trunks".'
    );
    expect(r.body.targets[0].aliases).toContain("a bathing suit");
  });

  it("drops a note with no variant behind it, rather than lecturing on a plain word", async () => {
    mockRound(([
        {
          label: "a mug",
          point: { x: 0.3, y: 0.6 },
          cloze: "Holding ___.",
          choices: ["a mug", "a plate", "a kettle", "a spoon"],
          aliases: [], // only the head noun survives, which is not a variant
          americanNote: 'In American English you\'ll usually hear "a mug".',
        },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].americanNote).toBeUndefined();
  });

  it("omits the note entirely rather than storing an empty one", async () => {
    mockRound(([
        { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "Holding ___.", choices: ["a mug", "a plate", "a kettle", "a spoon"], aliases: ["a cup"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect("americanNote" in r.body.targets[0]).toBe(false);
  });

  it("asks for regional variants, and asks the Spanish pack about Mexico", async () => {
    const api = await client();
    await post(api);
    const en = callsOf("enrich")[0][0].messages[0].content;
    expect(en).toContain("REGIONAL VARIANT");
    expect(en).toContain("swim trunks");
    expect(en).toContain("American English");

    vi.resetModules();
    createSpy.mockClear();
    const api2 = await client();
    await post(api2, { lang: "es" });
    const es = callsOf("enrich")[0][0].messages[0].content;
    expect(es).toContain("Mexican Spanish");
    expect(es).toContain("el traje de baño");
  });

  // ── The riddle clue ───────────────────────────────────────────────────────

  it("keeps an attributes-only riddle, without its final stop", async () => {
    mockRound(([
        { label: "a toolbox", point: { x: 0.3, y: 0.6 }, cloze: "He carries ___.", choices: ["a toolbox", "a lunchbox", "a crate", "a bucket"], riddle: "small and red." },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].riddle).toBe("small and red");
  });

  it("drops a riddle that gives the answer away", async () => {
    // A clue holding the answer is not a clue. Checked on the whole noun and on
    // each word of it, so "a red toolbox" fails as surely as "a toolbox".
    mockRound(([
        { label: "a toolbox", point: { x: 0.3, y: 0.6 }, cloze: "He carries ___.", choices: ["a toolbox", "a lunchbox", "a crate", "a bucket"], riddle: "red and a toolbox" },
        { label: "a first-aid kit", point: { x: 0.5, y: 0.5 }, cloze: "She opens ___.", choices: ["a first-aid kit", "a lunchbox", "a crate", "a bucket"], riddle: "white with a red kit cross" },
        { label: "a kettle", point: { x: 0.7, y: 0.4 }, cloze: "Steam from ___.", choices: ["a kettle", "a pan", "a jug", "a pot"], riddle: "silver and round" },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets.map((t) => t.riddle)).toEqual([undefined, undefined, "silver and round"]);
  });

  it("asks each pack for its own riddle when enriching, Spanish agreeing with algo", async () => {
    const api = await client();
    await post(api);
    expect(callsOf("enrich")[0][0].messages[0].content).toContain("I spy something");

    vi.resetModules();
    createSpy.mockClear();
    const api2 = await client();
    await post(api2, { lang: "es" });
    const es = callsOf("enrich")[0][0].messages[0].content;
    expect(es).toContain("Veo veo");
    expect(es).toContain("algo rojo");
  });

  it("refuses an alias that is one of the wrong choices", async () => {
    // An alias marks an answer correct. If it collided with a distractor, that
    // distractor would become a right answer and the question would be broken.
    mockRound(([
        {
          label: "a mug",
          point: { x: 0.3, y: 0.6 },
          cloze: "Holding ___.",
          choices: ["a mug", "a plate", "a kettle", "a spoon"],
          aliases: ["a plate", "cup"],
        },
      ])
    );
    const api = await client();
    const r = await post(api);
    const aliases = r.body.targets[0].aliases;
    expect(aliases).toContain("cup");
    expect(aliases).not.toContain("a plate");
  });

  it("a target with no model aliases still has the head noun and never null", async () => {
    mockRound(([
        { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "Holding ___.", choices: ["a mug", "a plate", "a kettle", "a spoon"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(Array.isArray(r.body.targets[0].aliases)).toBe(true);
    expect(r.body.targets[0].aliases).toEqual(["mug"]);
  });

  it("asks for aliases in the ENRICH call, and never in the locate call", async () => {
    const api = await client();
    await post(api);
    expect(callsOf("enrich")).toHaveLength(1);
    expect(callsOf("enrich")[0][0].messages[0].content).toContain('"aliases"');
    // The v8 guarantee, and the reason the split exists: nothing is spent
    // writing alternative names for targets the crop check has not passed yet.
    expect(callsOf("generate")[0][0].messages[0].content).not.toContain('"aliases"');
  });

  it("normalizes an unknown difficulty to medium", async () => {
    mockRound(([
        { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "Holding ___.", choices: ["a mug", "a plate", "a kettle", "a spoon"], difficulty: "impossible" },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].difficulty).toBe("medium");
  });

  it("determinism: the same image deals the same options in the same order", async () => {
    const api = await client();
    const a = await post(api);
    const b = await post(api);
    expect(a.body.targets).toEqual(b.body.targets);
  });

  it("the answer is not always in the same slot", async () => {
    const api = await client();
    const r = await post(api);
    const slots = new Set(r.body.targets.map((t) => t.answerIndex));
    expect(slots.size).toBeGreaterThan(1);
  });
});

// ── Localization ────────────────────────────────────────────────────────────

describe("convo-image-targets localization", () => {
  it("the es pack asks for Spanish labels with their article", async () => {
    const api = await client();
    await post(api, { lang: "es" });
    const system = callsOf("generate")[0][0].messages[0].content;
    expect(system).toContain("Spanish (neutral Latin American)");
    expect(system).toContain("la taza");
    expect(system).toContain("The article carries the gender");
    expect(system).not.toContain('"a mug"');
  });

  it("the en pack asks for English labels with their article", async () => {
    const api = await client();
    await post(api, { lang: "en" });
    const system = callsOf("generate")[0][0].messages[0].content;
    expect(system).toContain("English");
    expect(system).toContain('"a mug"');
    expect(system).not.toContain("neutral Latin American");
  });

  it("accepts `pack` as an alias for `lang` (the repo carries both names)", async () => {
    const api = await client();
    const r = await post(api, { lang: undefined, pack: "es" });
    expect(r.body.lang).toBe("es");
    expect(callsOf("generate")[0][0].messages[0].content).toContain("neutral Latin American");
  });

  it("an explicit lang wins over pack", async () => {
    const api = await client();
    const r = await post(api, { lang: "en", pack: "es" });
    expect(r.body.lang).toBe("en");
  });

  it("an unknown lang falls back to en", async () => {
    const api = await client();
    const r = await post(api, { lang: "fr" });
    expect(r.body.lang).toBe("en");
    expect(callsOf("generate")[0][0].messages[0].content).toContain('"a mug"');
  });

  it("forgives case and region on the pack value", async () => {
    // A Spanish learner silently handed an English round is the worst failure
    // here — nothing about it looks like an error — so "ES" and "es-MX" count.
    for (const value of ["ES", "es-MX", "es-mx", " es "]) {
      vi.resetModules();
      createSpy.mockClear();
      const api = await client();
      const r = await post(api, { lang: value });
      expect(r.body.lang, `lang=${value}`).toBe("es");
    }
  });

  it("strips the Spanish article when comparing, so el/la duplicates collapse", async () => {
    mockRound(([
        { label: "el plato", point: { x: 0.3, y: 0.6 }, cloze: "Está sobre ___.", choices: ["el plato", "la taza", "la olla", "la cuchara"] },
        { label: "un plato", point: { x: 0.5, y: 0.6 }, cloze: "Hay ___ aquí.", choices: ["un plato", "una taza", "una olla", "una cuchara"] },
      ])
    );
    const api = await client();
    const r = await post(api, { lang: "es" });
    expect(r.body.targets).toHaveLength(1);
  });
});

// ── Graceful degradation: the game is optional, so nothing ever 500s ────────

describe("convo-image-targets degradation", () => {
  it("a missing image degrades gracefully (no_image, no model call)", async () => {
    const api = await client();
    const r = await post(api, { imageUrl: "" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, targets: [], reason: "no_image" });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("an oversized image degrades gracefully (image_too_large, no model call)", async () => {
    const api = await client();
    const r = await post(api, { imageUrl: "d".repeat(3_500_001) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, targets: [], reason: "image_too_large" });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("a missing OPENAI_API_KEY degrades gracefully (init_error, no model call)", async () => {
    delete process.env.OPENAI_API_KEY;
    const api = await client();
    const r = await post(api);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, targets: [], reason: "init_error" });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("a model-call failure degrades gracefully (model_failed)", async () => {
    createSpy.mockRejectedValueOnce(new Error("openai exploded"));
    const api = await client();
    const r = await post(api);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, targets: [], reason: "model_failed" });
    expect(sbState.upserts).toHaveLength(0);
  });

  it("unparseable model output degrades gracefully (bad_model_json)", async () => {
    createSpy.mockResolvedValueOnce({ choices: [{ message: { content: "not json at all {" } }] });
    const api = await client();
    const r = await post(api);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, targets: [], reason: "bad_model_json" });
  });

  it("repairs slightly-broken model JSON (jsonrepair) and still deals a round", async () => {
    createSpy.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content:
              '{"targets":[{"label":"a mug","point":{"x":0.3,"y":0.6},"cloze":"Holding ___.","choices":["a mug","a plate","a kettle","a spoon"],}]}',
          },
        },
      ],
    });
    const api = await client();
    const r = await post(api);
    expect(r.body.targets).toHaveLength(1);
    expect(r.body.targets[0].label).toBe("a mug");
  });

  it("a set where nothing validates is no_valid_targets, NOT no_targets", async () => {
    // The distinction is the whole point: this is a prompt/model regression, and
    // reporting it as "nothing nameable in the picture" would hide it forever.
    mockRound(([
        { label: "a mug", point: { x: 9, y: 9 }, cloze: "Holding ___.", choices: ["a mug", "a plate"] },
        { label: "", point: { x: 0.5, y: 0.5 }, cloze: "___ here.", choices: ["a plate", "a kettle"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, targets: [], reason: "no_valid_targets" });
    expect(sbState.upserts).toHaveLength(0);
  });

  it("coordinates returned as percentages lose every target and say so", async () => {
    // The concrete regression the two reasons exist to tell apart: a model that
    // answers 0-100 instead of 0-1 fails every range check at once.
    mockRound((
        enTargets().map((t) => ({ ...t, point: { x: t.point.x * 100, y: t.point.y * 100 } }))
      )
    );
    const api = await client();
    const r = await post(api);
    expect(r.body).toMatchObject({ ok: true, targets: [], reason: "no_valid_targets" });
  });

  it("a model that finds nothing nameable is no_targets", async () => {
    mockRound(([]));
    const api = await client();
    const r = await post(api);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, targets: [], reason: "no_targets" });
    expect(sbState.upserts).toHaveLength(0);
  });
});
