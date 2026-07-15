// test/supabase.anon-fallback.test.js
// backend-hygiene item 2: the "admin" Supabase client silently falls back to the
// ANON key when no service-role key is set. Runtime behavior is intentionally
// unchanged (the client still builds), but the fallback must now be LOUD so
// partial/empty admin reads have an obvious cause. This locks: (1) a warning fires
// when only an anon key is present, (2) no warning when a service-role key is
// present, (3) the neither-key throw is unchanged. Hermetic — createClient is
// mocked; a fresh module per test resets the singleton + once-only warning flag.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ __mockClient: true })),
}));

const URL_KEYS = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"];
const SERVICE_KEYS = [
  "SUPABASE_SERVICE_ROLE",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY_JWT",
  "SUPABASE_SERVICE_KEY",
];
const ANON_KEYS = ["SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];

function clearEnv() {
  for (const k of [...URL_KEYS, ...SERVICE_KEYS, ...ANON_KEYS]) delete process.env[k];
}

let warnSpy;
beforeEach(() => {
  vi.resetModules(); // fresh module -> singleton + _warnedAnonFallback reset
  clearEnv();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  clearEnv();
});

async function loadFresh() {
  const mod = await import("../lib/supabase.js");
  return mod.getSupabaseAdmin;
}

describe("supabase anon-key fallback loudness (backend-hygiene item 2)", () => {
  it("warns loudly when only an anon key is present (service-role absent)", async () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-abc";

    const getSupabaseAdmin = await loadFresh();
    const client = getSupabaseAdmin();

    // Runtime behavior preserved: the client is still built and returned.
    expect(client).toBeTruthy();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toMatch(/service-role/i);
    expect(msg).toMatch(/anon/i);
    expect(msg).toMatch(/RLS|partial|empty/i);
  });

  it("does NOT warn when a service-role key is present", async () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-xyz";
    process.env.SUPABASE_ANON_KEY = "anon-abc"; // present but must be ignored

    const getSupabaseAdmin = await loadFresh();
    const client = getSupabaseAdmin();

    expect(client).toBeTruthy();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still throws when neither service-role nor anon key is present", async () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";

    const getSupabaseAdmin = await loadFresh();

    expect(() => getSupabaseAdmin()).toThrow(/service key/i);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
