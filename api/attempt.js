// file: /api/attempt.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// Allow the app + sandbox
const ALLOW_ORIGINS = new Set([
  'https://luxury-language-api.vercel.app',
  'https://prh3j3.csb.app',
  'http://localhost:3000',
]);

function cors(res, origin) {
  const allow = ALLOW_ORIGINS.has(origin) ? origin : 'https://luxury-language-api.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res, req.headers.origin || '');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return res.status(500).json({ error: 'Missing Supabase env vars' });
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // Body from attempt-log.js
    const b = req.body || {};
    const row = {
      uid:        b.uid || null,
      ts:         b.ts  || new Date().toISOString(),
      passage_key: String(b.passage || 'unknown'),
      part_index:  Number.isFinite(Number(b.part)) ? Number(b.part) : 0,
      text:        b.text || '',
      // What the admin pages read:
      summary: {
        acc:  b.acc ?? null,
        flu:  b.flu ?? null,
        comp: b.comp ?? null,
        pron: b.pron ?? null,
        // optional/large – omit if you want
        lows: Array.isArray(b.azure?.NBest?.[0]?.Words) ? undefined : b.lows,
      },
    };

    const { error } = await supabase.from('lux_attempts').insert(row);
    if (error) return res.status(500).json({ ok: false, error: error.message });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
