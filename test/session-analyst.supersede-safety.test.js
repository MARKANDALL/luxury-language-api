// test/session-analyst.supersede-safety.test.js
// Regression tests for the defects an adversarial review of the idempotency
// work found. Every case here is a way the supersede machinery could LOSE a
// learner's stored speech, which is worse than failing to capture it.
//
// The headline one: two conversations of the SAME scenario in one page load
// share uid, session_id, surface AND scenario_key, because the guided client
// mints one session id per page load. Before conversation_key existed, the
// second conversation either vanished (when shorter) or DELETED the first
// conversation's rows (when longer), on the ordinary End Session path.
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
const reply = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

const TURNS = [
  { index: 1, text: "La verdad es que llevo semanas dandole vueltas y todavia no lo tengo claro.", provenance: "spontaneous", asrConfidence: 0.96 },
  { index: 2, text: "El problema es que esta reunion esta muy importante para mi carrera.", provenance: "spontaneous", asrConfidence: 0.95 },
  { index: 3, text: "Necesito hacer una decision pronto, pero mis colegas no ayudan nada.", provenance: "spontaneous", asrConfidence: 0.97 },
];

const REPORT = {
  evidence: "sufficient",
  evidenceNote: "Nota.",
  items: [
    { channel: "grammar", category: "ser_estar", severity: "noticeable", turnIndex: 2, utterance: "esta muy importante", suggestion: "es muy importante", explanation: "Cualidad inherente." },
  ],
  strengths: [],
  afnCandidates: ["ser_estar"],
};

// Everything here is the SAME guided page load: one session id throughout.
function send(api, body) {
  return api
    .post("/api/router?route=session-analyst")
    .set("x-admin-token", "test_admin_token")
    .send({
      uid: "u1",
      sessionId: "page-load-1",
      surface: "guided",
      scenarioKey: "coffee",
      pack: "es",
      level: "C1",
      ...body,
    });
}

describe("two conversations of the same scenario in one page load", () => {
  it("does NOT delete the first conversation's rows when the second is longer", async () => {
    createSpy.mockResolvedValue(reply(REPORT));
    const api = await client();

    await send(api, { turns: TURNS.slice(0, 2), conversationKey: "c1" });
    expect(sbRef.current.rows(EVENTS)).toHaveLength(1);

    // Same scenario again, longer. Under a key without conversation_key this
    // deleted the rows above.
    await send(api, { turns: TURNS, conversationKey: "c2" });

    expect(sbRef.current.rows(EVENTS)).toHaveLength(2); // both survive
    expect(sbRef.current.rows(ANALYSES)).toHaveLength(2);
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT discard the second conversation when it is shorter", async () => {
    createSpy.mockResolvedValue(reply(REPORT));
    const api = await client();

    await send(api, { turns: TURNS, conversationKey: "c1" });
    const second = await send(api, { turns: TURNS.slice(0, 2), conversationKey: "c2" });

    expect(second.body.meta.deduped).toBeUndefined();
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(sbRef.current.rows(EVENTS)).toHaveLength(2);
  });

  it("still dedupes the two passes of ONE conversation, which is the whole point", async () => {
    createSpy.mockResolvedValue(reply(REPORT));
    const api = await client();

    await send(api, { turns: TURNS, conversationKey: "c1", capturedVia: "exit" });
    const again = await send(api, { turns: TURNS, conversationKey: "c1", capturedVia: "explicit" });

    expect(again.body.meta.deduped).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(sbRef.current.rows(EVENTS)).toHaveLength(1);
  });

  it("supersedes within one conversation, clearing only that conversation's rows", async () => {
    createSpy.mockResolvedValue(reply(REPORT));
    const api = await client();

    // Both flag turn 2, so both passes must carry at least two turns to store a row.
    await send(api, { turns: TURNS.slice(0, 2), conversationKey: "c1", capturedVia: "exit" });
    await send(api, { turns: TURNS.slice(0, 2), conversationKey: "c2" }); // a different conversation
    expect(sbRef.current.rows(EVENTS)).toHaveLength(2);

    // c1 comes back with more turns: it replaces its OWN row and nothing else.
    await send(api, { turns: TURNS, conversationKey: "c1", capturedVia: "explicit" });
    expect(sbRef.current.rows(EVENTS)).toHaveLength(2);
    expect(sbRef.current.rows(ANALYSES)).toHaveLength(2);
    expect(
      sbRef.current.rows(ANALYSES).find((r) => r.conversation_key === "c1").turn_count
    ).toBe(3);
  });
});

