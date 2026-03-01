// file: /api/admin-recent.js
import { pool } from "../lib/pool.js";

const ALLOWED_PASSAGES = new Set([
  "rainbow",
  "grandfather",
  "sentences",
  "wordList",
]);

function parseISO(d) {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isFinite(n)) return Math.min(Math.max(n, min), max);
  return fallback;
}

function csvEscape(v) {
  let s = v == null ? "" : String(v);
  // Excel friendliness: remove newlines inside fields and escape quotes
  if (/["\n,]/.test(s)) s = `"${s.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
  return s;
}

function rowsToCsv(rows) {
  const header = [
    "id",
    "uid",
    "label",
    "ts",
    "passage_key",
    "part_index",
    "text",
    "acc",
    "flu",
    "comp",
    "pron",
  ];
  const lines = [header.join(",")];

  for (const r of rows) {
    const s = r.summary || {};
    lines.push(
      [
        r.id,
        r.uid,
        r.label || "",
        r.ts,
        r.passage_key || "",
        r.part_index ?? "",
        r.text || "",
        s.acc ?? "",
        s.flu ?? "",
        s.comp ?? "",
        s.pron ?? "",
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  // Prepend BOM for Excel
  return "\ufeff" + lines.join("\r\n");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    const q = req.method === "GET" ? req.query : req.body;

    // --- Token: header first, then query (URL)
    const token =
      (req.headers["x-admin-token"] || "").toString().trim() ||
      (q.token || "").toString().trim();
    const expected = (process.env.ADMIN_TOKEN || "").toString().trim();

    if (!expected || token !== expected) {
      return res.status(401).json({ error: "unauthorized" });
    }

    // --- Inputs
    const uid = q.uid ? String(q.uid) : null;
    const limit = clampInt(q.limit, 1, 2000, 500);

    const fromIso = parseISO(q.from);

    // make "to" exclusive end-of-day if date supplied (YYYY-MM-DD => next day at 00:00)
    const toIso = q.to
      ? new Date(new Date(q.to).getTime() + 24 * 3600 * 1000).toISOString()
      : null;

    // passages filter (supports BOTH: passages=a,b,c  AND legacy: passage=a)
    let passages = null;

    if (q.passages) {
      const list = String(q.passages)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((p) => ALLOWED_PASSAGES.has(p));
      if (list.length) passages = list;
    } else if (q.passage) {
      const one = String(q.passage).trim();
      if (ALLOWED_PASSAGES.has(one)) passages = [one];
    }

    // --- Build SQL safely
    const params = [];
    const where = [];

    if (uid) {
      params.push(uid);
      where.push(`a.uid = $${params.length}`);
    }
    if (fromIso) {
      params.push(fromIso);
      where.push(`a.ts >= $${params.length}`);
    }
    if (toIso) {
      params.push(toIso);
      where.push(`a.ts < $${params.length}`);
    }
    if (passages) {
      params.push(passages);
      where.push(`a.passage_key = ANY($${params.length})`);
    }

    let sql = `
      SELECT
        a.id,
        a.uid,
        a.ts,
        a.passage_key,
        a.part_index,
        a.text,
        a.summary,
        COALESCE(l.label, u.label, '') AS label
      FROM public.lux_attempts a
      LEFT JOIN public.lux_user_labels l ON l.uid::text = a.uid
      LEFT JOIN public.lux_users u ON u.uid::text = a.uid
    `;

    if (where.length) sql += ` WHERE ${where.join(" AND ")} `;

    params.push(limit);
    sql += ` ORDER BY a.ts DESC LIMIT $${params.length}`;

    // --- Query
    const { rows } = await pool.query(sql, params);

    // --- CSV or JSON
    if (String(q.format).toLowerCase() === "csv") {
      const csv = rowsToCsv(rows);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="lux_attempts.csv"'
      );
      return res.status(200).send(csv);
    }

    return res.status(200).json({ rows });
  } catch (err) {
    console.error("admin-recent error:", err);
    // Never crash the function—always return JSON
    return res
      .status(500)
      .json({ error: "server_error", detail: String(err?.message || err) });
  }
}
