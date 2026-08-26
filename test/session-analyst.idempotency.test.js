// test/session-analyst.idempotency.test.js
// Hard law 6: the same session may be submitted more than once (an exit capture,
// then the learner returning and ending properly). A later pass supersedes an
// earlier one ONLY if it carries strictly more turns; otherwise it is a no-op.
//
// These are behaviour tests, not stub tests: _helpers/fakeSupabase.js holds real
// rows and enforces the real unique constraint from migration 0008, so what is
// asserted here is the actual supersede arithmetic.
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";
import { makeFakeSupabase, LUX_UNIQUE } from "./_helpers/fakeSupabase.js";

const { createSpy, sbRef } = vi.hoisted(() => ({
  createSpy: vi.fn(async () => ({ choices: [{ message: { content: "{}" } }] })),
  sbRef: { current: null },
}));

vi.mock("../lib/supabase.js", () => ({ getSupabaseAdmin: () => sbRef.current }));

vi.mock("openai", () => ({
  OpenAI: class {
    constructor() {
      this.chat = { completions: { create: createSpy } };
    }
  },
}));

const ANALYSES = "speech_session_analyses";
const EVENTS = "speech_events";

beforeEach(() => {
  vi.resetModules();
  createSpy.mockClear();
  sbRef.current = makeFakeSupabase({ unique: LUX_UNIQUE });
  process.env.ADMIN_TOKEN = "test_admin_token";
  process.env.OPENAI_API_KEY = "sk-test";
});

async function client() {
  const mod = await import("../api/router.js");
  return request(mkServer(mod.default || mod));
}

function reply(obj) {
  return { choices: [{ message: { content: JSON.stringify(obj) } }] };
}

// Each turn is comfortably over the 12-word spontaneous gate on its own.
const TURNS = [
  { index: 1, text: "La verdad es que llevo semanas dandole vueltas y todavia no lo tengo nada claro.", provenance: "spontaneous", asrConfidence: 0.96 },
  { index: 2, text: "El problema es que esta reunion esta muy importante para mi carrera profesional.", provenance: "spontaneous", asrConfidence: 0.95 },
  { index: 3, text: "Necesito hacer una decision pronto, pero mis colegas me dan consejos contradictorios.", provenance: "spontaneous", asrConfidence: 0.97 },
  { index: 4, text: "Sinceramente, me siento mas confundido ahora que cuando empece a pensarlo todo.", provenance: "spontaneous", asrConfidence: 0.96 },
];

const REPORT = {
  evidence: "sufficient",
  evidenceNote: "Dos detalles para pulir.",
  items: [
    { channel: "grammar", category: "ser_estar", severity: "noticeable", turnIndex: 2, utterance: "esta muy importante", suggestion: "es muy importante", explanation: "Cualidad inherente." },
  ],
  strengths: [],
  afnCandidates: ["ser_estar"],
};

function send(api, body) {
  return api
    .post("/api/router?route=session-analyst")
    .set("x-admin-token", "test_admin_token")
    .send({ uid: "u1", sessionId: "s1", surface: "guided", pack: "es", level: "C1", ...body });
}

