-- =====================================================================
-- Hospital AI — staff dashboard additions
-- Run ONCE in the hospital-ai Supabase project (SQL Editor → paste → Run),
-- after hospital-ai-schema.sql. Safe to re-run.
--
-- The dashboard never uses the public (anon) key to read data: every read and
-- write happens on the server, after the signed-in user's staff role is checked.
-- So no table is opened up to the browser here.
-- =====================================================================

-- Who closed a handoff, when, and what they did about it.
alter table public.escalations
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by text,
  add column if not exists staff_note  text;

-- Front-desk notes on a booking (e.g. "bring previous reports").
alter table public.appointments
  add column if not exists notes text;

-- The clinic name shown in the dashboard.
insert into public.clinic_settings (key, value) values ('clinic_name', 'Your clinic')
on conflict (key) do nothing;

-- Every change staff make from the dashboard, for accountability.
create table if not exists public.staff_activity (
  id          bigint generated always as identity primary key,
  staff_email text not null,
  action      text not null,
  detail      text,
  created_at  timestamptz not null default now()
);
create index if not exists staff_activity_created on public.staff_activity (created_at desc);

alter table public.staff_activity enable row level security;
revoke all on public.staff_activity from anon, authenticated;

-- Helpful indexes for the dashboard's lists.
create index if not exists escalations_open on public.escalations (resolved, created_at desc);
create index if not exists reports_created on public.reports (created_at desc);
create index if not exists feedback_responded on public.feedback (responded_at desc);
