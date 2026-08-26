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
// THE KEY is (uid, session_id, surface, scenario_key, conversation_key). Not
// session_id alone: the guided client mints one session id per PAGE LOAD and
// reuses it across every conversation in that load. scenario_key separates two
// DIFFERENT scenarios; conversation_key separates two runs of the SAME one,
// which nothing else can. Both are needed, and the second is what stops a
// superseding pass deleting a previous conversation's rows. See migrations/0008.
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

// How long a claim with no report must sit untouched before another pass may
// take it over. Comfortably longer than any serverless invocation can live, so
// the takeover can never reach a pass that is merely slow.
export const STALE_CLAIM_MS = 5 * 60 * 1000;

export function normalizeCapturedVia(v) {
  const s = String(v || "").trim().toLowerCase();
  return CAPTURED_VIA_VALUES.has(s) ? s : "explicit";
}

// Apply the composite key to a PostgREST query builder. scenario_key needs
// .is() rather than .eq() when null — PostgREST renders eq.null as the literal
// string "null" and would match nothing.
function applyKey(q, key) {
  let out = q.eq("uid", key.uid).eq("session_id", key.sessionId).eq("surface", key.surface);
  out = key.scenarioKey == null ? out.is("scenario_key", null) : out.eq("scenario_key", key.scenarioKey);
  return key.conversationKey == null
    ? out.is("conversation_key", null)
    : out.eq("conversation_key", key.conversationKey);
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
      sb.from(TABLE).select("id, turn_count, captured_via, evidence, stored_events, report, updated_at"),
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
 * Atomic in Postgres on every branch. The INSERT is guarded by the unique index;
 * the supersede UPDATE carries its own `turn_count <` predicate; and the takeover
 * UPDATE is pinned to one row id, re-checks `report is null` under the write, and
 * reports a win only when a row actually comes back. No two concurrent passes can
 * both win by any route.
 *
 * @returns {{ won: boolean, existing: object|null }}
 *   won:true  -> caller owns the pass and should write speech_events rows
 *   won:false -> a pass with >= turns already holds the key; `existing` carries
 *                its stored report so the caller can replay it
 *
 * @param {boolean} hadPrior  - readPass found a record a moment ago
 * @param {boolean} deadClaim - that record has no report, so it MAY be an
 *                              abandoned claim; the takeover re-checks under the
 *                              write and only fires on one that has gone stale
 * @param {string}  priorId   - that record's id, so the takeover targets it
 *                              specifically rather than whatever holds the key
 */
export async function commitPass(sb, key, fields, hadPrior, deadClaim = false, priorId = null) {
  if (!sb || !key?.sessionId) return { won: true, existing: null };

  const row = {
    uid: key.uid,
    session_id: key.sessionId,
    surface: key.surface,
    scenario_key: key.scenarioKey,
    conversation_key: key.conversationKey,
    ...fields,
  };

  try {
    // A prior record whose `report` is null MAY be a pass that claimed the key
    // and then died before finishing (function timeout, cold-start kill), which
    // would otherwise lock this session out of analysis forever: an equal-length
    // retry loses the `.lt("turn_count", ...)` comparison every time.
    //
    // But a null report is ALSO what a pass that is still running looks like,
    // because the claim is deliberately written before the rows are. So the
    // takeover is narrow on purpose, and every part of the predicate is
    // load-bearing:
    //   .eq("id")        - take over THAT record, not whatever now holds the key
    //   .is("report")    - re-check under the write; it may have finished since
    //   .lt("updated_at")- only a claim untouched for longer than any function
    //                      can live, so a pass still in flight is never clobbered
    //   .lte("turn_count")- never let a shorter pass overwrite a longer claim
    //   .select("id")    - won ONLY if a row actually came back, so two racing
    //                      takeovers cannot both believe they won
    if (deadClaim && priorId) {
      const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
      const { data, error } = await sb
        .from(TABLE)
        .update({ ...row, updated_at: new Date().toISOString() })
        .eq("id", priorId)
        .is("report", null)
        .lt("updated_at", staleBefore)
        .lte("turn_count", fields.turn_count)
        .select("id");
      if (error) {
        console.warn("[session-analysis-store] takeover skipped", error?.message || error);
        return { won: false, existing: await readPass(sb, key) };
      }
      if (Array.isArray(data) && data.length) return { won: true, existing: null };
      // The claim was not ours to take: still fresh, already finished, or longer.
      return { won: false, existing: await readPass(sb, key) };
    }

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
 *
 * @param {number} turnCount - this pass's turn count, used as the ownership guard
 */
export async function finalizePass(sb, key, fields, turnCount) {
  if (!sb || !key?.sessionId) return;
  try {
    // OWNERSHIP GUARD. Between the claim and this write, a longer pass may have
    // superseded us. Without matching on turn_count, this older pass would stamp
    // its own smaller report over the winner's. Only the row still carrying OUR
    // turn_count is ours to finalize.
    const { error } = await applyKey(
      sb.from(TABLE).update({ ...fields, updated_at: new Date().toISOString() }),
      key
    ).eq("turn_count", turnCount);
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
