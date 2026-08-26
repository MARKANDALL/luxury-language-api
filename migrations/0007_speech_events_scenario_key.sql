-- migrations/0007_speech_events_scenario_key.sql
-- The scenario a speech event came from, carried on each row.
--
-- WHY A NEW COLUMN AND NOT `surface`. speech_events.surface answers "which
-- machine produced this" and today holds exactly two values, 'guided' and
-- 'streaming' (routes/session-analyst.js:113 defaults it; there is no CHECK
-- constraint on the column). Overloading it with scenario identity would make
-- every existing row's surface value ambiguous and would break the one thing
-- the column is currently good for. scenario_key is a second, orthogonal axis:
-- WHICH conversation, independent of which engine ran it.
--
-- WHAT GOES IN IT. The scenario's STABLE id, never its display title. The ids
-- are pack-invariant ('quick-practice', 'coffee', 'doctor', 'job-interview'),
-- while `title` is pack-localized ("Pedir un cafe" vs "Ordering Coffee"), so a
-- title-keyed column could not group the same scenario across two packs.
-- Guided reads it from SCENARIOS[state.scenarioIdx].id; streaming reads the
-- same id from its parsed route (features/streaming/router.js:51).
--
-- WHAT IT UNLOCKS. Per-scenario aggregation: "freezes in the job interview,
-- fluent in the cafe". Today every event for a learner is pooled into one
-- portrait, so a pattern that only appears under pressure is averaged away
-- against relaxed practice.
--
-- NULLABLE ON PURPOSE, AND NOT BACKFILLABLE. Every row written before this
-- column existed has no scenario and never will: the analyst payload never
-- carried one, and nothing else in the schema records which conversation a
-- speech_events row belongs to. session_id cannot recover it either, because
-- the guided client mints one session id per PAGE LOAD and reuses it across
-- scenario switches. Readers must treat null as "unknown scenario", never as
-- an error and never as a distinct scenario bucket.
--
-- Idempotent: safe to run repeatedly (Supabase SQL editor).

alter table public.speech_events
  add column if not exists scenario_key text,
  add column if not exists conversation_key text;

-- conversation_key: WHICH RUN of that scenario, not which scenario.
--
-- These are two different questions and the second one has no answer without
-- this column. The guided client mints session_id once per PAGE LOAD and never
-- re-mints it, while startScenario() clears the transcript for each new
-- conversation. Talk the cafe scenario, end it, then talk the cafe scenario
-- again in the same page load, and both conversations share uid, session_id,
-- surface AND scenario_key. Without a per-run value they are indistinguishable,
-- and the analyst's supersede rule would treat the second conversation as a
-- duplicate of the first: either discarding it, or deleting the first
-- conversation's rows to make way for it. That second case is data loss, which
-- is why this column exists rather than being deferred.
--
-- Minted per conversation by the client and otherwise opaque. Nullable and not
-- backfillable for exactly the same reason scenario_key is not.

-- Answering "show me this learner's patterns in THIS scenario" without a full
-- per-uid scan. Partial, because rows without a scenario are never looked up
-- by it and there will always be a large historical block of them.
create index if not exists idx_speech_events_scenario
  on public.speech_events (uid, pack, scenario_key)
  where scenario_key is not null;

-- Supporting the supersede cleanup, which deletes one conversation's rows by
-- the full analyst key. Without this the delete is a per-uid scan.
create index if not exists idx_speech_events_conversation
  on public.speech_events (uid, session_id, surface, conversation_key)
  where conversation_key is not null;
