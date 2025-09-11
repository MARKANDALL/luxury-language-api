// /api/admin-label-user.js  (ESM; Vercel Node runtime)
import { createClient } from '@supabase/supabase-js';

function getToken(req) {
  let qsToken = null;
  try {
    const u = new URL(req.url, 'http://localhost');
    qsToken = u.searchParams.get('token');
  } catch {}
  return (
    req.headers['x-admin-token'] ||
    req.headers['x-admin-token'.toLowerCase()] ||
    qsToken
  );
}

export default async function handler(req, res) {
  try {
    // CORS
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'x-admin-token, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      return res.status(204).end();
    }

    const token = getToken(req);
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

    // GET: fetch labels
    if (req.method === 'GET') {
      const u = new URL(req.url, 'http://localhost');
      const uid = (u.searchParams.get('uid') || '').trim();
      const uidsCsv = (u.searchParams.get('uids') || '').trim(); // comma-separated
      let q = supa.from('lux_users').select('uid,label,note,updated_at');

      if (uid) q = q.eq('uid', uid);
      else if (uidsCsv) {
        const arr = uidsCsv.split(',').map(s => s.trim()).filter(Boolean);
        if (arr.length) q = q.in('uid', arr);
      } else {
        q = q.order('updated_at', { ascending: false }).limit(1000);
      }

      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({ rows: data });
    }

    // Helper: read JSON body
    const readJson = async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      return raw ? JSON.parse(raw) : {};
    };

    // POST: upsert or delete
    if (req.method === 'POST') {
      const { uid, label, note } = await readJson();
      if (!uid || typeof uid !== 'string') {
        return res.status(400).json({ error: 'uid required' });
      }

      // Empty label => delete
      if (label == null || String(label).trim() === '') {
        const { error } = await supa.from('lux_users').delete().eq('uid', uid);
        if (error) return res.status(500).json({ error: error.message });
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).json({ ok: true, deleted: true });
      }

      const payload = { uid, label: String(label).trim() };
      if (note != null) payload.note = String(note);

      const { data, error } = await supa.from('lux_users').upsert(payload).select();
      if (error) return res.status(500).json({ error: error.message });
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({ ok: true, row: data?.[0] || null });
    }

    // DELETE (optional): /api/admin-label-user?uid=...
    if (req.method === 'DELETE') {
      const u = new URL(req.url, 'http://localhost');
      const uid = (u.searchParams.get('uid') || '').trim();
      if (!uid) return res.status(400).json({ error: 'uid required' });
      const { error } = await supa.from('lux_users').delete().eq('uid', uid);
      if (error) return res.status(500).json({ error: error.message });
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({ ok: true, deleted: true });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    console.error('[admin-label-user] Crash:', err);
    return res.status(500).json({ error: 'server_error', message: err?.message || String(err) });
  }
}
