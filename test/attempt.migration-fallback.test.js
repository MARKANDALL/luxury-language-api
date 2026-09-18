// Regression cover for the 2026-09-03 outage: routes/attempt.js writes
// recognized_text and azure_detail (added by migrations/0010_attempt_azure_detail.sql).
// Migrations here are applied by hand, so a deploy can land on a database without
// them, and before this cover every POST /api/attempt returned 500 with
// `column "recognized_text" of relation "lux_attempts" does not exist` (SQLSTATE
// 42703). The attempt must degrade to the pre-0010 write instead of being lost.
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

// columnsExist models whether migration 0010 has been applied; failWith injects
// some other database fault, to prove the fallback does not swallow one.
const db = vi.hoisted(() => ({ calls: [], columnsExist: false, failWith: null }));

vi.mock("pg", () => {
  class Pool {
    async query(text, params) {
      db.calls.push({ text, params });
      if (db.failWith) throw db.failWith;
      if (!db.columnsExist && /recognized_text/.test(text)) {
        // Shaped like pg's DatabaseError: SQLSTATE lands on err.code as a string.
        const err = new Error(
          'column "recognized_text" of relation "lux_attempts" does not exist'
        );
        err.code = "42703";
        err.severity = "ERROR";
        err.routine = "checkInsertTargets";
        throw err;
      }
      return { rows: [{ id: 123 }] };
    }
  }
  return { Pool };
});

const VALID = {
  uid: "u_test",
  passageKey: "harvard01",
  partIndex: 0,
  text: "Hello world",
  summary: { overallScore: 88 },
  sessionId: "s_test",
};

async function postAttempt(body = VALID) {
  const mod = await import("../api/router.js");
  return request(mkServer(mod.default || mod))
    .post("/api/router?route=attempt")
    .set("content-type", "application/json")
    .send(body);
}

beforeEach(() => {
  vi.resetModules();
  delete globalThis.__lux_pool;
  db.calls = [];
  db.columnsExist = false;
  db.failWith = null;
});

describe("attempt survives a database without migration 0010", () => {
  it("still returns 200 + id when recognized_text/azure_detail are absent", async () => {
    const r = await postAttempt();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, id: 123 });
  });

  it("falls back to the pre-0010 seven-column write", async () => {
    await postAttempt();
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0].text).toMatch(/recognized_text, azure_detail/);
    expect(db.calls[1].text).not.toMatch(/recognized_text|azure_detail/);
    expect(db.calls[1].text).toMatch(
      /\(uid, ts, passage_key, part_index, text, summary, session_id\)/
    );
  });

  it("passes the same first seven params, so summary is untouched", async () => {
    await postAttempt();
    const [full, legacy] = db.calls;
    expect(legacy.params).toHaveLength(7);
    expect(legacy.params).toEqual(full.params.slice(0, 7));
    expect(JSON.parse(legacy.params[5])).toMatchObject({ overallScore: 88 });
  });

  it("uses the full nine-column write and does not retry once 0010 is applied", async () => {
    db.columnsExist = true;
    const r = await postAttempt();
    expect(r.status).toBe(200);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].text).toMatch(/recognized_text, azure_detail/);
  });

  it("does not mask a database error that is not 42703", async () => {
    const boom = new Error("connection terminated unexpectedly");
    boom.code = "57P01";
    db.failWith = boom;
    const r = await postAttempt();
    expect(db.calls).toHaveLength(1); // no retry
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ ok: false, error: "server_error" });
  });

  it("does not retry forever if the fallback is also missing a column", async () => {
    const err = new Error('column "session_id" of relation "lux_attempts" does not exist');
    err.code = "42703";
    db.failWith = err;
    const r = await postAttempt();
    expect(db.calls).toHaveLength(2); // full write, one fallback, then give up
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ ok: false, error: "server_error" });
  });
});
