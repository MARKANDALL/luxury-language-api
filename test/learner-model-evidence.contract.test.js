// test/learner-model-evidence.contract.test.js
// The Richness Pass, task 2: the drill-in behind one category of the portrait.
//
// The panel says "Ser vs. estar, 3 times, still recurring". This route is how the
// learner checks that. So the tests care about two things beyond the happy path:
//
//   1. The trail is HONEST about its own limits. cap, returned, total and
//      truncated all ship, so the panel can say "the 10 most recent of 23"
//      instead of showing ten rows and implying that is everything.
//   2. Praise never gets served as evidence of a mistake. Strengths carry a null
//      category, exactly like an uncategorised item, so the channel filter is the
//      only thing keeping them out of the "(uncategorized)" drawer. That is a
//      one-line mistake away, so it gets its own test.
//
// Hermetic: no network, no model. Same shape as test/learner-model.contract.test.js.
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

// `calls` records the query the route actually built, so the filter tests assert
// on the real chain rather than on the rows a stub chose to hand back.
const { sbState } = vi.hoisted(() => ({
  sbState: { rows: [], count: null, enabled: true, error: null, calls: [] },
}));

vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: () => {
    if (!sbState.enabled) throw new Error("SUPABASE_URL is required");
    return {
      from(table) {
        sbState.calls.push(["from", table]);
        const chain = {
          select: (cols, opts) => {
            sbState.calls.push(["select", cols, opts]);
            return chain;
          },
          eq: (col, val) => {
            sbState.calls.push(["eq", col, val]);
            return chain;
          },
          is: (col, val) => {
            sbState.calls.push(["is", col, val]);
            return chain;
          },
          in: (col, vals) => {
            sbState.calls.push(["in", col, vals]);
            return chain;
          },
          order: (col, opts) => {
            sbState.calls.push(["order", col, opts]);
            return chain;
          },
          limit: (n) => {
            sbState.calls.push(["limit", n]);
            return chain;
          },
          then: (resolve) =>
            resolve({ data: sbState.rows, error: sbState.error, count: sbState.count }),
        };
        return chain;
      },
    };
  },
}));

beforeEach(() => {
  vi.resetModules();
  process.env.ADMIN_TOKEN = "test_admin_token";
  sbState.enabled = true;
  sbState.rows = [];
  sbState.count = null;
  sbState.error = null;
  sbState.calls = [];
});

async function client() {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  return request(mkServer(handler));
}

function post(c, body) {
  return c
    .post("/api/router?route=learner-model-evidence")
    .set("x-admin-token", "test_admin_token")
    .send(body);
}

// A stored row, exactly as the .select() column list names it (snake_case).
function row(over = {}) {
  return {
    utterance: "yo soy cansado",
    suggestion: "yo estoy cansado",
    explanation: "Estado, no identidad.",
    severity: "noticeable",
    provenance: "spontaneous",
    surface: "guided",
    scenario_key: "coffee",
    created_at: "2026-08-20T10:00:00.000Z",
    ...over,
  };
}

const called = (name, col) =>
  sbState.calls.filter((c) => c[0] === name && (col === undefined || c[1] === col));

// ─────────────────────────────────────────────────────────────────────────────
describe("evidence trail — the events themselves", () => {
  it("returns every field the panel renders, camelCased, newest first", async () => {
    sbState.rows = [
      row({ created_at: "2026-08-20T10:00:00.000Z" }),
      row({
        utterance: "la agua",
        suggestion: "el agua",
        explanation: "Sustantivo femenino con articulo masculino.",
        severity: "polish",
        provenance: "dictated",
        surface: "streaming",
        scenario_key: "doctor",
        created_at: "2026-08-19T09:00:00.000Z",
      }),
    ];
    sbState.count = 2;

    const res = await post(await client(), { uid: "u-1", pack: "es", category: "ser_estar" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0]).toEqual({
      utterance: "yo soy cansado",
      suggestion: "yo estoy cansado",
      explanation: "Estado, no identidad.",
      severity: "noticeable",
      provenance: "spontaneous",
      surface: "guided",
      scenarioKey: "coffee",
      createdAt: "2026-08-20T10:00:00.000Z",
    });
    expect(res.body.events[1].scenarioKey).toBe("doctor");
    expect(res.body.events[1].provenance).toBe("dictated");

    // Newest first is the DB's job; assert we asked for it that way.
    expect(called("order", "created_at")[0][2]).toEqual({ ascending: false });
  });

  it("nulls a missing provenance or scenario rather than inventing one", async () => {
    sbState.rows = [row({ provenance: null, scenario_key: null, suggestion: null })];
    const res = await post(await client(), { uid: "u-1", pack: "es", category: "ser_estar" });

    expect(res.body.events[0].provenance).toBeNull();
    expect(res.body.events[0].scenarioKey).toBeNull();
    expect(res.body.events[0].suggestion).toBeNull();
  });

  it("resolves the category's human label from the pack dictionary", async () => {
    sbState.rows = [row()];
    const res = await post(await client(), { uid: "u-1", pack: "es", category: "ser_estar" });
    expect(res.body.label).toBe("Ser vs. estar");
    expect(res.body.category).toBe("ser_estar");
  });

  it("falls back to the raw code when the pack has no label for it", async () => {
    sbState.rows = [row()];
    // 'ser_estar' is an es code; the en stub dictionary has never heard of it.
    const res = await post(await client(), { uid: "u-1", pack: "en", category: "ser_estar" });
    expect(res.body.label).toBe("ser_estar");
  });
});

