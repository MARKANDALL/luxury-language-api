// test/coach-ask.contract.test.js
// Contract test for Ask-the-coach v1 on /api/router?route=coach-ask (Word Motor
// Wave 3, W3-G). Mirrors word-info.logonly.test.js: hermetic — Supabase and
// OpenAI are both mocked, so no network is ever reached. Covers the happy path
// (answer + coach tap logged), the admin gate, input validation, and the
// Spanish-pack tú register in the prompt.
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

const { insertSpy, createSpy } = vi.hoisted(() => ({
  insertSpy: vi.fn(() => Promise.resolve({ error: null })),
  createSpy: vi.fn(async () => ({
    choices: [{ message: { content: JSON.stringify({ answer: "Here it means to look around. Say it like 'browz', with a soft z." }) } }],
  })),
}));

vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: () => ({ from: () => ({ insert: insertSpy }) }),
}));

vi.mock("openai", () => ({
  OpenAI: class {
    constructor() {
      this.chat = { completions: { create: createSpy } };
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  insertSpy.mockClear();
  createSpy.mockClear();
  process.env.ADMIN_TOKEN = "test_admin_token";
});

async function client() {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  return request(mkServer(handler));
}

describe("coach-ask contract", () => {
  it("happy path: returns { ok, answer } and logs a coach tap", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=coach-ask")
      .set("x-admin-token", "test_admin_token")
      .send({ word: "browse", sentence: "Would you like to browse?", lang: "en", l1: "es", level: "B1", uid: "u1" });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.answer).toBe("string");
    expect(r.body.answer.length).toBeGreaterThan(0);
    expect(createSpy).toHaveBeenCalledTimes(1);
    // The tap was logged to word_taps, tagged surface "coach".
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy.mock.calls[0][0]).toMatchObject({ word: "browse", surface: "coach" });
  });

  it("enforces the admin gate (401 without token, no model call)", async () => {
    const api = await client();
    const r = await api.post("/api/router?route=coach-ask").send({ word: "browse" });
    expect(r.status).toBe(401);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("validates input (400 when word missing, no model call)", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=coach-ask")
      .set("x-admin-token", "test_admin_token")
      .send({ sentence: "no word here" });
    expect(r.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("uses the Spanish tú register instruction for the es pack", async () => {
    const api = await client();
    await api
      .post("/api/router?route=coach-ask")
      .set("x-admin-token", "test_admin_token")
      .send({ word: "hola", sentence: "Hola, amigo.", lang: "es", level: "A2" });
    const systemMsg = createSpy.mock.calls[0][0].messages[0].content;
    expect(systemMsg).toContain("Spanish");
    expect(systemMsg).toContain('"tú"');
  });

  it("adopts the selected coach persona voice in the prompt (Craft-B2 item 5)", async () => {
    const api = await client();
    await api
      .post("/api/router?route=coach-ask")
      .set("x-admin-token", "test_admin_token")
      .send({ word: "browse", sentence: "Would you like to browse?", style: "drill" });
    const systemMsg = createSpy.mock.calls[0][0].messages[0].content;
    expect(systemMsg).toContain("drill sergeant");
  });

  it("falls back to the tutor voice for an unknown/absent persona", async () => {
    const api = await client();
    await api
      .post("/api/router?route=coach-ask")
      .set("x-admin-token", "test_admin_token")
      .send({ word: "browse", sentence: "Would you like to browse?", style: "not-a-persona" });
    const systemMsg = createSpy.mock.calls[0][0].messages[0].content;
    expect(systemMsg).toContain("warm, patient tutor");
  });

  it("defaults to the meaning lens when no lens is sent (backward-compatible)", async () => {
    const api = await client();
    await api
      .post("/api/router?route=coach-ask")
      .set("x-admin-token", "test_admin_token")
      .send({ word: "browse", sentence: "Would you like to browse?" });
    const call = createSpy.mock.calls[0][0];
    expect(call.messages[0].content).toContain("TASK — MEANING");
    expect(call.max_tokens).toBe(240);
    expect(call.temperature).toBe(0.5);
  });

  it("falls back to the meaning lens for an unknown lens", async () => {
    const api = await client();
    await api
      .post("/api/router?route=coach-ask")
      .set("x-admin-token", "test_admin_token")
      .send({ word: "browse", lens: "not-a-lens" });
    expect(createSpy.mock.calls[0][0].messages[0].content).toContain("TASK — MEANING");
  });

  it("contrast lens uses the mapped l1 name (finally consumes l1)", async () => {
    const api = await client();
    // lang=en so the shared header says "English"; the only source of "Spanish"
    // here is the contrast task's L1NAME, mapped from l1: "es".
    await api
      .post("/api/router?route=coach-ask")
      .set("x-admin-token", "test_admin_token")
      .send({ word: "embarrassed", lang: "en", l1: "es", lens: "contrast" });
    const sys = createSpy.mock.calls[0][0].messages[0].content;
    expect(sys).toContain("COMPARE TO YOUR LANGUAGE");
    expect(sys).toContain("Spanish");
  });

  it("depth 2 appends the GO DEEPER clause and bumps max_tokens by ~120", async () => {
    const api = await client();
    await api
      .post("/api/router?route=coach-ask")
      .set("x-admin-token", "test_admin_token")
      .send({ word: "browse", lens: "meaning", depth: 2 });
    const call = createSpy.mock.calls[0][0];
    expect(call.messages[0].content).toContain("GO DEEPER");
    expect(call.max_tokens).toBe(360); // 240 + 120
  });

  it("returns 502 when the model yields an empty answer", async () => {
    createSpy.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ answer: "" }) } }] });
    const api = await client();
    const r = await api
      .post("/api/router?route=coach-ask")
      .set("x-admin-token", "test_admin_token")
      .send({ word: "browse", sentence: "Would you like to browse?" });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, error: "empty_answer" });
  });
});
