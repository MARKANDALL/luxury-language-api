// test/word-info.prefetch.test.js
// Contract test for the Word Motor Wave 4 (W4-D) prefetch no-log flag on
// /api/router?route=word-info. A prefetch warms the card cache for a rare word
// WITHOUT writing a word_taps row (the tap log is an implicit-assessment signal
// that prefetches must not poison). Everything else — cache read, and on a miss
// the model + cache write — is unchanged. Hermetic: a v2 card is served from the
// mocked cache so the model is never reached.
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

const { insertSpy, cacheState } = vi.hoisted(() => ({
  insertSpy: vi.fn(() => Promise.resolve({ error: null })),
  cacheState: { card: null },
}));

vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: () => ({
    from(table) {
      if (table === "word_taps") return { insert: insertSpy };
      // word_cards: chainable read (.select().eq()...maybeSingle()) + a
      // fire-and-forget upsert() write.
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve({ data: cacheState.card ? { card: cacheState.card } : null }),
        upsert: () => ({ then: () => ({ catch: () => {} }) }),
      };
      return chain;
    },
  }),
}));

const V2_CARD = {
  word: "pastry",
  unit: "pastry",
  pos: "noun",
  ipa: "ˈpeɪstri",
  def: "a small sweet baked food",
  example: "I bought a pastry.",
  l1Translation: "",
  tag: { cefr: "B1", freq: "very common" },
  collocations: ["fresh pastry"],
  trap: "",
  v: 2,
};

beforeEach(() => {
  vi.resetModules();
  insertSpy.mockClear();
  cacheState.card = { ...V2_CARD };
  process.env.ADMIN_TOKEN = "test_admin_token";
  // Deliberately NO OPENAI_API_KEY: a cached hit must never reach the model.
});

async function client() {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  return request(mkServer(handler));
}

describe("word-info prefetch no-log flag", () => {
  it("serves the cached card WITHOUT inserting a word_taps row", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=word-info")
      .set("x-admin-token", "test_admin_token")
      .send({ word: "pastry", sentence: "a fresh pastry", lang: "en", surface: "convo-ai", prefetch: true });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, cached: true, card: { v: 2, unit: "pastry" } });
    // The whole point: a prefetch logs NOTHING.
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("a normal (non-prefetch) call to the SAME word DOES log a tap", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=word-info")
      .set("x-admin-token", "test_admin_token")
      .send({ word: "pastry", sentence: "a fresh pastry", lang: "en", surface: "convo-ai" });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, cached: true });
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy.mock.calls[0][0]).toMatchObject({ word: "pastry", surface: "convo-ai" });
  });

  it("still enforces the admin gate for prefetch calls (401 without token)", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=word-info")
      .send({ word: "pastry", prefetch: true });
    expect(r.status).toBe(401);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
