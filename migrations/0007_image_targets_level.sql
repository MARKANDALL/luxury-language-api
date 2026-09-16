-- migrations/0007_image_targets_level.sql
-- The CEFR band a cached target set was generated for.
--
-- The I Spy game grew a level control, so the same picture in the same pack now
-- has a different right answer per band: an A1 round wants "a cup" where a C1
-- round wants "an espresso cup". That makes level part of the cache identity,
-- not a property of the row.
--
-- The default is the empty string, NOT null, and that is the whole trick. Every
-- row cached before this migration was generated with no band asked for, which
-- is exactly what "" means. Backfilling them to "" and putting "" in the new
-- primary key leaves all of them serving the scenario-default round, so nothing
-- anyone has already played re-bills a vision call. A row is only ever added,
-- never invalidated: asking for a new band on a picture is one fresh call,
-- cached forever after under its own key.
--
-- Idempotent: safe to run repeatedly (Supabase SQL editor).

alter table if exists public.image_targets
  add column if not exists level text not null default '';

comment on column public.image_targets.level is
  'CEFR band the set was generated for (A1..C2), or empty string for "whatever the model chose", which is what every pre-level row holds.';

-- Repoint the primary key at (image_key, lang, level). Dropping and recreating
-- is the only way to widen a PK, and it is safe here: the existing rows all
-- carry level = '' after the backfill above, so the widened key is unique over
-- exactly the same set of rows the old one covered.
do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.image_targets'::regclass
      and contype = 'p'
      and conname = 'image_targets_pkey'
      and array_length(conkey, 1) = 2
  ) then
    alter table public.image_targets drop constraint image_targets_pkey;
    alter table public.image_targets
      add constraint image_targets_pkey primary key (image_key, lang, level);
  end if;
end $$;
