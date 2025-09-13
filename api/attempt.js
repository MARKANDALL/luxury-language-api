// /api/attempt.js  — Vercel serverless function (CommonJS)
// Permissive CORS for dev + manual JSON parse (non-Next functions don’t get req.body).

module.exports = async (req, res) => {
  // ---- CORS (for ALL methods, including preflight) ----
  res.setHeader('Access-Control-Allow-Origin', '*');           // dev-wide
  res.setHeader('Vary', 'Origin');                             // cache safety
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();  // preflight OK
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // ---- Parse JSON body (Vercel functions don’t auto-parse) ----
  let body = {};
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch (_) {}

  // ---- TODO: save to your DB here (see step 2) ----
  // await saveAttempt(body);

  return res.status(200).json({ ok: true });
};
