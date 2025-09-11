// /api/admin-label-user.js  (ESM; Vercel Node runtime)
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'x-admin-token, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const url = new URL(req.url, 'http://localhost');
    const token =
      req.headers['x-admin-token'] ||
      req.headers['x-admin-token'.toLowerCase()] ||
      url.searchParams.get('token');

    if (!process.env.ADMIN_TOKEN) {
      console.error('[admin-label-user] Missing ADMIN_TOKEN');
      return res.status(500).json({ error: 'server_misconfigured' });
    }
    if (token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const supa = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    if (req.method === 'GET') {
      // 1) single uid:  ?uid=...
      // 2) many uids:   ?uids=a,b,c
      const uid = url.searchParams.get('uid');
      const uids = url.searchParams.get('uids');
      if (uids) {
        const list = uids.split(',').map(s => s.trim()).filter(Boolean);
        const { data, error } = await supa
          .from('lux_users')
          .select('uid,label')
          .in('uid', list);
        if (error) throw error;
        return res.status(200).json({ labels: data });
      }
      if (!uid) return res.status(400).json({ error: 'uid_required' });
      const { data, error } = await supa
        .from('lux_users')
        .select('uid,label,note')
        .eq('uid', uid)
        .maybeSingle();
      if (error) throw error;
      return res.status(200).json({ user: data || null });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const { uid, label, note = null } = body;
      if (!uid || !label) return res.status(400).json({ error: 'uid_and_label_required' });
      const { data, error } = await supa
        .from('lux_users')
        .upsert({ uid, label, note })
        .select('uid,label,note')
        .single();
      if (error) throw error;
      return res.status(200).json({ ok: true, user: data });
    }

    if (req.method === 'DELETE') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const uid = new URL(req.url, 'http://localhost').searchParams.get('uid') || body.uid;
      if (!uid) return res.status(400).json({ error: 'uid_required' });
      const { error } = await supa.from('lux_users').delete().eq('uid', uid);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    console.error('[admin-label-user] Crash:', err);
    return res.status(500).json({ error: 'server_error', message: err?.message || String(err) });
  }
}
