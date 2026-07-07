// test/session-analyst.contract.test.js
// Contract test for /api/router?route=session-analyst. Hermetic: Supabase and
// OpenAI are both mocked (mirrors coach-ask.contract.test.js). Covers:
//  - the synthetic ABOVE-gate fixture: exactly the two seeded errors surface
//    (a ser/estar grammar flag + a "hacer una decisión" collocation), nothing else
//  - server-side validation: unknown category codes and non-existent turns dropped
//  - provenance/confidence enforcement (hard laws 2b + 3): flags on chip_read and
//    low-confidence turns are dropped even when the model returns them
//  - the single JSON-repair retry, and fail-silent on a second failure (hard law 5)
//  - model-declared insufficient past the gate stores nothing
//  - pack-neutrality: the route runs end-to-end under pack:"en" using the stub
//  - the admin gate and input validation
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

// Synthetic ABOVE-gate fixture (es, C1): 4 spontaneous C1-ish turns, well over
// the 12-word gate, with exactly two seeded errors — a ser/estar slip (turn 2)
// and a "hacer una decisión" collocation (turn 3).
const SYNTHETIC_TURNS = [
  { index: 1, text: "La verdad es que llevo semanas dándole vueltas y todavía no lo tengo nada claro.", provenance: "spontaneous", asrConfidence: 0.96 },
  { index: 2, text: "El problema es que esta reunión está muy importante para mi carrera.", provenance: "spontaneous", asrConfidence: 0.95 },
  { index: 3, text: "Necesito hacer una decisión pronto, pero mis colegas me dan consejos contradictorios.", provenance: "spontaneous", asrConfidence: 0.97 },
  { index: 4, text: "Sinceramente, me siento más confundido ahora que cuando empecé a pensarlo.", provenance: "spontaneous", asrConfidence: 0.96 },
];

// What a well-calibrated gpt-4.1 should return for that fixture.
const SYNTHETIC_REPORT = {
  evidence: "sufficient",
  evidenceNote: "Buen manejo general; dos detalles para pulir.",
  items: [
    { channel: "grammar", category: "ser_estar", severity: "noticeable", turnIndex: 2, utterance: "está muy importante", suggestion: "es muy importante", explanation: "La importancia es una cualidad inherente, así que se usa ser." },
    { channel: "word_choice", category: "collocations", severity: "polish", turnIndex: 3, utterance: "hacer una decisión", suggestion: "tomar una decisión", explanation: "En español la colocación natural es tomar una decisión." },
  ],
  strengths: [
    { turnIndex: 1, utterance: "dándole vueltas", note: "Giro idiomático natural, por encima del nivel declarado." },
  ],
  afnCandidates: ["ser_estar", "collocations"],
};

function send(api, body) {
  return api
    .post("/api/router?route=session-analyst")
    .set("x-admin-token", "test_admin_token")
    .send({ uid: "u1", sessionId: "s1", surface: "guided", pack: "es", level: "C1", ...body });
}

