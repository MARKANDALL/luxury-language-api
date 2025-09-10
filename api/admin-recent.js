// /api/admin-recent.js
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const supa = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE // service_role key (SERVER ONLY)
  );

  const { data, error } = await supa
    .from('lux_attempts')
    .select('id, uid, ts, passage_key, part_index, text, summary')
    .order('ts', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json({ rows: data });
}
