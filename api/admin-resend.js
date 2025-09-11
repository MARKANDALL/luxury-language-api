// /api/admin-resend.js  (ESM; Vercel Node runtime)
import { createClient } from '@supabase/supabase-js';

function rowsToCSV(rows = []) {
  // flatten summary -> separate columns (acc, flu, comp, pron)
  const flat = rows.map(r => {
    const s = r.summary || {};
    return {
      id: r.id,
      uid: r.uid,
      ts: r.ts,
      passage_key: r.passage_key,
      part_index: r.part_index,
      text: r.text,
      acc: s.acc ?? '',
      flu: s.flu ?? '',
      comp: s.comp ?? '',
      pron: s.pron ?? '',
    };
  });

  const headers = flat.length
    ? Object.keys(flat[0])
    : ['id','uid','ts','passage_key','part_index','text','acc','flu','comp','pron'];

  const esc = v => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""').replace(/\r?\n/g, ' ');
    return /[",\n\r]/.test(s) ? `"${s}"` : s;
  };

  const lines = [headers.join(','), ...flat.map(r => headers.map(h => esc(r[h])).join(','))];
  return lines.join('\n');
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'x-admin-token, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      return res.status(204).end();
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    let qs;
    try { qs = new URL(req.url, 'http://localhost'); } catch {}
    const tokenFromQS = qs?.searchParams.get('token');
    const token = req.headers['x-admin-token'] || tokenFromQS;

    if (!process.env.ADMIN_TOKEN) {
      console.error('[admin-resend] Missing ADMIN_TOKEN');
      return res.status(500).json({ error: 'missing ADMIN_TOKEN' });
    }
    if (token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    let limit = parseInt(qs?.searchParams.get('limit') || '200', 10);
    if (!Number.isFinite(limit) || limit < 1 || limit > 5000) limit = 200;
    const uid = (qs?.searchParams.get('uid') || '').trim();
    const format = (qs?.searchParams.get('format') || 'json').toLowerCase();

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
      console.error('[admin-resend] Supabase error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (format === 'csv') {
      const csv = rowsToCSV(data || []);
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
