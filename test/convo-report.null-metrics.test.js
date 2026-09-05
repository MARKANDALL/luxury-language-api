// Cover for REPORT_measurement_audit.md finding 6: a turn nobody spoke counted
// as a zero.
//
// routes/attempt.js correctly stores pron: null for an attempt Azure never
// scored — a typed conversation turn, a recording with no speech in it. This
// route then ran Number(null), which is 0 and finite, so the mean folded it in
// as a total failure. The audit's case: a four-turn conversation scored 88, 90
// and 86 with one typed turn reported Pronunciation 66. The true average is 88.
import request from "supertest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

const db = vi.hoisted(() => ({ rows: [] }));

vi.mock("pg", () => {
  class Pool {
    async query() {
      return { rows: db.rows };
    }
  }
  return { Pool };
});

const TOKEN = "test-admin-token";
let prevToken;
let prevOpenAI;

beforeEach(() => {
  vi.resetModules();
  delete globalThis.__lux_pool;
  db.rows = [];
  prevToken = process.env.ADMIN_TOKEN;
  prevOpenAI = process.env.OPENAI_API_KEY;
  process.env.ADMIN_TOKEN = TOKEN;
  // No key => maybeNarrative returns null without calling out. The arithmetic
  // under test is what this file is about.
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = prevToken;
  if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevOpenAI;
});

function turn(i, summary) {
  return {
    part_index: i,
    text: `turn ${i}`,
    summary,
    ts: `2026-09-04T10:0${i}:00.000Z`,
  };
}

async function report() {
  const mod = await import("../api/router.js");
  const r = await request(mkServer(mod.default || mod))
    .post("/api/router?route=convo-report")
    .set("content-type", "application/json")
    .set("x-admin-token", TOKEN)
    .send({ uid: "u", sessionId: "s", passageKey: "convo:cafe" });
  expect(r.status).toBe(200);
  return r.body;
}

describe("convo-report: a silent turn is not a zero", () => {
  it("reports the audit's conversation as 88, not 66", async () => {
    db.rows = [
      turn(0, { pron: 88, acc: 90, flu: 85, comp: 100 }),
      turn(1, { pron: 90, acc: 92, flu: 87, comp: 100 }),
      turn(2, { pron: 86, acc: 88, flu: 83, comp: 100 }),
      // The typed turn. attempt.js stores every metric null for it.
      turn(3, { pron: null, acc: null, flu: null, comp: null }),
    ];

    const body = await report();
    expect(body.scores.pron).toBe(88);
    expect(body.meta.turns).toBe(4); // the turn still happened and is still counted
  });

  it("applies to every metric, not just pronunciation", async () => {
    db.rows = [
      turn(0, { pron: 88, acc: 90, flu: 85, comp: 100 }),
      turn(1, { pron: 90, acc: 92, flu: 87, comp: 100 }),
      turn(2, { pron: 86, acc: 88, flu: 83, comp: 100 }),
      turn(3, { pron: null, acc: null, flu: null, comp: null }),
    ];

    expect((await report()).scores).toEqual({ pron: 88, acc: 90, flu: 85, comp: 100 });
  });

  it("drops a metric that is absent rather than present-and-null", async () => {
    db.rows = [
      turn(0, { pron: 80 }),
      turn(1, { pron: 90 }),
      turn(2, {}),          // no keys at all
      turn(3, { pron: "" }), // empty string: Number("") is 0 too
    ];

    expect((await report()).scores.pron).toBe(85);
  });

  it("keeps a genuine zero, which is real data and not an absent score", async () => {
    db.rows = [turn(0, { pron: 100 }), turn(1, { pron: 0 })];
    expect((await report()).scores.pron).toBe(50);
  });

  it("returns null, not 0, when no turn in the session scored the metric", async () => {
    db.rows = [turn(0, { pron: null }), turn(1, { pron: null })];
    expect((await report()).scores.pron).toBeNull();
  });

  it("reads a metric stored as a numeric string", async () => {
    db.rows = [turn(0, { pron: "88" }), turn(1, { pron: 90 })];
    expect((await report()).scores.pron).toBe(89);
  });
});
