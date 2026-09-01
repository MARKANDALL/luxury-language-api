// test/learner-model.pronunciation.test.js
// The Richness Pass, task 3: the portrait's other half.
//
// Trouble Sounds and Trouble Words are the oldest signal this app has, and the
// speaking portrait could not see them. There is no rollup table to read — the
// Progress page computes those lists in the browser — so this section reads the
// durable SOURCE both views draw from, lux_attempts.summary, through the same
// two aggregators that already draw the end-of-conversation report.
//
// What these tests hold down:
//   1. It really is READ-ONLY reuse. The section is built by convo-report.js's
//      aggregators over lux_attempts, not by a second copy of the arithmetic —
//      asserted by comparing the route's output against calling those exported
//      functions directly on the same rows.
//   2. Pronunciation NEVER breaks the portrait. Its table missing, its read
//      erroring, its rows malformed — the speaking portrait still renders.
//   3. A learner who has practised sounds but never held a conversation still
//      gets their half back, instead of an all-zero model.
//
// Hermetic: no network, no model.
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";
import { aggregateLowsPhonemes, aggregateLowsWords } from "../routes/convo-report.js";

// Two tables, two row sets. The route reads speech_events and lux_attempts
// through the SAME client, so the fake has to tell them apart — a single shared
// chain would let a pronunciation test pass on speech-event rows.
const { sbState } = vi.hoisted(() => ({
  sbState: {
    speech_events: [],
    lux_attempts: [],
    enabled: true,
    errorOn: null, // table name whose read returns an error
    throwOn: null, // table name whose read throws
    tables: [],
  },
}));

vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: () => {
    if (!sbState.enabled) throw new Error("SUPABASE_URL is required");
    return {
      from(table) {
        sbState.tables.push(table);
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          is: () => chain,
          order: () => chain,
          limit: () => chain,
          then: (resolve, reject) => {
            if (sbState.throwOn === table) {
              const err = new Error(`simulated ${table} failure`);
              return reject ? reject(err) : Promise.reject(err);
            }
            if (sbState.errorOn === table) {
              return resolve({ data: null, error: { message: `${table} unavailable` } });
            }
            return resolve({ data: sbState[table] || [], error: null });
          },
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
  sbState.speech_events = [];
  sbState.lux_attempts = [];
  sbState.errorOn = null;
  sbState.throwOn = null;
  sbState.tables = [];
});

async function client() {
  const mod = await import("../api/router.js");
  const handler = mod.default || mod;
  return request(mkServer(handler));
}

function get(body = { uid: "u-1", pack: "es" }) {
  return client().then((c) =>
    c
      .post("/api/router?route=learner-model")
      .set("x-admin-token", "test_admin_token")
      .send(body)
  );
}

// A lux_attempts row exactly as routes/attempt.js toSummaryFromAzure writes it:
// summary.lows is [[phoneme, score]] and summary.words is [[word, avg, count]].
function attempt(ts, lows, words) {
  return { ts, summary: { pron: 78, acc: 80, flu: 75, comp: 90, lows, words } };
}

const SPEECH_EVENT = {
  session_id: "s1",
  channel: "grammar",
  category: "ser_estar",
  severity: "noticeable",
  utterance: "yo soy cansado",
  suggestion: "yo estoy cansado",
  explanation: "Estado, no identidad.",
  created_at: "2026-08-20T10:00:00.000Z",
  provenance: "spontaneous",
  surface: "guided",
  scenario_key: "coffee",
};

// ─────────────────────────────────────────────────────────────────────────────
describe("pronunciation — what it reads", () => {
  it("aggregates the worst sounds and words out of lux_attempts.summary", async () => {
    sbState.lux_attempts = [
      attempt("2026-08-20T10:00:00.000Z", [["r", 30], ["s", 55]], [["perro", 41, 2]]),
      attempt("2026-08-19T10:00:00.000Z", [["r", 42]], [["perro", 49, 1], ["carro", 62, 1]]),
    ];

    const res = await get();
    expect(res.status).toBe(200);
    const p = res.body.model.pronunciation;

    expect(p.attempts).toBe(2);
    expect(p.firstSeen).toBe("2026-08-19T10:00:00.000Z");
    expect(p.lastSeen).toBe("2026-08-20T10:00:00.000Z");

    // Worst first, and "r" is worst — averaged across both attempts, not summed.
    expect(p.sounds[0]).toEqual({ phoneme: "r", score: 36, n: 2 });
    expect(p.sounds.map((x) => x.phoneme)).toEqual(["r", "s"]);
    expect(p.words[0].word).toBe("perro");
  });

  it("is the convo-report arithmetic, not a second copy of it", async () => {
    // The whole point of task 3: reuse, no duplication. If someone reimplements
    // the aggregation inside learner-model.js, this test starts failing the
    // moment the two drift by a rounding rule.
    const rows = [
      attempt("2026-08-20T10:00:00.000Z", [["r", 30], ["x", 88]], [["perro", 41, 3]]),
      attempt("2026-08-18T10:00:00.000Z", [["r", 44], ["l", 51]], [["carro", 60, 1]]),
    ];
    sbState.lux_attempts = rows;

    const res = await get();
    expect(res.body.model.pronunciation.sounds).toEqual(aggregateLowsPhonemes(rows));
    expect(res.body.model.pronunciation.words).toEqual(aggregateLowsWords(rows));
  });

  it("reads lux_attempts alongside speech_events, not instead of it", async () => {
    sbState.speech_events = [SPEECH_EVENT];
    sbState.lux_attempts = [attempt("2026-08-20T10:00:00.000Z", [["r", 30]], [])];

    const res = await get();
    expect(sbState.tables).toContain("speech_events");
    expect(sbState.tables).toContain("lux_attempts");
    // Both halves of the portrait are present in one response.
    expect(res.body.model.categories).toHaveLength(1);
    expect(res.body.model.pronunciation.sounds).toHaveLength(1);
  });

  it("ships a zeroed section, not a missing key, when there is nothing to say", async () => {
    const res = await get();
    expect(res.body.model.pronunciation).toEqual({
      attempts: 0,
      firstSeen: null,
      lastSeen: null,
      sounds: [],
      words: [],
    });
  });
});

describe("pronunciation — a learner who has only practised sounds", () => {
  it("still gets their half back instead of an all-zero portrait", async () => {
    // No conversations at all: speech_events is empty. Before this section, the
    // answer was a wholly empty model — which threw away real practice history.
    sbState.speech_events = [];
    sbState.lux_attempts = [
      attempt("2026-08-20T10:00:00.000Z", [["r", 30], ["s", 55]], [["perro", 41, 2]]),
    ];

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.model.totals.events).toBe(0);
    expect(res.body.model.categories).toEqual([]);
    expect(res.body.model.pronunciation.attempts).toBe(1);
    expect(res.body.model.pronunciation.sounds).toHaveLength(2);
  });
});

