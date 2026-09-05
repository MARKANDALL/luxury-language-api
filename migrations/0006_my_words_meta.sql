-- migrations/0006_my_words_meta.sql
-- A nullable provenance bag on a saved word: where it came from, and anything
-- the surface that saved it wants to remember.
--
-- My Words is filling up from more and more places. A word tapped in a
-- conversation, a word earned in the I Spy round, and soon a word kept from a
-- keepsake or picked out of an image all arrive through the same save path and
-- land as the same bare row: text, and nothing about how it got there. That
-- makes "where did I learn this" unanswerable, and it makes a game score
-- homeless.
--
-- Deliberately ONE generic column rather than a set of feature columns. I Spy
-- wants a score and a picture; keepsakes will want a card; word imagery will
-- want a photo credit. Those do not belong as columns on everyone's rows. The
-- shape is a small convention instead, and unknown keys are simply carried:
--
--   {
--     "source":   "ispy",              -- who saved it
--     "savedAt":  "2026-08-11T…Z",
--     "scenario": "Ordering coffee",   -- where in the product
--     "turn":     "7",                 -- where in the conversation
--     "image":    "1bd337fe…",         -- which picture
--     "game":     { "score": 3, "max": 3, "hints": 0, "pron": 87 }
--   }
--
-- Everything is optional. A save with nothing to say leaves meta null, which is
-- exactly what every existing row already is.
--
-- Idempotent: safe to run repeatedly (Supabase SQL editor).
--
-- NOTE ON PLACEMENT: my_words_entries itself was created outside this folder
-- (it predates these migrations and has no file here). This is the project's
-- only migrations directory, so the column lives here rather than nowhere.

alter table if exists public.my_words_entries
  add column if not exists meta jsonb;

comment on column public.my_words_entries.meta is
  'Optional provenance bag written by whichever surface saved the word. See migrations/0006_my_words_meta.sql for the shape convention. Nullable: most rows have none.';

-- Read pattern this exists to serve: "everything I got from one surface", and
-- "everything from one conversation image". A GIN index keeps those containment
-- queries cheap without committing to any particular key.
create index if not exists idx_my_words_entries_meta
  on public.my_words_entries using gin (meta jsonb_path_ops);
