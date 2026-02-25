// routes/admin-user-stats.js
// One-line: Admin-only stats endpoint that aggregates lux_attempts by user and window, with safe in-handler Supabase init (no import-time crash).
import { getSupabaseAdmin } from '../lib/supabase.js';

const SUPABASE_URL   =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  'https://pvggfemqtlsicreynfxz.supabase.co';

const SERVICE_ROLE   =
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2Z2dmZW1xdGxzaWNyZXluZnh6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NzUzNDE0MiwiZXhwIjoyMDczMTEwMTQyfQ.Dx_NFUWCbtVF7msJM6LpvJvaS2txKFxIkimF4RurG7g';

const ADMIN_TOKEN    = process.env.ADMIN_TOKEN || 'sIMONCAT4!';

function getSupabaseClient() {
  // IMPORTANT: never crash at import-time (router-wide outage)
  if (!SUPABASE_URL) {
    throw new Error('SUPABASE_URL is required (set SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL)');
  }
  if (!SERVICE_ROLE) {
    throw new Error('SUPABASE service key is required (set SUPABASE_SERVICE_ROLE / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY)');
  }
  return getSupabaseAdmin({ url: SUPABASE_URL, key: SERVICE_ROLE });
}

function getAdminToken(req) {
  return req.headers['x-admin-token'] || req.query.token || '';
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

export default async function handler(req, res) {
  try {
    const token = getAdminToken(req);
    if (!token || (ADMIN_TOKEN && token !== ADMIN_TOKEN)) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    let supabase;
    try {
      supabase = getSupabaseClient();
    } catch (e) {
      const detail = e && e.message ? String(e.message) : String(e || 'supabase_init_error');
      return res.status(500).json({ error: 'supabase_not_configured', detail });
    }

    // Inputs
    const limit = clamp(parseInt(req.query.limit || '20000', 10) || 20000, 1, 50000);
    const toParam   = req.query.to;
    const fromParam = req.query.from;
    const windowDays = clamp(parseInt(req.query.window || '7', 10) || 7, 1, 30);
    const passages = (req.query.passages || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    const to   = toParam   ? new Date(`${toParam}T23:59:59Z`) : new Date();
    const from = fromParam ? new Date(`${fromParam}T00:00:00Z`)
                           : new Date(to.getTime() - 14 * 864e5);

    const recentFrom = new Date(to.getTime() - windowDays * 864e5);
    const prevFrom   = new Date(recentFrom.getTime() - windowDays * 864e5);
    const start      = new Date(Math.min(from.getTime(), prevFrom.getTime()));

    // Pull attempts once (prev window → now) and aggregate in code
    let q = supabase
      .from('lux_attempts')
      .select('uid, ts, passage_key, summary', { count: 'exact' })
      .gte('ts', start.toISOString())
      .lte('ts', to.toISOString())
      .order('ts', { ascending: false });

    if (passages.length) q = q.in('passage_key', passages);
    if (limit) q = q.limit(limit);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    // Labels (optional)
    const uids = Array.from(new Set(data.map(r => r.uid)));
    const { data: labels } = await supabase.from('lux_users').select('uid,label').in('uid', uids);
    const labelMap = new Map((labels || []).map(r => [r.uid, r.label]));

    // Aggregate
    const stats = new Map();
    const toMs = to.getTime(), fromMs = from.getTime();
    const recentFromMs = recentFrom.getTime(), prevFromMs = prevFrom.getTime();

    for (const r of data) {
      const uid = r.uid;
      const tsMs = new Date(r.ts).getTime();
      const pron = Number(r?.summary?.pron);

      if (!stats.has(uid)) {
        stats.set(uid, {
          uid, label: labelMap.get(uid) || '',
          last_ts: null, attempts: 0,
          sum: 0, n: 0,
          recentSum: 0, recentN: 0,
          prevSum: 0, prevN: 0
        });
      }
      const s = stats.get(uid);

      if (!s.last_ts || tsMs > new Date(s.last_ts).getTime()) s.last_ts = r.ts;

      if (tsMs >= fromMs && tsMs <= toMs) {
        s.attempts++;
        if (Number.isFinite(pron)) { s.sum += pron; s.n++; }
      }
      if (Number.isFinite(pron)) {
        if (tsMs > recentFromMs && tsMs <= toMs) {
          s.recentSum += pron; s.recentN++;
        } else if (tsMs > prevFromMs && tsMs <= recentFromMs) {
          s.prevSum += pron; s.prevN++;
        }
      }
    }

    const rows = Array.from(stats.values()).map(s => {
      const avg       = s.n        ? (s.sum / s.n) : null;
      const recentAvg = s.recentN  ? (s.recentSum / s.recentN) : null;
      const prevAvg   = s.prevN    ? (s.prevSum / s.prevN) : null;
      const delta     = (recentAvg != null && prevAvg != null) ? (recentAvg - prevAvg) : null;
      return {
        uid: s.uid,
        label: s.label || null,
        last_ts: s.last_ts,
        attempts: s.attempts,
        avg_pron:  avg       != null ? Number(avg.toFixed(1))       : null,
        recent_avg:recentAvg != null ? Number(recentAvg.toFixed(1)) : null,
        prev_avg:  prevAvg   != null ? Number(prevAvg.toFixed(1))   : null,
        delta:     delta     != null ? Number(delta.toFixed(1))     : null
      };
    }).sort((a, b) => new Date(b.last_ts) - new Date(a.last_ts));

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      rows,
      window_days: windowDays,
      from: from.toISOString(),
      to: to.toISOString()
    });
  } catch (e) {
    console.error(e);
    const detail = e && e.message ? String(e.message) : String(e || 'server_error');
    return res.status(500).json({ error: 'server_error', detail });
  }
}