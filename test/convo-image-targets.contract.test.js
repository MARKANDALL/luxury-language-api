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
    { label: "a counter", point: { x: 0.5, y: 0.78 }, cloze: "The keys are lying on ___.", choices: ["a counter", "a shelf", "a bench", "a table"], difficulty: "easy" },
    { label: "a window", point: { x: 0.86, y: 0.3 }, cloze: "Light comes in through ___.", choices: ["a window", "a door", "a mirror", "a lamp"], difficulty: "easy" },
    { label: "a chalkboard", point: { x: 0.15, y: 0.22 }, cloze: "The prices are written on ___.", choices: ["a chalkboard", "a poster", "a napkin", "a receipt"], difficulty: "hard" },
    { label: "a plant", point: { x: 0.7, y: 0.68 }, cloze: "There is ___ beside the till.", choices: ["a plant", "a basket", "a stool", "a crate"], difficulty: "medium" },
  ];
}

function modelReply(targets) {
  return { choices: [{ message: { content: JSON.stringify({ targets }) } }] };
}

beforeEach(() => {
  vi.resetModules();
  createSpy.mockReset();
  createSpy.mockResolvedValue(modelReply(enTargets()));
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
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("sends the image as a vision content part at temperature 0", async () => {
    const api = await client();
    await post(api);

    const call = createSpy.mock.calls[0][0];
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
    expect(createSpy.mock.calls[0][0].model).toBe("vision-model");
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
    expect(sbState.upserts).toHaveLength(0);
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

  it("a row stamped with an older schema version is a MISS and is overwritten", async () => {
    sbState.row = { targets: [{ label: "stale" }], v: 0 };
    const api = await client();
    const r = await post(api);

    expect(r.body.cached).toBe(false);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(sbState.upserts).toHaveLength(1);
    expect(sbState.upserts[0].payload.v).toBe(1);
  });

  it("an empty cached array is a MISS, not an empty round", async () => {
    sbState.row = { targets: [], v: 1 };
    const api = await client();
    const r = await post(api);
    expect(r.body.cached).toBe(false);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("writes the cache keyed (image_key, lang) with the validated targets", async () => {
    const api = await client();
    const r = await post(api);

    expect(sbState.upserts).toHaveLength(1);
    const { table, payload, opts } = sbState.upserts[0];
    expect(table).toBe("image_targets");
    expect(opts).toEqual({ onConflict: "image_key,lang" });
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

// ── Validation: the three things that make a target playable ────────────────

describe("convo-image-targets validation", () => {
  it("drops a target whose point is outside the image", async () => {
    createSpy.mockResolvedValue(
      modelReply([
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
    createSpy.mockResolvedValue(
      modelReply([
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
    createSpy.mockResolvedValue(
      modelReply([
        { label: "a mug", point: { x: 0, y: 1 }, cloze: "Holding ___.", choices: ["a mug", "a plate", "a kettle", "a spoon"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].point).toEqual({ x: 0.03, y: 0.97 });
  });

  it("normalizes a long underscore run into the ___ blank", async () => {
    createSpy.mockResolvedValue(
      modelReply([
        { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "The barista is holding ______.", choices: ["a mug", "a plate", "a kettle", "a spoon"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].cloze).toBe("The barista is holding ___.");
  });

  it("blanks the word itself when the model forgot the blank", async () => {
    createSpy.mockResolvedValue(
      modelReply([
        { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "The barista is holding a mug.", choices: ["a mug", "a plate", "a kettle", "a spoon"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].cloze).toBe("The barista is holding a ___");
  });

  it("drops a cloze that leaks its own answer alongside the blank", async () => {
    createSpy.mockResolvedValue(
      modelReply([
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
    createSpy.mockResolvedValue(
      modelReply([
        { label: "la taza de café", point: { x: 0.3, y: 0.6 }, cloze: "La taza de café está junto a ___.", choices: ["la taza de café", "el plato", "la olla", "la cuchara"] },
        { label: "la planta", point: { x: 0.7, y: 0.68 }, cloze: "Hay ___ aquí.", choices: ["la planta", "la silla", "la cesta", "el cajón"] },
      ])
    );
    const api = await client();
    const r = await post(api, { lang: "es" });
    expect(r.body.targets.map((t) => t.label)).toEqual(["la planta"]);
  });

  it("blanks a MULTI-WORD answer when the model forgot the blank", async () => {
    createSpy.mockResolvedValue(
      modelReply([
        { label: "the coffee cup", point: { x: 0.3, y: 0.6 }, cloze: "She is holding the coffee cup.", choices: ["the coffee cup", "the plate", "the kettle", "the spoon"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].cloze).toBe("She is holding the ___");
  });

  it("drops a target with no usable cloze at all", async () => {
    createSpy.mockResolvedValue(
      modelReply([
        { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "The barista is busy today.", choices: ["a mug", "a plate", "a kettle", "a spoon"] },
        { label: "a plant", point: { x: 0.7, y: 0.68 }, cloze: "There is ___ here.", choices: ["a plant", "a basket", "a stool", "a crate"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets.map((t) => t.label)).toEqual(["a plant"]);
  });

  it("always includes the answer in choices, even when the model omits it", async () => {
    createSpy.mockResolvedValue(
      modelReply([
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
    createSpy.mockResolvedValue(
      modelReply([
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
    createSpy.mockResolvedValue(
      modelReply([
        { label: "la taza", point: { x: 0.3, y: 0.6 }, cloze: "Está sosteniendo ___.", choices: ["la taza", "el plato", "la olla", "la cuchara"] },
        { label: "una taza", point: { x: 0.6, y: 0.4 }, cloze: "Hay ___ en la mesa.", choices: ["una taza", "un plato", "una olla", "una cuchara"] },
        { label: "la planta", point: { x: 0.7, y: 0.68 }, cloze: "Hay ___ aquí.", choices: ["la planta", "la silla", "la cesta", "el cajón"] },
      ])
    );
    const api = await client();
    const r = await post(api, { lang: "es" });
    expect(r.body.targets.map((t) => t.label)).toEqual(["la taza", "la planta"]);
  });

  it("caps the set at 8 targets", async () => {
    const many = [];
    for (let i = 0; i < 12; i++) {
      many.push({
        label: `thing${i}`,
        point: { x: 0.1 + i * 0.05, y: 0.5 },
        cloze: `Here is ___ number ${i}.`,
        choices: [`thing${i}`, `other${i}`, `spare${i}`, `extra${i}`],
      });
    }
    createSpy.mockResolvedValue(modelReply(many));
    const api = await client();
    const r = await post(api);
    expect(r.body.targets).toHaveLength(8);
  });

  it("puts the marker at the BOX CENTRE when there is a usable box", async () => {
    // The second playtest's grounding failure: a point a little off the
    // calculator read as the desk behind it. The box says which was meant, and
    // its centre beats a separately-estimated point.
    createSpy.mockResolvedValue(
      modelReply([
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
      createSpy.mockResolvedValue(
        modelReply([
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

  it("asks for a box and for a literal, unambiguous cloze, in the same one call", async () => {
    const api = await client();
    await post(api);
    expect(createSpy).toHaveBeenCalledTimes(1);
    const system = createSpy.mock.calls[0][0].messages[0].content;
    expect(system).toContain('"box"');
    expect(system).toContain("BOUNDING BOX");
    expect(system).toContain("LITERALLY TRUE OF THIS IMAGE");
    expect(system).toContain("VISUALLY UNAMBIGUOUS");
    expect(system).toContain("re-read your own list once");
  });

  it("always offers the bare head noun as an alias", async () => {
    // Dropping the article is the commonest near miss there is, and it must
    // never be graded wrong, whatever the model chose to return.
    createSpy.mockResolvedValue(
      modelReply([
        { label: "a coffee mug", point: { x: 0.3, y: 0.6 }, cloze: "Holding ___.", choices: ["a coffee mug", "a plate", "a kettle", "a spoon"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(r.body.targets[0].aliases).toContain("coffee mug");
  });

  it("keeps the model's own aliases, capped and de-duplicated", async () => {
    createSpy.mockResolvedValue(
      modelReply([
        {
          label: "a computer monitor",
          point: { x: 0.3, y: 0.6 },
          cloze: "She is looking at ___.",
          choices: ["a computer monitor", "a keyboard", "a printer", "a laptop"],
          aliases: ["monitor", "screen", "a display", "MONITOR", "computer screen", "one more", "and another"],
        },
      ])
    );
    const api = await client();
    const r = await post(api);
    const aliases = r.body.targets[0].aliases;
    expect(aliases.length).toBeLessThanOrEqual(4);
    expect(aliases).toContain("computer monitor"); // the head noun, added first
    expect(aliases).toContain("screen");
    // "MONITOR" folds to the same thing as "monitor"; only one survives.
    expect(aliases.filter((a) => a.toLowerCase() === "monitor")).toHaveLength(1);
  });

  it("refuses an alias that is one of the wrong choices", async () => {
    // An alias marks an answer correct. If it collided with a distractor, that
    // distractor would become a right answer and the question would be broken.
    createSpy.mockResolvedValue(
      modelReply([
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
    createSpy.mockResolvedValue(
      modelReply([
        { label: "a mug", point: { x: 0.3, y: 0.6 }, cloze: "Holding ___.", choices: ["a mug", "a plate", "a kettle", "a spoon"] },
      ])
    );
    const api = await client();
    const r = await post(api);
    expect(Array.isArray(r.body.targets[0].aliases)).toBe(true);
    expect(r.body.targets[0].aliases).toEqual(["mug"]);
  });

  it("asks the model for aliases in the same single call", async () => {
    const api = await client();
    await post(api);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][0].messages[0].content).toContain('"aliases"');
  });

  it("normalizes an unknown difficulty to medium", async () => {
    createSpy.mockResolvedValue(
      modelReply([
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
    const system = createSpy.mock.calls[0][0].messages[0].content;
    expect(system).toContain("Spanish (neutral Latin American)");
    expect(system).toContain("la taza");
    expect(system).toContain("The article carries the gender");
    expect(system).not.toContain('"a mug"');
  });

  it("the en pack asks for English labels with their article", async () => {
    const api = await client();
    await post(api, { lang: "en" });
    const system = createSpy.mock.calls[0][0].messages[0].content;
    expect(system).toContain("English");
    expect(system).toContain('"a mug"');
    expect(system).not.toContain("neutral Latin American");
  });

  it("accepts `pack` as an alias for `lang` (the repo carries both names)", async () => {
    const api = await client();
    const r = await post(api, { lang: undefined, pack: "es" });
    expect(r.body.lang).toBe("es");
    expect(createSpy.mock.calls[0][0].messages[0].content).toContain("neutral Latin American");
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
    expect(createSpy.mock.calls[0][0].messages[0].content).toContain('"a mug"');
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
    createSpy.mockResolvedValue(
      modelReply([
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
    createSpy.mockResolvedValue(
      modelReply([
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
    createSpy.mockResolvedValue(
      modelReply(
        enTargets().map((t) => ({ ...t, point: { x: t.point.x * 100, y: t.point.y * 100 } }))
      )
    );
    const api = await client();
    const r = await post(api);
    expect(r.body).toMatchObject({ ok: true, targets: [], reason: "no_valid_targets" });
  });

  it("a model that finds nothing nameable is no_targets", async () => {
    createSpy.mockResolvedValue(modelReply([]));
    const api = await client();
    const r = await post(api);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, targets: [], reason: "no_targets" });
    expect(sbState.upserts).toHaveLength(0);
  });
});
