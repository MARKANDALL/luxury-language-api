// test/session-analyst.provenance.test.js
// The two new provenance values, 'dictated' and 'composed'.
//
// The point of this file is the NEGATIVE result as much as the positive one:
// adding them must not have moved anything that was already there. Before this
// change dictated text arrived tagged 'spontaneous' and was gated and judged as
// such, so the new labels have to gate and judge identically or the change is a
// silent regression that withholds feedback from anyone who dictates.
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

// One turn, 15 words, comfortably over the 12-word gate on its own.
const LONE_TURN = "La verdad es que llevo semanas dandole vueltas y todavia no lo tengo nada claro.";

function send(api, body, sid = "s1") {
  return api
    .post("/api/router?route=session-analyst")
    .set("x-admin-token", "test_admin_token")
    .send({ uid: "u1", sessionId: sid, surface: "guided", pack: "es", level: "C1", ...body });
}

const FLAG = {
  evidence: "sufficient",
  evidenceNote: "Nota.",
  items: [
    { channel: "grammar", category: "ser_estar", severity: "noticeable", turnIndex: 1, utterance: "x", suggestion: "y", explanation: "z" },
  ],
  strengths: [{ turnIndex: 1, utterance: "dandole vueltas", note: "Giro natural." }],
  afnCandidates: [],
};

describe("provenance: dictated and composed are the learner's own production", () => {
  for (const provenance of ["dictated", "composed"]) {
    it(`counts a ${provenance} turn toward the spontaneous word gate`, async () => {
      createSpy.mockResolvedValueOnce(reply(FLAG));
      const api = await client();
      const r = await send(api, {
        turns: [{ index: 1, text: LONE_TURN, provenance, asrConfidence: 0.95 }],
      });

      // The gate was cleared, so the model actually ran.
      expect(r.body.evidence).toBe("sufficient");
      expect(r.body.meta.llmCalled).toBe(true);
      expect(r.body.meta.spontaneousWords).toBeGreaterThanOrEqual(12);
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it(`lets a ${provenance} turn carry a flag and a strength`, async () => {
      createSpy.mockResolvedValueOnce(reply(FLAG));
      const api = await client();
      const r = await send(api, {
        turns: [{ index: 1, text: LONE_TURN, provenance, asrConfidence: 0.95 }],
      });

      expect(r.body.items).toHaveLength(1);
      expect(r.body.strengths).toHaveLength(1);
    });

    it(`writes '${provenance}' onto the stored row, not 'spontaneous'`, async () => {
      createSpy.mockResolvedValueOnce(reply(FLAG));
      const api = await client();
      await send(api, {
        turns: [{ index: 1, text: LONE_TURN, provenance, asrConfidence: 0.95 }],
      });

      const rows = sbRef.current.rows("speech_events");
      expect(rows).toHaveLength(2); // the flag and the strength
      for (const row of rows) expect(row.provenance).toBe(provenance);
    });

    it(`still respects the ASR confidence floor for ${provenance}`, async () => {
      createSpy.mockResolvedValueOnce(reply(FLAG));
      const api = await client();
      const r = await send(api, {
        turns: [
          { index: 1, text: LONE_TURN, provenance, asrConfidence: 0.4 },
          { index: 2, text: LONE_TURN, provenance: "spontaneous", asrConfidence: 0.99 },
        ],
      });
      // Turn 1 is below the floor, so nothing may be pinned on it.
      expect(r.body.items).toHaveLength(0);
      expect(r.body.strengths).toHaveLength(0);
    });
  }

  it("leaves chip_read exactly as protected as before (hard law 3)", async () => {
    createSpy.mockResolvedValueOnce(reply(FLAG));
    const api = await client();
    const r = await send(api, {
      turns: [
        { index: 1, text: "Va, aqui espero.", provenance: "chip_read", asrConfidence: 0.99 },
        { index: 2, text: LONE_TURN, provenance: "dictated", asrConfidence: 0.95 },
      ],
    });
    // The model tried to flag AND praise turn 1; both must still be dropped.
    expect(r.body.items).toHaveLength(0);
    expect(r.body.strengths).toHaveLength(0);
  });

  it("does not count chip_read toward the gate, even alongside the new values", async () => {
    const api = await client();
    const r = await send(api, {
      turns: [{ index: 1, text: LONE_TURN, provenance: "chip_read", asrConfidence: 0.99 }],
    });
    expect(r.body.evidence).toBe("insufficient");
    expect(r.body.meta.spontaneousWords).toBe(0);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("still coerces an unrecognized provenance to spontaneous", async () => {
    createSpy.mockResolvedValueOnce(reply(FLAG));
    const api = await client();
    await send(api, {
      turns: [{ index: 1, text: LONE_TURN, provenance: "smuggled", asrConfidence: 0.95 }],
    });
    expect(sbRef.current.rows("speech_events")[0].provenance).toBe("spontaneous");
  });

  it("gates a dictated session exactly as it gated the same session before the label existed", async () => {
    // The regression guard. Same words, same confidence, only the label differs.
    const short = "Si, gracias.";
    const api = await client();

    const asSpontaneous = await send(
      api,
      { turns: [{ index: 1, text: short, provenance: "spontaneous", asrConfidence: 0.99 }] },
      "sa"
    );
    const asDictated = await send(
      api,
      { turns: [{ index: 1, text: short, provenance: "dictated", asrConfidence: 0.99 }] },
      "sb"
    );

    expect(asDictated.body.evidence).toBe(asSpontaneous.body.evidence);
    expect(asDictated.body.meta.spontaneousWords).toBe(asSpontaneous.body.meta.spontaneousWords);
    expect(createSpy).not.toHaveBeenCalled();
  });
});
