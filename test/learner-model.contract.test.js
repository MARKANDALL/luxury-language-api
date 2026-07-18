// test/learner-model.contract.test.js
// Contract + unit test for Speech Intelligence Phase 4a /api/router?route=learner-model.
// The route reads speech_events (through the mocked Supabase admin client) and
// aggregates a longitudinal Learner Model in pure JS. Hermetic: no network, no model.
//
// Two layers:
//  1) aggregateSpeechEvents(rows, labels, nowMs) — the pure aggregation, unit-tested
//     with a fixed nowMs so recencyDays/salience are deterministic. Covers totals,
//     salience ordering, all FOUR trend states, crutch tally/normalization, AFN
//     (<=3, excludes 'resolved'), strengths, severityMix, and the empty shape.
//  2) the HTTP contract through the router — admin gate, graceful degrade, empty
//     shape on no rows / missing uid, and label resolution in es AND en.
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";
import { aggregateSpeechEvents } from "../routes/learner-model.js";

// ── Shared, hoisted mock state the vi.mock factory can see. enabled:false
// simulates a missing Supabase env (getSupabaseAdmin throws). ─────────────────
const { sbState } = vi.hoisted(() => ({
  sbState: { rows: [], enabled: true, throwOnRead: false },
}));

vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: () => {
    if (!sbState.enabled) throw new Error("SUPABASE_URL is required");
    return {
      from() {
        const result = { data: sbState.rows, error: null };
        // Chainable + thenable: `await sb.from(t).select()...limit()` -> result.
        // throwOnRead simulates the real Supabase client throwing mid-read (a
        // DB-layer exception) so we can prove the route degrades, never 500s.
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          then: (resolve, reject) => {
            if (sbState.throwOnRead) {
              const err = new Error("simulated supabase read failure");
              return reject ? reject(err) : Promise.reject(err);
            }
            return resolve(result);
          },
        };
        return chain;
      },
    };
  },
}));

beforeEach(() => {
  vi.resetModules();
  process.env.ADMIN_TOKEN = "test_admin_token";
  sbState.enabled = true;
  sbState.rows = [];
  sbState.throwOnRead = false;
});

