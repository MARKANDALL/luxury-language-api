-- migrations/0008_speech_session_analyses.sql
-- One row per Session Analyst PASS that actually landed. Two jobs:
--   1. captured_via — how the analysis was triggered. The admin's only way to
--      see whether interruption-resilient capture is really working.
--   2. server-side idempotency — the safety property that lets a session be
--      analyzed more than once without double-counting the learner.
--
-- WHY THIS EXISTS AT ALL. Until now the analyst fired only on an explicit End
-- Session (guided) or Save (streaming). Roughly 95% of real sessions end by
-- walking away, so most speech was never analyzed. Exit hooks (pagehide,
-- visibilitychange->hidden) and a scenario-switch hook now fire the same
-- analysis, which means the SAME session can be submitted several times: once
-- on exit, again when the learner comes back and ends properly.
--
-- THE SUPERSEDE RULE. A later pass replaces an earlier one only if it carries
-- STRICTLY MORE turns; otherwise it is a no-op that replays the stored report.
-- turn_count is the whole rule, so it is not null and is the only thing the
-- conditional update compares. A no-op pass costs no LLM call and writes no
-- speech_events rows, and the caller still gets its report back from `report`
-- so the end-of-session UI renders exactly as it did before.
--
-- THE KEY IS COMPOSITE, AND EVERY PART OF IT EARNS ITS PLACE. Keying on
-- session_id alone would be wrong: the guided client mints one session id per
-- PAGE LOAD (features/convo/convo-state.js) and never re-mints it, while
-- startScenario() clears the transcript per conversation. Two conversations in
-- one page load therefore share a session id with turn indices both restarting
-- at 1.
--
-- surface separates the guided, streaming and practice machines.
--
-- scenario_key separates two DIFFERENT scenarios in one page load.
--
-- conversation_key separates two runs of the SAME scenario in one page load,
-- which scenario_key cannot: talk the cafe scenario, end it, then talk it again,
-- and every other column matches. Without this part the supersede rule would
-- read the second conversation as a duplicate of the first and either discard it
-- (when it is shorter) or DELETE the first conversation's speech_events rows to
-- make way for it (when it is longer). The second outcome is data loss on the
-- ordinary End Session path, with no exit capture involved, which is why this
-- column is here rather than deferred.
--
-- coalesce(..., '') is required on both optional parts because Postgres treats
-- NULLs in a unique index as distinct, which would defeat dedupe on every row
-- that has no scenario (all streaming sessions started with no ?scenario=
-- param) or no conversation key (any client older than this change).
--
-- NO FOREIGN KEY to speech_events on purpose: a pass that produced zero flags
-- is a real, valuable pass (zero flags is a valid analyst outcome) and must
-- still occupy the key so a later equal-length pass is a no-op.
--
-- RLS mirrors speech_events (migration 0003): RLS ENABLED, no anon or
-- authenticated policy granted. The backend service role bypasses RLS and is
-- the only reader and writer. The browser can neither read nor write this table.
--
-- Idempotent: safe to run repeatedly (Supabase SQL editor).

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ========================= TABLE =========================
create table if not exists public.speech_session_analyses (
  id uuid primary key default gen_random_uuid(),
  uid text not null,
  session_id text not null,
  surface text not null,
  scenario_key text,
  -- Which RUN of that scenario. See the key argument above.
  conversation_key text,
  pack text not null,

  -- 'explicit' = End Session / Save. 'exit' = pagehide or visibilitychange.
  -- 'switch'   = the learner started a different scenario in the same page load.
  -- Text, not an enum: adding a fourth trigger later must not need a migration.
  captured_via text not null default 'explicit',

  -- The number of user turns the winning pass carried. The supersede comparison.
  turn_count int not null default 0,

  -- The payload was trimmed to the most recent N turns to stay under the
  -- fetch keepalive body cap (~64KB). The analysis is honest but partial.
  truncated boolean not null default false,

  -- What the pass concluded, and how many speech_events rows it wrote.
  evidence text,
  stored_events int not null default 0,

  -- The full report returned to the caller, replayed verbatim on a no-op pass
  -- so a deduped call renders the same UI instead of an empty section.
  report jsonb,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ========================= IDEMPOTENCY KEY =========================
-- The one index the dedupe depends on. coalesce() is load-bearing: see above.
create unique index if not exists uq_speech_session_analyses_key
  on public.speech_session_analyses (
    uid, session_id, surface, coalesce(scenario_key, ''), coalesce(conversation_key, '')
  );

-- "Is exit capture actually working, and how much is it recovering?"
create index if not exists idx_speech_session_analyses_via
  on public.speech_session_analyses (captured_via, created_at desc);

-- ========================= RLS =========================
alter table public.speech_session_analyses enable row level security;