describe("session-analyst contract", () => {
  it("flags exactly the two seeded errors and nothing else (above the gate)", async () => {
    createSpy.mockResolvedValueOnce(reply(SYNTHETIC_REPORT));
    const api = await client();
    const r = await send(api, { turns: SYNTHETIC_TURNS });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.evidence).toBe("sufficient");
    expect(createSpy).toHaveBeenCalledTimes(1); // one LLM call

    expect(r.body.items).toHaveLength(2);
    // Sorted most-severe first: noticeable (ser_estar) before polish (collocations).
    expect(r.body.items[0]).toMatchObject({ channel: "grammar", category: "ser_estar", turnIndex: 2 });
    expect(r.body.items[1]).toMatchObject({ channel: "word_choice", category: "collocations", turnIndex: 3 });
    expect(r.body.strengths).toHaveLength(1);
    expect(r.body.strengths[0]).toMatchObject({ turnIndex: 1, utterance: "dándole vueltas" });

    // Store all: 2 items + 1 strength = 3 rows, in one insert call.
    expect(insertSpy).toHaveBeenCalledTimes(1);
    const rows = insertSpy.mock.calls[0][0];
    expect(rows).toHaveLength(3);
    const strengthRow = rows.find((x) => x.channel === "strength");
    expect(strengthRow).toMatchObject({ severity: "positive", category: null });
    // asr_confidence + provenance are carried from the flagged turn.
    const serRow = rows.find((x) => x.category === "ser_estar");
    expect(serRow).toMatchObject({ asr_confidence: 0.95, provenance: "spontaneous", pack: "es" });
  });

  it("sorts items most-severe first even when the model returns them out of order", async () => {
    // Model returns polish -> blocked -> noticeable; the route must reorder to
    // blocked -> noticeable -> polish (exercises the severity sort, not a no-op).
    createSpy.mockResolvedValueOnce(reply({
      evidence: "sufficient",
      evidenceNote: "…",
      items: [
        { channel: "word_choice", category: "collocations", severity: "polish", turnIndex: 3, utterance: "hacer una decisión", suggestion: "tomar una decisión", explanation: "polish" },
        { channel: "grammar", category: "ser_estar", severity: "blocked", turnIndex: 2, utterance: "está muy importante", suggestion: "es muy importante", explanation: "blocked" },
        { channel: "grammar", category: "subjunctive", severity: "noticeable", turnIndex: 1, utterance: "todavía no lo tengo claro", suggestion: "aunque todavía no lo tenga claro", explanation: "noticeable" },
      ],
      strengths: [],
      afnCandidates: [],
    }));
    const api = await client();
    const r = await send(api, { turns: SYNTHETIC_TURNS });

    expect(r.body.items.map((i) => i.severity)).toEqual(["blocked", "noticeable", "polish"]);
    expect(r.body.items.map((i) => i.turnIndex)).toEqual([2, 1, 3]);
  });

  it("drops unknown category codes and flags on non-existent turns", async () => {
    createSpy.mockResolvedValueOnce(reply({
      evidence: "sufficient",
      evidenceNote: "…",
      items: [
        ...SYNTHETIC_REPORT.items,
        { channel: "grammar", category: "totally_made_up", severity: "blocked", turnIndex: 2, utterance: "x", suggestion: "y", explanation: "z" },
        { channel: "grammar", category: "ser_estar", severity: "blocked", turnIndex: 99, utterance: "x", suggestion: "y", explanation: "z" },
      ],
      strengths: [
        ...SYNTHETIC_REPORT.strengths,
        { turnIndex: 99, utterance: "ghost", note: "does not exist" },
      ],
      afnCandidates: ["ser_estar", "totally_made_up", "collocations"],
    }));
    const api = await client();
    const r = await send(api, { turns: SYNTHETIC_TURNS });

    expect(r.body.items).toHaveLength(2); // decoys dropped
    expect(r.body.items.map((i) => i.category).sort()).toEqual(["collocations", "ser_estar"]);
    expect(r.body.strengths).toHaveLength(1); // ghost strength dropped
    expect(r.body.afnCandidates).toEqual(["ser_estar", "collocations"]); // unknown code filtered
  });

  it("drops flags on chip_read and low-confidence turns (hard laws 2b + 3)", async () => {
    const turns = [
      { index: 1, text: "Quiero contarte que ayer estuve pensando mucho en lo que hablamos la semana pasada.", provenance: "spontaneous", asrConfidence: 0.97 },
      { index: 2, text: "Va, aquí espero.", provenance: "chip_read", asrConfidence: 0.98 },
      { index: 3, text: "esta comida está muy rico", provenance: "spontaneous", asrConfidence: 0.6 },
    ];
    createSpy.mockResolvedValueOnce(reply({
      evidence: "sufficient",
      evidenceNote: "…",
      items: [
        { channel: "grammar", category: "gender_agreement", severity: "noticeable", turnIndex: 1, utterance: "lo que hablamos", suggestion: "lo que hablamos", explanation: "válido" },
        { channel: "grammar", category: "ser_estar", severity: "blocked", turnIndex: 2, utterance: "aquí espero", suggestion: "x", explanation: "chip_read: no debe marcarse" },
        { channel: "grammar", category: "gender_agreement", severity: "noticeable", turnIndex: 3, utterance: "está muy rico", suggestion: "está muy rica", explanation: "baja confianza: no debe marcarse" },
      ],
      strengths: [{ turnIndex: 2, utterance: "aquí espero", note: "chip_read no merece crédito" }],
      afnCandidates: [],
    }));
    const api = await client();
    const r = await send(api, { turns });

    // Only the turn-1 spontaneous, high-confidence flag survives.
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].turnIndex).toBe(1);
    // The chip_read strength earns no credit.
    expect(r.body.strengths).toHaveLength(0);
  });

  it("retries once on invalid JSON, then succeeds", async () => {
    createSpy
      .mockResolvedValueOnce(reply({ evidence: "maybe", items: [] })) // invalid enum -> repair
      .mockResolvedValueOnce(reply(SYNTHETIC_REPORT));
    const api = await client();
    const r = await send(api, { turns: SYNTHETIC_TURNS });

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(r.status).toBe(200);
    expect(r.body.evidence).toBe("sufficient");
    expect(r.body.items).toHaveLength(2);
    expect(r.body.meta.retried).toBe(true);
    // The retry must actually carry the repair instruction (hard law 5) — not
    // just re-send the same messages. Assert the second call's final turn asks
    // for the corrected JSON.
    const secondMessages = createSpy.mock.calls[1][0].messages;
    const lastTurn = secondMessages[secondMessages.length - 1];
    expect(lastTurn.role).toBe("user");
    expect(lastTurn.content).toContain("corrected JSON");
  });

  it("fails silent (502, no rows) when JSON is invalid twice", async () => {
    createSpy
      .mockResolvedValueOnce(reply({ evidence: "maybe" }))
      .mockResolvedValueOnce(reply({ nope: true }));
    const api = await client();
    const r = await send(api, { turns: SYNTHETIC_TURNS });

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, error: "analysis_unavailable" });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("honors a model-declared insufficient past the gate (stores nothing)", async () => {
    createSpy.mockResolvedValueOnce(reply({
      evidence: "insufficient",
      evidenceNote: "Fueron respuestas cortas y transaccionales.",
      items: [], strengths: [], afnCandidates: [],
    }));
    const api = await client();
    const r = await send(api, { turns: SYNTHETIC_TURNS });

    expect(r.status).toBe(200);
    expect(r.body.evidence).toBe("insufficient");
    expect(r.body.items).toEqual([]);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("excludes low-confidence words from the pre-gate count (hard law 2b)", async () => {
    // 18 raw spontaneous words, but all below the 0.85 ASR floor — so the gate
    // count is 0, the session is insufficient, and the LLM is never called. If
    // the confidence filter were dropped from the gate, this would spuriously
    // clear 12 and call the model.
    const lowConf = [
      { index: 1, text: "esta es una respuesta bastante larga pero poco confiable", provenance: "spontaneous", asrConfidence: 0.5 },
      { index: 2, text: "otra frase igual de larga que tampoco se escucha bien", provenance: "spontaneous", asrConfidence: 0.5 },
    ];
    const api = await client();
    const r = await send(api, { turns: lowConf });

    expect(r.status).toBe(200);
    expect(r.body.evidence).toBe("insufficient");
    expect(r.body.meta.spontaneousWords).toBe(0);
    expect(r.body.meta.llmCalled).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("runs end-to-end under pack:'en' using the stub (pack-neutral)", async () => {
    // Below-gate en session: proves the engine loads the en dictionary and never
    // touches OpenAI when the pre-gate trips.
    const api = await client();
    const r = await api
      .post("/api/router?route=session-analyst")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "u1", sessionId: "s1", surface: "guided", pack: "en", level: "B2", turns: [
        { index: 1, text: "Yes, sure.", provenance: "spontaneous", asrConfidence: 0.99 },
      ] });

    expect(r.status).toBe(200);
    expect(r.body.evidence).toBe("insufficient");
    expect(r.body.evidenceNote).toContain("free speech"); // en copy, not Spanish
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("surfaces an en-stub category on an above-gate en session (full engine path)", async () => {
    createSpy.mockResolvedValueOnce(reply({
      evidence: "sufficient",
      evidenceNote: "Solid overall.",
      items: [
        { channel: "word_choice", category: "collocations", severity: "polish", turnIndex: 1, utterance: "do a decision", suggestion: "make a decision", explanation: "The set phrase is 'make a decision'." },
      ],
      strengths: [],
      afnCandidates: ["collocations"],
    }));
    const api = await client();
    const r = await api
      .post("/api/router?route=session-analyst")
      .set("x-admin-token", "test_admin_token")
      .send({ uid: "u1", sessionId: "s1", surface: "guided", pack: "en", level: "B2", turns: [
        { index: 1, text: "I really need to do a decision about the job offer before the weekend comes.", provenance: "spontaneous", asrConfidence: 0.95 },
      ] });

    expect(r.status).toBe(200);
    expect(r.body.evidence).toBe("sufficient");
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].category).toBe("collocations");
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("enforces the admin gate (401, no model call)", async () => {
    const api = await client();
    const r = await api
      .post("/api/router?route=session-analyst")
      .send({ uid: "u1", turns: SYNTHETIC_TURNS });
    expect(r.status).toBe(401);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("validates input (400 on missing uid / empty turns)", async () => {
    const api = await client();
    const r1 = await send(api, { uid: "", turns: SYNTHETIC_TURNS });
    expect(r1.status).toBe(400);
    const r2 = await send(api, { turns: [] });
    expect(r2.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });
});
