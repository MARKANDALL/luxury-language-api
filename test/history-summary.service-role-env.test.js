// test/history-summary.service-role-env.test.js
// backend-hygiene item 2 gap fix: historySummary used to resolve its Supabase key
// from a private chain that OMITTED SUPABASE_SERVICE_ROLE (the only service-role
// var set on prod). So it resolved to "" and bailed at its own url/key guard BEFORE
// querying — the coaching history never loaded, and item 1's trouble-word/phoneme
// fix returned nothing on prod. It now calls the shared getSupabaseAdmin(), which
// resolves the canonical env order (SUPABASE_SERVICE_ROLE first) and degrades via
// the existing try/catch. Hermetic — the factory is mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { safeNum, extractPronScore } from "../routes/pronunciation-gpt/scoring.js";

const { getAdminSpy, sbState } = vi.hoisted(() => ({
  getAdminSpy: vi.fn(),
  sbState: { rows: [], error: null, throwOnInit: false },
}));

vi.mock("../lib/supabase.js", () => ({
  getSupabaseAdmin: (...args) => {
    getAdminSpy(...args);
    if (sbState.throwOnInit) {
      // Mirrors the real factory's throw when neither url nor key is configured.
      throw new Error("Supabase service key is required");
    }
    return {
      from: () => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => Promise.resolve({ data: sbState.rows, error: sbState.error }),
        };
        return chain;
      },
    };
  },
}));

const SERVICE_KEYS = [
  "SUPABASE_SERVICE_ROLE",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY_JWT",
  "SUPABASE_SERVICE_KEY",
];
const ANON_KEYS = ["SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const URL_KEYS = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"];

beforeEach(() => {
  vi.resetModules();
  getAdminSpy.mockClear();
  sbState.rows = [];
  sbState.error = null;
  sbState.throwOnInit = false;
  // Start from a clean env so the "only SUPABASE_SERVICE_ROLE" case is faithful.
  for (const k of [...SERVICE_KEYS, ...ANON_KEYS, ...URL_KEYS]) delete process.env[k];
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

describe("historySummary via shared admin client (backend-hygiene item 2 gap)", () => {
  it("loads history when ONLY SUPABASE_SERVICE_ROLE is set (prod's config)", async () => {
    // Prod reality: the ONLY service-role var present. The old private chain never
    // checked this name, so it bailed; the shared factory resolves it.
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE = "service-role-secret";
    sbState.rows = [
      { ts: "2026-07-06T10:00:00Z", summary: { words: [["thorough", 41, 1]], lows: [["ɹ", 30]] } },
    ];

    const out = await readSummary();

    // Item 1 + lows now actually run on this env and return populated data.
    expect(out).toBeTruthy();
    expect(out.topTroubleWords).toContain("thorough");
    expect(out.topTroublePhonemes).toContain("ɹ");
    // It went through the shared factory with NO bespoke url/key opts.
    expect(getAdminSpy).toHaveBeenCalledTimes(1);
    expect(getAdminSpy.mock.calls[0][0]).toBeUndefined();
  });

  it("degrades to null (never throws) when the shared client can't init", async () => {
    sbState.throwOnInit = true; // factory throws -> catch -> null, as before
    const out = await readSummary();
    expect(out).toBeNull();
    expect(getAdminSpy).toHaveBeenCalledTimes(1);
  });
});
