// test/supabase.anon-fallback.test.js
// Security baseline: the backend admin client must fail closed when only a
// browser-safe anon key is configured. It also accepts Supabase's independently
// rotatable sb_secret key alongside the legacy service-role aliases.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ __mockClient: true })),
}));

const URL_KEYS = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"];
const SERVICE_KEYS = [
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY_JWT",
  "SUPABASE_SERVICE_KEY",
];
const ANON_KEYS = ["SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];

function clearEnv() {
  for (const k of [...URL_KEYS, ...SERVICE_KEYS, ...ANON_KEYS]) delete process.env[k];
}

beforeEach(() => {
  vi.resetModules();
  clearEnv();
});
afterEach(() => {
  clearEnv();
});

async function loadFresh() {
  const mod = await import("../lib/supabase.js");
  return mod.getSupabaseAdmin;
}

describe("supabase admin key isolation", () => {
  it("fails closed when only an anon key is present", async () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-abc";

    const getSupabaseAdmin = await loadFresh();

    expect(() => getSupabaseAdmin()).toThrow(/service key/i);
  });

  it("uses a legacy service-role key when present", async () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-xyz";
    process.env.SUPABASE_ANON_KEY = "anon-abc"; // present but must be ignored

    const getSupabaseAdmin = await loadFresh();
    const client = getSupabaseAdmin();

    expect(client).toBeTruthy();
  });

  it("accepts an independently rotatable Supabase secret key", async () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "sb_secret_replacement";

    const getSupabaseAdmin = await loadFresh();
    const client = getSupabaseAdmin();

    expect(client).toBeTruthy();
  });

  it("throws when no server-side key is present", async () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";

    const getSupabaseAdmin = await loadFresh();

    expect(() => getSupabaseAdmin()).toThrow(/service key/i);
  });
});
