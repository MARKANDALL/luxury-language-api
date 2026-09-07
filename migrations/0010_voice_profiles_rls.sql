-- migrations/0010_voice_profiles_rls.sql
-- Close anonymous access to Voice Mirror profile metadata. All production
-- reads and writes use the backend service client, so no browser policy is
-- required for this table.

alter table public.voice_profiles enable row level security;

revoke all privileges on table public.voice_profiles from anon, authenticated;
grant select, insert, update, delete on table public.voice_profiles to service_role;
