// lib/supabase.js
// One-line: Centralized, lazy-initialized Supabase admin client singleton for backend routes.

import { createClient } from '@supabase/supabase-js';

let _adminClient = null;
let _warnedAnonFallback = false;

function envSupabaseUrl() {
  return (
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    ''
  );
}

// Resolve the key used for the "admin" client, and report whether we had to fall
// back to an ANON key.
//
// ⚠️ RISK (backend-hygiene item 2): the ANON keys below are a deliberate
// LAST-RESORT fallback, NOT an equal alternative to the service-role key. If no
// service-role key is set and we fall back to an anon key, the client still
// constructs and every query still "succeeds" — but Postgres RLS silently
// applies, so admin reads come back PARTIAL or EMPTY with NO error raised. That
// silent, everything-looks-fine degradation is the danger, not a crash.
//
// Runtime behavior is intentionally unchanged in this pass (we still build the
// client on the anon key). The `anonFallback` flag lets getSupabaseAdmin emit a
// loud startup warning so the condition is legible. Escalating this fallback to a
// hard failure is a clean one-line follow-up once the service-role env var is
// confirmed present in the deploy environment.
function resolveServiceKey() {
  const serviceRole =
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY_JWT ||
    process.env.SUPABASE_SERVICE_KEY ||
    '';
  if (serviceRole) return { key: serviceRole, anonFallback: false };

  const anon =
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    '';
  return { key: anon, anonFallback: !!anon };
}

/**
 * Admin/service-role client (singleton).
 * Lazy init = avoids import-time crashes that can take down the whole router.
 */
export function getSupabaseAdmin(opts = {}) {
  if (_adminClient) return _adminClient;

  const url = (opts.url || envSupabaseUrl() || '').toString().trim();

  // An explicitly-passed key wins (preserves prior behavior); otherwise resolve
  // from the env, tracking whether that resolution had to fall back to anon.
  let key = (opts.key || '').toString().trim();
  let anonFallback = false;
  if (!key) {
    const resolved = resolveServiceKey();
    key = (resolved.key || '').toString().trim();
    anonFallback = resolved.anonFallback;
  }

  if (!url) {
    throw new Error('SUPABASE_URL is required (set SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL)');
  }
  if (!key) {
    throw new Error(
      'Supabase service key is required (set SUPABASE_SERVICE_ROLE / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY)'
    );
  }

  // Loud, once-per-process warning when we're running the "admin" client on an
  // anon key. Behavior is unchanged — this only makes the silent fallback
  // legible so partial/empty admin reads have an obvious cause in the logs.
  if (anonFallback && !_warnedAnonFallback) {
    _warnedAnonFallback = true;
    console.warn(
      '[supabase] WARNING: no service-role key found ' +
        '(checked SUPABASE_SERVICE_ROLE / SUPABASE_SERVICE_ROLE_KEY / ' +
        'SUPABASE_SERVICE_ROLE_KEY_JWT / SUPABASE_SERVICE_KEY). Falling back to the ' +
        'ANON key — Postgres RLS will apply, so admin reads may return PARTIAL or ' +
        'EMPTY results with no error. Set a service-role key in the environment to fix this.'
    );
  }

  _adminClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return _adminClient;
}

export default getSupabaseAdmin;
