// test/learner-model.provenance.test.js
// The Richness Pass, task 1: speech_events now records WHERE a turn's words came
// from, and the read route surfaces that as a source mix — per category, and once
// at panel level.
//
// The point of this file is not that the counts add up. It is that they are ONLY
// counts. The weighting decision is reserved, so the tests below pin the two
// properties that make "nothing has been weighted" checkable rather than merely
// claimed:
//
//   1. sum(sourceMix) === n, for every category and for the panel. Weighting a
//      provenance, or quietly dropping one, breaks this sum.
//   2. Re-labelling every row's provenance changes the mix and NOTHING else — not
//      n, not trend, not severityMix, not the salience ordering, not AFN. That is
//      the whole "descriptive only" claim, asserted directly rather than trusted.
//
// Hermetic: no network, no model. Mirrors test/learner-model.contract.test.js.
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";
import { aggregateSpeechEvents } from "../routes/learner-model.js";

// Shared, hoisted mock state. `selectArgs` records the column list the route asks
// for, so the contract layer can prove the three new columns are really read.
const { sbState } = vi.hoisted(() => ({
  sbState: { rows: [], enabled: true, selectArgs: [] },
}));

vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: () => {
    if (!sbState.enabled) throw new Error("SUPABASE_URL is required");
    return {
      from() {
        const result = { data: sbState.rows, error: null };
        const chain = {
          select: (cols) => {
            sbState.selectArgs.push(String(cols || ""));
            return chain;
          },
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          then: (resolve) => resolve(result),
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
  sbState.selectArgs = [];
});

async function client() {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  return request(mkServer(handler));
}

// One grammar item. `p` is the provenance under test.
function ev(p, over = {}) {
  return {
    session_id: "s1",
    channel: "grammar",
    category: "ser_estar",
    severity: "noticeable",
    utterance: "yo soy cansado",
    suggestion: "yo estoy cansado",
    explanation: "Estado, no identidad.",
    created_at: "2026-08-20T10:00:00.000Z",
    provenance: p,
    surface: "guided",
    scenario_key: "coffee",
    ...over,
  };
}

const SUM = (mix) => Object.values(mix).reduce((a, b) => a + b, 0);
const NOW = Date.parse("2026-08-21T00:00:00.000Z");

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — the pure aggregation.
// ─────────────────────────────────────────────────────────────────────────────
describe("sourceMix — the shape", () => {
  it("carries every provenance key plus 'unknown', zero-filled, on an empty model", () => {
    const m = aggregateSpeechEvents([], new Map(), NOW);
    expect(m.sourceMix).toEqual({
      spontaneous: 0,
      chip_modified: 0,
      dictated: 0,
      composed: 0,
      unknown: 0,
    });
  });

  it("keeps that stable key order even when only one provenance is present", () => {
    const m = aggregateSpeechEvents([ev("dictated")], new Map(), NOW);
    // Stable keys matter: the panel renders the mix as a fixed row of labels, and
    // a category with no dictated turns should say "0", not omit the line.
    expect(Object.keys(m.sourceMix)).toEqual([
      "spontaneous",
      "chip_modified",
      "dictated",
      "composed",
      "unknown",
    ]);
    expect(Object.keys(m.categories[0].sourceMix)).toEqual(Object.keys(m.sourceMix));
  });
});

describe("sourceMix — the counts", () => {
  it("counts each provenance, per category and at panel level", () => {
    const rows = [
      ev("spontaneous"),
      ev("spontaneous"),
      ev("chip_modified"),
      ev("dictated"),
      ev("composed"),
      ev("spontaneous", { category: "por_para" }),
      ev("dictated", { category: "por_para" }),
    ];
    const m = aggregateSpeechEvents(rows, new Map(), NOW);

    const serEstar = m.categories.find((c) => c.code === "ser_estar");
    expect(serEstar.sourceMix).toEqual({
      spontaneous: 2,
      chip_modified: 1,
      dictated: 1,
      composed: 1,
      unknown: 0,
    });

    const porPara = m.categories.find((c) => c.code === "por_para");
    expect(porPara.sourceMix).toEqual({
      spontaneous: 1,
      chip_modified: 0,
      dictated: 1,
      composed: 0,
      unknown: 0,
    });

    expect(m.sourceMix).toEqual({
      spontaneous: 3,
      chip_modified: 1,
      dictated: 2,
      composed: 1,
      unknown: 0,
    });
  });

  it("sums to n for every category and to totals.events for the panel", () => {
    const rows = [
      ev("spontaneous"),
      ev("dictated"),
      ev(null),
      ev("composed", { category: "por_para" }),
      ev("chip_modified", { category: "articles" }),
    ];
    const m = aggregateSpeechEvents(rows, new Map(), NOW);

    // THE no-weighting invariant. If anyone ever multiplies a provenance by a
    // factor, or drops one from the tally, exactly this line fails.
    for (const c of m.categories) expect(SUM(c.sourceMix)).toBe(c.n);
    expect(SUM(m.sourceMix)).toBe(m.totals.events);
  });

  it("buckets a null, an empty string and an unrecognised value as 'unknown'", () => {
    // Rows written before the frontend sent a provenance read back as null, and
    // 'chip_read' is a real value in the writer's vocabulary that the judgeable
    // gate means can never actually land here. None of the three is dropped.
    const rows = [ev(null), ev(""), ev("chip_read"), ev("spontaneous")];
    const m = aggregateSpeechEvents(rows, new Map(), NOW);
    expect(m.sourceMix.unknown).toBe(3);
    expect(m.sourceMix.spontaneous).toBe(1);
    expect(SUM(m.sourceMix)).toBe(4);
  });

  it("counts strengths in no mix at all, so the panel figure matches totals.events", () => {
    const rows = [
      ev("spontaneous"),
      {
        session_id: "s1",
        channel: "strength",
        category: null,
        severity: "positive",
        utterance: "me encantaria probarlo",
        explanation: "Condicional bien usado.",
        created_at: "2026-08-20T10:05:00.000Z",
        provenance: "dictated",
      },
    ];
    const m = aggregateSpeechEvents(rows, new Map(), NOW);
    expect(m.totals.events).toBe(1);
    expect(m.strengths.n).toBe(1);
    expect(SUM(m.sourceMix)).toBe(1);
    expect(m.sourceMix.dictated).toBe(0);
  });
});

describe("sourceMix — descriptive only", () => {
  it("re-labelling every row changes the mix and nothing else", () => {
    // The same rows twice, identical but for provenance. If provenance influenced
    // any count, rank, trend or salience anywhere, these two portraits would
    // differ somewhere other than in sourceMix — and this test says exactly where.
    const shape = [
      { category: "ser_estar", severity: "blocked", created_at: "2026-08-20T10:00:00.000Z" },
      { category: "ser_estar", severity: "polish", created_at: "2026-08-19T10:00:00.000Z" },
      { category: "por_para", severity: "noticeable", created_at: "2026-08-18T10:00:00.000Z" },
      {
        category: "articles",
        severity: "polish",
        created_at: "2026-08-10T10:00:00.000Z",
        session_id: "s0",
      },
    ];
    const a = aggregateSpeechEvents(shape.map((o) => ev("spontaneous", o)), new Map(), NOW);
    const b = aggregateSpeechEvents(shape.map((o) => ev("dictated", o)), new Map(), NOW);

    const strip = (m) => ({
      ...m,
      sourceMix: undefined,
      categories: m.categories.map((c) => ({ ...c, sourceMix: undefined })),
    });
    expect(strip(b)).toEqual(strip(a));

    // ...and the ordering itself, spelled out rather than left implied.
    expect(b.categories.map((c) => c.code)).toEqual(a.categories.map((c) => c.code));
    expect(b.afn.map((x) => x.code)).toEqual(a.afn.map((x) => x.code));

    // The mixes are the one thing that did move.
    expect(a.sourceMix.spontaneous).toBe(4);
    expect(b.sourceMix.dictated).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — the HTTP contract.
// ─────────────────────────────────────────────────────────────────────────────
describe("learner-model route — provenance over the wire", () => {
  it("selects provenance, surface and scenario_key alongside the original eight", async () => {
    sbState.rows = [ev("spontaneous")];
    const c = await client();
    const res = await c
      .post("/api/router?route=learner-model")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "u-1", pack: "es" });

    expect(res.status).toBe(200);
    const cols = sbState.selectArgs.join(" ");
    for (const col of [
      "session_id",
      "channel",
      "category",
      "severity",
      "utterance",
      "suggestion",
      "explanation",
      "created_at",
      "provenance",
      "surface",
      "scenario_key",
    ]) {
      expect(cols).toContain(col);
    }
  });

  it("returns the mix at panel level and on each category", async () => {
    sbState.rows = [
      ev("spontaneous"),
      ev("dictated"),
      ev("chip_modified", { category: "por_para" }),
    ];
    const c = await client();
    const res = await c
      .post("/api/router?route=learner-model")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "u-1", pack: "es" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.model.sourceMix).toEqual({
      spontaneous: 1,
      chip_modified: 1,
      dictated: 1,
      composed: 0,
      unknown: 0,
    });
    for (const cat of res.body.model.categories) {
      expect(SUM(cat.sourceMix)).toBe(cat.n);
    }
  });

  it("still answers an empty learner with a zeroed mix, not a missing key", async () => {
    sbState.rows = [];
    const c = await client();
    const res = await c
      .post("/api/router?route=learner-model")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "u-1", pack: "es" });

    expect(res.status).toBe(200);
    expect(res.body.model.sourceMix).toEqual({
      spontaneous: 0,
      chip_modified: 0,
      dictated: 0,
      composed: 0,
      unknown: 0,
    });
  });
});
