// /api/admin-recent.js  (ESM; Vercel Node runtime)
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  try {
    // token via header or query
    let qs;
    try { qs = new URL(req.url, 'http://localhost'); } catch {}
    const tokenFromQS = qs?.searchParams.get('token');
    const token = req.headers['x-admin-token'] || tokenFromQS;

    if (!process.env.ADMIN_TOKEN) {
      console.error('[admin-recent] Missing ADMIN_TOKEN');
      return res.status(500).json({ error: 'missing ADMIN_TOKEN' });
    }
    if (token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    // optional limit + uid filter
    let limit = parseInt(qs?.searchParams.get('limit') || '200', 10);
    if (!Number.isFinite(limit) || limit < 1 || limit > 1000) limit = 200;
    const uid = (qs?.searchParams.get('uid') || '').trim();

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
    if (error) {
      console.error('[admin-recent] Supabase error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ rows: data });
  } catch (err) {
    console.error('[admin-recent] Crash:', err);
    return res.status(500).json({ error: 'server_error', message: err?.message || String(err) });
  }
}
