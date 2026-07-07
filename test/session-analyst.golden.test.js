// test/session-analyst.golden.test.js
// MANDATORY golden fixture — Mark's own café-order calibration session (es, C1).
// This fixture sits UNDER the 12-word spontaneous pre-gate (hard law 2a), so the
// route must return evidence:"insufficient" WITHOUT calling OpenAI and WITHOUT
// writing any speech_events rows. Hermetic: Supabase + OpenAI are both mocked and
// both asserted to be UNTOUCHED.
//
// Reconciliation note (see backend PR Disclosures): §2.5 also says "at least one
// strength", but the same paragraph places this fixture under the pre-gate (no
// LLM call), and its only sophisticated phrase ("me tienta", turn 1) is a
// chip_read utterance which hard law 3 forbids crediting. Both hard laws force
// ZERO strengths here, so this test asserts zero — following the hard laws, not
// the prose, exactly as §2.5 instructs ("fix the prompt, not the expectation" is
// moot when the pre-gate means no prompt runs at all).
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

const { insertSpy, createSpy } = vi.hoisted(() => ({
  insertSpy: vi.fn(() => Promise.resolve({ error: null })),
  createSpy: vi.fn(async () => ({ choices: [{ message: { content: "{}" } }] })),
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

// The exact fixture from the handover (§2.5).
const CALIBRATION_TURNS = [
  { index: 1, text: "Mmm, hoy sí me tienta el de la pizarra.", provenance: "chip_read", asrConfidence: 0.95 },
  { index: 2, text: "Sí, con leche entera.", provenance: "spontaneous", asrConfidence: 0.97 },
  { index: 3, text: "Grande.", provenance: "spontaneous", asrConfidence: 0.98 },
  { index: 4, text: "Para llevar, por favor.", provenance: "spontaneous", asrConfidence: 0.97 },
  { index: 5, text: "Va, aquí espero.", provenance: "chip_modified", asrConfidence: 0.94 },
  { index: 6, text: "Sí, aquí espero.", provenance: "chip_modified", asrConfidence: 0.96 },
];

describe("session-analyst golden calibration fixture (under the pre-gate)", () => {
  it("returns insufficient with NO LLM call and NO rows written", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=session-analyst")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "mark", sessionId: "s1", surface: "guided", pack: "es", level: "C1", turns: CALIBRATION_TURNS });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.evidence).toBe("insufficient");
    // Zero grammar items and zero strengths (both hard-law-forced here).
    expect(r.body.items).toEqual([]);
    expect(r.body.strengths).toEqual([]);
    // The pre-gate spared the LLM and wrote nothing.
    expect(r.body.meta.llmCalled).toBe(false);
    expect(r.body.meta.stored).toBe(0);
    expect(createSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    // Only 9 spontaneous words (turns 2-4); 3 short of the gate of 12.
    expect(r.body.meta.spontaneousWords).toBe(9);
  });

  it("returns the Spanish insufficient note under the es pack", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=session-analyst")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "mark", sessionId: "s1", surface: "guided", pack: "es", level: "C1", turns: CALIBRATION_TURNS });

    expect(r.body.evidenceNote).toContain("habla libre");
  });
});