describe("a pass that claimed the key and died", () => {
  it("is taken over by an equal-length retry instead of locking the session", async () => {
    // The abandoned claim: turn_count set, report never written.
    sbRef.current.seed(ANALYSES, [
      {
        uid: "u1",
        session_id: "page-load-1",
        surface: "guided",
        scenario_key: "coffee",
        conversation_key: "c1",
        pack: "es",
        captured_via: "exit",
        turn_count: 3,
        truncated: false,
        evidence: "sufficient",
        stored_events: 0,
        report: null,
      },
    ]);
    createSpy.mockResolvedValueOnce(reply(REPORT));
    const api = await client();

    const r = await send(api, { turns: TURNS, conversationKey: "c1", capturedVia: "explicit" });

    expect(r.body.evidence).toBe("sufficient");
    expect(createSpy).toHaveBeenCalledTimes(1); // it really re-analyzed
    expect(sbRef.current.rows(EVENTS)).toHaveLength(1); // and really stored
    const [rec] = sbRef.current.rows(ANALYSES);
    expect(rec.report).toBeTruthy();
    expect(rec.captured_via).toBe("explicit");
    expect(sbRef.current.rows(ANALYSES)).toHaveLength(1); // taken over, not duplicated
  });
});

describe("a pass whose rows never landed", () => {
  it("is left claimable rather than recorded as a finished analysis", async () => {
    // speech_events is unwritable; the analyses table is fine.
    sbRef.current = makeFakeSupabase({
      unique: LUX_UNIQUE,
      failTables: new Set([EVENTS]),
    });
    createSpy.mockResolvedValueOnce(reply(REPORT));
    const api = await client();

    const r = await send(api, { turns: TURNS, conversationKey: "c1" });

    // The learner still gets their report.
    expect(r.status).toBe(200);
    expect(r.body.evidence).toBe("sufficient");
    expect(r.body.meta.stored).toBe(0);

    // But the record must not claim the pass finished, or a retry could never
    // store anything for this session again.
    const [rec] = sbRef.current.rows(ANALYSES);
    expect(rec.report).toBeNull();
    expect(rec.stored_events).toBe(0);
  });
});

describe("a longer pass the model calls insufficient", () => {
  it("clears the shorter pass's rows it supersedes", async () => {
    const api = await client();

    createSpy.mockResolvedValueOnce(reply(REPORT));
    await send(api, { turns: TURNS.slice(0, 2), conversationKey: "c1", capturedVia: "exit" });
    expect(sbRef.current.rows(EVENTS)).toHaveLength(1);

    // More turns, but this fuller reading finds nothing worth flagging.
    createSpy.mockResolvedValueOnce(
      reply({ evidence: "insufficient", evidenceNote: "Turnos muy cortos.", items: [], strengths: [], afnCandidates: [] })
    );
    const second = await send(api, { turns: TURNS, conversationKey: "c1", capturedVia: "explicit" });

    expect(second.body.evidence).toBe("insufficient");
    // The earlier flag must not survive a fuller reading that rejected it.
    expect(sbRef.current.rows(EVENTS)).toHaveLength(0);
    expect(sbRef.current.rows(ANALYSES)[0].evidence).toBe("insufficient");
  });
});

describe("clients that send no conversation key", () => {
  it("still dedupe, so an older client is not left unprotected", async () => {
    createSpy.mockResolvedValue(reply(REPORT));
    const api = await client();

    await send(api, { turns: TURNS, capturedVia: "exit" });
    const again = await send(api, { turns: TURNS, capturedVia: "explicit" });

    expect(again.body.meta.deduped).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(sbRef.current.rows(ANALYSES)).toHaveLength(1);
    expect(sbRef.current.rows(ANALYSES)[0].conversation_key).toBeNull();
  });
});
