// /api/admin-resend.js  — CSV/JSON export with token check (Vercel Node runtime, ESM)
import { createClient } from '@supabase/supabase-js';

function toCSV(rows) {
  if (!rows?.length) return 'id,uid,ts,passage_key,part_index,text,summary\n';
  const headers = Object.keys(rows[0]);
  const esc = v => (v == null ? '' : String(v).replace(/"/g, '""').replace(/\r?\n/g, ' '));
  const lines = [headers.join(','), ...rows.map(r => headers.map(h => `"${esc(r[h])}"`).join(','))];
  return lines.join('\n');
}

export default async function handler(req, res) {
  try {
    // CORS (lets you open in a tab or fetch from admin tools)
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'x-admin-token, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      return res.status(204).end();
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    // token via header or query (?token=...)
    let qsToken = null, format = 'json', limit = 100;
    try {
      const u = new URL(req.url, 'http://localhost');
      qsToken = u.searchParams.get('token');
      format = (u.searchParams.get('format') || 'json').toLowerCase();
      const l = parseInt(u.searchParams.get('limit') || '100', 10);
      if (Number.isFinite(l) && l > 0 && l <= 1000) limit = l;
    } catch {}
    const token = req.headers['x-admin-token'] || req.headers['x-admin-token'.toLowerCase()] || qsToken;

    if (!process.env.ADMIN_TOKEN) return res.status(500).json({ error: 'missing ADMIN_TOKEN' });
    if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE;
    if (!url || !key) return res.status(500).json({ error: 'missing_supabase_envs' });

    const supa = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

    const { data, error } = await supa
      .from('lux_attempts')
      .select('id, uid, ts, passage_key, part_index, text, summary')
      .order('ts', { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ error: error.message });

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (format === 'csv') {
      const csv = toCSV(data || []);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="lux_attempts.csv"');
      return res.status(200).end(csv);
    }
    return res.status(200).json({ rows: data });
  } catch (err) {
    console.error('[admin-resend] Crash:', err);
    return res.status(500).json({ error: 'server_error', message: err?.message || String(err) });
  }
}
