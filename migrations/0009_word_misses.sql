-- 0009_word_misses.sql
--
-- The words that got away.
--
-- I Spy reveals a word when three guesses run out. Until now that was the end
-- of it: the word was shown, flown to My Words if the learner asked, and
-- forgotten by the system. A vocabulary game that never remembers what beat you
-- can only ever be a series of unrelated rounds.
--
-- A NEW table rather than a column on something else, and the alternatives were
-- weighed rather than assumed:
--   speech_events is the closest shape, but its channel/severity CHECKs and its
--     rollup view feed the existing grammar and word-choice portrait; vocabulary
--     misses written there would corrupt a model already in use.
--   my_words_entries is the SAVED set, written from the browser under an auth
--     uid. A miss is by definition not saved.
--   image_targets has no uid at all.
--
-- Shape follows 0003_speech_events and 0004_coach_log exactly: uuid PK, uid
-- text, CHECK-enum text columns, created_at, a (uid, created_at desc) index,
-- RLS enabled with NO policy so only the service role can reach it, and a
-- rollup view as the substrate a longitudinal learner model will query.
--
-- THE UID IS UNVERIFIED. It is the client-supplied device uid, self-asserted
-- and gated only by the shared ADMIN_TOKEN, exactly as speech_events and
-- coach_log already are. That problem stays parked where it already lives; this
-- table does not make it worse and must not be read as having solved it.

create extension if not exists pgcrypto;

create table if not exists public.word_misses (
  id               uuid primary key default gen_random_uuid(),
  uid              text not null,
  -- The displayable form, with its article: the article is half the word in
  -- Spanish, so "la taza" has to survive to be shown back.
  label            text not null,
  -- The article-stripped, accent-folded form. This is what the learner model
  -- groups by, and the only way a miss can ever be matched against a saved
  -- word, or against the same word missed in another picture. Without it
  -- "la taza", "taza" and "Taza" are three unrelated misses.
  normalized_label text not null,
  lang             text not null,
  -- '' means no band was asked for, matching 0007's convention on image_targets.
  -- Makes "he misses B2 nouns but never A2" answerable, which is the most
  -- valuable longitudinal question this table can answer.
  level            text not null default '',
  -- Joins back to image_targets, so the cloze, boxes, aliases and distractors
  -- are all recoverable without duplicating them here.
  image_key        text,
  -- One column now stops this becoming an I Spy-only table when the next
  -- surface wants to log a miss.
  surface          text not null default 'ispy',
  -- "Nearly had it" and "no idea" are different learner states and collapsing
  -- them throws away the distinction a model most needs.
  verdict          text not null check (verdict in ('revealed', 'close')),
  -- A timestamp, not a boolean: it answers both "is this still open" (is null)
  -- and "how long did it take to learn" (cleared_at - created_at). A boolean
  -- throws the second away.
  cleared_at       timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists idx_word_misses_uid_created
  on public.word_misses (uid, created_at desc);

-- Serves the two hot reads: what does this learner still owe, and the lookup
-- the clearing path performs when the word is finally got right. Partial, so it
-- stays small as the table grows.
create index if not exists idx_word_misses_open
  on public.word_misses (uid, lang, normalized_label)
  where cleared_at is null;

alter table public.word_misses enable row level security;

create or replace view public.word_miss_rollups as
select
  uid,
  lang,
  level,
  normalized_label,
  max(label)                                     as label,
  count(*)                                       as n,
  count(*) filter (where cleared_at is null)     as n_open,
  min(created_at)                                as first_seen,
  max(created_at)                                as last_seen,
  max(cleared_at)                                as last_cleared
from public.word_misses
group by uid, lang, level, normalized_label;
