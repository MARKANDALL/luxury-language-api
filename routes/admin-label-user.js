// routes/admin-label-user.js
// One-line: Admin-only endpoint to upsert a user's label/note in lux_users using a centralized Supabase admin client.

import { getSupabaseAdmin } from '../lib/supabase.js';
import { isAdminKeyRequest } from '../lib/admin-auth.js';

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')); }
      catch { resolve({}); }
    });
  });
}

export default async function handler(req, res) {
  try {
    // ADMIN-ONLY: upserts a label/note onto ANY caller-supplied uid via the
    // service-role client. Gated on ADMIN_KEY_PRIVATE only (x-admin-key
    // header); an unset key fails closed rather than returning a 500 that
    // advertises the deployment's configuration.
    if (!isAdminKeyRequest(req)) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    let uid = null, label = null, note = null;
    try {
      const u = new URL(req.url, 'http://localhost');
      uid     = u.searchParams.get('uid');
      label   = u.searchParams.get('label');
      note    = u.searchParams.get('note');
    } catch (err) {
      console.warn("[admin/admin-label-user] failed to parse query params", err);
    }

    // Allow POST body too
    if (req.method === 'POST') {
      const body = await readJson(req);
      uid   = body.uid   ?? uid;
      label = body.label ?? label;
      note  = body.note  ?? note;
    }

    uid = (uid || '').trim();
    label = (label || '').trim();
    note = (note || '').trim();

    if (!uid || !label) {
      return res.status(400).json({ error: 'uid_and_label_required' });
    }
    if (label.length > 120) {
      return res.status(400).json({ error: 'label_too_long' });
    }

    const supa = getSupabaseAdmin();

    const { data, error } = await supa
      .from('lux_users')
      .upsert([{ uid, label, note }], { onConflict: 'uid' })
      .select()
      .limit(1);

    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ ok: true, row: data?.[0] || { uid, label, note } });
  } catch (err) {
    console.error('[admin-label-user] Crash:', err);
    return res.status(500).json({ error: 'server_error', message: err?.message || String(err) });
  }
}
