// /api/attempt.js  (Node/Next API Route)
import { sql } from '@vercel/postgres';

const ALLOW = new Set([
  'https://prh3j3.csb.app',              // your sandbox
  'https://luxurylanguagelearninglab.com', // prod (add if needed)
  'http://localhost:3000',
]);

function cors(res, origin) {
  if (origin && ALLOW.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { uid, ts, passage, part, text, success, error, acc, flu, comp, pron } = req.body || {};

    // create table once (idempotent)
    await sql`
      CREATE TABLE IF NOT EXISTS attempts (
        id SERIAL PRIMARY KEY,
        uid TEXT,
        ts TIMESTAMPTZ,
        passage TEXT,
        part INT,
        text TEXT,
        success BOOLEAN,
        error TEXT,
        acc REAL,
        flu REAL,
        comp REAL,
        pron REAL
      )
    `;

    await sql`
      INSERT INTO attempts (uid, ts, passage, part, text, success, error, acc, flu, comp, pron)
      VALUES (${uid}, ${ts}, ${passage}, ${part}, ${text}, ${success}, ${error}, ${acc}, ${flu}, ${comp}, ${pron})
    `;

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('attempt insert failed', e);
    return res.status(500).json({ ok: false, error: 'db-failed' });
  }
}
