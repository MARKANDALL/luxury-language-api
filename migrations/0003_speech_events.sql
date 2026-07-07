-- migrations/0003_speech_events.sql
-- Session Analyst (Speech Intelligence Phase 0+1) — structured store for the
-- non-pronunciation feedback instrument. One row per surfaced event:
-- grammar/word_choice flags AND strengths (channel='strength', severity='positive').
--
-- Idempotent: safe to run repeatedly (Supabase SQL editor).
--
-- RLS mirrors the existing word_taps / word_cards pattern: RLS ENABLED, and the
-- only writer is the backend service role (routes/session-analyst.js via the
-- Supabase service key), which bypasses RLS. No anon/authenticated policy is
-- granted, so the browser (anon key) can neither read nor write this table —
-- identical posture to word_taps. NOTE: word_taps' policies were created
-- out-of-band in Supabase (not in an earlier migration), so this reproduces the
-- described pattern rather than copying a checked-in policy verbatim; adjust if
-- word_taps grants differ. (See backend PR Disclosures.)

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ========================= TABLE =========================
create table if not exists public.speech_events (
  id uuid primary key default gen_random_uuid(),
  uid text not null,
  session_id text,
  surface text,
  turn_index int,
  pack text not null,
  channel text not null check (channel in ('grammar','word_choice','strength')),
  category text,
  severity text check (severity in ('blocked','noticeable','polish','positive')),
  utterance text,
  suggestion text,
  explanation text,
  asr_confidence numeric,
  provenance text,
  created_at timestamptz default now()
);

-- Read patterns: per-user history, and the rollup view's group-by.
create index if not exists idx_speech_events_uid_created
  on public.speech_events (uid, created_at desc);
create index if not exists idx_speech_events_rollup
  on public.speech_events (uid, pack, channel, category);

-- ========================= RLS =========================
-- Mirror word_taps: enable RLS, grant no anon/authenticated policy. The service
-- role bypasses RLS, so only the backend can write/read.
alter table public.speech_events enable row level security;

-- ========================= ROLLUP VIEW =========================
-- Errors only (strengths excluded), counted per user/pack/channel/category with
-- first/last seen — the substrate for a future Learner Model. Strengths are
-- stored (channel='strength', severity='positive') but never rolled up here.
create or replace view public.speech_event_rollups as
select uid, pack, channel, category,
       count(*) as n,
       min(created_at) as first_seen,
       max(created_at) as last_seen
from public.speech_events
where channel != 'strength'
group by uid, pack, channel, category;
