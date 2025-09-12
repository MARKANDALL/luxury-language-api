// api/admin-recent.js
// Returns recent attempts for admin dashboards (JSON or CSV).
//
// Query params:
//   token        - admin token (or header x-admin-token)
//   uid          - optional: filter by single user id
//   from         - optional: YYYY-MM-DD (inclusive, at 00:00)
//   to           - optional: YYYY-MM-DD (inclusive, +1 day boundary)
//   passages     - optional: comma list, e.g. "rainbow,grandfather"
//   limit        - optional: default 500 (server hard cap 10000)
//   format=csv   - optional: return CSV (with UTF-8 BOM)
//
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function bad(res, code, msg) {
  res.status(code).json({ error: msg });
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseDate(d) {
  // Accept YYYY-MM-DD only
  if (!d) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return d;
}

export default async function handler(req, res) {
  try {
    // ---- Auth -------------------------------------------------------------
    const token =
      req.query.token ||
      req.headers["x-admin-token"] ||
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

    if (!token || token !== process.env.ADMIN_TOKEN) {
      return bad(res, 401, "unauthorized");
    }

    // ---- Inputs -----------------------------------------------------------
    const uid = (req.query.uid || "").trim();
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    const limit = Math.max(
      1,
      Math.min(10000, parseInt(req.query.limit || "500", 10) || 500)
    );

    let passages = [];
    if (req.query.passages) {
      passages = String(req.query.passages)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // ---- Build SQL --------------------------------------------------------
    const where = [];
    const params = [];

    if (uid) {
      params.push(uid);
      where.push(`a.uid = $${params.length}`);
    }
    if (from) {
      params.push(from);
      where.push(`a.ts >= $${params.length}::date`);
    }
    if (to) {
      // inclusive end-of-day: < (to + 1 day)
      params.push(to);
      where.push(`a.ts < ($${params.length}::date + interval '1 day')`);
    }
    if (passages.length) {
      params.push(passages);
      where.push(`a.passage_key = ANY($${params.length}::text[])`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // Optional label table (don't fail if it doesn't exist)
    const hasLabels =
      (
        await pool.query(
          "select to_regclass('public.lux_user_labels') as reg"
        )
      ).rows?.[0]?.reg !== null;

    params.push(limit);
    const limitPlaceholder = `$${params.length}`;

    const baseSelect = `
      SELECT
        a.id,
        a.uid,
        a.ts,
        a.passage_key,
        a.part_index,
        a.text,
        a.summary
        ${hasLabels ? ", l.label" : ""}
      FROM public.lux_attempts a
      ${hasLabels ? "LEFT JOIN public.lux_user_labels l ON l.uid = a.uid" : ""}
      ${whereSql}
      ORDER BY a.ts DESC
      LIMIT ${limitPlaceholder}
    `;

    const { rows } = await pool.query(baseSelect, params);

    // ---- CSV or JSON ------------------------------------------------------
    if (String(req.query.format).toLowerCase() === "csv") {
      // Shape: id,uid,label,ts,passage_key,part_index,text,acc,flu,comp,pron
      const header =
        "id,uid,label,ts,passage_key,part_index,text,acc,flu,comp,pron\n";

      const body = rows
        .map((r) => {
          const s = r.summary || {};
          const line = [
            csvEscape(r.id),
            csvEscape(r.uid),
            csvEscape(r.label || ""),
            csvEscape(r.ts instanceof Date ? r.ts.toISOString() : r.ts),
            csvEscape(r.passage_key),
            csvEscape(r.part_index),
            csvEscape(r.text),
            csvEscape(s.acc),
            csvEscape(s.flu),
            csvEscape(s.comp),
            csvEscape(s.pron),
          ].join(",");
          return line;
        })
        .join("\n");

      // UTF-8 BOM to make Excel happy
      const csv = "\uFEFF" + header + body;

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=\"lux_attempts.csv\""
      );
      res.status(200).send(csv);
      return;
    }

    // JSON (default)
    res.status(200).json({ rows });
  } catch (err) {
    console.error("admin-recent error:", err);
    bad(res, 500, "server_error");
  }
}
