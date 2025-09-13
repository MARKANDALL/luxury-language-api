// /api/attempt.js  (Vercel serverless function)
const ALLOW_ORIGINS = [
  'https://luxury-language-api.vercel.app',
  'https://prh3j3.csb.app',
  'http://localhost:3000'
];

function allowOrigin(origin) {
  if (!origin) return '*';
  return ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
}

// If you already have a DB helper, require it here.
// const { saveAttempt } = require('../lib/db'); // <-- adjust path or replace with your insert

module.exports = async (req, res) => {
  const origin = allowOrigin(req.headers.origin);
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const b = req.body || {};
    const row = {
      uid: b.uid || null,
      ts: b.ts || new Date().toISOString(),
      passage: b.passage || 'unknown',
      part: Number(b.part ?? 0),
      text: b.text || '',
      acc: b.acc ?? null,
      flu: b.flu ?? null,
      comp: b.comp ?? null,
      pron: b.pron ?? null,
      success: b.success !== false,
      error: b.error || null,
      azure: b.azure || null
    };

    // await saveAttempt(row); // <-- call your real DB insert here
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
