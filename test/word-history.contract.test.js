// test/word-history.contract.test.js
// Contract test for Word Motor Wave 4 (W4-A) /api/router?route=word-history.
// It aggregates a learner's own history with one word from three tables
// (word_taps, my_words_entries, lux_attempts), all read through the mocked
// Supabase admin client. Hermetic: no network, no model. Covers the happy
// path, the admin gate, input validation, and the graceful no-Supabase degrade.
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

// Shared, hoisted mock state the vi.mock factory can see. `enabled:false`
// simulates a missing Supabase env (getSupabaseAdmin throws).
const { sbState } = vi.hoisted(() => ({ sbState: { tables: {}, enabled: true } }));

vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: () => {
    if (!sbState.enabled) throw new Error("SUPABASE_URL is required");
    return {
      from(table) {
        const result = sbState.tables[table] ?? { data: [], error: null };
        // Every builder method is chainable; the chain is thenable so
        // `await sb.from(t).select()...` resolves to the table's result.
        const chain = {
          select: () => chain,
          eq: () => chain,
          ilike: () => chain,
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
  sbState.tables = {};
});

async function client() {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  return request(mkServer(handler));
}

describe("word-history contract", () => {
  it("aggregates taps, saved and scores for the happy path", async () => {
    sbState.tables = {
      word_taps: {
        data: [
          { surface: "convo-ai", created_at: "2026-07-01T10:00:00Z" },
          { surface: "passage", created_at: "2026-07-03T10:00:00Z" },
          { surface: "convo-ai", created_at: "2026-07-05T10:00:00Z" },
        ],
        error: null,
      },
      my_words_entries: { data: [{ id: "mw1", archived: false }], error: null },
      lux_attempts: {
        data: [
          { ts: "2026-07-06T10:00:00Z", summary: { words: [["pastry", 82, 1], ["muffin", 60, 1]] } },
          { ts: "2026-07-02T10:00:00Z", summary: { words: [["pastry", 66, 1]] } },
        ],
        error: null,
      },
    };

    const api = await client();
    const r = await api
      .post("/api/router?route=word-history")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "u-1", word: "Pastry", lang: "en" });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.history).toEqual({
      taps: 3,
      firstSeen: "2026-07-01T10:00:00Z",
      lastSeen: "2026-07-05T10:00:00Z",
      surfaces: ["convo-ai", "passage"],
      saved: true,
      scores: { count: 2, avg: 74, last: 82 }, // round((82+66)/2)=74, newest-first last=82
    });
  });

  it("returns scores:null and saved:false when the word has no history", async () => {
    sbState.tables = {
      word_taps: { data: [], error: null },
      my_words_entries: { data: [], error: null },
      lux_attempts: { data: [{ ts: "2026-07-06T10:00:00Z", summary: { words: [["other", 90, 1]] } }], error: null },
    };
    const api = await client();
    const r = await api
      .post("/api/router?route=word-history")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "u-1", word: "pastry", lang: "en" });

    expect(r.status).toBe(200);
    expect(r.body.history.taps).toBe(0);
    expect(r.body.history.saved).toBe(false);
    expect(r.body.history.scores).toBeNull();
    expect(r.body.history.surfaces).toEqual([]);
  });

  it("treats an archived My Words entry as not saved", async () => {
    sbState.tables = { my_words_entries: { data: [{ id: "mw1", archived: true }], error: null } };
    const api = await client();
    const r = await api
      .post("/api/router?route=word-history")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "u-1", word: "pastry", lang: "en" });
    expect(r.status).toBe(200);
    expect(r.body.history.saved).toBe(false);
  });

  it("enforces the admin gate (401 without token)", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=word-history")
      .send({ uid: "u-1", word: "pastry", lang: "en" });
    expect(r.status).toBe(401);
  });

  it("validates input (400 when word is missing)", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=word-history")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "u-1", lang: "en" });
    expect(r.status).toBe(400);
  });

  it("degrades gracefully to an empty history when Supabase env is missing", async () => {
    sbState.enabled = false;
    const api = await client();
    const r = await api
      .post("/api/router?route=word-history")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "u-1", word: "pastry", lang: "en" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      history: { taps: 0, firstSeen: null, lastSeen: null, surfaces: [], saved: false, scores: null },
    });
  });
});