describe("pronunciation — it never breaks the portrait", () => {
  it("survives the lux_attempts read erroring", async () => {
    sbState.speech_events = [SPEECH_EVENT];
    sbState.errorOn = "lux_attempts";

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.model.categories).toHaveLength(1); // portrait intact
    expect(res.body.model.pronunciation.sounds).toEqual([]);
    expect(res.body.model.pronunciation.attempts).toBe(0);
  });

  it("survives the lux_attempts read throwing", async () => {
    sbState.speech_events = [SPEECH_EVENT];
    sbState.throwOn = "lux_attempts";

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.model.categories).toHaveLength(1);
    expect(res.body.model.pronunciation.attempts).toBe(0);
  });

  it("survives malformed summaries without dropping the good rows", async () => {
    sbState.lux_attempts = [
      { ts: "2026-08-20T10:00:00.000Z", summary: null },
      { ts: "2026-08-19T10:00:00.000Z", summary: { lows: "not-an-array", words: {} } },
      { ts: null, summary: { lows: [["r", 30]], words: [["perro", 41, 1]] } },
      attempt("2026-08-18T10:00:00.000Z", [["s", 44]], [["casa", 55, 1]]),
    ];

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.model.pronunciation.attempts).toBe(4);
    expect(res.body.model.pronunciation.sounds.map((x) => x.phoneme).sort()).toEqual(["r", "s"]);
    // A null ts is skipped for the window without discarding its aggregation.
    expect(res.body.model.pronunciation.firstSeen).toBe("2026-08-18T10:00:00.000Z");
  });

  it("still answers when the speech_events read fails but attempts are readable", async () => {
    sbState.errorOn = "speech_events";
    sbState.lux_attempts = [attempt("2026-08-20T10:00:00.000Z", [["r", 30]], [])];

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.model.totals.events).toBe(0);
    expect(res.body.model.pronunciation.attempts).toBe(1);
  });

  it("degrades to the fully empty model when Supabase is absent", async () => {
    sbState.enabled = false;
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.model.pronunciation).toEqual({
      attempts: 0,
      firstSeen: null,
      lastSeen: null,
      sounds: [],
      words: [],
    });
  });
});

describe("pronunciation — read-only, and honest about scope", () => {
  it("issues no write of any kind", async () => {
    // The fake exposes no insert/update/delete/upsert at all, so a route that
    // tried one would throw and this assertion would never be reached.
    sbState.lux_attempts = [attempt("2026-08-20T10:00:00.000Z", [["r", 30]], [])];
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns the same pronunciation under either pack, because it cannot be pack-scoped", async () => {
    // lux_attempts carries no pack the writer ever sets, so this section is
    // pack-agnostic by construction. Pinning it here means anyone who later adds
    // a pack filter has to come and change this test on purpose.
    sbState.lux_attempts = [attempt("2026-08-20T10:00:00.000Z", [["r", 30]], [["perro", 41, 1]])];

    const es = await get({ uid: "u-1", pack: "es" });
    const en = await get({ uid: "u-1", pack: "en" });
    expect(en.body.model.pronunciation).toEqual(es.body.model.pronunciation);
  });
});
