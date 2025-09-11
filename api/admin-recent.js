// /api/admin-recent.js  (ESM; Vercel Node runtime)
import { createClient } from '@supabase/supabase-js';

function getQS(req) {
  try { return new URL(req.url, 'http://localhost').searchParams; }
  catch { return new URLSearchParams(); }
}
function toISOStart(s) {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(+d)) return null;
  // if only YYYY-MM-DD, force start of day local
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d.setHours(0,0,0,0);
  return d.toISOString();
}
function toISOEnd(s) {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(+d)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d.setHours(23,59,59,999);
  return d.toISOString();
}

export default async function handler(req, res) {
  try {
    const qs = getQS(req);

    // allow header OR ?token=
    const token =
      req.headers['x-admin-token'] ||
      req.headers['x-admin-token'.toLowerCase()] ||
      qs.get('token');

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
      return res.status(500).json({ error: 'missing Supabase envs' });
    }

    const supa = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ---- filters ----
    const limit = Math.min(Math.max(parseInt(qs.get('limit') || '100', 10), 1), 50000);
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
    if (error) {
      console.error('[admin-recent] Supabase error:', error);
      return res.status(500).json({ error: error.message });
    }

    // attach labels
    const uids = [...new Set((data || []).map(r => r.uid))];
    if (uids.length) {
      const { data: labels, error: lerr } = await supa
        .from('lux_users')
        .select('uid, label')
        .in('uid', uids);
      if (!lerr && labels) {
        const map = Object.fromEntries(labels.map(x => [x.uid, x.label]));
        data.forEach(r => (r.label = map[r.uid] || null));
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ rows: data });
  } catch (err) {
    console.error('[admin-recent] Crash:', err);
    return res.status(500).json({ error: 'server_error', message: err?.message || String(err) });
  }
}
