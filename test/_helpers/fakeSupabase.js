// test/_helpers/fakeSupabase.js
// A small in-memory stand-in for the PostgREST query builder, enough for the
// Session Analyst's idempotency path. Deliberately NOT a set of stubs: it
// stores real rows and enforces a real unique constraint, so a test that
// exercises dedupe exercises the actual supersede arithmetic rather than a
// canned answer.
//
// Supports the exact shapes routes/session-analyst.js and
// lib/session-analysis-store.js build:
//   from(t).select(cols).eq().is().limit(n)
//   from(t).insert(rowOrRows)
//   from(t).update(patch).eq().is().lt().lte().select(cols)   // .select() optional
//   from(t).delete().eq().is()
//
// Unknown columns on insert are REJECTED with PGRST204, like the real thing.
//
// Unique constraints are declared per table as a list of column names; a null
// participates as '' so it matches the coalesce() in migration 0008.

function keyOf(row, cols) {
  return cols.map((c) => (row[c] == null ? "" : String(row[c]))).join(" ");
}

// The real column list of every table this project writes, transcribed from the
// migrations. PostgREST rejects an insert naming a column that does not exist,
// for the WHOLE batch, so a fake that silently accepts anything will pass a test
// that production cannot run. That is not hypothetical: it let a route write
// conversation_key into speech_afn_candidates for a whole commit before the
// column existed, with every test green.
export const LUX_COLUMNS = {
  // migrations/0003 + 0007
  speech_events: [
    "id", "uid", "session_id", "surface", "scenario_key", "conversation_key",
    "turn_index", "pack", "channel", "category", "severity", "utterance",
    "suggestion", "explanation", "asr_confidence", "provenance", "created_at",
  ],
  // migrations/0008
  speech_session_analyses: [
    "id", "uid", "session_id", "surface", "scenario_key", "conversation_key",
    "pack", "captured_via", "turn_count", "truncated", "evidence",
    "stored_events", "report", "created_at", "updated_at",
  ],
  // migrations/0009
  speech_afn_candidates: [
    "id", "uid", "session_id", "surface", "scenario_key", "conversation_key",
    "pack", "category", "rank", "created_at",
  ],
};

export function makeFakeSupabase({
  unique = {},
  failTables = new Set(),
  columns = LUX_COLUMNS,
} = {}) {
  /** @type {Record<string, object[]>} */
  const tables = Object.create(null);
  const rowsOf = (t) => {
    if (!tables[t]) tables[t] = [];
    return tables[t];
  };

  function query(table, op, payload) {
    const preds = [];
    let selectAfter = false;
    let limitN = Infinity;

    const match = (r) => preds.every((p) => p(r));

    function run() {
      if (failTables.has(table)) {
        return {
          data: null,
          error: { code: "42P01", message: 'relation "' + table + '" does not exist' },
        };
      }
      const rows = rowsOf(table);

      if (op === "select") {
        return { data: rows.filter(match).slice(0, limitN).map((r) => ({ ...r })), error: null };
      }

      if (op === "insert") {
        const incoming = Array.isArray(payload) ? payload : [payload];

        // Reject unknown columns exactly as PostgREST does: one bad name fails
        // the whole batch, so the route sees stored: 0 rather than a partial write.
        const known = columns?.[table];
        if (known) {
          const allowed = new Set(known);
          for (const r of incoming) {
            const bad = Object.keys(r).find((k) => !allowed.has(k));
            if (bad) {
              return {
                data: null,
                error: {
                  code: "PGRST204",
                  message: `Could not find the '${bad}' column of '${table}' in the schema cache`,
                },
              };
            }
          }
        }

        const cols = unique[table];
        if (cols) {
          const existing = new Set(rows.map((r) => keyOf(r, cols)));
          for (const r of incoming) {
            if (existing.has(keyOf(r, cols))) {
              return {
                data: null,
                error: { code: "23505", message: "duplicate key value violates unique constraint" },
              };
            }
          }
        }
        for (const r of incoming) rows.push({ ...r });
        return { data: incoming.map((r) => ({ ...r })), error: null };
      }

      if (op === "update") {
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, payload);
        return { data: selectAfter ? hit.map((r) => ({ ...r })) : null, error: null };
      }

      if (op === "delete") {
        const kept = rows.filter((r) => !match(r));
        const removed = rows.length - kept.length;
        tables[table] = kept;
        return { data: null, error: null, count: removed };
      }

      return { data: null, error: null };
    }

    const q = {
      eq(col, val) {
        preds.push((r) => r[col] === val);
        return q;
      },
      is(col, val) {
        preds.push((r) => (r[col] ?? null) === val);
        return q;
      },
      lt(col, val) {
        // Numbers compare numerically; anything else (timestamps) lexically,
        // which is how Postgres orders ISO-8601 too.
        preds.push((r) =>
          typeof val === "number" ? Number(r[col]) < Number(val) : String(r[col] ?? "") < String(val)
        );
        return q;
      },
      lte(col, val) {
        preds.push((r) =>
          typeof val === "number" ? Number(r[col]) <= Number(val) : String(r[col] ?? "") <= String(val)
        );
        return q;
      },
      limit(n) {
        limitN = n;
        return q;
      },
      select() {
        selectAfter = true;
        return q;
      },
      then(onOk, onErr) {
        return Promise.resolve().then(run).then(onOk, onErr);
      },
    };
    return q;
  }

  return {
    // Inspect what actually landed.
    _tables: tables,
    rows: (t) => rowsOf(t).map((r) => ({ ...r })),
    seed(t, seedRows) {
      rowsOf(t).push(...seedRows.map((r) => ({ ...r })));
      return this;
    },
    from(table) {
      return {
        select: (cols) => query(table, "select", cols),
        insert: (payload) => query(table, "insert", payload),
        update: (patch) => query(table, "update", patch),
        delete: () => query(table, "delete", null),
      };
    },
  };
}

// The constraint set this project actually has.
export const LUX_UNIQUE = {
  speech_session_analyses: [
    "uid",
    "session_id",
    "surface",
    "scenario_key",
    "conversation_key",
  ],
};
