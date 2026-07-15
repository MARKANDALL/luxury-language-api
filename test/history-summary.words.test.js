// test/history-summary.words.test.js
// backend-hygiene item 1: the reader in historySummary.js must parse the compact
// trouble-word triples [word, score, count] that attempt.js (toSummaryFromAzure,
// attempt.js:62) actually persists into lux_attempts.summary.words. The old reader
// only understood the {word,...} object shape, so every triple fell through and
// topTroubleWords came back EMPTY — the "You and this word" trouble list vanished.
// Also locks the graceful degrade: malformed/legacy shapes must read as empty, not
// throw. Hermetic — Supabase is mocked; no network, no model.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { safeNum, extractPronScore } from "../routes/pronunciation-gpt/scoring.js";

const { sbState } = vi.hoisted(() => ({ sbState: { rows: [], error: null } }));

vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      // Chainable builder; the terminal .limit() resolves to the query result.
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
  // historySummary bails early unless it has both a URL and a key.
  process.env.SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
});

async function readSummary() {
  const { computeHistorySummaryIfNeeded } = await import(
    "../routes/pronunciation-gpt/historySummary.js"
  );
  // includeHistory:true + chunk 1 + deep mode + uid clears every early-return guard.
  return computeHistorySummaryIfNeeded(
    { safeNum, extractPronScore },
    { mode: "deep", chunk: 1, includeHistory: true, attemptId: 1, uid: "u-1" }
  );
}

describe("historySummary trouble-word reader (backend-hygiene item 1)", () => {
  it("reads the writer's [word, score, count] triples as populated trouble words", async () => {
    // EXACTLY the shape attempt.js toSummaryFromAzure emits (attempt.js:62) and
    // that word-history.js / convo-report.js already read.
    sbState.rows = [
      { ts: "2026-07-06T10:00:00Z", summary: { words: [["thorough", 41, 1], ["rural", 55, 1]] } },
      { ts: "2026-07-05T10:00:00Z", summary: { words: [["thorough", 39, 1], ["squirrel", 60, 1]] } },
    ];

    const out = await readSummary();

    expect(out).toBeTruthy();
    expect(out.topTroubleWords).toContain("thorough");
    expect(out.topTroubleWords).toContain("rural");
    expect(out.topTroubleWords).toContain("squirrel");
    // "thorough" recurs across both attempts, so it must outrank the singles.
    expect(out.topTroubleWords[0]).toBe("thorough");
  });

  it("degrades to empty (never throws) on malformed / unexpected word shapes", async () => {
    sbState.rows = [
      { ts: "2026-07-06T10:00:00Z", summary: { words: [null, 42, {}, [], [123], ["", 10, 1]] } },
      { ts: "2026-07-05T10:00:00Z", summary: { words: "not-an-array" } },
      { ts: "2026-07-04T10:00:00Z", summary: null },
    ];

    const out = await readSummary();

    // A caught throw would surface as null; a graceful empty stays a real object
    // with an empty list. Asserting both distinguishes the two.
    expect(out).toBeTruthy();
    expect(out.topTroubleWords).toEqual([]);
  });

  it("still supports the legacy { word, count } object shape", async () => {
    sbState.rows = [
      { ts: "2026-07-06T10:00:00Z", summary: { words: [{ word: "legacy", count: 3 }] } },
    ];

    const out = await readSummary();

    expect(out.topTroubleWords).toContain("legacy");
  });
});
