-- migrations/0005_keepsakes.sql
-- CONVO KEEPSAKES. The compressed set of illustrations from one conversation,
-- parked as PENDING while the session runs and flipped to SAVED only if the
-- learner taps Keep on the end-of-session report card.
--
-- The bytes live in Supabase Storage (private bucket "keepsakes"), keyed
-- <uid>/<conversation_id>/<idx>.webp. These tables hold only the metadata and
-- the pointer. Nothing here stores image data.
--
-- ⚠️ conversation_id IS NOT state.sessionId. DO NOT JOIN IT TO coach_log.session_id
-- OR speech_events.session_id. The frontend's state.sessionId is minted once per
-- PAGE LOAD and deliberately survives a new scenario (see
-- features/convo/celebrate-session.js, which documents the same trap), so keying
-- on it would merge every conversation the learner runs without reloading into a
-- single set, and one Keep would silently save all of them. This column holds an
-- id minted per CONVERSATION, at resetConvoImageState() in
-- features/convo-image/convo-image.js. The two ids are different granularities
-- and a join between them is always wrong.
--
-- WHY STATUS AND NOT A MOVE: promote must be instant and do no work, so an
-- object is written ONCE under its final key and never moves. Promoting is a
-- single UPDATE of keepsake_sets.status. The key is identical either way, so a
-- straggler image that finishes uploading after the learner has already tapped
-- Keep simply lands in a set that is already saved, and is kept.
--
-- WHY expires_at IS NULLABLE: it carries a value only while status = 'pending'.
-- Promoting clears it. routes/keepsake-cleanup.js deletes the storage objects
-- and the rows for any pending set whose expires_at has passed, so a session the
-- learner did not save costs nothing once the TTL is up.
--
-- Idempotent: safe to run repeatedly (Supabase SQL editor).
--
-- RLS mirrors the coach_log / speech_events pattern: RLS ENABLED, and the only
-- writer is the backend service role (routes/keepsake-*.js via the Supabase
-- service key), which bypasses RLS. No anon/authenticated policy is granted, so
-- the browser (anon key) can neither read nor write these tables directly.

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ========================= SETS =========================
-- One row per conversation that produced at least one image. Unique on
-- (uid, conversation_id) so the upload route can upsert without racing itself:
-- images arrive one at a time and any of them may be the first to create the set.
create table if not exists public.keepsake_sets (
  id uuid primary key default gen_random_uuid(),
  uid text not null,
  conversation_id text not null,

  -- Shown on the album card. Captured from the first image to arrive.
  scenario_id text,
  scenario_label text,

  -- 'pending' = built as the session ran, not yet kept, will be reaped.
  -- 'saved'   = the learner tapped Keep. Permanent until they delete it.
  status text not null default 'pending' check (status in ('pending','saved')),

  created_at timestamptz not null default now(),

  -- Set on insert, cleared on promote. Null on a saved set is the invariant the
  -- cleanup route relies on: it never has to reason about status and expiry
  -- together to decide what is safe to delete.
  expires_at timestamptz,
  saved_at timestamptz,

  constraint keepsake_sets_uid_conversation_key unique (uid, conversation_id)
);

-- The album read: this learner's saved sets, newest first.
create index if not exists idx_keepsake_sets_uid_status
  on public.keepsake_sets (uid, status, saved_at desc);
-- The reaper read: only ever scans pending rows that have actually expired.
create index if not exists idx_keepsake_sets_expiry
  on public.keepsake_sets (expires_at)
  where status = 'pending';

-- ========================= IMAGES =========================
-- One row per kept illustration. idx is the image's position in the
-- conversation, so the album and the gallery show them in the order they
-- happened rather than the order they finished compressing.
create table if not exists public.keepsake_images (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.keepsake_sets(id) on delete cascade,
  idx int not null,

  storage_path text not null,
  thumb_path text not null,

  width int,
  height int,
  bytes int,
  thumb_bytes int,

  -- caption: the learner-facing turn text this image was drawn for.
  -- description: the model's own scene description, already carried through the
  -- conversation on the image wrapper's dataset.
  caption text,
  description text,

  created_at timestamptz not null default now(),

  constraint keepsake_images_set_idx_key unique (set_id, idx)
);

create index if not exists idx_keepsake_images_set
  on public.keepsake_images (set_id, idx);

-- ========================= RLS =========================
alter table public.keepsake_sets enable row level security;
alter table public.keepsake_images enable row level security;

-- ========================= ROLLUP VIEW =========================
-- What the keepsakes actually cost, split by status. The pending row is the one
-- to watch: it should stay small and should never grow without bound, because
-- everything in it is either promoted or reaped within the TTL. A pending
-- total that climbs steadily means the cleanup cron is not running.
create or replace view public.keepsake_storage_rollups as
select s.status,
       count(distinct s.id) as sets,
       count(i.id) as images,
       coalesce(sum(i.bytes), 0) as full_bytes,
       coalesce(sum(i.thumb_bytes), 0) as thumb_bytes,
       coalesce(sum(i.bytes), 0) + coalesce(sum(i.thumb_bytes), 0) as total_bytes,
       min(s.created_at) as first_seen,
       max(s.created_at) as last_seen
from public.keepsake_sets s
left join public.keepsake_images i on i.set_id = s.id
group by s.status;
