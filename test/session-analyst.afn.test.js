// test/session-analyst.afn.test.js
// AFN = areas-for-next-focus (routes/learner-model.js:38). The analyst nominates
// up to three taxonomy category codes per session; until migration 0009 they
// were computed, returned once to the end-of-session modal, and thrown away.
//
// These tests pin that they are now persisted, that persisting them did NOT
// change how they are computed, and that a missing table never costs the learner
// their report or their speech_events rows.
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

const AFN = "speech_afn_candidates";
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
const reply = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

const TURNS = [
  { index: 1, text: "La verdad es que llevo semanas dandole vueltas y todavia no lo tengo claro.", provenance: "spontaneous", asrConfidence: 0.96 },
  { index: 2, text: "El problema es que esta reunion esta muy importante para mi carrera.", provenance: "spontaneous", asrConfidence: 0.95 },
];

function baseReport(afnCandidates) {
  return {
    evidence: "sufficient",
    evidenceNote: "Nota.",
    items: [
      { channel: "grammar", category: "ser_estar", severity: "noticeable", turnIndex: 2, utterance: "esta muy importante", suggestion: "es muy importante", explanation: "Cualidad inherente." },
    ],
    strengths: [],
    afnCandidates,
  };
}

function send(api, body) {
  return api
    .post("/api/router?route=session-analyst")
    .set("x-admin-token", "test_admin_token")
    .send({ uid: "u1", sessionId: "s1", surface: "guided", pack: "es", level: "C1", ...body });
}

describe("session-analyst AFN persistence (migration 0009)", () => {
  it("stores each nominated category with its rank, and keeps returning them", async () => {
    createSpy.mockResolvedValueOnce(reply(baseReport(["ser_estar", "collocations"])));
    const api = await client();
    const r = await send(api, { turns: TURNS, scenarioKey: "coffee" });

    // The response contract is unchanged.
    expect(r.body.afnCandidates).toEqual(["ser_estar", "collocations"]);

    const rows = sbRef.current.rows(AFN);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      uid: "u1",
      session_id: "s1",
      surface: "guided",
      scenario_key: "coffee",
      pack: "es",
      category: "ser_estar",
      rank: 1,
    });
    expect(rows[1]).toMatchObject({ category: "collocations", rank: 2 });
    expect(r.body.meta.storedAfn).toBe(2);
  });

  it("does not change how candidates are computed: unknown codes still dropped, still capped at 3, still deduped", async () => {
    createSpy.mockResolvedValueOnce(
      reply(baseReport(["ser_estar", "ser_estar", "not_a_real_code", "collocations", "gender_agreement", "por_para"]))
    );
    const api = await client();
    const r = await send(api, { turns: TURNS });

    expect(r.body.afnCandidates).toHaveLength(3);
    expect(r.body.afnCandidates).not.toContain("not_a_real_code");
    expect(new Set(r.body.afnCandidates).size).toBe(3);
    // What was stored is exactly what was returned, in the same order.
    expect(sbRef.current.rows(AFN).map((x) => x.category)).toEqual(r.body.afnCandidates);
    expect(sbRef.current.rows(AFN).map((x) => x.rank)).toEqual([1, 2, 3]);
  });

  it("writes nothing when the analyst nominated nothing", async () => {
    createSpy.mockResolvedValueOnce(reply(baseReport([])));
    const api = await client();
    const r = await send(api, { turns: TURNS });

    expect(r.body.afnCandidates).toEqual([]);
    expect(sbRef.current.rows(AFN)).toHaveLength(0);
    expect(sbRef.current.rows(EVENTS)).toHaveLength(1); // the flag still landed
  });

  it("writes nothing below the spontaneous word gate (hard law 2a)", async () => {
    const api = await client();
    const r = await send(api, {
      turns: [{ index: 1, text: "Si.", provenance: "spontaneous", asrConfidence: 0.99 }],
    });
    expect(r.body.evidence).toBe("insufficient");
    expect(sbRef.current.rows(AFN)).toHaveLength(0);
  });

  it("a superseding pass replaces the earlier pass's nominations, never stacks them", async () => {
    const api = await client();

    createSpy.mockResolvedValueOnce(reply(baseReport(["ser_estar"])));
    await send(api, { turns: TURNS.slice(0, 1), capturedVia: "exit" });
    expect(sbRef.current.rows(AFN).map((x) => x.category)).toEqual(["ser_estar"]);

    createSpy.mockResolvedValueOnce(reply(baseReport(["collocations", "por_para"])));
    await send(api, { turns: TURNS, capturedVia: "explicit" });

    const rows = sbRef.current.rows(AFN);
    expect(rows).toHaveLength(2);
    expect(rows.map((x) => x.category)).toEqual(["collocations", "por_para"]);
  });

  it("a deduped no-op pass writes no second generation of nominations", async () => {
    createSpy.mockResolvedValue(reply(baseReport(["ser_estar", "collocations"])));
    const api = await client();

    await send(api, { turns: TURNS, capturedVia: "exit" });
    const second = await send(api, { turns: TURNS, capturedVia: "explicit" });

    expect(second.body.meta.deduped).toBe(true);
    expect(sbRef.current.rows(AFN)).toHaveLength(2);
  });

  it("a missing table costs neither the report nor the speech_events rows", async () => {
    sbRef.current = makeFakeSupabase({ unique: LUX_UNIQUE, failTables: new Set([AFN]) });
    createSpy.mockResolvedValueOnce(reply(baseReport(["ser_estar"])));
    const api = await client();
    const r = await send(api, { turns: TURNS });

    expect(r.status).toBe(200);
    expect(r.body.evidence).toBe("sufficient");
    expect(r.body.afnCandidates).toEqual(["ser_estar"]);
    expect(r.body.meta.storedAfn).toBe(0);
    expect(sbRef.current.rows(EVENTS)).toHaveLength(1);
  });
});
