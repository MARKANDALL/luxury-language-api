-- migrations/0006_keepsake_scan_key.sql
-- The I Spy scan cache key, carried on each kept picture.
--
-- WHY THIS CANNOT BE DERIVED LATER. The I Spy scan cache
-- (public.image_targets, in the lux-ispy-api project) is keyed on
-- (image_key, lang, level), where image_key is the lowercase hex SHA-256 of the
-- image's URL STRING truncated to 32 characters. For a conversation picture
-- that string is the generated data: URI, which exists only in the browser and
-- only while the conversation is on screen.
--
-- An album picture is served from a SIGNED bucket URL that is regenerated on
-- every read, so its hash is different every time and could never match. There
-- is no moment after the save at which the right key can be recomputed from
-- anything we still hold. It has to be captured at save time or it is gone.
--
-- Without it, playing I Spy on a saved picture silently misses the cache and
-- re-bills a full vision call for a scan the conversation already paid for.
--
-- lang and level are stored beside the key because they are the other two
-- thirds of that primary key: the same picture scanned at B1 in English is a
-- different row from the same picture at A2 in Spanish, and an album round has
-- to be able to line itself up with the scan that already exists.
--
-- Nullable on purpose. Sets saved before this column existed have no key and
-- never will; the album must treat a null as "never scanned" rather than as an
-- error. crypto.subtle is also unavailable in an insecure context, so a browser
-- on plain http legitimately sends no key.
--
-- Idempotent: safe to run repeatedly (Supabase SQL editor).

alter table public.keepsake_images
  add column if not exists scan_key text,
  add column if not exists scan_lang text,
  add column if not exists scan_level text;

-- Answering "has this picture been scanned, and under what scope" for a whole
-- album at once. Partial, because rows without a key are never looked up by it.
create index if not exists idx_keepsake_images_scan_key
  on public.keepsake_images (scan_key)
  where scan_key is not null;
