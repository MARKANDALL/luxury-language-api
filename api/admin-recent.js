// /api/admin-recent.js
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  try {
    let qsToken = null, uid = null, limit = 100;
    try {
      const u = new URL(req.url, 'http://localhost');
      qsToken = u.searchParams.get('token');
      uid = (u.searchParams.get('uid') || '').trim() || null;
      const l = parseInt(u.searchParams.get('limit') || '100', 10);
      if (Number.isFinite(l)) limit = Math.min(Math.max(l, 1), 1000);
    } catch {}

    const token =
      req.headers['x-admin-token'] ||
      req.headers['x-admin-token'.toLowerCase()] ||
      qsToken;

    if (!process.env.ADMIN_TOKEN) {
      return res.status(500).json({ error: 'missing ADMIN_TOKEN' });
    }
    if (token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const supa = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    let q = supa
      .from('lux_attempts')
      .select('id, uid, ts, passage_key, part_index, text, summary')
      .order('ts', { ascending: false })
      .limit(limit);

    if (uid) q = q.eq('uid', uid);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.status(200).json({ rows: data });
  } catch (err) {
    console.error('[admin-recent] Crash:', err);
    return res.status(500).json({ error: 'server_error', message: err?.message || String(err) });
  }
}
