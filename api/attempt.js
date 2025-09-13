// pages/api/attempt.js  (Next.js "pages" router)
import { saveAttempt } from '../../lib/db' // whatever you use to insert

const ALLOW_ORIGINS = [
  'https://luxury-language-api.vercel.app',
  'https://prh3j3.csb.app',             // your CodeSandbox
  'http://localhost:3000'
];

function allowOrigin(origin) {
  if (!origin) return '*'; // permissive fallback
  return ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
}

export default async function handler(req, res) {
  const origin = allowOrigin(req.headers.origin);

  // Shared headers
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin'); // cache-safe
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    // Preflight OK
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    const body = req.body || {};
    // minimally validate
    const row = {
      uid: body.uid || null,
      ts: body.ts || new Date().toISOString(),
      passage: body.passage || 'unknown',
      part: Number(body.part ?? 0),
      text: body.text || '',
      acc: body.acc ?? null,
      flu: body.flu ?? null,
      comp: body.comp ?? null,
      pron: body.pron ?? null,
      success: body.success !== false,
      error: body.error || null,
      azure: body.azure || null
    };

    await saveAttempt(row); // insert into your DB
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
