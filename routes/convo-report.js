// routes/convo-report.js
export const config = {
  api: { bodyParser: true, externalResolver: true },
};

import { pool } from "../lib/pool.js";

// CORS handled by router (api/router.js)

function mean(nums) {
  const xs = (nums || []).filter((n) => Number.isFinite(n));
  if (!xs.length) return null;
  const sum = xs.reduce((a, b) => a + b, 0);
  return Math.round((sum / xs.length) * 10) / 10;
}

function aggregateLowsPhonemes(rows) {
  const agg = new Map(); // phoneme -> {sum,n}
  for (const r of rows) {
    const lows = r?.summary?.lows;
    if (!Array.isArray(lows)) continue;
    for (const item of lows) {
      const p = String(item?.[0] || "").trim();
      const s = Number(item?.[1]);
      if (!p || !Number.isFinite(s)) continue;
      const cur = agg.get(p) || { sum: 0, n: 0 };
      cur.sum += s;
      cur.n += 1;
      agg.set(p, cur);
    }
  }
  const out = Array.from(agg.entries()).map(([p, v]) => ({
    phoneme: p,
    score: Math.round((v.sum / Math.max(1, v.n)) * 10) / 10,
    n: v.n,
  }));
  out.sort((a, b) => a.score - b.score);
  return out.slice(0, 8);
}

function aggregateLowsWords(rows) {
  const agg = new Map(); // word -> {sum, n}
  for (const r of rows) {
    const words = r?.summary?.words;
    if (!Array.isArray(words)) continue;
    for (const item of words) {
      const w = String(item?.[0] || "").trim().toLowerCase();
      const score = Number(item?.[1]);
      const n = Number(item?.[2] ?? 1);
      if (!w || !Number.isFinite(score)) continue;
      const weight = Number.isFinite(n) && n > 0 ? n : 1;
      const cur = agg.get(w) || { sum: 0, n: 0 };
      cur.sum += score * weight;
      cur.n += weight;
      agg.set(w, cur);
    }
  }
  const out = Array.from(agg.entries()).map(([w, v]) => ({
    word: w,
    score: Math.round((v.sum / Math.max(1, v.n)) * 10) / 10,
    n: v.n,
  }));
  out.sort((a, b) => a.score - b.score);
  return out.slice(0, 10);
}

async function maybeNarrative({ stats, sampleUtterances }) {
  if (!process.env.OPENAI_API_KEY) return null;

  const { OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const sys = `
You are a supportive, practical American English pronunciation coach.
Write a SHORT report that is encouraging and actionable.
Output JSON ONLY with:
{
  "overall": "1-3 sentences",
  "strengths": ["...", "..."],
  "focus": ["...", "...", "..."],
  "practice_next": ["short speakable line", "short speakable line", "short speakable line"]
}
Avoid shaming. Avoid long explanations.
`.trim();

  const user = {
    stats,
    sample_utterances: sampleUtterances,
  };

  const rsp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.5,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify(user) },
    ],
  });

  const raw = rsp?.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    return { overall: raw, strengths: [], focus: [], practice_next: [] };
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const token =
    (req.headers["x-admin-token"] || "").toString().trim() ||
    (req.query?.token || "").toString().trim();
  const expected = (process.env.ADMIN_TOKEN || "").toString().trim();
  if (!expected || token !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    const uid = body.uid || body.userId || null;
    const sessionId = body.sessionId || body.session_id || null;
    const passageKey = body.passageKey || body.passage_key || body.passage || null;

    if (!uid) return res.status(400).json({ ok: false, error: "missing_uid" });
    if (!sessionId) return res.status(400).json({ ok: false, error: "missing_session_id" });
    if (!passageKey) return res.status(400).json({ ok: false, error: "missing_passage_key" });

    const sql = `
      SELECT part_index, text, summary, ts
      FROM public.lux_attempts
      WHERE uid = $1 AND passage_key = $2 AND session_id = $3
      ORDER BY part_index ASC, ts ASC
    `;
    const { rows } = await pool.query(sql, [uid, passageKey, sessionId]);

    if (!rows?.length) {
      return res.status(404).json({ ok: false, error: "no_attempts_for_session" });
    }

    const scores = {
      pron: mean(rows.map((r) => Number(r?.summary?.pron))),
      acc: mean(rows.map((r) => Number(r?.summary?.acc))),
      flu: mean(rows.map((r) => Number(r?.summary?.flu))),
      comp: mean(rows.map((r) => Number(r?.summary?.comp))),
    };

    const lows_phonemes = aggregateLowsPhonemes(rows);
    const lows_words = aggregateLowsWords(rows);

    const meta = {
      turns: rows.length,
      start_ts: rows[0]?.ts || null,
      end_ts: rows[rows.length - 1]?.ts || null,
    };

    const sampleUtterances = rows
      .map((r) => String(r?.text || "").trim())
      .filter(Boolean)
      .slice(-10);

    const stats = { meta, scores, lows_phonemes, lows_words };

    const narrative = await maybeNarrative({ stats, sampleUtterances });

    return res.status(200).json({
      ok: true,
      uid,
      sessionId,
      passageKey,
      meta,
      scores,
      lows_phonemes,
      lows_words,
      narrative,
    });
  } catch (err) {
    console.error("[convo-report] error:", err);
    return res.status(500).json({ ok: false, error: "server_error", detail: err?.message || String(err) });
  }
}
