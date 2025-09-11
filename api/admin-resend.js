// /api/admin-resend.js  (ESM; CSV/JSON export with filters)
import { createClient } from '@supabase/supabase-js';

function getQS(req) {
  try { return new URL(req.url, 'http://localhost').searchParams; }
  catch { return new URLSearchParams(); }
}
function toISOStart(s){ if(!s) return null; const d=new Date(s); if(Number.isNaN(+d)) return null; if(/^\d{4}-\d{2}-\d{2}$/.test(s)) d.setHours(0,0,0,0); return d.toISOString(); }
function toISOEnd(s){ if(!s) return null; const d=new Date(s); if(Number.isNaN(+d)) return null; if(/^\d{4}-\d{2}-\d{2}$/.test(s)) d.setHours(23,59,59,999); return d.toISOString(); }
function toCSV(rows) {
  if (!rows?.length) return 'id,uid,label,ts,passage_key,part_index,text,acc,flu,comp,pron\n';
  const out = ['id,uid,label,ts,passage_key,part_index,text,acc,flu,comp,pron'];
  for (const r of rows) {
    const s = r.summary || {};
    const esc = (v)=> (v==null? '' : `"${String(v).replace(/"/g,'""').replace(/\r?\n/g,' ')}"`);
    out.push([r.id, r.uid, r.label ?? '', r.ts, r.passage_key, r.part_index, esc(r.text), s.acc ?? '', s.flu ?? '', s.comp ?? '', s.pron ?? ''].join(','));
  }
  return out.join('\n');
}

export default async function handler(req, res) {
  try {
    const qs = getQS(req);
    const token =
      req.headers['x-admin-token'] ||
      req.headers['x-admin-token'.toLowerCase()] ||
      qs.get('token');

    if (!process.env.ADMIN_TOKEN) return res.status(500).json({ error: 'missing ADMIN_TOKEN' });
    if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const limit = Math.min(Math.max(parseInt(qs.get('limit') || '1000', 10), 1), 50000);
    const uid = (qs.get('uid') || '').trim();
    const passage = (qs.get('passage') || '').trim();
    const fromISO = toISOStart(qs.get('from'));
    const toISO   = toISOEnd(qs.get('to'));

    let q = supa
      .from('lux_attempts')
      .select('id, uid, ts, passage_key, part_index, text, summary')
      .order('ts', { ascending: false })
      .limit(limit);

    if (uid) q = q.eq('uid', uid);
    if (passage) q = q.eq('passage_key', passage);
    if (fromISO) q = q.gte('ts', fromISO);
    if (toISO)   q = q.lte('ts', toISO);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    // labels
    const uids = [...new Set((data || []).map(r => r.uid))];
    if (uids.length) {
      const { data: labels } = await supa.from('lux_users').select('uid,label').in('uid', uids);
      const map = Object.fromEntries((labels||[]).map(x => [x.uid, x.label]));
      (data||[]).forEach(r => (r.label = map[r.uid] || null));
    }

    const format = (qs.get('format') || 'json').toLowerCase();
    res.setHeader('Cache-Control','no-store');

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="lux_attempts.csv"');
      return res.status(200).end(toCSV(data || []));
    }
    return res.status(200).json({ rows: data });
  } catch (err) {
    console.error('[admin-resend] Crash:', err);
    return res.status(500).json({ error: 'server_error', message: err?.message || String(err) });
  }
}
