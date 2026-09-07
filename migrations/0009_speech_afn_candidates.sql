-- migrations/0009_speech_afn_candidates.sql
-- The Session Analyst's per-session "areas for next focus" nominations.
--
-- WHAT AFN IS. Areas For Next focus: at most three taxonomy category codes the
-- analyst nominates at the end of a session as the things worth working on
-- next. The acronym is spelled out in routes/learner-model.js:38.
--
-- WHAT THE CANDIDATES CONTAIN. Nothing but category codes. The route validates
-- each one against the active pack dictionary (lang/session-analyst/<pack>.js),
-- de-duplicates, and caps at three. They carry no utterance, no severity, no
-- turn index; they are the analyst's own ordering of what to focus on, and the
-- order is preserved here as `rank`.
--
-- WHY THEY WERE BEING THROWN AWAY. The route computed afnCandidates and
-- returned them in the response, and nothing ever stored them. The end-of-
-- session modal showed them once and they were gone. Meanwhile the Learner
-- Model re-derives its own AFN longitudinally from accumulated speech_events
-- (routes/learner-model.js), which is a different and much slower signal: it
-- can only ever see what the analyst chose to FLAG, never what the analyst
-- judged most worth working on next. Keeping both lets a later pass compare
-- "what the analyst said at the time" against "what the rows imply".
--
-- WHY A SEPARATE TABLE AND NOT A speech_events ROW. speech_events.channel
-- carries a CHECK constraint, migrations/0003_speech_events.sql:27:
--     channel text not null check (channel in ('grammar','word_choice','strength'))
-- so an additive row under a new channel value such as 'afn_candidate' would be
-- rejected outright. Relaxing that constraint would weaken the guarantee every
-- existing reader relies on (learner-model.js splits items from strengths purely
-- on channel), and a candidate is a poor fit for that table anyway: it has no
-- utterance, no severity, no turn, and no provenance. A small additive table
-- keeps speech_events exactly as strict as it is today.
--
-- SUPERSEDE. These rows are cleared and rewritten alongside speech_events when a
-- later analysis pass supersedes an earlier one for the same session, so a
-- session never accumulates two generations of nominations.
--
-- RLS mirrors speech_events: enabled, no anon or authenticated policy. Only the
-- backend service role reads or writes.
--
-- Idempotent: safe to run repeatedly (Supabase SQL editor).

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ========================= TABLE =========================
create table if not exists public.speech_afn_candidates (
  id uuid primary key default gen_random_uuid(),
  uid text not null,
  session_id text,
  surface text,
  scenario_key text,
  -- Which RUN of that scenario, matching speech_events. The supersede cleanup
  -- deletes from both tables by the same full key, so this column is not
  -- optional: without it the delete cannot target one conversation, and the
  -- insert names a column that does not exist and fails for the whole batch.
  conversation_key text,
  pack text not null,

  -- A taxonomy code from lang/session-analyst/<pack>.js, already whitelisted
  -- server-side. Text, not a foreign key: the taxonomy lives in code, not in a
  -- table, and a code retired from a pack must not orphan its history.
  category text not null,

  -- 1..3, the analyst's own ordering. Rank 1 is what it nominated first.
  rank int not null,

  created_at timestamptz default now()
);

-- Read patterns: this learner's nominations over time, and the supersede
-- cleanup, which deletes by the same key speech_events uses.
create index if not exists idx_speech_afn_uid_created
  on public.speech_afn_candidates (uid, pack, created_at desc);
create index if not exists idx_speech_afn_session
  on public.speech_afn_candidates (uid, session_id, surface, conversation_key);

-- ========================= RLS =========================
alter table public.speech_afn_candidates enable row level security;