describe("session-analyst idempotency (hard law 6)", () => {
  it("an equal-length second pass is a no-op: no LLM call, no duplicate rows", async () => {
    createSpy.mockResolvedValue(reply(REPORT));
    const api = await client();

    const first = await send(api, { turns: TURNS, capturedVia: "exit" });
    expect(first.status).toBe(200);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(sbRef.current.rows(EVENTS)).toHaveLength(1);

    const second = await send(api, { turns: TURNS, capturedVia: "explicit" });
    expect(second.status).toBe(200);
    expect(createSpy).toHaveBeenCalledTimes(1); // still one: no second analysis
    expect(sbRef.current.rows(EVENTS)).toHaveLength(1); // still one: no duplicate

    // The caller still gets a real report, so the UI renders identically.
    expect(second.body.evidence).toBe("sufficient");
    expect(second.body.items).toEqual(first.body.items);
    expect(second.body.meta.deduped).toBe(true);

    // The record still belongs to the pass that won it.
    const [rec] = sbRef.current.rows(ANALYSES);
    expect(rec.captured_via).toBe("exit");
    expect(rec.turn_count).toBe(4);
  });

  it("a strictly longer pass supersedes: the shorter pass's rows are replaced", async () => {
    createSpy.mockResolvedValue(reply(REPORT));
    const api = await client();

    // Exit capture caught the first two turns only.
    await send(api, { turns: TURNS.slice(0, 2), capturedVia: "exit" });
    expect(sbRef.current.rows(EVENTS)).toHaveLength(1);
    expect(sbRef.current.rows(ANALYSES)[0].turn_count).toBe(2);

    // The learner came back and ended properly with all four.
    const full = await send(api, { turns: TURNS, capturedVia: "explicit" });
    expect(full.status).toBe(200);
    expect(createSpy).toHaveBeenCalledTimes(2);

    // Exactly one set of rows: the earlier pass's row was cleared, not stacked.
    expect(sbRef.current.rows(EVENTS)).toHaveLength(1);
    expect(sbRef.current.rows(ANALYSES)).toHaveLength(1);
    const [rec] = sbRef.current.rows(ANALYSES);
    expect(rec.turn_count).toBe(4);
    expect(rec.captured_via).toBe("explicit");
    expect(rec.stored_events).toBe(1);
  });

  it("a shorter later pass loses: an exit hook after a full End Session changes nothing", async () => {
    createSpy.mockResolvedValue(reply(REPORT));
    const api = await client();

    await send(api, { turns: TURNS, capturedVia: "explicit" });
    const before = sbRef.current.rows(EVENTS);

    const late = await send(api, { turns: TURNS.slice(0, 2), capturedVia: "exit" });
    expect(late.status).toBe(200);
    expect(late.body.meta.deduped).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(sbRef.current.rows(EVENTS)).toEqual(before);
    expect(sbRef.current.rows(ANALYSES)[0].captured_via).toBe("explicit");
  });

  it("records captured_via and truncated, defaulting an absent or unknown value to explicit", async () => {
    createSpy.mockResolvedValue(reply(REPORT));
    const api = await client();

    await send(api, { turns: TURNS, sessionId: "a", capturedVia: "switch", truncated: true });
    await send(api, { turns: TURNS, sessionId: "b" });
    await send(api, { turns: TURNS, sessionId: "c", capturedVia: "hacked" });

    const rows = sbRef.current.rows(ANALYSES);
    expect(rows.find((r) => r.session_id === "a")).toMatchObject({
      captured_via: "switch",
      truncated: true,
    });
    expect(rows.find((r) => r.session_id === "b")).toMatchObject({
      captured_via: "explicit",
      truncated: false,
    });
    expect(rows.find((r) => r.session_id === "c").captured_via).toBe("explicit");
  });

  it("does NOT collide across two scenarios sharing one guided session id", async () => {
    // The guided client mints one session id per PAGE LOAD and reuses it across
    // startScenario(). Keying on session_id alone would silently discard the
    // second, shorter scenario. The composite key must keep them apart.
    createSpy.mockResolvedValue(reply(REPORT));
    const api = await client();

    await send(api, { turns: TURNS, scenarioKey: "coffee" });
    await send(api, { turns: TURNS.slice(0, 2), scenarioKey: "doctor" });

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(sbRef.current.rows(ANALYSES)).toHaveLength(2);
    expect(sbRef.current.rows(EVENTS)).toHaveLength(2);
  });

  it("separates the two surfaces even when a session id is shared", async () => {
    createSpy.mockResolvedValue(reply(REPORT));
    const api = await client();

    await send(api, { turns: TURNS, surface: "guided" });
    await send(api, { turns: TURNS, surface: "streaming" });

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(sbRef.current.rows(ANALYSES)).toHaveLength(2);
  });

  it("skips dedupe entirely when there is no session id (the pre-idempotency path)", async () => {
    createSpy.mockResolvedValue(reply(REPORT));
    const api = await client();

    await send(api, { turns: TURNS, sessionId: "" });
    await send(api, { turns: TURNS, sessionId: "" });

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(sbRef.current.rows(EVENTS)).toHaveLength(2); // unchanged old behaviour
    expect(sbRef.current.rows(ANALYSES)).toHaveLength(0);
  });

  it("degrades to today's behaviour when the analyses table has not been migrated yet", async () => {
    // Migrations here are pasted into the Supabase SQL editor by hand, so
    // between a deploy and that paste the table does not exist. Idempotency is
    // a safety net, never a gate: the analyst must keep working without it.
    sbRef.current = makeFakeSupabase({ unique: LUX_UNIQUE, failTables: new Set([ANALYSES]) });
    createSpy.mockResolvedValue(reply(REPORT));
    const api = await client();

    const first = await send(api, { turns: TURNS });
    const second = await send(api, { turns: TURNS });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.evidence).toBe("sufficient");
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(sbRef.current.rows(EVENTS)).toHaveLength(2);
  });

  it("writes NOTHING at all for a below-gate pass, record included (hard law 2a)", async () => {
    // "Store nothing" under the gate covers the idempotency record too. A
    // below-gate pass costs no LLM call and no speech_events row, so there is
    // nothing a record would protect against; re-running the gate is pure local
    // arithmetic. A repeated exit hook is therefore free, not deduped.
    const api = await client();
    const tiny = [{ index: 1, text: "Si, gracias.", provenance: "spontaneous", asrConfidence: 0.99 }];

    const first = await send(api, { turns: tiny, capturedVia: "exit" });
    expect(first.body.evidence).toBe("insufficient");
    expect(createSpy).not.toHaveBeenCalled();
    expect(sbRef.current.rows(ANALYSES)).toHaveLength(0);
    expect(sbRef.current.rows(EVENTS)).toHaveLength(0);

    const second = await send(api, { turns: tiny, capturedVia: "exit" });
    expect(second.body.evidence).toBe("insufficient");
    expect(second.body.meta.deduped).toBeUndefined();
    expect(createSpy).not.toHaveBeenCalled();
    expect(sbRef.current.rows(ANALYSES)).toHaveLength(0);
  });

  it("lets a real conversation run after an earlier below-gate exit capture", async () => {
    createSpy.mockResolvedValue(reply(REPORT));
    const api = await client();

    await send(api, { turns: [{ index: 1, text: "Hola." , provenance: "spontaneous", asrConfidence: 0.99 }], capturedVia: "exit" });
    expect(sbRef.current.rows(ANALYSES)).toHaveLength(0);

    const full = await send(api, { turns: TURNS, capturedVia: "explicit" });
    expect(full.body.evidence).toBe("sufficient");
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(sbRef.current.rows(ANALYSES)).toHaveLength(1);
    expect(sbRef.current.rows(ANALYSES)[0].evidence).toBe("sufficient");
    expect(sbRef.current.rows(EVENTS)).toHaveLength(1);
  });

  it("dedupes a model-declared insufficient pass, which DID cost an LLM call", async () => {
    createSpy.mockResolvedValue(reply({ evidence: "insufficient", evidenceNote: "Turnos muy cortos.", items: [], strengths: [], afnCandidates: [] }));
    const api = await client();

    const first = await send(api, { turns: TURNS, capturedVia: "exit" });
    expect(first.body.evidence).toBe("insufficient");
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(sbRef.current.rows(ANALYSES)).toHaveLength(1);
    expect(sbRef.current.rows(EVENTS)).toHaveLength(0);

    const second = await send(api, { turns: TURNS, capturedVia: "explicit" });
    expect(second.body.meta.deduped).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1); // the second LLM call was saved
  });

  it("stores the report so a deduped caller renders the same section", async () => {
    createSpy.mockResolvedValue(reply(REPORT));
    const api = await client();

    const first = await send(api, { turns: TURNS });
    const rec = sbRef.current.rows(ANALYSES)[0];
    expect(rec.report).toBeTruthy();
    expect(rec.report.items).toHaveLength(1);

    const second = await send(api, { turns: TURNS });
    expect(second.body.evidenceNote).toBe(first.body.evidenceNote);
    expect(second.body.afnCandidates).toEqual(first.body.afnCandidates);
  });
});
