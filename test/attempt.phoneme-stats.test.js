// Cover for REPORT_measurement_audit.md finding 5: every trouble percentage on
// the Progress page was computed from a deliberately biased sample.
//
// routes/user-recent.js selects `summary` and no Azure column, so the Progress
// rollups can only ever read summary.lows — the SIX LOWEST-SCORING phonemes of
// the attempt. A sound spoken at 95, 92 and 78 was stored as 78, attempt after
// attempt, and reported as a trouble sound whose true average is 88.
//
// routes/attempt.js now writes summary.stats.phonemes beside `lows`: every
// scored phoneme of the attempt as { occ, avg, low }. That is the shape the
// rollups ALREADY prefer (features/progress/rollups/rollupsAccumulate.js:206),
// so nothing on the frontend changed and `lows` is untouched for its other
// readers.
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkServer } from "./_helpers/mkServer.js";

const db = vi.hoisted(() => ({ calls: [] }));

vi.mock("pg", () => {
  class Pool {
    async query(text, params) {
      db.calls.push({ text, params });
      return { rows: [{ id: 123 }] };
    }
  }
  return { Pool };
});

beforeEach(() => {
  vi.resetModules();
  delete globalThis.__lux_pool;
  db.calls = [];
});

// Azure returns per-item scores FLAT on words and phonemes on this path, which
// is what toSummaryFromAzure reads. Each entry here is [word, [[phoneme,score]…]].
function azure(words) {
  return {
    RecognitionStatus: "Success",
    DisplayText: words.map(([w]) => w).join(" "),
    NBest: [
      {
        Display: words.map(([w]) => w).join(" "),
        PronScore: 88,
        AccuracyScore: 90,
        FluencyScore: 85,
        CompletenessScore: 100,
        Words: words.map(([w, phonemes]) => ({
          Word: w,
          AccuracyScore: Math.round(
            phonemes.reduce((a, [, s]) => a + s, 0) / Math.max(1, phonemes.length)
          ),
          ErrorType: "None",
          Phonemes: phonemes.map(([p, s]) => ({ Phoneme: p, AccuracyScore: s })),
        })),
      },
    ],
  };
}

async function post(body) {
  const mod = await import("../api/router.js");
  const r = await request(mkServer(mod.default || mod))
    .post("/api/router?route=attempt")
    .set("content-type", "application/json")
    .send(body);
  expect(r.status).toBe(200);
  // params[5] is the JSON handed to the summary column.
  return JSON.parse(db.calls[0].params[5]);
}

// The audit's own case, spelled out: /eɪ/ spoken three times at 95, 92 and 78,
// surrounded by low sounds that fill the six-slot `lows` list.
const AUDIT_CASE = azure([
  ["day", [["d", 85], ["eɪ", 95]]],
  ["rain", [["ɹ", 60], ["eɪ", 92], ["n", 88]]],
  ["they", [["ð", 70], ["eɪ", 78]]],
  ["thin", [["θ", 55], ["ɪ", 82], ["n", 90]]],
]);

