// lib/session-analysis-store.js
// One-line: server-side idempotency for the Session Analyst — decides whether a
// given analysis pass should run, supersede an earlier one, or be a no-op.
//
// WHY THIS IS SERVER-SIDE. The client latch that would otherwise do this job
// dies with the tab, which is precisely the moment exit capture fires. A pass
// sent from a `pagehide` handler and a pass sent minutes later from an explicit
// End Session are two separate page lifetimes; only the server sees both.
//
// THE RULE, in one sentence: a later pass supersedes an earlier one only if it
// carries STRICTLY MORE turns; otherwise it is a no-op that replays the stored
// report. Equal counts lose, so a re-opened report card cannot re-analyze.
//
// THE KEY is (uid, session_id, surface, coalesce(scenario_key, '')). Not
// session_id alone: the guided client mints one session id per PAGE LOAD and
// reuses it across scenario switches, so a bare session_id key would silently
// discard a second, shorter scenario. See migrations/0008 for the full argument.
//
// DEGRADATION IS THE POINT. Migrations in this repo are pasted into the Supabase
// SQL editor by hand, so between a deploy and that paste the table does not
// exist. Every function here swallows its error and returns the value that makes
// the caller behave EXACTLY as it did before this file existed: no prior pass
// found, and the commit "won". Idempotency is a safety net, never a gate.

export const TABLE = "speech_session_analyses";

// How an analysis pass was triggered. Unknown values coerce to 'explicit',
// which is what every pre-existing caller effectively is.
export const CAPTURED_VIA_VALUES = new Set(["explicit", "exit", "switch"]);

export function normalizeCapturedVia(v) {
  const s = String(v || "").trim().toLowerCase();
  return CAPTURED_VIA_VALUES.has(s) ? s : "explicit";
}

// Apply the composite key to a PostgREST query builder. scenario_key needs
// .is() rather than .eq() when null — PostgREST renders eq.null as the literal
// string "null" and would match nothing.
function applyKey(q, key) {
  const out = q.eq("uid", key.uid).eq("session_id", key.sessionId).eq("surface", key.surface);
  return key.scenarioKey == null
    ? out.is("scenario_key", null)
    : out.eq("scenario_key", key.scenarioKey);
}

/**
 * The pass already recorded under this key, or null.
 * Returns null on ANY failure (missing table, missing env, network) so the
 * caller proceeds exactly as it would have without dedupe.
 */
export async function readPass(sb, key) {
  if (!sb || !key?.sessionId) return null;
  try {
    const { data, error } = await applyKey(
      sb.from(TABLE).select("id, turn_count, captured_via, evidence, stored_events, report"),
      key
    ).limit(1);
    if (error) {
      console.warn("[session-analysis-store] read skipped", error?.message || error);
      return null;
    }
    return Array.isArray(data) && data.length ? data[0] : null;
  } catch (e) {
    console.warn("[session-analysis-store] read skipped", e?.message || e);
    return null;
  }
}

/**
 * Claim this key for a pass carrying `fields.turn_count` turns.
 *
 * Atomic in Postgres either way: the INSERT is guarded by the unique index, and
 * the UPDATE carries its own `turn_count <` predicate, so two concurrent passes
 * cannot both win.
 *
 * @returns {{ won: boolean, existing: object|null }}
 *   won:true  -> caller owns the pass and should write speech_events rows
 *   won:false -> a pass with >= turns already holds the key; `existing` carries
 *                its stored report so the caller can replay it
 */
export async function commitPass(sb, key, fields, hadPrior) {
  if (!sb || !key?.sessionId) return { won: true, existing: null };

  const row = {
    uid: key.uid,
    session_id: key.sessionId,
    surface: key.surface,
    scenario_key: key.scenarioKey,
    ...fields,
  };

  try {
    // No prior pass seen a moment ago: try to take the key outright.
    if (!hadPrior) {
      const { error } = await sb.from(TABLE).insert(row);
      if (!error) return { won: true, existing: null };
      // 23505 = unique violation. Someone claimed it between our read and now,
      // so fall through to the conditional update. Any OTHER error means the
      // table is unusable (not yet migrated, no permission): behave as before.
      if (error.code !== "23505") {
        console.warn("[session-analysis-store] claim skipped", error?.message || error);
        return { won: true, existing: null };
      }
    }

    // Supersede ONLY on strictly more turns. A row is returned iff we won.
    const { data, error } = await applyKey(
      sb.from(TABLE).update({ ...row, updated_at: new Date().toISOString() }),
      key
    )
      .lt("turn_count", fields.turn_count)
      .select("id");

    if (error) {
      console.warn("[session-analysis-store] supersede skipped", error?.message || error);
      return { won: true, existing: null };
    }
    if (Array.isArray(data) && data.length) return { won: true, existing: null };

    // Lost: an equal-or-longer pass holds the key. Hand back its report.
    return { won: false, existing: await readPass(sb, key) };
  } catch (e) {
    console.warn("[session-analysis-store] commit skipped", e?.message || e);
    return { won: true, existing: null };
  }
}

/**
 * Fill in a claimed pass's outcome once its rows have landed.
 *
 * The claim in commitPass() has to happen BEFORE the speech_events insert (so a
 * losing pass never writes rows), but the report body is only complete AFTER it
 * (meta.stored is the real row count). This second write closes that gap. A
 * failure leaves report null, which the reader deliberately treats as "no usable
 * prior pass" and re-analyzes rather than replaying an empty section.
 */
export async function finalizePass(sb, key, fields) {
  if (!sb || !key?.sessionId) return;
  try {
    const { error } = await applyKey(
      sb.from(TABLE).update({ ...fields, updated_at: new Date().toISOString() }),
      key
    );
    if (error) console.warn("[session-analysis-store] finalize skipped", error?.message || error);
  } catch (e) {
    console.warn("[session-analysis-store] finalize skipped", e?.message || e);
  }
}

// Everything an earlier pass may have written for a session. Both are cleared
// together so a superseded session never leaves half a generation behind.
const SUPERSEDED_TABLES = ["speech_events", "speech_afn_candidates"];

/**
 * Remove the rows an earlier, shorter pass wrote for this key.
 * Called only when a superseding pass has WON, so the learner is never counted
 * twice for the same session. A failure here is logged and ignored: writing the
 * new rows still leaves the portrait strictly more correct than dropping them.
 */
export async function clearSupersededEvents(sb, key) {
  if (!sb || !key?.sessionId) return;
  for (const table of SUPERSEDED_TABLES) {
    try {
      const { error } = await applyKey(sb.from(table).delete(), key);
      if (error) {
        console.warn("[session-analysis-store] supersede cleanup skipped", table, error?.message || error);
      }
    } catch (e) {
      console.warn("[session-analysis-store] supersede cleanup skipped", table, e?.message || e);
    }
  }
}
