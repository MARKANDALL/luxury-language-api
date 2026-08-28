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

import { cropWindow } from "../lib/crop-window.js";

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
/**
 * The box a crop was cut for, decoded from what the crop mock returned.
 *
 * The route hands the crop straight to the model, so the encoded suffix arrives
 * in the message the model mock is looking at.
 */
function cropBoxOf(text) {
  const m = /QQ==#([-\d.,]+)/.exec(String(text || ""));
  if (!m) return null;
  const [x, y, w, h] = m[1].split(",").map(Number);
  return [x, y, w, h].every(Number.isFinite) ? { x, y, w, h } : null;
}

/**
 * Bounds, in CROP fractions, that exactly cover `box`: what a good model says
 * about an honest box. Uses the route's own crop-window arithmetic rather than
 * a hand-computed constant, so a change to the padding cannot silently turn
 * every default answer into a partial-coverage failure.
 */
function boundsCovering(box) {
  if (!box) return { x: 0.26, y: 0.28, w: 0.48, h: 0.44 };
  const dim = { w: 1600, h: 900 }; // matches sizeSpy, so the window is the real one
  const win = cropWindow(box, dim);
  return {
    x: (box.x * dim.w - win.x) / win.w,
    y: (box.y * dim.h - win.y) / win.h,
    w: (box.w * dim.w) / win.w,
    h: (box.h * dim.h) / win.h,
  };
}

const KIND = {
  // v10: the mine call (deepen) carries the top-up's sentinel sentence and ALSO
  // inventory-prompt phrases, so topUp must be matched BEFORE inventory.
  topUp: "Already taken, do NOT return any of these",
  inventory: "Build its nameable INVENTORY",
  bandpass: "choosing WORDS for a language learner from the nameable INVENTORY",
  // Anchored on the opening line rather than on the question, which is reworded
  // whenever the check gains a new one. When the crop prompt grew its
  // prominence question the old phrase vanished, every crop check was routed to
  // the generation branch, and twelve tests failed for a reason that had nothing
  // to do with the route.
  crop: "a small crop taken from a larger photograph",
  tighten: "snug bounding box",
  relocalize: "give its bounding box",
  enumerate: "find EVERY separate instance",
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
/**
 * v10: a fresh scan writes TWO rows now, the band-free inventory and the band
 * row. Every existing assertion about "the row this scan wrote" means the band
 * row, so this is what they read.
 */
function bandUpserts() {
  return sbState.upserts.filter((u) => u.payload?.level !== "__inv1");
}

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
        // v12: `bounds` is the thing's whole visible extent in CROP fractions.
        // The default covers the middle of the crop, which is exactly where an
        // honest box sits inside its own padded crop: the crop is 2.1
        // box-widths across, so the box occupies the middle ~0.48 of it. A test
        // that wants a displaced or partial box overrides opts.bounds.
        return Promise.resolve(
          reply({
            shows: true,
            prominence: prom,
            bounds:
              opts.bounds === null
                ? undefined
                : (typeof opts.bounds === "function"
                    ? opts.bounds(cropBoxOf(text))
                    : opts.bounds) || boundsCovering(cropBoxOf(text)),
            ...(opts.cut ? { cut: true } : null),
          }),
        );
      }
      case "relocalize":
        return Promise.resolve(reply(opts.relocalized ?? { box: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 } }));
      case "enumerate":
        // The heal path shape: one row per LABEL INDEX, each with every instance
        // found and a crowd flag for "there are more of these than I can point
        // at". Defaults to nothing found, which leaves the row planning from its
        // own boxes exactly as it did before enumeration came back.
        return Promise.resolve(reply({ labels: opts.instances ?? [] }));
      case "topUp":
        // The mine call: inventory entries for the deepen, offset past the base
        // fixture the way the route offsets past the cached inventory.
        return Promise.resolve(
          reply({
            inventory: (opts.topUp ?? []).map((t, i) => ({
              gloss: t.label,
              granularity: "object",
              box: t.box,
              boxes: t.boxes,
              point: t.point,
            })),
          }),
        );
      case "tighten":
        // The snug ask. opts.snug is a box in CROP fractions, or absent to
        // decline; the recheck that follows a shrink flows through the crop
        // branch above like any other crop question.
        return Promise.resolve(reply(opts.snug ? { box: opts.snug } : { absent: true }));
      case "inventory":
        return Promise.resolve(
          reply({
            inventory: targets.map((t) => ({
              gloss: t.label,
              granularity: "object",
              box: t.box,
              boxes: t.boxes,
              point: t.point,
            })),
          }),
        );
      case "bandpass": {
        // Answered from the inventory listing THIS call was sent, parsed back
        // out of the user turn, so the ids always match the route's own
        // whatever sanitize dropped or a mining pass offset. The gloss IS the
        // fixture label, so the round comes out shaped exactly as it used to.
        const user = String(req?.messages?.[1]?.content || "");
        const listed = [...user.matchAll(/^(\d+)\. (.+) \((?:object|part|material|surface|state|action)\)$/gm)]
          .map((m) => ({
            id: Number(m[1]),
            label: m[2],
            // Carry the fixture's own difficulty through, so tests can still
            // drive the normalization path with a junk value.
            difficulty: ([...targets, ...(opts.topUp ?? [])].find((t) => t.label === m[2]) || {}).difficulty || "easy",
          }));
        return Promise.resolve(
          reply({
            targets: listed,
            counts: opts.counts ?? { A1: 6, A2: 6, B1: 6, B2: 6, C1: 6, C2: 6 },
          }),
        );
      }
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
              near: t.near,
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
  // Encodes the BOX it was asked to cut. The model mock decodes it and answers
  // bounds that exactly cover that box, which is what a good model would say
  // about an honest box, whatever shape the fixture chose.
  cropSpy.mockImplementation((_url, box) =>
    Promise.resolve(`data:image/jpeg;base64,QQ==#${box ? [box.x, box.y, box.w, box.h].join(",") : ""}`),
  );
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
    const user = callsOf("bandpass")[0][0].messages[1].content;
    const text = JSON.stringify(user);
    expect(text).toContain("ALREADY been taught");
    expect(text).toContain("- chair");
    expect(text).toContain("- lamp");
  });

  it("says nothing about exclusions when there are none", async () => {
    const api = await client();
    await post(api);
    const text = JSON.stringify(callsOf("bandpass")[0][0].messages[1].content);
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
    const key = bandUpserts().at(-1).payload.image_key;

    sbState.upserts.length = 0;
    const api2 = await client();
    await post(api2, { exclude: ["lamp", "door"] });
    expect(bandUpserts().at(-1).payload.image_key).toBe(key);
  });

  it("caps a long history rather than sending a paragraph on every request", async () => {
    const many = Array.from({ length: 60 }, (_, i) => `word${i}`);
    const api = await client();
    await post(api, { exclude: many });
    const text = JSON.stringify(callsOf("bandpass")[0][0].messages[1].content);
    expect(text).toContain("- word0");
    expect(text).not.toContain("- word30");
  });
});