describe("attempt: summary.stats.phonemes carries every scored phoneme", () => {
  it("stores /eɪ/'s true average, not its worst occurrence", async () => {
    const summary = await post({ uid: "u_test", passageKey: "p", azureResult: AUDIT_CASE });

    // What the biased sample said: the single worst /eɪ/, and nothing else.
    expect(summary.lows).toContainEqual(["eɪ", 78]);
    expect(summary.lows.filter(([p]) => p === "eɪ")).toHaveLength(1);

    // What the row now also says: three occurrences, true mean 88.3, one of
    // them below 80.
    expect(summary.stats.phonemes["eɪ"]).toEqual({ occ: 3, avg: 88.3, low: 1 });
  });

  it("keeps every scored phoneme, not the six the old field could hold", async () => {
    const summary = await post({ uid: "u_test", passageKey: "p", azureResult: AUDIT_CASE });

    expect(summary.lows).toHaveLength(6);
    expect(Object.keys(summary.stats.phonemes).sort()).toEqual(
      ["d", "eɪ", "n", "ð", "ɪ", "ɹ", "θ"].sort()
    );
  });

  it("leaves lows byte-identical: still the six lowest, ascending", async () => {
    const summary = await post({ uid: "u_test", passageKey: "p", azureResult: AUDIT_CASE });

    expect(summary.lows).toEqual([
      ["θ", 55], ["ɹ", 60], ["ð", 70], ["eɪ", 78], ["ɪ", 82], ["d", 85],
    ]);
  });

  it("recovers the true mean under the reader's own arithmetic", async () => {
    // rollupsAccumulate.js:227-228 does exactly this: count += occ, sum += avg * occ.
    const summary = await post({ uid: "u_test", passageKey: "p", azureResult: AUDIT_CASE });

    const truth = new Map();
    for (const w of AUDIT_CASE.NBest[0].Words) {
      for (const p of w.Phonemes) {
        const c = truth.get(p.Phoneme) || { n: 0, sum: 0 };
        c.n += 1;
        c.sum += p.AccuracyScore;
        truth.set(p.Phoneme, c);
      }
    }

    for (const [ipa, v] of truth) {
      const st = summary.stats.phonemes[ipa];
      expect(st.occ).toBe(v.n);
      // Only the one-decimal rounding separates the two.
      expect(Math.abs((st.avg * st.occ) / st.occ - v.sum / v.n)).toBeLessThanOrEqual(0.05);
    }
  });

  it("counts low occurrences the way the reader it replaces does (below 80)", async () => {
    const summary = await post({
      uid: "u_test",
      passageKey: "p",
      azureResult: azure([["so", [["s", 79], ["s", 80], ["s", 81]]]]),
    });

    // 79 is low, 80 is not — rollupsAccumulate.js:265 tests `< 80`, strictly.
    expect(summary.stats.phonemes["s"]).toEqual({ occ: 3, avg: 80, low: 1 });
  });

  it("skips an unscored phoneme rather than storing it as a zero", async () => {
    const summary = await post({
      uid: "u_test",
      passageKey: "p",
      azureResult: {
        NBest: [
          {
            PronScore: 80,
            Words: [
              {
                Word: "hm",
                AccuracyScore: 80,
                Phonemes: [
                  { Phoneme: "h" },              // no score at all
                  { Phoneme: "", AccuracyScore: 50 }, // no name
                  { Phoneme: "m", AccuracyScore: 80 },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(Object.keys(summary.stats.phonemes)).toEqual(["m"]);
  });

  it("omits stats entirely when the attempt carries no Azure result", async () => {
    const summary = await post({ uid: "u_test", passageKey: "p", pron: 80 });
    expect(summary.stats).toBeUndefined();
  });

  it("omits stats rather than write a sample, past the distinct-phoneme ceiling", async () => {
    // 257 distinct keys is not a language, it is a malformed payload. The field
    // is dropped whole so readers fall back to `lows` — today's behaviour —
    // rather than storing a partial, biased set.
    const many = Array.from({ length: 257 }, (_, i) => ["p" + i, 70]);
    const summary = await post({
      uid: "u_test",
      passageKey: "p",
      azureResult: azure([["x", many]]),
    });

    expect(summary.stats).toBeUndefined();
    expect(summary.lows).toHaveLength(6); // the old field still lands
  });

  it("survives the client summary merge that runs over the server's block", async () => {
    // Every real client posts a summary of its own (frontend _api/attempts.js),
    // which is shallow-merged on top. It must not knock `stats` out.
    const summary = await post({
      uid: "u_test",
      passageKey: "p",
      azureResult: AUDIT_CASE,
      summary: { pron: 88, meta: { schema_version: "attempt.v2" } },
    });

    expect(summary.meta.schema_version).toBe("attempt.v2");
    expect(summary.stats.phonemes["eɪ"].occ).toBe(3);
  });
});
