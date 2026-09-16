-- migrations/0010_my_words_source_note.sql
-- Round 6 item 12: My Words learns where an entry came from, and gains a place
-- for the learner's own note.
--
-- WHY. Every word a learner taps in a conversation is now kept, not just the
-- ones they deliberately save. Both live in this one table, because they are
-- the same thing at different strengths: a lookup is a word you met, a save is
-- a word you chose, and a save is very often a lookup you came back to. Keeping
-- them apart in two tables would mean reconciling them on every read, and would
-- make "promote this lookup to a save" a move between tables instead of a flag.
--
-- THE DEFAULT IS NOT COSMETIC. Every row that exists before this migration was
-- written by the save path, so every one of them is a deliberate save. The
-- column therefore defaults to 'saved' and is backfilled to 'saved', and the
-- frontend treats a missing/NULL source the same way. A lookup has to say so
-- explicitly; nothing becomes a lookup by accident.
--
-- NOTHING RENDERS LOOKUPS YET. Round 6 stores them and filters them out of
-- every existing view; round 7 gives them a column of their own and fills in
-- `note`. This migration is the whole of the data work for that round.

alter table public.my_words_entries
  add column if not exists source text default 'saved',
  add column if not exists note   text default '';

-- Existing rows: all of them were saves.
update public.my_words_entries
   set source = 'saved'
 where source is null;

-- Only the two values the app writes. Kept as a CHECK rather than an enum so a
-- later round can add a third source without a type migration.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'my_words_entries_source_check'
  ) then
    alter table public.my_words_entries
      add constraint my_words_entries_source_check
      check (source in ('saved', 'lookup'));
  end if;
end $$;

-- The Library reads a learner's saves; round 7's column reads their lookups.
-- Both are "this uid, this source, most recent first".
create index if not exists my_words_entries_uid_source_updated_idx
  on public.my_words_entries (uid, source, updated_at desc);