// ── Same-referent dedup ─────────────────────────────────────────────────────
//
// One round served "a suit jacket" and "a blazer" as two targets on the same
// garment. The head-word check cannot catch that and never could: they share no
// head word, so by every TEXT test they are two different words. The only thing
// that knows they are one coat is where they are.

const boxed = (label, box, point) => ({
  label,
  point: point || { x: box.x + box.w / 2, y: box.y + box.h / 2 },
  box,
  cloze: `Here is ___.`,
  choices: [label, "a", "b", "c"],
});

describe("convo-image-targets same-referent dedup", () => {
  it("folds two names for one garment into a single target", async () => {
    const coat = { x: 0.3, y: 0.2, w: 0.3, h: 0.5 };
    mockRound([
      boxed("a suit jacket", coat),
      // Same coat, drawn a shade differently by the model.
      boxed("a blazer", { x: 0.31, y: 0.21, w: 0.29, h: 0.49 }),
      boxed("a mug", { x: 0.8, y: 0.8, w: 0.08, h: 0.08 }),
    ]);
    const api = await client();
    const res = await post(api, { level: "B1" });

    const labels = res.body.targets.map((t) => t.label);
    expect(labels).toContain("a mug");
    // One of the two coat words, never both.
    const coats = labels.filter((l) => l === "a suit jacket" || l === "a blazer");
    expect(coats).toHaveLength(1);
  });

  it("does NOT fold a part into the object it sits on", async () => {
    // The rule that makes the high bands possible. A lapel inside a blazer is
    // contained by it, and containment is exactly what this must not use: C1 and
    // C2 are told to name a hat's brim and a shirt's cuff.
    const blazer = { x: 0.3, y: 0.2, w: 0.3, h: 0.5 };
    const lapel = { x: 0.33, y: 0.24, w: 0.06, h: 0.12 };
    mockRound([boxed("the blazer", blazer), boxed("the lapel", lapel)]);
    const api = await client();
    const res = await post(api, { level: "C1" });

    const labels = res.body.targets.map((t) => t.label);
    expect(labels).toContain("the blazer");
    expect(labels).toContain("the lapel");
  });

  it("keeps the MORE specific label at a high band", async () => {
    // Deliberately NOT the blazer/suit-jacket pair here. At C1 and C2 the
    // existing too_basic rule drops "a suit jacket" on its head word before the
    // dedup ever sees it, which is correct and is why that pair belongs in the
    // beginner-band test below. Two labels that both survive a high band are
    // what this actually needs.
    // The pair also needs DIFFERENT head words, or the head-word pass upstream
    // folds them before this rule is reached: "a carabiner" and "a locking
    // carabiner" are one head word and never both arrive here.
    const fitting = { x: 0.3, y: 0.2, w: 0.2, h: 0.2 };
    mockRound([
      boxed("a ferrule", fitting),
      boxed("a metal collar", { x: 0.3, y: 0.21, w: 0.2, h: 0.19 }),
    ]);
    const api = await client();
    const res = await post(api, { level: "C2" });
    const labels = res.body.targets.map((t) => t.label);
    expect(labels).toContain("a metal collar");
    expect(labels).not.toContain("a ferrule");
  });

  it("keeps the SIMPLER label at a beginner band, and the band rule gets the last word", async () => {
    // The assertion here used to be `toContain("a blazer")`: of two names for
    // one garment the deduper prefers the shorter at A1 and A2, and "a blazer"
    // is shorter than "a suit jacket".
    //
    // That is still what the deduper does, and it is no longer what the round
    // serves. The B1 colour/garment rule runs afterwards, on every target, and
    // refuses "a blazer" at an everyday band: the question there is not which
    // label is shorter, it is whether the learner holds the WORD, and "blazer"
    // is a B2 word for a jacket. So the deduper picks the blazer and ruleFailure
    // sends it back, which leaves the jacket, which is the right answer by both
    // rules at once.
    const coat = { x: 0.3, y: 0.2, w: 0.3, h: 0.5 };
    mockRound([
      boxed("a suit jacket", coat),
      boxed("a blazer", { x: 0.3, y: 0.21, w: 0.3, h: 0.49 }),
    ]);
    const api = await client();
    const res = await post(api, { level: "A2" });
    const labels = res.body.targets.map((t) => t.label);
    expect(labels).not.toContain("a blazer");
    expect(labels).toContain("a suit jacket");
  });

  it("leaves two genuinely separate objects alone", async () => {
    mockRound([
      boxed("a mug", { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }),
      boxed("a plate", { x: 0.6, y: 0.6, w: 0.1, h: 0.1 }),
    ]);
    const api = await client();
    const res = await post(api, { level: "B1" });
    const labels = res.body.targets.map((t) => t.label);
    expect(labels).toContain("a mug");
    expect(labels).toContain("a plate");
  });

  it("keeps a boxless target rather than treating it as a duplicate", async () => {
    mockRound([
      { label: "the sky", point: { x: 0.5, y: 0.1 }, cloze: "Here is ___.", choices: ["the sky", "a", "b", "c"] },
      boxed("a mug", { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }),
    ]);
    const api = await client();
    const res = await post(api, { level: "B1" });
    expect(res.body.targets.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Band-aware breadth ──────────────────────────────────────────────────────

describe("convo-image-targets breadth by band", () => {
  it("tells a beginner band to reach for universal nameables", async () => {
    const api = await client();
    await post(api, { level: "A1" });
    const sys = callsOf("bandpass")[0][0].messages[0].content;
    expect(sys).toContain("BREADTH AT THIS BAND");
    expect(sys).toContain("a hand");
    expect(sys).toContain("play ANY picture");
  });

  it("tells a high band it may go anywhere in the frame", async () => {
    const api = await client();
    await post(api, { level: "C2" });
    const sys = callsOf("bandpass")[0][0].messages[0].content;
    expect(sys).toContain("BREADTH AT THIS BAND");
    expect(sys).toContain("ANYWHERE in the frame");
  });

  it("keeps the scenario's own words the primary lean at EVERY band", async () => {
    // The breadth is additive. Practising the conversation's words is still the
    // point, so every band leads with them.
    for (const level of ["A1", "A2", "B1", "B2", "C1", "C2"]) {
      createSpy.mockClear();
      const api = await client();
      await post(api, { level });
      const sys = callsOf("bandpass")[0][0].messages[0].content;
      expect(sys, `band ${level}`).toContain("Lead with the words this scene is about");
    }
  });

  it("says nothing about breadth when there is no band at all", async () => {
    const api = await client();
    await post(api, { level: "" });
    const sys = callsOf("bandpass")[0][0].messages[0].content;
    expect(sys).not.toContain("BREADTH AT THIS BAND");
  });
});

// ── Six bands, one engine ───────────────────────────────────────────────────

describe("convo-image-targets band calibration", () => {
  it("gives the LOW bands a self-check that names the filed failure", async () => {
    // "an espresso machine" came back in a live A2 round. The band text already
    // forbade specialist names in general terms and that was not enough, so the
    // check names it and gives the plain word beside it.
    for (const level of ["A1", "A2"]) {
      createSpy.mockClear();
      const api = await client();
      await post(api, { level });
      const sys = callsOf("bandpass")[0][0].messages[0].content;
      expect(sys, level).toContain(`LEVEL SELF-CHECK (${level} only`);
      expect(sys, level).toContain("an espresso machine");
      expect(sys, level).toContain("is a coffee maker");
    }
  });

  it("gives the HIGH bands the opposite check, and never both", async () => {
    const api = await client();
    await post(api, { level: "C2" });
    const sys = callsOf("bandpass")[0][0].messages[0].content;
    expect(sys).toContain("LEVEL SELF-CHECK (C2 only");
    expect(sys).not.toContain("is a coffee maker");
  });

  it("leaves the middle bands with neither", async () => {
    for (const level of ["B1", "B2"]) {
      createSpy.mockClear();
      const api = await client();
      await post(api, { level });
      const sys = callsOf("bandpass")[0][0].messages[0].content;
      expect(sys, level).not.toContain("LEVEL SELF-CHECK");
    }
  });

  it("tells the LOW bands to accept the sharper word as an alias", async () => {
    // The other half of asking plainly. A beginner asked for "a cup" who says
    // "an espresso cup" must win, and the aliases are the credit path.
    const api = await client();
    await post(api, { level: "A2" });
    const enrich = callsOf("enrich")[0][0].messages[0].content;
    expect(enrich).toContain("THE SHARPER WORDS TOO");
    expect(enrich).toContain("an espresso cup");
    expect(enrich).toContain("Ask plainly, accept generously");
  });

  it("does not tell a high band to reach downward in its aliases", async () => {
    const api = await client();
    await post(api, { level: "C1" });
    const enrich = callsOf("enrich")[0][0].messages[0].content;
    expect(enrich).not.toContain("THE SHARPER WORDS TOO");
  });

  it("sets the CLUE SENTENCE level per band, shortest at A1", async () => {
    const api = await client();
    await post(api, { level: "A1" });
    const enrich = callsOf("enrich")[0][0].messages[0].content;
    expect(enrich).toContain("SENTENCE LEVEL");
    expect(enrich).toContain("Max 8 words");
    expect(enrich).toContain("No subordinate clauses");
  });

  it("lets C2 write at full range", async () => {
    const api = await client();
    await post(api, { level: "C2" });
    const enrich = callsOf("enrich")[0][0].messages[0].content;
    expect(enrich).toContain("SENTENCE LEVEL");
    expect(enrich).toContain("Fully idiomatic");
  });

  it("says the sentence level governs the CLUE and not the answer word", async () => {
    // The confusion this prevents: a band rule that reads as being about the
    // noun would undo LEVEL_GUIDE, which has already settled the noun.
    const api = await client();
    await post(api, { level: "B1" });
    const enrich = callsOf("enrich")[0][0].messages[0].content;
    expect(enrich).toContain("not the answer word");
  });
});

// ── The preference list ─────────────────────────────────────────────────────
//
// What the learner is already working on: words they have KEPT and words that
// have BEATEN them. It can only ever narrow toward things that are really in the
// picture, so the tests that matter are the ones that pin how WEAK it is.

describe("convo-image-targets preferences", () => {
  it("offers the learner's words to the scan, as a preference", async () => {
    const api = await client();
    await post(api, { prefer: ["mug", "windowsill"] });
    const text = JSON.stringify(callsOf("bandpass")[0][0].messages[1].content);
    expect(text).toContain("already working on");
    expect(text).toContain("- mug");
    expect(text).toContain("- windowsill");
    // The line that keeps this safe. A word planted in a picture that does not
    // contain it is a question with no answer, which is worse than not
    // revisiting it at all.
    expect(text).toContain("return none of");
  });

  it("says nothing at all when the learner has no words yet", async () => {
    const api = await client();
    await post(api);
    const text = JSON.stringify(callsOf("bandpass")[0][0].messages[1].content);
    expect(text).not.toContain("already working on");
  });

  it("carries them into the TOP-UP, which is where they matter most", async () => {
    // A top-up is already asking "what else is in here", which is exactly the
    // moment to reach for a word the learner is working on rather than for
    // whatever happens to be left.
    mockRound(
      [
        { label: "a mug", point: { x: 0.2, y: 0.5 }, cloze: "Holding ___.", choices: ["a mug", "a", "b", "c"] },
        { label: "a plate", point: { x: 0.4, y: 0.5 }, cloze: "Beside ___.", choices: ["a plate", "a", "b", "c"] },
      ],
      { topUp: [] },
    );
    const api = await client();
    await post(api, { prefer: ["windowsill"] });

    expect(callsOf("topUp")).toHaveLength(1);
    const text = JSON.stringify(callsOf("topUp")[0][0].messages[1].content);
    expect(text).toContain("already working on");
    expect(text).toContain("- windowsill");
  });

  it("does not repeat a word that is already in the misses list", async () => {
    // A missed word has its own, stronger instruction and its own revisit
    // marking. Naming it twice in one prompt is the same request asking for a
    // word in two voices.
    const api = await client();
    await post(api, { misses: ["a ticket"], prefer: ["a ticket", "mug"] });
    const text = JSON.stringify(callsOf("bandpass")[0][0].messages[1].content);
    expect(text).toContain("previously failed to name");
    expect(text).toContain("- mug");
    // Once, in the misses block, and not again in the preference block.
    expect(text.split("- a ticket").length - 1).toBe(1);
  });

  it("does not ask for a word it is simultaneously forbidding", async () => {
    // exclude is a hard rule for this picture. A word on both lists would be
    // demanded and forbidden in the same prompt.
    const api = await client();
    await post(api, { exclude: ["chair"], prefer: ["chair", "mug"] });
    const text = JSON.stringify(callsOf("bandpass")[0][0].messages[1].content);
    expect(text).toContain("- mug");
    expect(text.split("- chair").length - 1).toBe(1);
  });

  it("self-dedupes, because the caller merges two of its own lists", async () => {
    const api = await client();
    await post(api, { prefer: ["mug", "mug", "MUG"] });
    const text = JSON.stringify(callsOf("bandpass")[0][0].messages[1].content);
    expect(text.toLowerCase().split("- mug").length - 1).toBe(1);
  });

  it("caps the list, because a long enough preference stops being one", async () => {
    // This cap is the safety of the whole feature rather than a size limit. A
    // list covering most of a learner's vocabulary would have the model reaching
    // for a listed word on every picture, and a round where nothing new ever
    // appears is the opposite of what a picture is for.
    const many = Array.from({ length: 40 }, (_, i) => `pref${i}`);
    const api = await client();
    await post(api, { prefer: many });
    const text = JSON.stringify(callsOf("bandpass")[0][0].messages[1].content);
    expect(text).toContain("- pref11");
    expect(text).not.toContain("- pref12");
  });

  it("steers away from words met on OTHER pictures, softly", async () => {
    const api = await client();
    await post(api, { avoid: ["cup", "phone"] });
    const text = JSON.stringify(callsOf("bandpass")[0][0].messages[1].content);
    expect(text).toContain("on OTHER pictures");
    expect(text).toContain("- cup");
    // The sentence that keeps it a steer. A second cafe genuinely does contain a
    // cup, and refusing to ever teach it again is worse than teaching it twice.
    expect(text).toContain("steer and not a rule");
  });

  it("never asks for a word and steers away from it in the same prompt", async () => {
    const api = await client();
    await post(api, { prefer: ["cup"], avoid: ["cup", "phone"] });
    const text = JSON.stringify(callsOf("bandpass")[0][0].messages[1].content);
    expect(text).toContain("already working on");
    expect(text).toContain("- phone");
    // "cup" appears once, in the preference block, not again in the avoid list.
    expect(text.split("- cup").length - 1).toBe(1);
  });

  it("caps the steer lower than the exclusions, because a long steer is a rule", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `av${i}`);
    const api = await client();
    await post(api, { avoid: many });
    const text = JSON.stringify(callsOf("bandpass")[0][0].messages[1].content);
    expect(text).toContain("- av15");
    expect(text).not.toContain("- av16");
  });

  it("is never part of the cache key, so one learner cannot fork a picture", async () => {
    const api = await client();
    await post(api, { prefer: ["mug"] });
    const key = bandUpserts().at(-1).payload.image_key;

    sbState.upserts.length = 0;
    const api2 = await client();
    await post(api2, { prefer: ["windowsill", "lapel"] });
    expect(bandUpserts().at(-1).payload.image_key).toBe(key);
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
    const wrote = bandUpserts().length ? bandUpserts()[0].payload.targets.length : 0;
    expect(wrote === 0 || wrote > served).toBe(true);

    // And the tail does land, with more than was served.
    expect(await settled(() => bandUpserts().length > 0)).toBe(true);
    expect(bandUpserts().at(-1).payload.targets.length).toBeGreaterThan(served);
  });

  it("the follow-up collects the rest under the scanId it was given", async () => {
    const api = await client();
    const first = await post(api, { firstPlayable: true });
    expect(await settled(() => bandUpserts().length > 0)).toBe(true);

    // What the tail wrote is what a follow-up reads.
    // Exactly what the tail wrote, stamps included, which is what the next read
    // of that row will find.
    const wrote = bandUpserts().at(-1).payload;
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
    expect(callsOf("inventory")).toHaveLength(1);
  });

  it("sends the image as a vision content part at temperature 0", async () => {
    const api = await client();
    await post(api);

    const call = callsOf("inventory")[0][0];
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
    expect(callsOf("inventory")[0][0].model).toBe("vision-model");
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
    expect(bandUpserts()).toHaveLength(1);
    expect(bandUpserts()[0].payload.verified).toBe(4);
    expect(bandUpserts()[0].payload.targets).toEqual(stored);
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
    expect(callsOf("inventory")).toHaveLength(1); // ONCE, not once per bad target
    expect(bandUpserts()).toHaveLength(1);
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
    expect(callsOf("inventory")).toHaveLength(1);
    expect(bandUpserts()).toHaveLength(1);
    expect(bandUpserts()[0].payload.v).toBe(1);
  });

  it("an empty cached array is a MISS, not an empty round", async () => {
    sbState.row = { targets: [], v: 1 };
    const api = await client();
    const r = await post(api);
    expect(r.body.cached).toBe(false);
    expect(callsOf("inventory")).toHaveLength(1);
  });

  it("writes the cache keyed (image_key, lang, level) with the validated targets", async () => {
    const api = await client();
    const r = await post(api);

    expect(bandUpserts()).toHaveLength(1);
    const { table, payload, opts } = bandUpserts()[0];
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
    const system = callsOf("bandpass")[0][0].messages[0].content;
    expect(system).toContain("VOCABULARY LEVEL");
    expect(system).toContain("A1 beginner");

    const { payload, opts } = bandUpserts()[0];
    expect(payload.level).toBe("A1");
    expect(opts).toEqual({ onConflict: "image_key,lang,level" });
  });

  it("no level asked for stores the empty band, which is what old rows hold", async () => {
    const api = await client();
    await post(api);
    expect(bandUpserts()[0].payload.level).toBe("");
    expect(callsOf("bandpass")[0][0].messages[0].content).not.toContain("VOCABULARY LEVEL");
  });

  it("an unknown level is ignored rather than cached under a junk key", async () => {
    const api = await client();
    await post(api, { level: "Z9" });
    expect(bandUpserts()[0].payload.level).toBe("");
  });

  it("the two ends of the scale are told to lean inward", async () => {
    // A picture holds only so many A1 nouns, and a C2 round of genuinely rare
    // words stops being a game about the scene.
    const api = await client();
    await post(api, { level: "A1" });
    expect(callsOf("bandpass")[0][0].messages[0].content).toContain("lean up to A2");

    vi.resetModules();
    createSpy.mockClear();
    const api2 = await client();
    await post(api2, { level: "C2" });
    expect(callsOf("bandpass")[0][0].messages[0].content).toContain("lean down to C1");
  });

  it("a caller-supplied imageKey becomes the cache key", async () => {
    const api = await client();
    const r = await post(api, { imageKey: "convo-7-shot-3" });
    expect(r.body.imageKey).toBe("convo-7-shot-3");
    expect(bandUpserts()[0].payload.image_key).toBe("convo-7-shot-3");
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
    expect(bandUpserts().map((u) => u.payload.lang)).toEqual(["en", "es"]);
  });

  it("runs cacheless when Supabase env is missing", async () => {
    sbState.enabled = false;
    const api = await client();
    const r = await post(api);
    expect(r.status).toBe(200);
    expect(r.body.targets).toHaveLength(6);
    expect(bandUpserts()).toHaveLength(0);
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

    // Three verify cuts plus three tighten-pass padded cuts: every accepted
    // primary box buys ONE refinement crop (Stage D). The snug ask returns
    // nothing under this mock, so no recheck cut follows.
    expect(cropSpy).toHaveBeenCalledTimes(6);
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
      // The crop mock encodes the box it cut onto the end of the URI, so the
      // model mock can answer bounds about the right box.
      expect(images[0].image_url.url).toMatch(/^data:image\/jpeg;base64,QQ==#/);
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

    expect(cropSpy).toHaveBeenCalledTimes(3) // 2 instance checks + 1 tighten pad cut;
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
    const system = callsOf("inventory")[0][0].messages[0].content;
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
    expect(cropSpy).toHaveBeenCalledTimes(8) // 4 heal checks + 4 tighten pad cuts;
    expect(bandUpserts()).toHaveLength(1);
    expect(bandUpserts()[0].payload.verified).toBe(4);
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
    expect(callsOf("crop").length).toBeGreaterThan(0);
    // AND IT GOES LOOKING FOR INSTANCES. This assertion used to say the
    // opposite, on the reasoning that v8 gets instances from the locate call so
    // a second enumeration would be paying twice. That is true of a FRESH scan
    // and false of a cached row, which never went through today's locate call:
    // planning from the boxes the row happens to carry means a heal can lose an
    // instance and never find one. It is why "Where is a poster?" was asked in a
    // classroom covered in posters with one poster accepting.
    expect(callsOf("enumerate")).toHaveLength(1);
    expect(bandUpserts()).toHaveLength(1);
    expect(bandUpserts()[0].payload.verified).toBe(4);
  });

  it("finds an instance the cached row never held, and Find It can use it", async () => {
    // MARK'S POSTER, end to end. The row holds ONE poster box. The picture holds
    // three. Before the heal enumerated, boxCount was 1, instanceConfidence read
    // "one", and ispy-deal.js let Find It ask a question only one tap could
    // answer.
    sbState.row = {
      targets: [
        ...storedBoxed,
        {
          label: "a poster",
          point: { x: 0.12, y: 0.2 },
          box: { x: 0.08, y: 0.14, w: 0.08, h: 0.12 },
          cloze: "On the wall, ___.",
          choices: ["a poster", "a mirror", "a clock"],
          answerIndex: 0,
        },
      ],
      v: 1,
      verified: 2,
    };
    mockRound(enTargets(), {
      instances: [
        {
          i: 4,
          crowd: false,
          boxes: [
            { x: 0.08, y: 0.14, w: 0.08, h: 0.12 },
            { x: 0.4, y: 0.12, w: 0.09, h: 0.13 },
            { x: 0.72, y: 0.16, w: 0.08, h: 0.11 },
          ],
        },
      ],
    });
    const api = await client();
    const r = await post(api);

    const poster = r.body.targets.find((t) => t.label === "a poster");
    expect(poster.boxes).toHaveLength(3);
    expect(poster.instances).toBe("many");
  });

  it("declines rather than guessing when nothing counted the instances", async () => {
    // The other half, and the more important one: when the enumeration finds
    // nothing to say about a label, one box is one box and proves nothing about
    // how many there are. "unknown" is what ispy-deal.js refuses to deal into
    // Find It, so the game stops asking a question it cannot score instead of
    // asking it and being wrong.
    sbState.row = { targets: storedBoxed, v: 1, verified: 2 };
    mockRound(enTargets(), { instances: [] });
    const api = await client();
    const r = await post(api);

    // Asked of the targets FIND IT COULD DEAL, which is the mode the verdict
    // governs: a target with no box is already refused by playable() and its
    // instance count was never a question anyone asked.
    const boxed = r.body.targets.filter((t) => t.box || t.boxes?.length);
    expect(boxed.length).toBeGreaterThan(0);
    expect(boxed.every((t) => t.instances === "unknown")).toBe(true);
  });

  it("does not count one thing twice when the enumeration redraws its box", async () => {
    // THE OVER-COUNT, which is this finding pointing the other way. An
    // under-count makes Find It ask a question only one tap can answer; an
    // over-count makes it accept a tap on something that is not the thing.
    //
    // MEASURED, not imagined. On parents-1 the row's own box for the closed
    // laptop and the enumeration's box for the same laptop came out at IoU
    // 0.513, under the 0.6 same-referent threshold, and the target was served
    // "many" for a picture holding one laptop. Their containment is 0.888, which
    // is the number that tells the two cases apart: one object drawn twice
    // scores near 1, two separate posters on a wall score 0.
    sbState.row = {
      targets: [{ ...storedBoxed[0], box: { x: 0.38, y: 0.76, w: 0.55, h: 0.14 } }, ...storedBoxed.slice(1)],
      v: 1,
      verified: 2,
    };
    mockRound(enTargets(), {
      instances: [
        // only:true, because the point of this case is the DEDUPE and not the
        // certainty rule: without it the verdict would be "unknown" for the
        // right reason and the wrong test would be passing.
        { i: 0, crowd: false, only: true, boxes: [{ x: 0.405, y: 0.748, w: 0.441, h: 0.108 }] },
      ],
    });
    const api = await client();
    const r = await post(api);

    const mug = r.body.targets.find((t) => t.label === "a mug");
    expect(mug.boxes).toBeUndefined();
    expect(mug.instances).toBe("one");
  });

  it("refuses a single instance the enumeration is not sure is the only one", async () => {
    // MARK'S POSTER, and the answer his own photograph gives. Asked outright,
    // the enumeration returns ONE poster for parents-1 and says only:false,
    // because the classroom wall carries several and it did not box them. A
    // count of one taken as proof of singularity is the original bug in a newer
    // coat; asked whether it is sure, the honest answer is no, and Find It then
    // declines the label rather than asking a question whose right answers it
    // would mark wrong.
    sbState.row = { targets: storedBoxed, v: 1, verified: 2 };
    mockRound(enTargets(), {
      instances: [
        { i: 0, crowd: false, only: false, boxes: [{ x: 0.28, y: 0.55, w: 0.08, h: 0.1 }] },
        { i: 1, crowd: false, only: true, boxes: [{ x: 0.46, y: 0.45, w: 0.09, h: 0.12 }] },
      ],
    });
    const api = await client();
    const r = await post(api);

    expect(r.body.targets.find((t) => t.label === "a mug").instances).toBe("unknown");
    // And a label it IS sure about is asked normally. Erring toward "unknown"
    // costs a target; erring toward "one" costs the learner a correct tap, and
    // this has to be able to tell the two apart or it would refuse everything.
    expect(r.body.targets.find((t) => t.label === "an apron").instances).toBe("one");
  });

  it("refuses a label the picture holds a crowd of", async () => {
    sbState.row = { targets: storedBoxed, v: 1, verified: 2 };
    mockRound(enTargets(), {
      instances: [{ i: 0, crowd: true, boxes: [{ x: 0.28, y: 0.55, w: 0.08, h: 0.1 }] }],
    });
    const api = await client();
    const r = await post(api);

    expect(r.body.targets.find((t) => t.label === "a mug").instances).toBe("unknown");
  });

  it("re-derives ENRICHMENT on the heal, not only geometry", async () => {
    // The third of the three, and the one that was silently exempt. A row
    // written before riddles existed healed into a perfectly audited row with no
    // clues in it, and left the Riddle chip dark forever.
    sbState.row = { targets: storedBoxed, v: 1, verified: 2 };
    const api = await client();
    await post(api);

    expect(callsOf("enrich")).toHaveLength(1);
    const written = bandUpserts()[0].payload.targets;
    expect(written.every((t) => typeof t.cloze === "string" && Array.isArray(t.choices))).toBe(true);
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
    expect(callsOf("inventory")).toHaveLength(1);
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
    sbState.row = { targets: storedBoxed, v: 1, verified: 4 };
    const api = await client();
    const r = await post(api);

    expect(r.body.cached).toBe(true);
    expect(cropSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(bandUpserts()).toHaveLength(0);
  });

  it("stamps every answer with its own vintage", async () => {
    // WHAT MARK'S EYES ARE JUDGING HAS TO NAME ITSELF. A round served from a row
    // scanned three weeks ago and one generated ten seconds ago came down the
    // wire identical, so a fix that worked and a cached row that predates it
    // could not be told apart from outside the code.
    sbState.row = { targets: storedBoxed, v: 1, verified: 4, updated_at: "2026-08-01T10:00:00.000Z", model: "gpt-4.1-mini" };
    const api = await client();
    const r = await post(api);

    expect(r.body.vintage).toMatchObject({
      v: 1,
      verified: 4,
      at: "2026-08-01T10:00:00.000Z",
      source: "cache",
      now: { v: 1, verified: 4 },
    });
  });

  it("says HEALED when it healed, not merely CACHE", async () => {
    sbState.row = { targets: storedBoxed, v: 1, verified: 2, updated_at: "2026-08-01T10:00:00.000Z" };
    const api = await client();
    const r = await post(api);

    expect(r.body.vintage.source).toBe("healed");
    // Stamped at the audit level it was healed TO, so the badge does not report
    // a row as stale one serve after it stopped being stale.
    expect(r.body.vintage.verified).toBe(4);
  });

  it("says FRESH for a generation, and carries what expects it", async () => {
    sbState.row = null;
    const api = await client();
    const r = await post(api);

    expect(r.body.cached).toBe(false);
    expect(r.body.vintage.source).toBe("fresh");
    expect(r.body.vintage.now).toEqual({ v: 1, verified: 4 });
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
    const system = callsOf("bandpass")[0][0].messages[0].content;
    expect(system).toContain("VOCABULARY LEVEL");
    expect(system).toContain("driftwood");
    expect(system).toContain("a tourniquet");
    expect(system).toContain("MATERIALS");
    expect(system).toContain("PARTS");
  });

  it("the Spanish pack gets Spanish exemplars", async () => {
    const api = await client();
    await post(api, { level: "C1", lang: "es" });
    const system = callsOf("bandpass")[0][0].messages[0].content;
    expect(system).toContain("el torniquete");
    expect(system).toContain("la gasa");
    expect(system).not.toContain("driftwood");
  });

  it("only C1 and C2 get the self-check, and it names the failure it exists for", async () => {
    const api = await client();
    await post(api, { level: "C2" });
    const c2 = callsOf("bandpass")[0][0].messages[0].content;
    expect(c2).toContain("LEVEL SELF-CHECK");
    // The check SWAPS within the inventory now, never drops for visibility:
    // dropping the boarding pass for being visible is the filed airport bug.
    expect(c2).toContain("SWAP");
    expect(c2).toContain("a bucket hat");
    expect(c2).toContain("JUDGE THE WORD, NOT THE THING");

    vi.resetModules();
    createSpy.mockClear();
    const api2 = await client();
    await post(api2, { level: "B1" });
    expect(callsOf("bandpass")[0][0].messages[0].content).not.toContain("LEVEL SELF-CHECK");
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
    expect(bandUpserts()[0].payload.targets.map((t) => t.label)).toEqual(["a mug", "a chalkboard"]);
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
    expect(callsOf("inventory")).toHaveLength(1);
    expect(callsOf("enrich")).toHaveLength(1);

    // Locate: what and where, and the quality rules for a box a learner taps.
    const locate = callsOf("inventory")[0][0].messages[0].content;
    expect(locate).toContain('"box"');
    expect(locate).toContain("BOUNDING BOX");
    expect(locate).toContain("VISUALLY UNAMBIGUOUS");
    expect(locate).toContain("re-read your own list once");
    expect(locate).toContain("TIGHT");
    expect(locate).toContain("IT MUST CONTAIN ALL OF THE THING YOU NAMED");
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
    expect(callsOf("inventory")[0][0].messages[0].content).not.toContain('"aliases"');
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
    const system = callsOf("bandpass")[0][0].messages[0].content;
    expect(system).toContain("Spanish (neutral Latin American)");
    expect(system).toContain("la taza");
    expect(system).toContain("The article carries the gender");
    expect(system).not.toContain('"a mug"');
  });

  it("the en pack asks for English labels with their article", async () => {
    const api = await client();
    await post(api, { lang: "en" });
    const system = callsOf("bandpass")[0][0].messages[0].content;
    expect(system).toContain("English");
    expect(system).toContain('"a mug"');
    expect(system).not.toContain("neutral Latin American");
  });

  it("accepts `pack` as an alias for `lang` (the repo carries both names)", async () => {
    const api = await client();
    const r = await post(api, { lang: undefined, pack: "es" });
    expect(r.body.lang).toBe("es");
    expect(callsOf("bandpass")[0][0].messages[0].content).toContain("neutral Latin American");
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
    expect(callsOf("bandpass")[0][0].messages[0].content).toContain('"a mug"');
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
    expect(bandUpserts()).toHaveLength(0);
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
              '{"inventory":[{"gloss":"a mug","granularity":"object","point":{"x":0.3,"y":0.6},}]}',
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
    expect(bandUpserts()).toHaveLength(0);
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
    expect(bandUpserts()).toHaveLength(0);
  });
});

// ── Near misses, and the B1 band's own vocabulary ───────────────────────────

describe("convo-image-targets near misses", () => {
  it("asks the enrich call for reasonable descriptions that are NOT the word", async () => {
    const api = await client();
    await post(api, { level: "C1" });
    const enrich = callsOf("enrich")[0][0].messages[0].content;
    expect(enrich).toContain('"near"');
    expect(enrich).toContain("a ceiling leak");
    // The line that keeps it safe: a synonym here would make a right answer wrong.
    expect(enrich).toContain("belongs in");
    expect(enrich).toContain('"aliases"');
  });

  it("never keeps a near term that is also the label or an alias", async () => {
    // The guarantee: acceptance always wins. A term on both lists would turn a
    // correct answer into "close, try again".
    mockRound([
      {
        label: "a mug",
        point: { x: 0.3, y: 0.5 },
        box: { x: 0.25, y: 0.45, w: 0.1, h: 0.1 },
        cloze: "Holding ___.",
        choices: ["a mug", "a", "b", "c"],
        aliases: ["a cup"],
        near: ["a cup", "a mug", "a bowl"],
      },
    ]);
    const api = await client();
    const res = await post(api, { level: "B1" });
    const t = res.body.targets.find((x) => x.label === "a mug");
    expect(t).toBeTruthy();
    expect(t.near || []).not.toContain("a cup");
    expect(t.near || []).not.toContain("a mug");
    expect(t.near || []).toContain("a bowl");
  });

  it("omits the field entirely rather than shipping an empty one", async () => {
    mockRound([
      {
        label: "a plate",
        point: { x: 0.3, y: 0.5 },
        box: { x: 0.25, y: 0.45, w: 0.1, h: 0.1 },
        cloze: "Beside ___.",
        choices: ["a plate", "a", "b", "c"],
      },
    ]);
    const api = await client();
    const res = await post(api, { level: "B1" });
    expect(res.body.targets[0]).not.toHaveProperty("near");
  });
});

describe("convo-image-targets B1 vocabulary", () => {
  it("puts workplace and safety kit ABOVE B1, naming the filed words", async () => {
    // Mark questioned "a clipboard" and "an apron" at B1. The object is
    // ordinary; the WORD is not one a B1 learner holds.
    const api = await client();
    await post(api, { level: "B1" });
    const sys = callsOf("bandpass")[0][0].messages[0].content;
    expect(sys).toContain("a clipboard");
    expect(sys).toContain("an apron");
    expect(sys).toContain("B2 or above");
  });

  it("keeps parts of things out of B1, where C1 owns them", async () => {
    const api = await client();
    await post(api, { level: "B1" });
    const sys = callsOf("bandpass")[0][0].messages[0].content;
    expect(sys).toContain("a windowsill");
    expect(sys).toContain("are parts, and parts");
  });

  it("offers B1 examples a B1 learner would actually hold", async () => {
    const api = await client();
    await post(api, { level: "B1" });
    const sys = callsOf("bandpass")[0][0].messages[0].content;
    for (const w of ["a backpack", "a receipt", "a blanket", "a napkin"]) {
      expect(sys, w).toContain(w);
    }
    // And the old over-reaching examples are gone from the YES list.
    expect(sys).not.toContain('"a first-aid kit".');
  });
});


// ── Stage D: the tighten pass ───────────────────────────────────────────────
//
// A box that passed verification is not necessarily SNUG, and the arrow anchors
// on the box edge: a loose box parks the arrow beside the object. Every gate in
// the refinement fails toward the box that already passed, and these tests are
// those gates.

describe("convo-image-targets box tightening", () => {
  const loose = () => [{
    label: "a kettle",
    point: { x: 0.5, y: 0.5 },
    box: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
    cloze: "On the stove sits ___.",
    choices: ["a kettle", "a pot", "a pan", "a jug"],
  }];

  it("REFUSES a recentre that is not the crop's main subject", async () => {
    // A recentre says the thing is somewhere else entirely, which is a much
    // bigger claim than a shrink. Measured on a real scan, a loose recentre
    // moved a correct box off a man in a suit and onto the window behind him.
    mockRound(loose(), { snug: { x: 0.85, y: 0.85, w: 0.12, h: 0.12 }, prominence: "part" });
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].box).toEqual({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
  });

  it("keeps the tighter box when it shrinks and still shows the thing", async () => {
    // The snug ask answers in CROP fractions; centred half-size inside the
    // padded crop maps back to a strictly smaller image box.
    mockRound(loose(), { snug: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 } });
    const api = await client();
    const r = await post(api);
    const t = r.body.targets[0];
    expect(t.box.w).toBeLessThan(0.2);
    expect(t.box.h).toBeLessThan(0.2);
    // The point follows the box it belongs to.
    expect(t.point.x).toBeCloseTo(t.box.x + t.box.w / 2, 5);
    expect(t.point.y).toBeCloseTo(t.box.y + t.box.h / 2, 5);
  });

  it("keeps the ORIGINAL box when the tightened crop no longer shows it", async () => {
    // A snug box of the wrong thing is worse than a loose box of the right one.
    // First ask per box passes verification; opts.shows turns false afterwards,
    // so the recheck on the tightened crop fails.
    let asks = 0;
    mockRound(loose(), {
      snug: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },
      shows: () => { asks += 1; return asks <= 1; },
    });
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].box).toEqual({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
  });

  it("does not churn a box for a marginal shrink", async () => {
    // Nearly the whole padded crop: bigger than 90% of the old area once
    // mapped back, so not worth keeping.
    mockRound(loose(), { snug: { x: 0.02, y: 0.02, w: 0.96, h: 0.96 } });
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].box).toEqual({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
  });

  it("keeps the original when the snug ask declines", async () => {
    mockRound(loose()); // no opts.snug: the tighten branch answers absent
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].box).toEqual({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
  });
});


// ── Coverage, not centring (v11 B, upgraded in v12) ─────────────────────────
//
// The crop is PADDED, by 55 percent each side and 85 below, which is right for
// judging and is exactly how a displaced box passed: a box over the window
// between two people cuts a crop containing slivers of both jackets, so "is a
// suit jacket visible in this crop" is honestly yes.
//
// Centring caught that and missed the other half. A clipboard box starting
// below the clip still held the clipboard's CENTRE; a person's box starting at
// the chin still held most of the person. Both passed, and both were filed from
// a rendered scan. Coverage asks the two questions a bounding box is actually
// making a claim about: does it CONTAIN the thing, and is it not much BIGGER
// than the thing.

describe("convo-image-targets box coverage", () => {
  const one = (label) => [{
    label,
    point: { x: 0.5, y: 0.5 },
    box: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 },
    cloze: "Here is ___.",
    choices: [label, "a pot", "a pan", "a jug"],
  }];

  it("keeps a box that bounds its thing", async () => {
    mockRound(one("a kettle"));
    const api = await client();
    const r = await post(api);
    expect(r.body.targets).toHaveLength(1);
    expect(r.body.targets[0].box).toEqual({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 });
  });

  it("REDRAWS a box whose thing is beside it, rather than accepting it", async () => {
    // The thing is over at the left of the padded crop, so the box names
    // something else. The bounds the model just gave ARE the thing's place, so
    // the box is redrawn to them and re-checked rather than dropped.
    mockRound(one("a suit jacket"), { bounds: (b) => (b && b.x === 0.4 && b.w === 0.1 ? { x: 0.0, y: 0.28, w: 0.16, h: 0.44 } : undefined) });
    const api = await client();
    const r = await post(api);
    expect(r.body.targets).toHaveLength(1);
    expect(r.body.targets[0].box.x).toBeLessThan(0.4);
  });

  it("REDRAWS a box that covers only PART of its thing", async () => {
    // The clipboard case: the box starts below the clip, so it holds the
    // thing's centre and passed centring while covering half of it.
    mockRound(one("a clipboard"), { bounds: (b) => (b && b.x === 0.4 && b.w === 0.1 ? { x: 0.26, y: 0.05, w: 0.48, h: 0.67 } : undefined) });
    const api = await client();
    const r = await post(api);
    expect(r.body.targets).toHaveLength(1);
    expect(r.body.targets[0].box.y).toBeLessThan(0.4);
  });

  it("REDRAWS a box that is mostly not the thing", async () => {
    // A box several times the thing's area accepts taps on whatever else is in
    // it. This is the test a person's box swallowing the window fails. The
    // bounds have to map to a SERVABLE box: a redraw is held to the same box
    // gate a model's own box is, and anything under the minimum side is a
    // failure rather than a licence to keep the box that just failed.
    mockRound(one("a name badge"), { bounds: (b) => (b && b.x === 0.4 && b.w === 0.1 ? { x: 0.42, y: 0.4, w: 0.16, h: 0.2 } : undefined) });
    const api = await client();
    const r = await post(api);
    expect(r.body.targets).toHaveLength(1);
    expect(r.body.targets[0].box.w).toBeLessThan(0.1);
  });

  it("drops the target when the REDRAW does not check out either", async () => {
    // A redraw is a new claim and gets its own check.
    let asks = 0;
    mockRound(one("a suit jacket"), {
      bounds: { x: 0.0, y: 0.28, w: 0.16, h: 0.44 },
      shows: () => ++asks <= 1,
    });
    const api = await client();
    const r = await post(api);
    expect(r.body.targets).toHaveLength(0);
    expect(r.body.reason).toBe("no_valid_targets");
  });

  it("forgives excess on a thing that runs past the crop's edge", async () => {
    // Bounds clipped at the edge understate the thing's area, so the excess
    // ratio would convict an honest box for being bigger than the fragment it
    // could see.
    mockRound(one("a long banner"), { bounds: { x: 0.26, y: 0.28, w: 0.16, h: 0.16 }, cut: true });
    const api = await client();
    const r = await post(api);
    expect(r.body.targets).toHaveLength(1);
    expect(r.body.targets[0].box).toEqual({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 });
  });

  it("keeps a box when the model did not answer at all", async () => {
    // An unanswerable question is not evidence against the box, and a cached
    // judgement from before the field existed is the same shape.
    mockRound(one("a kettle"), { bounds: null });
    const api = await client();
    const r = await post(api);
    expect(r.body.targets).toHaveLength(1);
  });
});


// ── The boxless odd one out (v11 B) ─────────────────────────────────────────
//
// A boxless entry cannot be crop-verified, tightened, tapped or pointed at: it
// is served on the model's unchecked word alone. A real scan served "a paper
// clip" that way, with its point on a bare table edge. But a whole answer with
// no boxes is a different regime, and rows cached before boxes existed still
// live in it, so only the odd one out goes.

describe("convo-image-targets boxless entries", () => {
  const withBox = (label, x) => ({
    label, point: { x, y: 0.5 }, box: { x, y: 0.4, w: 0.08, h: 0.12 },
    cloze: "Here is ___.", choices: [label, "a pot", "a pan", "a jug"],
  });
  const noBox = (label, x) => ({
    label, point: { x, y: 0.5 },
    cloze: "Here is ___.", choices: [label, "a pot", "a pan", "a jug"],
  });

  it("drops the one entry that came back without a box", async () => {
    mockRound([withBox("a kettle", 0.2), noBox("a paper clip", 0.5), withBox("a ladle", 0.7)]);
    const api = await client();
    const r = await post(api);
    expect(r.body.targets.map((t) => t.label)).toEqual(["a kettle", "a ladle"]);
  });

  it("keeps an answer that gave no boxes AT ALL, which is a different regime", async () => {
    // Rows cached before boxes existed still live here, and so does a model
    // answering an older shape. Dropping these would empty the round.
    mockRound([noBox("a mug", 0.2), noBox("a jar", 0.5), noBox("a window", 0.8)]);
    const api = await client();
    const r = await post(api);
    expect(r.body.targets.map((t) => t.label)).toEqual(["a mug", "a jar", "a window"]);
  });
});
