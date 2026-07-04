// lib/expenses/migration.js
// One-line: The expense-dashboard schema + seed as a runnable SQL string (mirror of migrations/0001_expense_dashboard.sql).
//
// Kept as an embedded string (not read from disk) so it is always bundled into
// the serverless function. It is byte-identical to
// migrations/0001_expense_dashboard.sql — edit both together.
// Applied by POST /api/admin/expenses/migrate via the pg pool. Idempotent.

export const MIGRATION_SQL = `
create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ========================= TABLES =========================

create table if not exists public.expense_sources (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  display_name  text not null,
  category      text not null check (category in ('run', 'build')),
  billing_shape text not null check (billing_shape in ('metered', 'flat', 'one_time')),
  fetch_mode    text not null check (fetch_mode in ('auto', 'manual')),
  vendor_url    text,
  active        boolean not null default true,
  notes         text,
  created_at    timestamptz not null default now()
);

create table if not exists public.expense_snapshots (
  id           uuid primary key default gen_random_uuid(),
  source_id    uuid not null references public.expense_sources(id) on delete cascade,
  period_start date,
  period_end   date,
  amount_usd   numeric(12, 2),
  method       text not null check (method in ('auto', 'manual')),
  fetched_at   timestamptz not null default now(),
  raw          jsonb
);
create index if not exists idx_expense_snapshots_source
  on public.expense_snapshots (source_id, fetched_at desc);
create index if not exists idx_expense_snapshots_period
  on public.expense_snapshots (period_start, period_end);

create table if not exists public.expense_events (
  id          uuid primary key default gen_random_uuid(),
  source_id   uuid references public.expense_sources(id) on delete set null,
  event_date  date not null,
  kind        text not null check (kind in ('plan_change', 'one_time', 'note')),
  amount_usd  numeric(12, 2),
  description text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_expense_events_date
  on public.expense_events (event_date desc);

-- ========================= SEED: sources =========================
insert into public.expense_sources
  (slug, display_name, category, billing_shape, fetch_mode, vendor_url, active, notes)
values
  ('openai', 'OpenAI', 'run', 'metered', 'auto',
    'https://platform.openai.com/settings/organization/usage', true,
    'Org Costs API (month-to-date). Per-key attribution unavailable while the Lux key shares the Default project; org total stored as amount_usd, full response in raw. Needs OPENAI_ADMIN_KEY.'),
  ('azure', 'Azure', 'run', 'metered', 'manual',
    'https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/costanalysis', true,
    'Manual v1: hand-entered from Portal Cost analysis. Phase 2: Entra service principal for the Cost Management API.'),
  ('gemini', 'Gemini (AI Studio)', 'run', 'metered', 'manual',
    'https://aistudio.google.com/billing', true,
    'Manual v1: AI Studio Prepay exposes no public billing API. Hand-enter balance + month spend. Phase 2: Cloud Billing BigQuery export.'),
  ('elevenlabs', 'ElevenLabs', 'run', 'flat', 'auto',
    'https://elevenlabs.io/app/subscription', true,
    'Starter plan, $5/mo. Planned migration to Azure TTS (pay-per-char, cheaper, pending business vetting).'),
  ('supabase', 'Supabase', 'run', 'flat', 'manual',
    'https://supabase.com/dashboard/project/_/settings/billing', true,
    'Free tier — $0 until the plan changes.'),
  ('vercel', 'Vercel', 'run', 'flat', 'manual',
    'https://vercel.com/dashboard/usage', true,
    'Hobby tier — $0 until the plan changes.'),
  ('github', 'GitHub', 'build', 'flat', 'manual',
    'https://github.com/settings/billing', true,
    'Free tier — $0 until the plan changes.'),
  ('claude', 'Claude (Anthropic)', 'build', 'flat', 'manual',
    'https://claude.ai/settings/billing', true,
    'Max 20x subscription. Scheduled downgrade to Max 5x on 2026-07-12 (see expense_events).'),
  ('play_store', 'Google Play Store', 'build', 'one_time', 'manual',
    'https://play.google.com/console', false,
    'Placeholder (inactive). One-time developer registration fee; status TBD.'),
  ('domain', 'Custom Domain', 'run', 'flat', 'manual',
    null, false,
    'Placeholder (inactive). Custom domain, if one exists; TBD.'),
  ('speechace_eval', 'Speechace Evaluation', 'build', 'one_time', 'manual',
    'https://www.speechace.com/', false,
    'Placeholder (inactive). Evaluation cost, if any; TBD.')
on conflict (slug) do nothing;

-- ========================= SEED: snapshots (2026-07-04) =========================
-- Metered run costs — month-to-date window 2026-07-01 .. 2026-07-04.
insert into public.expense_snapshots
  (source_id, period_start, period_end, amount_usd, method, fetched_at, raw)
select s.id, date '2026-07-01', date '2026-07-04', v.amount, 'manual',
       timestamptz '2026-07-04T12:00:00Z', v.raw
from (values
  ('openai', 0.27::numeric, '{"source":"seed","note":"MTD org cost read from platform.openai.com"}'::jsonb),
  ('azure',  0.06::numeric, '{"source":"seed","note":"MTD from Portal Cost analysis"}'::jsonb),
  ('gemini', 4.64::numeric, '{"source":"seed","note":"prepay balance low, auto-reload off"}'::jsonb)
) as v(slug, amount, raw)
join public.expense_sources s on s.slug = v.slug
where not exists (
  select 1 from public.expense_snapshots x
  where x.source_id = s.id and x.raw->>'source' = 'seed'
);

-- Flat monthly subscriptions — billing month 2026-07-01 .. 2026-07-31.
insert into public.expense_snapshots
  (source_id, period_start, period_end, amount_usd, method, fetched_at, raw)
select s.id, date '2026-07-01', date '2026-07-31', v.amount, 'manual',
       timestamptz '2026-07-04T12:00:00Z', v.raw
from (values
  ('elevenlabs',   5.00::numeric, '{"source":"seed","tier":"Starter","note":"$5/mo flat"}'::jsonb),
  ('supabase',     0.00::numeric, '{"source":"seed","note":"free tier"}'::jsonb),
  ('vercel',       0.00::numeric, '{"source":"seed","note":"hobby tier"}'::jsonb),
  ('github',       0.00::numeric, '{"source":"seed","note":"free tier"}'::jsonb),
  ('claude',     200.00::numeric, '{"source":"seed","plan":"Max 20x","note":"$200/mo; downgrade to Max 5x scheduled 2026-07-12"}'::jsonb)
) as v(slug, amount, raw)
join public.expense_sources s on s.slug = v.slug
where not exists (
  select 1 from public.expense_snapshots x
  where x.source_id = s.id and x.raw->>'source' = 'seed'
);

-- ========================= SEED: events =========================
insert into public.expense_events (source_id, event_date, kind, amount_usd, description)
select s.id, date '2026-07-12', 'plan_change', 100.00,
       'Downgrade Claude Max 20x ($200/mo) -> Max 5x ($100/mo)'
from public.expense_sources s
where s.slug = 'claude'
  and not exists (
    select 1 from public.expense_events e
    where e.source_id = s.id
      and e.event_date = date '2026-07-12'
      and e.kind = 'plan_change'
  );

-- Nudge PostgREST to reload its schema cache so supabase-js sees the new
-- tables immediately after this migration runs.
notify pgrst, 'reload schema';
`;

export default MIGRATION_SQL;
