-- migrations/0005_image_targets.sql
-- The I Spy / Veo veo target set for one conversation image, per pack.
--
-- routes/convo-image-targets.js asks a vision model, ONCE per image, which
-- things in it are worth naming and where they are. That answer is a property of
-- the image: it does not change, it costs a vision call to produce, and the game
-- is meant to be re-openable. So it is cached here, and a reopened game reads
-- this table instead of the model.
--
-- Keyed (image_key, lang): the same picture played in the en pack and the es
-- pack is two different rounds — different labels, different cloze sentences,
-- different distractors — so each pack gets its own row.
--
-- Idempotent: safe to run repeatedly (Supabase SQL editor).
--
-- RLS mirrors the word_taps / speech_events / coach_log pattern: RLS ENABLED,
-- and the only reader/writer is the backend service role (the route, via the
-- Supabase service key), which bypasses RLS. No anon/authenticated policy is
-- granted, so the browser (anon key) can neither read nor write this table.

-- ========================= TABLE =========================
-- Column names are the upsert payload in routes/convo-image-targets.js,
-- verbatim. Adding a field to that upsert without adding it here makes PostgREST
-- reject the whole row and silently drop the cache write.
create table if not exists public.image_targets (
  -- Caller-supplied stable id for the image, or sha256(imageUrl) truncated to
  -- 32 hex chars when the caller has none. Conversation images are data: URIs
  -- that live only in the browser, so there is no image row to point at — the
  -- content hash IS the identity, the same way word_cards keys on a
  -- sentence_hash rather than a sentence row.
  image_key text not null,

  -- Active pack: 'en' | 'es'.
  lang text not null,

  -- Target-shape version. The route treats a row whose v does not match its
  -- current TARGETS_V as a cache MISS and overwrites it in place, so reshaping
  -- the payload never needs a migration (same trick as word_cards' card.v).
  v integer not null default 1,

  -- [{ label, point:{x,y}, cloze, choices[], answerIndex, difficulty }, ...]
  -- Already validated by the route: points inside [0,1], a real ___ blank, the
  -- answer present in choices, no duplicate labels.
  targets jsonb not null,

  -- Which model produced this set. Kept so a bad batch can be attributed and
  -- invalidated by model rather than wholesale.
  model text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (image_key, lang)
);

-- Housekeeping read: "what has the game cached lately", and the handle for
-- expiring old rows if this table ever needs pruning.
create index if not exists idx_image_targets_updated
  on public.image_targets (updated_at desc);

-- ========================= RLS =========================
alter table public.image_targets enable row level security;
