// test/history-summary.ordering.test.js
// backend-hygiene item 3: every lux_attempts query must order by `ts` — the column
// attempt.js populates on insert and that user-recent, admin-recent,
// admin-user-stats, convo-report and word-history all read. historySummary was the
// lone outlier ordering (and selecting) by `created_at`. This locks it to `ts` so a
// future edit can't silently reintroduce the split-column ordering. Hermetic — the
// mocked Supabase client records the select/order arguments.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { safeNum, extractPronScore } from "../routes/pronunciation-gpt/scoring.js";

const { calls, sbState } = vi.hoisted(() => ({
  calls: { from: null, select: null, order: null },
  sbState: { rows: [], error: null },
}));

vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: () => ({
    from: (table) => {
      calls.from = table;
      const chain = {
        select: (cols) => { calls.select = cols; return chain; },
        eq: () => chain,
        order: (col, opts) => { calls.order = [col, opts]; return chain; },
        limit: () => Promise.resolve({ data: sbState.rows, error: sbState.error }),
      };
      return chain;
    },
  }),
}));

beforeEach(() => {
  vi.resetModules();
  calls.from = null;
  calls.select = null;
  calls.order = null;
  sbState.rows = [{ ts: "2026-07-06T10:00:00Z", summary: { words: [["x", 40, 1]] } }];
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

describe("historySummary orders lux_attempts by ts (backend-hygiene item 3)", () => {
  it("orders by `ts` descending, not `created_at`", async () => {
    await readSummary();
    expect(calls.from).toBe("lux_attempts");
    expect(calls.order[0]).toBe("ts");
    expect(calls.order[0]).not.toBe("created_at");
    expect(calls.order[1]).toMatchObject({ ascending: false });
  });

  it("selects the `ts` column it orders by, not `created_at`", async () => {
    await readSummary();
    expect(calls.select).toContain("ts");
    expect(calls.select).not.toContain("created_at");
  });
});
