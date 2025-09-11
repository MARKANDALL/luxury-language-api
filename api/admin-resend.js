// /api/admin-resend.js
import { createClient } from '@supabase/supabase-js';

function flatten(rows = []) {
  return rows.map((r) => {
    const s = r.summary || {};
    const lows = Array.isArray(s.lows)
      ? s.lows.map((l) => `${l.word}:${l.phoneme}(${l.score})`).join(' | ')
      : '';
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
      lows,
    };
  });
}

function toCSV(rows = []) {
  if (!rows.length) {
    return 'id,uid,ts,passage_key,part_index,text,acc,flu,comp,pron,lows\n';
  }
  const headers = Object.keys(rows[0]);
  const esc = (v) => (v == null ? '' : String(v).replace(/"/g, '""').replace(/\r?\n/g, ' '));
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => `"${esc(r[h])}"`).join(',')),
  ].join('\n');
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

    const u = new URL(req.url, 'http://localhost');
    const token =
      req.headers['x-admin-token'] ||
      req.headers['x-admin-token'.toLowerCase()] ||
      u.searchParams.get('token');

    if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    const format = (u.searchParams.get('format') || 'json').toLowerCase();
    const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '200', 10) || 200, 1), 1000);
    const uid = u.searchParams.get('uid') || null;

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
      const csv = toCSV(flatten(data));
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