describe("evidence trail — honest about the cap", () => {
  it("reports cap, returned, total and truncated when there is more than it shows", async () => {
    sbState.rows = Array.from({ length: 10 }, (_, i) =>
      row({ created_at: `2026-08-${String(20 - i).padStart(2, "0")}T10:00:00.000Z` })
    );
    sbState.count = 23;

    const res = await post(await client(), { uid: "u-1", pack: "es", category: "ser_estar" });

    expect(res.body.cap).toBe(10);
    expect(res.body.returned).toBe(10);
    expect(res.body.total).toBe(23);
    expect(res.body.truncated).toBe(true);
    // The cap is enforced at the DB, not by slicing after the fact.
    expect(called("limit")[0][1]).toBe(10);
  });

  it("is not truncated when the learner has fewer events than the cap", async () => {
    sbState.rows = [row(), row()];
    sbState.count = 2;
    const res = await post(await client(), { uid: "u-1", pack: "es", category: "ser_estar" });
    expect(res.body.truncated).toBe(false);
    expect(res.body.total).toBe(2);
    expect(res.body.returned).toBe(2);
  });

  it("falls back to what it has when the client reports no count", async () => {
    sbState.rows = [row(), row(), row()];
    sbState.count = null; // a client that does not return an exact count
    const res = await post(await client(), { uid: "u-1", pack: "es", category: "ser_estar" });
    expect(res.body.total).toBe(3);
    expect(res.body.truncated).toBe(false);
  });

  it("asks for an exact count so total can be honest", async () => {
    sbState.rows = [row()];
    await post(await client(), { uid: "u-1", pack: "es", category: "ser_estar" });
    expect(called("select")[0][2]).toEqual({ count: "exact" });
  });
});

describe("evidence trail — the filters", () => {
  it("never serves a strength as evidence: items only, both channels", async () => {
    // Strengths carry category null, exactly like an uncategorised item. This
    // filter is the only thing keeping praise out of the evidence drawer.
    sbState.rows = [row()];
    await post(await client(), { uid: "u-1", pack: "es", category: "ser_estar" });

    const inCall = called("in", "channel")[0];
    expect(inCall).toBeTruthy();
    expect(inCall[2]).toEqual(["grammar", "word_choice"]);
    expect(inCall[2]).not.toContain("strength");
  });

  it("scopes to the uid and the pack, like the portrait it drills into", async () => {
    sbState.rows = [row()];
    await post(await client(), { uid: "u-1", pack: "es", category: "ser_estar" });

    const eqs = Object.fromEntries(called("eq").map((c) => [c[1], c[2]]));
    expect(eqs.uid).toBe("u-1");
    expect(eqs.pack).toBe("es");
    expect(eqs.category).toBe("ser_estar");
  });

  it("turns the portrait's '(uncategorized)' bucket back into a null lookup", async () => {
    // learner-model.js buckets a null category under UNCATEGORIZED. Asking the DB
    // for a literal '(uncategorized)' string would return nothing, forever.
    sbState.rows = [row({ severity: "blocked" })];
    const res = await post(await client(), {
      uid: "u-1",
      pack: "es",
      category: "(uncategorized)",
    });

    expect(res.status).toBe(200);
    expect(called("is", "category")[0][2]).toBeNull();
    expect(called("eq", "category")).toHaveLength(0);
    expect(res.body.events).toHaveLength(1);
  });

  it("reads speech_events and nothing else", async () => {
    sbState.rows = [row()];
    await post(await client(), { uid: "u-1", pack: "es", category: "ser_estar" });
    expect(called("from").map((c) => c[1])).toEqual(["speech_events"]);
  });
});

describe("evidence trail — it degrades, it does not break", () => {
  it("enforces the admin gate", async () => {
    const c = await client();
    const res = await c
      .post("/api/router?route=learner-model-evidence")
      .send({ uid: "u-1", pack: "es", category: "ser_estar" });
    expect(res.status).toBe(401);
  });

  it("answers a missing category with a valid empty trail, not an error", async () => {
    const res = await post(await client(), { uid: "u-1", pack: "es" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      pack: "es",
      cap: 10,
      returned: 0,
      total: 0,
      truncated: false,
      events: [],
    });
    // It never even reached the DB.
    expect(sbState.calls).toHaveLength(0);
  });

  it("answers a missing uid the same way", async () => {
    const res = await post(await client(), { pack: "es", category: "ser_estar" });
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(sbState.calls).toHaveLength(0);
  });

  it("degrades to the empty trail when Supabase is absent", async () => {
    sbState.enabled = false;
    const res = await post(await client(), { uid: "u-1", pack: "es", category: "ser_estar" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.events).toEqual([]);
  });

  it("degrades to the empty trail on a read error, never a 500", async () => {
    sbState.error = { message: "relation does not exist" };
    const res = await post(await client(), { uid: "u-1", pack: "es", category: "ser_estar" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.events).toEqual([]);
    // The label still resolved, so the panel keeps its heading.
    expect(res.body.label).toBe("Ser vs. estar");
  });

  it("rejects a non-POST method", async () => {
    const c = await client();
    const res = await c
      .get("/api/router?route=learner-model-evidence")
      .set("x-admin-token", "test_admin_token");
    expect(res.status).toBe(405);
  });
});
