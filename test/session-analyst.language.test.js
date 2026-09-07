// test/session-analyst.language.test.js
// The explanation language is a RULE, not a hope. Hermetic (Supabase + OpenAI
// mocked), asserting on the system prompt the route actually sends.
//
// WHY THIS FILE EXISTS. A production session whose learner had chosen English
// came back with its word-choice explanations and its strength note written in
// German. Nothing in the repo contained a word of German: the contract asked the
// model to write "in the analyst's language", a phrase defined nowhere in the
// assembled prompt, and only the es pack ever named its own language. With the
// referent dangling the model was free to pick one, and it did.
//
// So these tests assert the two halves of the rule:
//   1. the resolved pack's language is NAMED in the prompt, every time;
//   2. an absent or unsupported pack resolves to English and never to the
//      language the learner did not choose.
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";
import { makeFakeSupabase, LUX_UNIQUE } from "./_helpers/fakeSupabase.js";

const { createSpy, sbRef } = vi.hoisted(() => ({
  createSpy: vi.fn(async () => ({ choices: [{ message: { content: "{}" } }] })),
  sbRef: { current: null },
}));

vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: () => sbRef.current,
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
  createSpy.mockClear();
  sbRef.current = makeFakeSupabase({ unique: LUX_UNIQUE });
  process.env.ADMIN_TOKEN = "test_admin_token";
  process.env.OPENAI_API_KEY = "sk-test";
});

async function client() {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  return request(mkServer(handler));
}

function reply(obj) {
  return { choices: [{ message: { content: JSON.stringify(obj) } }] };
}

// Above the 12-word spontaneous gate, so the route reaches the model.
const TURNS = [
  { index: 1, text: "I was stressing out over this and I could not think straight.", provenance: "spontaneous", asrConfidence: 0.96 },
  { index: 2, text: "Look, it is an elephant trying to use a tablet, and I love it.", provenance: "spontaneous", asrConfidence: 0.95 },
];

const CLEAN_REPORT = {
  evidence: "sufficient",
  evidenceNote: "note",
  items: [],
  strengths: [],
  afnCandidates: [],
};

function send(api, body) {
  return api
    .post("/api/router?route=session-analyst")
    .set("x-admin-token", "test_admin_token")
    .send({ uid: "u1", level: "B1", turns: TURNS, ...body });
}

// The system prompt of the one call the route made.
function systemPrompt() {
  return createSpy.mock.calls[0][0].messages[0].content;
}

describe("session-analyst explanation language", () => {
  it("names English in the prompt for pack \"en\"", async () => {
    createSpy.mockResolvedValueOnce(reply(CLEAN_REPORT));
    const api = await client();
    const r = await send(api, { pack: "en" });

    expect(r.status).toBe(200);
    expect(r.body.meta.pack).toBe("en");
    const sys = systemPrompt();
    expect(sys).toContain("LANGUAGE (absolute, overrides everything else)");
    expect(sys).toContain("write EVERY learner-facing\nstring in English");
    // Every learner-facing field carries the language, the strength note included:
    // the German note in the production session was on a field that named no
    // language at all.
    expect(sys).toContain('"evidenceNote": "one short sentence, in English"');
    expect(sys).toContain("<one sentence, learner-facing, in English>");
    expect(sys).toContain("<one sentence, in English>");
  });

  it("names Mexican Spanish in the prompt for pack \"es\"", async () => {
    createSpy.mockResolvedValueOnce(reply(CLEAN_REPORT));
    const api = await client();
    const r = await send(api, { pack: "es" });

    expect(r.status).toBe(200);
    expect(r.body.meta.pack).toBe("es");
    const sys = systemPrompt();
    expect(sys).toContain("write EVERY learner-facing\nstring in español mexicano");
    expect(sys).toContain('"evidenceNote": "one short sentence, in español mexicano"');
    expect(sys).not.toContain("in English");
  });

  it("falls back to English when the pack is absent", async () => {
    createSpy.mockResolvedValueOnce(reply(CLEAN_REPORT));
    const api = await client();
    const r = await send(api, {});

    expect(r.status).toBe(200);
    expect(r.body.meta.pack).toBe("en");
    expect(systemPrompt()).toContain("write EVERY learner-facing\nstring in English");
  });

  it("falls back to English for a pack the app does not support, never to that language", async () => {
    createSpy.mockResolvedValueOnce(reply(CLEAN_REPORT));
    const api = await client();
    const r = await send(api, { pack: "de" });

    expect(r.status).toBe(200);
    expect(r.body.meta.pack).toBe("en");
    const sys = systemPrompt();
    expect(sys).toContain("write EVERY learner-facing\nstring in English");
    expect(sys).not.toMatch(/German|Deutsch/);
  });

  it("never asks for \"the analyst's language\" again — the phrase that had no referent", async () => {
    createSpy.mockResolvedValueOnce(reply(CLEAN_REPORT));
    const api = await client();
    await send(api, { pack: "en" });

    expect(systemPrompt()).not.toContain("the analyst's language");
  });

  it("runs the analysis at temperature 0, so two passes over one transcript agree", async () => {
    createSpy.mockResolvedValueOnce(reply(CLEAN_REPORT));
    const api = await client();
    await send(api, { pack: "en" });

    expect(createSpy.mock.calls[0][0].temperature).toBe(0);
  });
});
