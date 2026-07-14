// test/word-info.logonly.test.js
// Contract test for the Word Motor Wave 2 logOnly fast-path on
// /api/router?route=word-info. logOnly taps come from gloss surfaces that were
// answered locally by the frontend BUILTIN_GLOSS map: the tap must still be
// logged to analytics, but the cache read and the model call are skipped.
// Hermetic — Supabase is mocked, no OpenAI is ever reached.
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

// A spy insert() we can assert against, hoisted so the vi.mock factory can see it.
const { insertSpy } = vi.hoisted(() => ({ insertSpy: vi.fn(() => Promise.resolve({ error: null })) }));

vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: () => ({ from: () => ({ insert: insertSpy }) }),
}));

beforeEach(() => {
  vi.resetModules();
  insertSpy.mockClear();
  // Router admin gate expects x-admin-token to match ADMIN_TOKEN.
  process.env.ADMIN_TOKEN = "test_admin_token";
  // Deliberately NO OPENAI_API_KEY: logOnly must never reach the model.
});

async function client() {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  return request(mkServer(handler));
}

describe("word-info logOnly fast-path", () => {
  it("logs the tap and returns { ok, logged } without a model call", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=word-info")
      .set("x-admin-token", "test_admin_token")
      .send({ word: "ridge", sentence: "on the alveolar ridge", lang: "en", surface: "ph-hover", logOnly: true });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, logged: true });
    // The tap row was inserted exactly once, tagged with the right surface.
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy.mock.calls[0][0]).toMatchObject({ word: "ridge", surface: "ph-hover" });
  });

  it("still enforces the admin gate (401 without token)", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=word-info")
      .send({ word: "ridge", logOnly: true });
    expect(r.status).toBe(401);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("still validates input (400 when word is missing)", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=word-info")
      .set("x-admin-token", "test_admin_token")
      .send({ logOnly: true });
    expect(r.status).toBe(400);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("falls back an unknown surface to convo-ai (whitelist unchanged)", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=word-info")
      .set("x-admin-token", "test_admin_token")
      .send({ word: "ridge", surface: "not-a-real-surface", logOnly: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, logged: true });
    expect(insertSpy.mock.calls[0][0]).toMatchObject({ surface: "convo-ai" });
  });

  it("preserves the Craft-B2 surfaces (narration, score-metrics, practice)", async () => {
    for (const surface of ["narration", "score-metrics", "practice"]) {
      insertSpy.mockClear();
      const api = await client();
      const r = await api
        .post("/api/router?route=word-info")
        .set("x-admin-token", "test_admin_token")
        .send({ word: "ridge", surface, logOnly: true });
      expect(r.status).toBe(200);
      // Not downgraded to convo-ai — these are now whitelisted surfaces.
      expect(insertSpy.mock.calls[0][0]).toMatchObject({ surface });
    }
  });
});
