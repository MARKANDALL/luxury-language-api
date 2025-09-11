// /api/admin-label-user.js  (ESM; POST/DELETE; Vercel Node runtime)
import { createClient } from '@supabase/supabase-js';

function getQS(req) {
  try { return new URL(req.url, 'http://localhost').searchParams; }
  catch { return new URLSearchParams(); }
}
async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

export default async function handler(req, res) {
  // CORS (handy if you ever open this from another origin)
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'x-admin-token, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
    return res.status(204).end();
  }

  try {
    const qs = getQS(req);
    const token =
      req.headers['x-admin-token'] ||
      req.headers['x-admin-token'.toLowerCase()] ||
      qs.get('token');

    if (!process.env.ADMIN_TOKEN) {
      return res.status(500).json({ error: 'missing ADMIN_TOKEN' });
    }
    if (token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // accept uid/label via either query string or JSON body
    let uid = (qs.get('uid') || '').trim();
    let label = (qs.get('label') || '').trim();
    if (!uid) {
      const raw = await readBody(req);
      if (raw) {
        try {
          const j = JSON.parse(raw);
          uid = (j.uid || uid || '').trim();
          label = (j.label || label || '').trim();
        } catch {}
      }
    }

    if (!uid) return res.status(400).json({ error: 'uid required' });

    if (req.method === 'DELETE' || label === '') {
      const { error } = await supa.from('lux_users').delete().eq('uid', uid);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, action: 'deleted', uid });
    }

    const { data, error } = await supa
      .from('lux_users')
      .upsert({ uid, label }, { onConflict: 'uid' })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, user: data });
  } catch (err) {
    console.error('[admin-label-user] Crash:', err);
    return res.status(500).json({ error: 'server_error', message: err?.message || String(err) });
  }
}
