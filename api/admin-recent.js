// /api/admin-recent.js  (ESM; Vercel Node runtime)
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'x-admin-token, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      return res.status(204).end();
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    // token via header or query
    let qsToken = null;
    try {
      const u = new URL(req.url, 'http://localhost');
      qsToken = u.searchParams.get('token');
    } catch {}
    const token =
      req.headers['x-admin-token'] ||
      req.headers['x-admin-token'.toLowerCase()] ||
      qsToken;

    if (!process.env.ADMIN_TOKEN) {
      console.error('[admin-recent] Missing ADMIN_TOKEN');
      return res.status(500).json({ error: 'server_misconfigured:ADMIN_TOKEN' });
    }
    if (token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      console.error('[admin-recent] Missing Supabase envs', {
        hasUrl: !!SUPABASE_URL,
        hasServiceRole: !!SERVICE_ROLE
      });
      return res.status(500).json({ error: 'server_misconfigured:SUPABASE' });
    }

    const supa = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // optional ?limit=NN
    let limit = 100;
    try {
      const u = new URL(req.url, 'http://localhost');
      const l = parseInt(u.searchParams.get('limit') || '100', 10);
      if (Number.isFinite(l) && l > 0 && l <= 1000) limit = l;
    } catch {}

    const { data, error } = await supa
      .from('lux_attempts')
      .select('id, uid, ts, passage_key, part_index, text, summary')
      .order('ts', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[admin-recent] Supabase error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ rows: data });
  } catch (err) {
    console.error('[admin-recent] Crash:', err);
    return res.status(500).json({ error: 'server_error', message: err?.message || String(err) });
  }
}
