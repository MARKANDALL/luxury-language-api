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

function envSupabaseServiceKey() {
  return (
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY_JWT ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ''
  );
}

/**
 * Admin/service-role client (singleton).
 * Lazy init = avoids import-time crashes that can take down the whole router.
 */
export function getSupabaseAdmin(opts = {}) {
  if (_adminClient) return _adminClient;

  const url = (opts.url || envSupabaseUrl() || '').toString().trim();
  const key = (opts.key || envSupabaseServiceKey() || '').toString().trim();

  if (!url) {
    throw new Error('SUPABASE_URL is required (set SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL)');
  }
  if (!key) {
    throw new Error(
      'Supabase service key is required (set SUPABASE_SERVICE_ROLE / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY)'
    );
  }

  _adminClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return _adminClient;
}

export default getSupabaseAdmin;
