// test/word-info.prefetch-logonly.test.js
// backend-hygiene item 4: the prefetch + logOnly COMBINATION on
// /api/router?route=word-info. Each flag alone is correct (see the sibling tests
// word-info.logonly.test.js and word-info.prefetch.test.js): logOnly logs the tap
// and skips the model; prefetch runs normally but never logs a tap. The bug is the
// combination — the logOnly fast-path inserted the tap BEFORE the prefetch guard
// was reached, so a prefetching logOnly call wrote a word_taps row it must never
// write (taps are implicit-assessment data). Prefetch must win: no tap inserted.
// Hermetic — Supabase is mocked and a v2 card is served from cache, so OpenAI is
// never reached on any path here.
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
  word: "ridge",
  unit: "ridge",
  pos: "noun",
  ipa: "rɪdʒ",
  def: "a long narrow raised part",
  example: "The tongue touches the ridge.",
  l1Translation: "",
  tag: { cefr: "B1", freq: "common" },
  collocations: ["alveolar ridge"],
  trap: "",
  v: 2,
};

beforeEach(() => {
  vi.resetModules();
  insertSpy.mockClear();
  cacheState.card = { ...V2_CARD };
  process.env.ADMIN_TOKEN = "test_admin_token";
  // Deliberately NO OPENAI_API_KEY: none of these paths may reach the model.
});

async function client() {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  return request(mkServer(handler));
}

describe("word-info prefetch + logOnly (backend-hygiene item 4)", () => {
  it("prefetch wins: a logOnly+prefetch call inserts NO tap", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=word-info")
      .set("x-admin-token", "test_admin_token")
      .send({ word: "ridge", sentence: "on the alveolar ridge", lang: "en", surface: "ph-hover", logOnly: true, prefetch: true });

    expect(r.status).toBe(200);
    // No tap logged, and the response says so honestly.
    expect(r.body).toEqual({ ok: true, logged: false });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("logOnly alone still logs the tap (single-flag behavior unchanged)", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=word-info")
      .set("x-admin-token", "test_admin_token")
      .send({ word: "ridge", sentence: "on the alveolar ridge", lang: "en", surface: "ph-hover", logOnly: true });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, logged: true });
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy.mock.calls[0][0]).toMatchObject({ word: "ridge", surface: "ph-hover" });
  });

  it("prefetch alone still serves the card and logs no tap (single-flag behavior unchanged)", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=word-info")
      .set("x-admin-token", "test_admin_token")
      .send({ word: "ridge", sentence: "on the alveolar ridge", lang: "en", surface: "ph-hover", prefetch: true });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, cached: true, card: { v: 2, unit: "ridge" } });
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
