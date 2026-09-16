// lib/supabase.js
// One-line: Centralized, lazy-initialized Supabase admin client singleton for backend routes.

import { createClient } from '@supabase/supabase-js';

let _adminClient = null;

function envSupabaseUrl() {
  return (
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    ''
  );
}

// Resolve only a server-side key. An anon key must never power this admin client:
// RLS would silently turn privileged reads into partial or empty results.
function resolveServiceKey() {
  return (
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY_JWT ||
    process.env.SUPABASE_SERVICE_KEY ||
    ""
  );
}

/**
 * Admin/service-role client (singleton).
 * Lazy init = avoids import-time crashes that can take down the whole router.
 */
export function getSupabaseAdmin(opts = {}) {
  if (_adminClient) return _adminClient;

  const url = (opts.url || envSupabaseUrl() || '').toString().trim();

  // An explicitly-passed key wins; otherwise resolve from server-only env vars.
  let key = (opts.key || '').toString().trim();
  if (!key) {
    key = (resolveServiceKey() || '').toString().trim();
  }

  if (!url) {
    throw new Error('SUPABASE_URL is required (set SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL)');
  }
  if (!key) {
    throw new Error(
      'Supabase service key is required (set SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY)'
    );
  }

  _adminClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return _adminClient;
}

export default getSupabaseAdmin;