async function client() {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  return request(mkServer(handler));
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — the pure aggregation (deterministic nowMs).
// ─────────────────────────────────────────────────────────────────────────────

// Fixed "today" so recencyDays/salience are reproducible.
const NOW = Date.parse("2026-07-18T00:00:00Z");

// Seven sessions, oldest -> newest. Ranked by recency, the 5 newest (s3..s7) are
// the "recent" window; s1+s2 are "prior".
const D = {
  s1: "2026-06-01T10:00:00Z",
  s2: "2026-06-05T10:00:00Z",
  s3: "2026-06-20T10:00:00Z",
  s4: "2026-07-01T10:00:00Z",
  s5: "2026-07-08T10:00:00Z",
  s6: "2026-07-14T10:00:00Z",
  s7: "2026-07-17T10:00:00Z",
};

const WORD_CHOICE = new Set(["crutch_words", "precision", "collocations"]);
function item(session_id, category, severity, created_at, extra = {}) {
  return {
    session_id,
    channel: WORD_CHOICE.has(category) ? "word_choice" : "grammar",
    category,
    severity,
    utterance: extra.utterance ?? null,
    suggestion: extra.suggestion ?? null,
    explanation: extra.explanation ?? null,
    created_at,
  };
}
function strength(session_id, created_at, extra = {}) {
  return {
    session_id,
    channel: "strength",
    category: null,
    severity: "positive",
    utterance: extra.utterance ?? null,
    suggestion: null,
    explanation: extra.note ?? null,
    created_at,
  };
}

// A synthetic learner engineered to exhibit every behavior at once.
const FIXTURE = [
  // subjunctive — present in prior + recent at a similar rate => PERSISTENT; top salience.
  item("s1", "subjunctive", "noticeable", D.s1),
  item("s2", "subjunctive", "noticeable", D.s2),
  item("s3", "subjunctive", "noticeable", D.s3),
  item("s4", "subjunctive", "blocked", D.s4),
  item("s5", "subjunctive", "noticeable", D.s5),
  item("s6", "subjunctive", "noticeable", D.s6),
  item("s7", "subjunctive", "polish", D.s7, {
    utterance: "quiero que vengas",
    suggestion: "quiero que vengas mañana",
    explanation: "Buen uso del subjuntivo, ampliable.",
  }),

  // articles — only in the newest session, no prior => EMERGING.
  item("s7", "articles", "blocked", "2026-07-17T10:05:00Z"),
  item("s7", "articles", "blocked", "2026-07-17T10:06:00Z"),

  // crutch_words — present in prior + recent => PERSISTENT; drives the crutch tally.
  item("s7", "crutch_words", "polish", "2026-07-17T10:10:00Z", { utterance: "muy" }),
  item("s6", "crutch_words", "polish", D.s6, { utterance: "muy" }),
  item("s5", "crutch_words", "polish", D.s5, { utterance: " MUY " }), // normalize: trim+lower
  item("s4", "crutch_words", "polish", D.s4, { utterance: "cosa" }),
  item("s3", "crutch_words", "polish", D.s3, { utterance: "Cosa" }), // normalize: case
  item("s2", "crutch_words", "polish", D.s2, { utterance: "muy" }),

  // ser_estar — heavy in prior, nearly gone recently => IMPROVING.
  item("s1", "ser_estar", "noticeable", D.s1),
  item("s1", "ser_estar", "noticeable", "2026-06-01T10:01:00Z"),
  item("s1", "ser_estar", "noticeable", "2026-06-01T10:02:00Z"),
  item("s2", "ser_estar", "noticeable", D.s2),
  item("s2", "ser_estar", "noticeable", "2026-06-05T10:01:00Z"),
  item("s2", "ser_estar", "noticeable", "2026-06-05T10:02:00Z"),
  item("s5", "ser_estar", "polish", D.s5),

  // precision — only in prior, absent from the recent window => RESOLVED.
  item("s1", "precision", "polish", D.s1),
  item("s2", "precision", "polish", D.s2),

  // strengths (channel='strength').
  strength("s7", "2026-07-17T12:00:00Z", { utterance: "utteranceA", note: "noteA" }),
  strength("s6", "2026-07-14T12:00:00Z", { utterance: "utteranceB", note: "noteB" }),
  strength("s5", "2026-07-08T12:00:00Z", { utterance: "utteranceC", note: "noteC" }),
  strength("s4", "2026-07-01T12:00:00Z", { utterance: "utteranceD", note: "noteD" }),
];

const EMPTY_MODEL = {
  totals: { sessions: 0, events: 0, firstSeen: null, lastSeen: null },
  categories: [],
  crutchWords: [],
  afn: [],
  strengths: { n: 0, recent: [] },
};

describe("aggregateSpeechEvents (pure)", () => {
  const labels = new Map([["subjunctive", "Subjuntivo"]]); // one mapped, rest fall back
  const model = aggregateSpeechEvents(FIXTURE, labels, NOW);
  const byCode = Object.fromEntries(model.categories.map((c) => [c.code, c]));

  it("computes totals (sessions distinct, events = items only, first/last over items)", () => {
    expect(model.totals).toEqual({
      sessions: 7,
      events: 24,
      firstSeen: "2026-06-01T10:00:00Z",
      lastSeen: "2026-07-17T10:10:00Z",
    });
  });

  it("sorts categories most-salient first", () => {
    expect(model.categories.map((c) => c.code)).toEqual([
      "subjunctive",
      "crutch_words",
      "articles",
      "ser_estar",
      "precision",
    ]);
  });

  it("resolves labels from the dictionary and falls back to the raw code", () => {
    expect(byCode.subjunctive.label).toBe("Subjuntivo");
    expect(byCode.ser_estar.label).toBe("ser_estar"); // unmapped -> raw code
  });

  it("produces all four trend states", () => {
    expect(byCode.subjunctive.trend).toBe("persistent");
    expect(byCode.crutch_words.trend).toBe("persistent");
    expect(byCode.articles.trend).toBe("emerging");
    expect(byCode.ser_estar.trend).toBe("improving");
    expect(byCode.precision.trend).toBe("resolved");
  });

  it("tallies severityMix over blocked/noticeable/polish", () => {
    expect(byCode.subjunctive.severityMix).toEqual({ blocked: 1, noticeable: 5, polish: 1 });
    expect(byCode.crutch_words.severityMix).toEqual({ blocked: 0, noticeable: 0, polish: 6 });
  });

  it("takes lastExample from the newest row in the category", () => {
    expect(byCode.subjunctive.lastExample).toEqual({
      utterance: "quiero que vengas",
      suggestion: "quiero que vengas mañana",
      explanation: "Buen uso del subjuntivo, ampliable.",
    });
  });

  it("tallies + normalizes crutch words (case/whitespace) with lastSeen", () => {
    expect(model.crutchWords).toEqual([
      { term: "muy", n: 4, lastSeen: "2026-07-17T10:10:00Z" },
      { term: "cosa", n: 2, lastSeen: "2026-07-01T10:00:00Z" },
    ]);
  });

  it("derives AFN: <=3, salience order, excludes 'resolved'", () => {
    expect(model.afn.map((a) => a.code)).toEqual(["subjunctive", "crutch_words", "articles"]);
    expect(model.afn.every((a) => a.trend !== "resolved")).toBe(true);
    expect(model.afn.some((a) => a.code === "precision")).toBe(false);
    // reason is a generic, pack-agnostic fallback built from n + trend (no Spanish).
    expect(model.afn[0]).toEqual({
      code: "subjunctive",
      label: "Subjuntivo",
      n: 7,
      trend: "persistent",
      reason: "7×, still recurring",
    });
  });

  it("collects strengths (n + newest ~3 as {utterance, note, lastSeen})", () => {
    expect(model.strengths.n).toBe(4);
    expect(model.strengths.recent).toHaveLength(3);
    expect(model.strengths.recent[0]).toEqual({
      utterance: "utteranceA",
      note: "noteA",
      lastSeen: "2026-07-17T12:00:00Z",
    });
  });

  it("returns the empty shape for no rows", () => {
    expect(aggregateSpeechEvents([], new Map(), NOW)).toEqual(EMPTY_MODEL);
    expect(aggregateSpeechEvents(null, new Map(), NOW)).toEqual(EMPTY_MODEL);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — the HTTP contract through the router.
// ─────────────────────────────────────────────────────────────────────────────

describe("learner-model contract (HTTP)", () => {
  it("aggregates a real uid+pack and resolves es labels (200 ok)", async () => {
    sbState.rows = [
      item("a", "subjunctive", "noticeable", "2026-07-17T10:00:00Z", {
        utterance: "es muy tarde",
        explanation: "Aquí correspondía el subjuntivo.",
      }),
      item("a", "crutch_words", "polish", "2026-07-17T10:01:00Z", { utterance: "Muy" }),
      strength("a", "2026-07-17T10:02:00Z", { utterance: "bien dicho", note: "buen registro" }),
    ];
    const api = await client();
    const r = await api
      .post("/api/router?route=learner-model")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "u-1", pack: "es" });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.pack).toBe("es");
    expect(r.body.model.totals.events).toBe(2); // strengths excluded
    expect(r.body.model.totals.sessions).toBe(1);
    const sub = r.body.model.categories.find((c) => c.code === "subjunctive");
    expect(sub.label).toBe("Subjuntivo");
    expect(r.body.model.crutchWords).toEqual([
      { term: "muy", n: 1, lastSeen: "2026-07-17T10:01:00Z" },
    ]);
    expect(r.body.model.strengths.n).toBe(1);
  });

  it("resolves en labels and falls back to the raw code for es-only codes", async () => {
    sbState.rows = [
      item("a", "articles", "noticeable", "2026-07-17T10:00:00Z"), // in the en stub
      item("a", "subjunctive", "noticeable", "2026-07-17T10:01:00Z"), // NOT in the en stub
    ];
    const api = await client();
    const r = await api
      .post("/api/router?route=learner-model")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "u-1", pack: "en" });

    expect(r.status).toBe(200);
    expect(r.body.pack).toBe("en");
    const byCode = Object.fromEntries(r.body.model.categories.map((c) => [c.code, c]));
    expect(byCode.articles.label).toBe("Articles"); // resolved from en.js
    expect(byCode.subjunctive.label).toBe("subjunctive"); // raw-code fallback
  });

  it("returns the empty shape (200) when the learner has no rows", async () => {
    sbState.rows = [];
    const api = await client();
    const r = await api
      .post("/api/router?route=learner-model")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "brand-new", pack: "es" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, pack: "es", model: EMPTY_MODEL });
  });

  it("degrades gracefully to the empty shape when Supabase env is missing", async () => {
    sbState.enabled = false;
    const api = await client();
    const r = await api
      .post("/api/router?route=learner-model")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "u-1", pack: "en" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, pack: "en", model: EMPTY_MODEL });
  });

  it("returns the empty shape (200, never internal_error) when the DB read throws", async () => {
    // The reported production failure was a router-level `internal_error` (a 500):
    // a throw escaped the route to the router's outer catch. This proves a
    // DB-layer exception is now contained on this surface as a graceful 200.
    sbState.throwOnRead = true;
    const api = await client();
    const r = await api
      .post("/api/router?route=learner-model")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "3220f89f-ee4f-4500-a6d8-ff4b67377968", pack: "es" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, pack: "es", model: EMPTY_MODEL });
    expect(r.body.error).toBeUndefined();
  });

  it("returns the empty shape (200, not 400) when uid is missing", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=learner-model")
      .set("x-admin-token", "test_admin_token")
      .send({ pack: "es" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, pack: "es", model: EMPTY_MODEL });
  });

  it("enforces the admin gate (401 without token)", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=learner-model")
      .send({ uid: "u-1", pack: "es" });
    expect(r.status).toBe(401);
  });

  it("defaults pack to 'en' for an unknown pack value", async () => {
    sbState.rows = [];
    const api = await client();
    const r = await api
      .post("/api/router?route=learner-model")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "u-1", pack: "fr" });
    expect(r.status).toBe(200);
    expect(r.body.pack).toBe("en");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guard — the route is pure DB read + arithmetic: no OpenAI import, no model call.
// ─────────────────────────────────────────────────────────────────────────────
describe("learner-model purity", () => {
  it("imports no OpenAI SDK and fires no model call", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "routes/learner-model.js"), "utf8");
    expect(/openai/i.test(src)).toBe(false);
  });
});
