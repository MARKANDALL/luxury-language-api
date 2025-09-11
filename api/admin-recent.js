// /api/admin-recent.js
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  try {
    // Support header or query param (works even if there’s no req.query)
    let qsToken = null;
    try {
      const u = new URL(req.url, 'http://localhost');
      qsToken = u.searchParams.get('token');
    } catch {}
    const token =
      req.headers['x-admin-token'] ||
      req.headers['x-admin-token'.toLowerCase()] ||
      qsToken;

    if (!process.env.ADMIN_TOKEN) {
      console.error('[admin-recent] Missing ADMIN_TOKEN env');
      return res.status(500).json({ error: 'missing ADMIN_TOKEN' });
    }
    if (token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      console.error('[admin-recent] Missing Supabase envs', {
        hasUrl: !!SUPABASE_URL,
        hasServiceRole: !!SERVICE_ROLE,
      });
      return res
        .status(500)
        .json({ error: 'missing-env', hasUrl: !!SUPABASE_URL, hasServiceRole: !!SERVICE_ROLE });
    }

    const supa = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await supa
      .from('lux_attempts')
      .select('id, uid, ts, passage_key, part_index, text, summary')
      .order('ts', { ascending: false })
      .limit(100);

    if (error) {
      console.error('[admin-recent] Supabase error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ rows: data });
  } catch (err) {
    console.error('[admin-recent] Crash:', err);
    return res
      .status(500)
      .json({ error: 'server_error', message: err?.message || String(err) });
  }
}
