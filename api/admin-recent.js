// /api/admin-recent.js  (ESM; Vercel Node runtime)
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  try {
    // Parse query safely (works on Vercel)
    let limit = 100, uidFilter = null, qsToken = null;
    try {
      const u = new URL(req.url, 'http://localhost');
      qsToken   = u.searchParams.get('token');
      limit     = Math.min(parseInt(u.searchParams.get('limit') || '100', 10), 1000);
      uidFilter = (u.searchParams.get('uid') || '').trim() || null;
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
      console.error('[admin-recent] Missing Supabase envs');
      return res.status(500).json({ error: 'missing_supabase_envs' });
    }

    const supa = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Main query (optionally filter by uid)
    let q = supa
      .from('lux_attempts')
      .select('id, uid, ts, passage_key, part_index, text, summary')
      .order('ts', { ascending: false })
      .limit(limit);

    if (uidFilter) q = q.eq('uid', uidFilter);

    const { data: attempts, error } = await q;
    if (error) {
      console.error('[admin-recent] Supabase error:', error);
      return res.status(500).json({ error: error.message });
    }

    // Fetch labels and merge (no FK between tables, so do it in code)
    const uids = [...new Set((attempts || []).map(r => r.uid))];
    const labelByUid = {};
    if (uids.length) {
      const { data: labels, error: e2 } = await supa
        .from('lux_users')
        .select('uid, label')
        .in('uid', uids);
      if (e2) console.error('[admin-recent] label fetch error:', e2);
      (labels || []).forEach(r => (labelByUid[r.uid] = r.label));
    }

    const out = (attempts || []).map(r => ({ ...r, label: labelByUid[r.uid] || null }));
    return res.status(200).json({ rows: out });
  } catch (err) {
    console.error('[admin-recent] Crash:', err);
    return res.status(500).json({ error: 'server_error', message: err?.message || String(err) });
  }
}
