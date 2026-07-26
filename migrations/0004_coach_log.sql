-- migrations/0004_coach_log.sql
-- THE COACH ROUTER's log (Coach Program v1.0). One row per classification made
-- by the pre-pass in routes/coach-page.js — written for EVERY message, including
-- the OFF_SCOPE ones that short-circuit before the expensive call.
--
-- This log is how we later learn which chips earn clicks and which lanes
-- actually fire. It is also the substrate for protection layer 4 (usage limits:
-- after N OFF_SCOPE hits in one session, skip classification and return the
-- plain redirect directly) whenever we decide to build it.
--
-- Idempotent: safe to run repeatedly (Supabase SQL editor).
--
-- RLS mirrors the word_taps / speech_events pattern: RLS ENABLED, and the only
-- writer is the backend service role (routes/coach-page.js via the Supabase
-- service key), which bypasses RLS. No anon/authenticated policy is granted, so
-- the browser (anon key) can neither read nor write this table.

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ========================= TABLE =========================
-- Column names are the insert payload in routes/coach-page.js, verbatim. Adding
-- a field to that insert without adding it here makes PostgREST reject the whole
-- row and silently drop the classification.
create table if not exists public.coach_log (
  id uuid primary key default gen_random_uuid(),
  uid text,
  session_id text,
  page_id text,
  anchor_type text,

  -- lane: the EFFECTIVE lane the main call ran in (after demotion / the
  -- confidence floor). raw_lane: what the classifier actually said, kept so a
  -- drift between the two is visible rather than invisible.
  lane text not null,
  raw_lane text,
  in_scope boolean not null default true,
  confidence numeric,

  -- advisory: confidence was under 0.5, so the lane was treated as advisory and
  -- the main call proceeded as LANGUAGE_GENERAL. Low confidence is not a refusal.
  advisory boolean not null default false,

  route_target text,
  route_question text,

  message text,
  lang text,

  -- 'conversion' (the Law 6 first-ask offer) | 'plain' | null when in scope.
  off_scope_reply text check (off_scope_reply in ('conversion','plain')),

  created_at timestamptz default now()
);

-- Read patterns: one learner's coach history, and the lane/page rollup below.
create index if not exists idx_coach_log_uid_created
  on public.coach_log (uid, created_at desc);
create index if not exists idx_coach_log_lane_page
  on public.coach_log (lane, page_id);
-- Protection layer 4 will count OFF_SCOPE hits within a single session.
create index if not exists idx_coach_log_session_created
  on public.coach_log (session_id, created_at desc);

-- ========================= RLS =========================
alter table public.coach_log enable row level security;

-- ========================= ROLLUP VIEW =========================
-- Which lanes actually fire, and from where. The advisory count shows how often
-- the classifier was unsure enough that the lane was ignored — the number to
-- watch if the router ever needs retuning.
create or replace view public.coach_log_lane_rollups as
select page_id, lane,
       count(*) as n,
       count(*) filter (where advisory) as n_advisory,
       count(*) filter (where not in_scope) as n_off_scope,
       avg(confidence) as avg_confidence,
       min(created_at) as first_seen,
       max(created_at) as last_seen
from public.coach_log
group by page_id, lane;
