-- migrations/0002_voice_profiles_lang.sql
-- Voice Mirror ("Espejo de Voz") — tag each cloned voice with the language it
-- was calibrated in, so the es-MX pack can tell a Spanish-calibrated clone from
-- an English one and prompt a Spanish re-read instead of silently reusing an
-- English-sample clone.
--
-- Idempotent: safe to run repeatedly (Supabase SQL editor).
--
-- The `voice_profiles` table was created out-of-band (it is not defined in an
-- earlier migration), so this only adds the new column. `NOT NULL DEFAULT 'en'`
-- backfills every existing row to 'en' in one shot, which is correct: all clones
-- that predate the Spanish pack were built from English calibration reads.
--
-- English path stays byte-identical: routes/voice-clone.js only reads/writes
-- `lang` when pack==="es". English clones simply inherit the 'en' default; the
-- English code paths never reference the column.

alter table public.voice_profiles
  add column if not exists lang text not null default 'en';

comment on column public.voice_profiles.lang is
  'Language the voice clone was calibrated in ("en" | "es"). Set to "es" when the '
  'clone is built from the Spanish (es-MX) Voice Mirror calibration reads. '
  'multilingual_v2 can speak either language from any clone, but Spanish reads '
  'give better Spanish phoneme coverage.';
