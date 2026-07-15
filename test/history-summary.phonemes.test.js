// test/history-summary.phonemes.test.js
// backend-hygiene follow-up (parallel to item 1): the reader in historySummary.js
// must parse the compact trouble-phoneme pairs [phoneme, score] that attempt.js
// (toSummaryFromAzure, attempt.js:43) actually persists into
// lux_attempts.summary.lows. The old reader only handled a non-array object shape,
// so every pair was skipped and topTroublePhonemes came back EMPTY. The pair
// carries a SCORE, not a count, so each appearance must weigh 1 (frequency), never
// the score. Also locks the graceful degrade. Hermetic — Supabase is mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { safeNum, extractPronScore } from "../routes/pronunciation-gpt/scoring.js";

const { sbState } = vi.hoisted(() => ({ sbState: { rows: [], error: null } }));

vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => Promise.resolve({ data: sbState.rows, error: sbState.error }),
      };
      return chain;
    },
  }),
}));

beforeEach(() => {
  vi.resetModules();
  sbState.rows = [];
  sbState.error = null;
  process.env.SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
});

async function readSummary() {
  const { computeHistorySummaryIfNeeded } = await import(
    "../routes/pronunciation-gpt/historySummary.js"
  );
  return computeHistorySummaryIfNeeded(
    { safeNum, extractPronScore },
    { mode: "deep", chunk: 1, includeHistory: true, attemptId: 1, uid: "u-1" }
  );
}

describe("historySummary trouble-phoneme reader (backend-hygiene lows fix)", () => {
  it("reads the writer's [phoneme, score] pairs as populated trouble phonemes", async () => {
    // EXACTLY the shape attempt.js toSummaryFromAzure emits (attempt.js:43).
    sbState.rows = [
      { ts: "2026-07-06T10:00:00Z", summary: { lows: [["ɹ", 30], ["θ", 55]] } },
      { ts: "2026-07-05T10:00:00Z", summary: { lows: [["ɹ", 42], ["ʒ", 60]] } },
    ];

    const out = await readSummary();

    expect(out).toBeTruthy();
    expect(out.topTroublePhonemes).toContain("ɹ");
    expect(out.topTroublePhonemes).toContain("θ");
    expect(out.topTroublePhonemes).toContain("ʒ");
    // "ɹ" is a trouble phoneme in both attempts, so it must rank first — and it
    // must rank by FREQUENCY, not by the score in the pair.
    expect(out.topTroublePhonemes[0]).toBe("ɹ");
  });

  it("degrades to empty (never throws) on malformed / unexpected phoneme shapes", async () => {
    sbState.rows = [
      { ts: "2026-07-06T10:00:00Z", summary: { lows: [null, 42, {}, [], [123], ["", 10]] } },
      { ts: "2026-07-05T10:00:00Z", summary: { lows: "not-an-array" } },
      { ts: "2026-07-04T10:00:00Z", summary: null },
    ];

    const out = await readSummary();

    expect(out).toBeTruthy();
    expect(out.topTroublePhonemes).toEqual([]);
  });

  it("still supports the legacy { phoneme: count } object shape", async () => {
    sbState.rows = [
      { ts: "2026-07-06T10:00:00Z", summary: { lows: { "ʃ": 3, "ð": 1 } } },
    ];

    const out = await readSummary();

    expect(out.topTroublePhonemes).toContain("ʃ");
    expect(out.topTroublePhonemes[0]).toBe("ʃ"); // 3 > 1
  });
});
