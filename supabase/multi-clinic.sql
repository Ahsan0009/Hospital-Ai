set client_min_messages = warning;
-- =====================================================================
-- Hospital AI — multi-clinic database
--
-- Run in the Supabase SQL Editor (paste the whole file, press Run).
--   * On a NEW project: creates everything.
--   * On a project that already ran the single-clinic scripts
--     (hospital-ai-schema.sql / dashboard.sql): converts it in place. Every
--     existing row is moved into one first clinic; nothing is deleted.
-- Safe to run more than once.
--
-- How clinics are kept apart
--   1. Every row carries clinic_id. Appointments, reports, feedback and
--      handoffs reference patients/doctors/appointments by (clinic_id, id),
--      so the database itself refuses a row that points into another clinic.
--   2. Staff belong to exactly one clinic (staff_members). Dashboard reads run
--      as the signed-in user; row-level security only returns rows whose
--      clinic_id is that user's clinic, and only while the clinic is active
--      or on trial. Removing a person from staff_members cuts access at once.
--   3. Staff can read, never write, through the public API. All changes go
--      through the dashboard server or n8n (service-role key), which pass the
--      clinic explicitly to the functions at the bottom of this file.
--   4. Billing, operator notes and WhatsApp credentials are not readable by
--      clinic staff at all.
-- =====================================================================

-- ---------- Clinics (one row per paying customer) ----------
create table if not exists public.clinics (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (length(name) between 2 and 80),
  status             text not null default 'trial' check (status in ('trial','active','suspended','cancelled')),
  plan               text not null default 'starter' check (plan in ('starter','growth','pro','custom')),
  monthly_fee        numeric(12,2) not null default 0 check (monthly_fee >= 0),
  currency           text not null default 'PKR' check (currency ~ '^[A-Z]{3}$'),
  paid_until         date,
  timezone           text not null default 'Asia/Karachi',
  contact_phone      text,          -- told to patients if the service is paused
  alert_email        text,          -- front-desk alerts (handoffs, low ratings, critical reports)
  google_review_link text,
  template_lang      text not null default 'en',
  wa_phone_number_id text unique,   -- Meta phone number ID; routes incoming WhatsApp messages to this clinic
  wa_display_number  text,
  wa_token_enc       text,          -- clinic's own WhatsApp token, AES-256-GCM encrypted outside the database; null = platform token
  report_secret_hash text unique,   -- SHA-256 of the lab system's secret; the secret itself is never stored
  notes              text,          -- operator only
  created_at         timestamptz not null default now(),
  status_changed_at  timestamptz not null default now()
);

create table if not exists public.staff_members (
  user_id    uuid primary key,      -- Supabase Auth user id; one clinic per account
  clinic_id  uuid not null references public.clinics(id) on delete cascade,
  role       text not null check (role in ('admin','staff')),
  email      text not null,
  created_at timestamptz not null default now()
);
create index if not exists staff_members_clinic on public.staff_members (clinic_id);

create table if not exists public.payments (
  id           bigint generated always as identity primary key,
  clinic_id    uuid references public.clinics(id) on delete set null,
  clinic_name  text not null,       -- kept so revenue history survives a deleted clinic
  amount       numeric(12,2) not null check (amount > 0),
  currency     text not null check (currency ~ '^[A-Z]{3}$'),
  period_from  date not null,
  period_to    date not null check (period_to >= period_from),
  method       text,
  reference    text,
  note         text,
  recorded_by  text not null,
  recorded_at  timestamptz not null default now()
);
create index if not exists payments_clinic on public.payments (clinic_id, recorded_at desc);

create table if not exists public.operator_audit (
  id             bigint generated always as identity primary key,
  operator_email text not null,
  action         text not null,
  clinic_id      uuid,
  detail         text,
  created_at     timestamptz not null default now()
);

-- ---------- Clinic data tables (fresh projects) ----------
create table if not exists public.patients (
  id bigint generated always as identity primary key,
  clinic_id uuid not null,
  phone text not null check (phone ~ '^[0-9]{6,15}$'),
  name text,
  last_message_at timestamptz,
  paused_notice_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists public.doctors (
  id bigint generated always as identity primary key,
  clinic_id uuid not null,
  name text not null,
  department text not null,
  consultation_fee numeric(10,2),
  working_days smallint[] not null default '{1,2,3,4,5}',
  start_time time not null default '09:00',
  end_time time not null default '17:00',
  slot_minutes smallint not null default 15 check (slot_minutes between 5 and 240),
  active boolean not null default true,
  notes text,
  check (end_time > start_time)
);
create table if not exists public.appointments (
  id bigint generated always as identity primary key,
  clinic_id uuid not null,
  patient_id bigint not null,
  doctor_id bigint not null,
  slot_time timestamptz not null,
  status text not null default 'confirmed' check (status in ('confirmed','cancelled','completed','no_show')),
  source text not null default 'whatsapp',
  rescheduled boolean not null default false,
  reminder_24h_sent boolean not null default false,
  reminder_2h_sent boolean not null default false,
  feedback_sent boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.processed_messages (
  wa_message_id text primary key,
  clinic_id uuid,
  patient_phone text,
  received_at timestamptz not null default now()
);
create table if not exists public.feedback (
  id bigint generated always as identity primary key,
  clinic_id uuid not null,
  appointment_id bigint,
  patient_phone text not null,
  rating smallint check (rating between 1 and 5),
  requested_at timestamptz not null default now(),
  responded_at timestamptz
);
create table if not exists public.reports (
  id bigint generated always as identity primary key,
  clinic_id uuid not null,
  patient_id bigint not null,
  report_type text not null,
  report_link text,
  summary text,
  is_critical boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.escalations (
  id bigint generated always as identity primary key,
  clinic_id uuid not null,
  patient_phone text,
  patient_id bigint,
  reason text not null,
  urgency text not null default 'normal' check (urgency in ('normal','urgent')),
  resolved boolean not null default false,
  notified boolean not null default false,
  resolved_at timestamptz,
  resolved_by text,
  staff_note text,
  created_at timestamptz not null default now()
);
create table if not exists public.calls (
  id bigint generated always as identity primary key,
  clinic_id uuid,
  call_id text,
  appointment_id bigint,
  patient_phone text,
  outcome text,
  transcript_summary text,
  created_at timestamptz not null default now()
);
create table if not exists public.error_log (
  id bigint generated always as identity primary key,
  clinic_id uuid,                   -- null for platform-wide problems
  source text,
  patient_phone text,
  error_detail text,
  created_at timestamptz not null default now()
);
create table if not exists public.staff_activity (
  id bigint generated always as identity primary key,
  clinic_id uuid not null,
  staff_email text not null,
  action text not null,
  detail text,
  created_at timestamptz not null default now()
);

-- ---------- Columns added after the single-clinic version ----------
alter table public.patients      add column if not exists clinic_id uuid;
alter table public.patients      add column if not exists paused_notice_at timestamptz;
alter table public.doctors       add column if not exists clinic_id uuid;
alter table public.appointments  add column if not exists clinic_id uuid;
alter table public.appointments  add column if not exists notes text;
alter table public.processed_messages add column if not exists clinic_id uuid;
alter table public.feedback      add column if not exists clinic_id uuid;
alter table public.reports       add column if not exists clinic_id uuid;
alter table public.escalations   add column if not exists clinic_id uuid;
alter table public.escalations   add column if not exists resolved_at timestamptz;
alter table public.escalations   add column if not exists resolved_by text;
alter table public.escalations   add column if not exists staff_note text;
alter table public.calls         add column if not exists clinic_id uuid;
alter table public.error_log     add column if not exists clinic_id uuid;
alter table public.staff_activity add column if not exists clinic_id uuid;

-- ---------- Move single-clinic data into a first clinic ----------
do $$
declare
  first_clinic uuid;
  t text;
  orphans boolean := false;
  legacy_name text;
  legacy_tz text;
begin
  foreach t in array array['patients','doctors','appointments','feedback','reports','escalations','staff_activity','processed_messages','calls'] loop
    execute format('select exists (select 1 from public.%I where clinic_id is null)', t) into orphans;
    exit when orphans;
  end loop;
  if not orphans then return; end if;
  -- Only the one-time upgrade from the single-clinic schema moves rows; a re-run never does.
  if to_regclass('public.clinic_settings') is null and exists (select 1 from public.clinics) then return; end if;

  if to_regclass('public.clinic_settings') is not null then
    execute $q$select value from public.clinic_settings where key = 'clinic_name'$q$ into legacy_name;
    execute $q$select value from public.clinic_settings where key = 'timezone'$q$ into legacy_tz;
  end if;

  select id into first_clinic from public.clinics order by created_at limit 1;
  if first_clinic is null then
    insert into public.clinics (name, timezone, status)
    values (coalesce(nullif(legacy_name, 'Your clinic'), 'First clinic'), coalesce(legacy_tz, 'Asia/Karachi'), 'trial')
    returning id into first_clinic;
  end if;

  foreach t in array array['patients','doctors','appointments','feedback','reports','escalations','staff_activity','processed_messages','calls'] loop
    execute format('update public.%I set clinic_id = %L where clinic_id is null', t, first_clinic);
  end loop;

  -- Staff accounts made with the single-clinic dashboard keep their role in this clinic.
  if to_regclass('auth.users') is not null then
    execute format($q$
      insert into public.staff_members (user_id, clinic_id, role, email)
      select id, %L, raw_app_meta_data->>'role', coalesce(email, '')
      from auth.users
      where raw_app_meta_data->>'role' in ('admin','staff')
      on conflict (user_id) do nothing$q$, first_clinic);
    -- The role now lives in staff_members; the old copy in app metadata is cleared.
    execute $q$update auth.users set raw_app_meta_data = raw_app_meta_data - 'role'
               where raw_app_meta_data->>'role' in ('admin','staff')$q$;
  end if;
end $$;

-- ---------- Clinic is required everywhere it must be ----------
alter table public.patients       alter column clinic_id set not null;
alter table public.doctors        alter column clinic_id set not null;
alter table public.appointments   alter column clinic_id set not null;
alter table public.feedback       alter column clinic_id set not null;
alter table public.reports        alter column clinic_id set not null;
alter table public.escalations    alter column clinic_id set not null;
alter table public.staff_activity alter column clinic_id set not null;

-- A phone number is unique per clinic, not across clinics.
alter table public.patients drop constraint if exists patients_phone_key;
create unique index if not exists patients_clinic_phone on public.patients (clinic_id, phone);

-- Keys that let other tables point at (clinic_id, id).
create unique index if not exists patients_clinic_id_id on public.patients (clinic_id, id);
create unique index if not exists doctors_clinic_id_id on public.doctors (clinic_id, id);
create unique index if not exists appointments_clinic_id_id on public.appointments (clinic_id, id);

-- Foreign keys: to the clinic, and cross-table links that must stay inside one clinic.
do $$
declare
  fk record;
begin
  for fk in
    select * from (values
      ('patients',       'patients_clinic_fk',       'foreign key (clinic_id) references public.clinics(id) on delete cascade'),
      ('doctors',        'doctors_clinic_fk',        'foreign key (clinic_id) references public.clinics(id) on delete cascade'),
      ('appointments',   'appointments_clinic_fk',   'foreign key (clinic_id) references public.clinics(id) on delete cascade'),
      ('feedback',       'feedback_clinic_fk',       'foreign key (clinic_id) references public.clinics(id) on delete cascade'),
      ('reports',        'reports_clinic_fk',        'foreign key (clinic_id) references public.clinics(id) on delete cascade'),
      ('escalations',    'escalations_clinic_fk',    'foreign key (clinic_id) references public.clinics(id) on delete cascade'),
      ('staff_activity', 'staff_activity_clinic_fk', 'foreign key (clinic_id) references public.clinics(id) on delete cascade'),
      ('processed_messages', 'processed_messages_clinic_fk', 'foreign key (clinic_id) references public.clinics(id) on delete cascade'),
      ('calls',          'calls_clinic_fk',          'foreign key (clinic_id) references public.clinics(id) on delete cascade'),
      ('error_log',      'error_log_clinic_fk',      'foreign key (clinic_id) references public.clinics(id) on delete cascade'),
      ('appointments',   'appointments_same_clinic_patient', 'foreign key (clinic_id, patient_id) references public.patients(clinic_id, id) on delete cascade'),
      ('appointments',   'appointments_same_clinic_doctor',  'foreign key (clinic_id, doctor_id) references public.doctors(clinic_id, id)'),
      ('reports',        'reports_same_clinic_patient',      'foreign key (clinic_id, patient_id) references public.patients(clinic_id, id) on delete cascade'),
      ('feedback',       'feedback_same_clinic_appointment', 'foreign key (clinic_id, appointment_id) references public.appointments(clinic_id, id) on delete cascade'),
      ('escalations',    'escalations_same_clinic_patient',  'foreign key (clinic_id, patient_id) references public.patients(clinic_id, id) on delete set null (patient_id)')
    ) as v(tbl, name, def)
  loop
    if not exists (select 1 from pg_constraint where conname = fk.name) then
      execute format('alter table public.%I add constraint %I %s', fk.tbl, fk.name, fk.def);
    end if;
  end loop;
end $$;

-- The single-clinic schema linked tables by id alone. The (clinic_id, id) keys above
-- replace those links, and keeping both would make the API's joins ambiguous.
alter table public.appointments drop constraint if exists appointments_patient_id_fkey;
alter table public.appointments drop constraint if exists appointments_doctor_id_fkey;
alter table public.feedback     drop constraint if exists feedback_appointment_id_fkey;
alter table public.reports      drop constraint if exists reports_patient_id_fkey;
alter table public.escalations  drop constraint if exists escalations_patient_id_fkey;

-- ---------- Version 2: doctor sessions and time off, channels, plan limits ----------
-- A doctor can sit several times a day (morning and evening clinics) and on
-- different hours per weekday. Days off and clinic holidays block booking.
create table if not exists public.doctor_sessions (
  id bigint generated always as identity primary key,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  doctor_id bigint not null,
  weekday smallint not null check (weekday between 1 and 7),   -- 1 = Monday … 7 = Sunday
  start_time time not null,
  end_time time not null,
  check (end_time > start_time),
  constraint doctor_sessions_same_clinic_doctor foreign key (clinic_id, doctor_id) references public.doctors(clinic_id, id) on delete cascade
);
create index if not exists doctor_sessions_doctor on public.doctor_sessions (doctor_id, weekday);

create table if not exists public.doctor_time_off (
  id bigint generated always as identity primary key,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  doctor_id bigint,                 -- null = the whole clinic is closed (public holiday)
  starts_on date not null,
  ends_on date not null,
  reason text,                      -- staff only; never shown to patients
  created_by text,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  constraint doctor_time_off_same_clinic_doctor foreign key (clinic_id, doctor_id) references public.doctors(clinic_id, id) on delete cascade
);
create index if not exists doctor_time_off_lookup on public.doctor_time_off (clinic_id, ends_on);

-- The automation records that it is alive; the owner console shows it.
create table if not exists public.platform_heartbeat (
  name text primary key,
  seen_at timestamptz not null default now(),
  detail text
);

alter table public.clinics add column if not exists remind_24h boolean not null default true;
alter table public.clinics add column if not exists remind_2h boolean not null default true;
alter table public.clinics add column if not exists ask_feedback boolean not null default true;
alter table public.clinics add column if not exists sms_enabled boolean not null default false;
alter table public.clinics add column if not exists sms_number text;          -- E.164, e.g. +13055550123
alter table public.clinics add column if not exists preferred_channel text not null default 'whatsapp';
alter table public.clinics add column if not exists limit_appointments integer; -- null = the plan's limit
alter table public.clinics add column if not exists limit_messages integer;
alter table public.clinics add column if not exists retention_months integer;   -- null = keep everything
alter table public.patients add column if not exists channel text not null default 'whatsapp';
alter table public.patients add column if not exists sms_opt_out boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'clinics_preferred_channel_check') then
    alter table public.clinics add constraint clinics_preferred_channel_check check (preferred_channel in ('whatsapp','sms'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'clinics_sms_number_key') then
    alter table public.clinics add constraint clinics_sms_number_key unique (sms_number);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'clinics_retention_months_check') then
    alter table public.clinics add constraint clinics_retention_months_check check (retention_months is null or retention_months between 6 and 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'clinics_limits_check') then
    alter table public.clinics add constraint clinics_limits_check check ((limit_appointments is null or limit_appointments > 0) and (limit_messages is null or limit_messages > 0));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'patients_channel_check') then
    alter table public.patients add constraint patients_channel_check check (channel in ('whatsapp','sms'));
  end if;
end $$;

-- Doctors set up before sessions existed get one session per working day.
-- (The dashboard keeps working_days in step with the sessions.)
insert into public.doctor_sessions (clinic_id, doctor_id, weekday, start_time, end_time)
select d.clinic_id, d.id, w, d.start_time, d.end_time
from public.doctors d cross join lateral unnest(d.working_days) as w
where w between 1 and 7 and d.start_time < d.end_time
  and not exists (select 1 from public.doctor_sessions s where s.doctor_id = d.id);

-- A doctor added any other way (SQL editor, an import) gets the same default
-- sessions; the dashboard then replaces them with the exact week it was given.
create or replace function public.doctor_default_sessions() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.doctor_sessions (clinic_id, doctor_id, weekday, start_time, end_time)
  select new.clinic_id, new.id, w, new.start_time, new.end_time
  from unnest(new.working_days) as w
  where w between 1 and 7 and new.start_time < new.end_time;
  return null;
end $$;
revoke all on function public.doctor_default_sessions() from public, anon, authenticated;
drop trigger if exists doctor_default_sessions on public.doctors;
create trigger doctor_default_sessions after insert on public.doctors
  for each row execute function public.doctor_default_sessions();

-- Indexes for the dashboard and the schedulers.
create unique index if not exists appointments_no_double_booking on public.appointments (doctor_id, slot_time) where status = 'confirmed';
create index if not exists appointments_clinic_slot on public.appointments (clinic_id, slot_time);
create index if not exists appointments_status_slot on public.appointments (status, slot_time);
create unique index if not exists feedback_one_per_appointment on public.feedback (appointment_id);
create index if not exists escalations_clinic_open on public.escalations (clinic_id, resolved, created_at desc);
create index if not exists reports_clinic_created on public.reports (clinic_id, created_at desc);
create index if not exists feedback_clinic_requested on public.feedback (clinic_id, requested_at desc);
create index if not exists error_log_clinic_created on public.error_log (clinic_id, created_at desc);
create index if not exists staff_activity_clinic_created on public.staff_activity (clinic_id, created_at desc);
create index if not exists processed_messages_clinic_received on public.processed_messages (clinic_id, received_at desc);
create index if not exists doctors_clinic on public.doctors (clinic_id);

-- The single-clinic settings table is replaced by columns on clinics.
drop table if exists public.clinic_settings;

-- ---------- Who is asking (used by row-level security) ----------
create or replace function public.my_clinic_id() returns uuid
language sql stable security definer set search_path = public as $$
  select s.clinic_id
  from public.staff_members s
  join public.clinics c on c.id = s.clinic_id
  where s.user_id = auth.uid() and c.status in ('trial', 'active')
$$;
revoke all on function public.my_clinic_id() from public, anon;
grant execute on function public.my_clinic_id() to authenticated, service_role;

-- ---------- Lock down, then open read-only access to one's own clinic ----------
do $$
declare t text;
begin
  foreach t in array array['clinics','staff_members','payments','operator_audit','patients','doctors','appointments',
                           'processed_messages','feedback','reports','escalations','calls','error_log','staff_activity',
                           'doctor_sessions','doctor_time_off','platform_heartbeat'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;

  -- Remove every older policy first: permissive policies are OR-ed, so one stray
  -- "using (true)" would undo the clinic filter below.
  for t in select format('drop policy %I on %I.%I', policyname, schemaname, tablename) from pg_policies
           where schemaname = 'public' and tablename in ('clinics','staff_members','payments','operator_audit','patients','doctors',
             'appointments','processed_messages','feedback','reports','escalations','calls','error_log','staff_activity',
             'doctor_sessions','doctor_time_off','platform_heartbeat') loop
    execute t;
  end loop;

  foreach t in array array['patients','doctors','appointments','feedback','reports','escalations','error_log','staff_activity','staff_members',
                           'doctor_sessions','doctor_time_off'] loop
    execute format('create policy clinic_read on public.%I for select to authenticated using (clinic_id = public.my_clinic_id())', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- Staff may see their own clinic's everyday settings, never billing, notes or credentials.
drop policy if exists clinic_read on public.clinics;
create policy clinic_read on public.clinics for select to authenticated using (id = public.my_clinic_id());
grant select (id, name, status, timezone, contact_phone, alert_email, google_review_link, wa_display_number,
              remind_24h, remind_2h, ask_feedback, sms_enabled, sms_number, preferred_channel) on public.clinics to authenticated;

-- A clinic always keeps at least one admin, even when two admins act at the same moment.
create or replace function public.keep_one_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role <> 'admin' or (tg_op = 'UPDATE' and new.role = 'admin' and new.clinic_id = old.clinic_id) then
    return null;
  end if;
  -- Serialise changes per clinic; a clinic being deleted is gone already and is skipped.
  perform 1 from public.clinics where id = old.clinic_id for update;
  if not found then return null; end if;
  if not exists (select 1 from public.staff_members where clinic_id = old.clinic_id and role = 'admin') then
    raise exception 'The clinic needs at least one admin.' using errcode = 'P0001';
  end if;
  return null;
end $$;
revoke all on function public.keep_one_admin() from public, anon, authenticated;
drop trigger if exists staff_members_keep_one_admin on public.staff_members;
create trigger staff_members_keep_one_admin after update or delete on public.staff_members
  for each row execute function public.keep_one_admin();

-- ---------- Old single-clinic functions are removed (they had no clinic argument) ----------
drop function if exists public.clinic_tz();
drop function if exists public.fmt_local(timestamptz);
drop function if exists public.slot_problem(bigint, timestamptz, bigint);
drop function if exists public.patient_id_for(text);
drop function if exists public.list_doctors();
drop function if exists public.available_slots(bigint, date);
drop function if exists public.my_appointments(text);
drop function if exists public.book_appointment(text, bigint, date, text);
drop function if exists public.reschedule_appointment_at(text, bigint, timestamptz);
drop function if exists public.reschedule_appointment(text, bigint, date, text);
drop function if exists public.cancel_appointment(text, bigint);
drop function if exists public.my_reports(text);
drop function if exists public.create_escalation(text, text, text);

-- ---------- Helpers ----------
create or replace function public.clinic_tz(p_clinic uuid) returns text
language sql stable as $$
  select coalesce((select timezone from public.clinics where id = p_clinic), 'UTC')
$$;

create or replace function public.fmt_local(p_clinic uuid, ts timestamptz) returns text
language sql stable as $$
  select to_char(ts at time zone public.clinic_tz(p_clinic), 'FMDay, DD FMMonth YYYY, HH12:MI AM')
$$;

-- Why a doctor is away on a date (staff wording), or NULL. Clinic-wide closures first.
create or replace function public.doctor_off(p_clinic uuid, p_doctor_id bigint, p_date date) returns text
language sql stable as $$
  select case when o.doctor_id is null then 'clinic closed' else 'away' end
  from public.doctor_time_off o
  where o.clinic_id = p_clinic and (o.doctor_id is null or o.doctor_id = p_doctor_id)
    and p_date between o.starts_on and o.ends_on
  order by o.doctor_id nulls first
  limit 1
$$;

-- "09:00 AM – 01:00 PM, 05:00 PM – 09:00 PM" for one doctor on one weekday.
create or replace function public.doctor_day_hours(p_doctor_id bigint, p_weekday smallint) returns text
language sql stable as $$
  select string_agg(to_char(s.start_time, 'HH12:MI AM') || ' – ' || to_char(s.end_time, 'HH12:MI AM'), ', ' order by s.start_time)
  from public.doctor_sessions s where s.doctor_id = p_doctor_id and s.weekday = p_weekday
$$;

-- NULL if the doctor can take this slot, otherwise a reason a patient can read.
create or replace function public.slot_problem(p_clinic uuid, p_doctor_id bigint, p_slot timestamptz, p_ignore_appointment bigint default null)
returns text language plpgsql stable as $$
declare
  d public.doctors;
  local_ts timestamp := p_slot at time zone public.clinic_tz(p_clinic);
  t time := local_ts::time;
  wd smallint := extract(isodow from local_ts)::smallint;
  s public.doctor_sessions;
  off text;
begin
  select * into d from public.doctors where id = p_doctor_id and clinic_id = p_clinic and active;
  if not found then return 'That doctor was not found or is not taking appointments.'; end if;
  if p_slot <= now() then return 'That time has already passed. Please choose a future time.'; end if;
  off := public.doctor_off(p_clinic, d.id, local_ts::date);
  if off = 'clinic closed' then return format('The clinic is closed on %s.', to_char(local_ts, 'FMDay DD FMMonth')); end if;
  if off is not null then return format('Dr. %s is not seeing patients on %s.', d.name, to_char(local_ts, 'FMDay DD FMMonth')); end if;
  if not exists (select 1 from public.doctor_sessions x where x.doctor_id = d.id and x.weekday = wd) then
    return format('Dr. %s does not work on %s.', d.name, trim(to_char(local_ts, 'Day')));
  end if;
  select * into s from public.doctor_sessions x
   where x.doctor_id = d.id and x.weekday = wd and t >= x.start_time and t + make_interval(mins => d.slot_minutes) <= x.end_time
   order by x.start_time limit 1;
  if not found then
    return format('Dr. %s sees patients on %s at %s.', d.name, trim(to_char(local_ts, 'Day')), public.doctor_day_hours(d.id, wd));
  end if;
  if (extract(epoch from (t - s.start_time)) / 60)::int % d.slot_minutes <> 0 then
    return format('Appointments with Dr. %s start every %s minutes from %s.', d.name, d.slot_minutes, to_char(s.start_time, 'HH12:MI AM'));
  end if;
  if exists (select 1 from public.appointments a
             where a.doctor_id = p_doctor_id and a.slot_time = p_slot and a.status = 'confirmed'
               and a.id is distinct from p_ignore_appointment) then
    return 'That slot has just been taken. Please choose another time.';
  end if;
  return null;
end $$;

create or replace function public.patient_id_for(p_clinic uuid, p_phone text) returns bigint
language sql stable as $$ select id from public.patients where clinic_id = p_clinic and phone = p_phone $$;

-- ---------- Functions the WhatsApp assistant and the dashboard call ----------
create or replace function public.list_doctors(p_clinic uuid) returns json
language sql stable as $$
  select coalesce(json_agg(json_build_object(
    'doctor_id', d.id, 'name', d.name, 'department', d.department,
    'consultation_fee', d.consultation_fee,
    'schedule', (select json_agg(json_build_object(
                    'day', case w when 1 then 'Mon' when 2 then 'Tue' when 3 then 'Wed' when 4 then 'Thu'
                                  when 5 then 'Fri' when 6 then 'Sat' else 'Sun' end,
                    'hours', public.doctor_day_hours(d.id, w::smallint)) order by w)
                 from (select distinct weekday as w from public.doctor_sessions where doctor_id = d.id) days),
    'not_available', (select json_agg(case when o.starts_on = o.ends_on then to_char(o.starts_on, 'FMDay DD FMMonth')
                                           else to_char(o.starts_on, 'DD FMMonth') || ' to ' || to_char(o.ends_on, 'DD FMMonth') end
                                      order by o.starts_on)
                      from public.doctor_time_off o
                      where o.clinic_id = p_clinic and (o.doctor_id = d.id or o.doctor_id is null)
                        and o.ends_on >= (now() at time zone public.clinic_tz(p_clinic))::date
                        and o.starts_on <= (now() at time zone public.clinic_tz(p_clinic))::date + 60),
    'slot_minutes', d.slot_minutes, 'notes', d.notes
  ) order by d.department, d.name), '[]'::json)
  from public.doctors d where d.clinic_id = p_clinic and d.active
$$;

create or replace function public.available_slots(p_clinic uuid, p_doctor_id bigint, p_date date) returns json
language plpgsql stable as $$
declare
  d public.doctors;
  tz text := public.clinic_tz(p_clinic);
  free text[] := '{}';
  s record;
  t time;
  slot timestamptz;
  off text;
begin
  select * into d from public.doctors where id = p_doctor_id and clinic_id = p_clinic and active;
  if not found then return json_build_object('ok', false, 'error', 'Doctor not found.'); end if;
  if p_date < (now() at time zone tz)::date then
    return json_build_object('ok', false, 'error', 'That date has already passed.');
  end if;
  off := public.doctor_off(p_clinic, d.id, p_date);
  if off = 'clinic closed' then
    return json_build_object('ok', false, 'error', format('The clinic is closed on %s.', to_char(p_date, 'FMDay DD FMMonth')));
  end if;
  if off is not null then
    return json_build_object('ok', false, 'error', format('Dr. %s is not seeing patients on %s.', d.name, to_char(p_date, 'FMDay DD FMMonth')));
  end if;
  if not exists (select 1 from public.doctor_sessions x where x.doctor_id = d.id and x.weekday = extract(isodow from p_date)) then
    return json_build_object('ok', false, 'error', format('Dr. %s does not work on %s.', d.name, trim(to_char(p_date, 'Day'))));
  end if;
  for s in select x.start_time, x.end_time from public.doctor_sessions x
           where x.doctor_id = d.id and x.weekday = extract(isodow from p_date) order by x.start_time loop
    t := s.start_time;
    while t + make_interval(mins => d.slot_minutes) <= s.end_time loop
      slot := (p_date + t) at time zone tz;
      if slot > now() and not exists (select 1 from public.appointments a
          where a.doctor_id = d.id and a.slot_time = slot and a.status = 'confirmed') then
        free := free || to_char(t, 'HH24:MI');
      end if;
      t := t + make_interval(mins => d.slot_minutes);
      exit when t = '00:00'::time;
    end loop;
  end loop;
  return json_build_object('ok', true, 'doctor', d.name, 'department', d.department,
    'date', to_char(p_date, 'FMDay, DD FMMonth YYYY'), 'free_times_24h', free,
    'note', case when array_length(free, 1) is null then 'Fully booked on this date.' else null end);
end $$;

create or replace function public.my_appointments(p_clinic uuid, p_phone text) returns json
language sql stable as $$
  select coalesce(json_agg(json_build_object(
    'appointment_id', a.id, 'doctor', d.name, 'department', d.department,
    'when', public.fmt_local(p_clinic, a.slot_time)) order by a.slot_time), '[]'::json)
  from public.appointments a
  join public.doctors d on d.id = a.doctor_id
  join public.patients p on p.id = a.patient_id
  where a.clinic_id = p_clinic and p.clinic_id = p_clinic and p.phone = p_phone
    and a.status = 'confirmed' and a.slot_time > now() - interval '1 hour'
$$;

create or replace function public.book_appointment(p_clinic uuid, p_phone text, p_doctor_id bigint, p_date date, p_time text)
returns json language plpgsql as $$
declare
  pid bigint := public.patient_id_for(p_clinic, p_phone);
  slot timestamptz;
  problem text;
  new_id bigint;
  d public.doctors;
begin
  if pid is null then return json_build_object('ok', false, 'error', 'Patient record not found.'); end if;
  begin
    slot := (p_date + p_time::time) at time zone public.clinic_tz(p_clinic);
  exception when others then
    return json_build_object('ok', false, 'error', 'Please give the time as HH:MM, for example 10:30.');
  end;
  problem := public.slot_problem(p_clinic, p_doctor_id, slot);
  if problem is not null then return json_build_object('ok', false, 'error', problem); end if;
  if exists (select 1 from public.appointments a where a.clinic_id = p_clinic and a.patient_id = pid and a.doctor_id = p_doctor_id
             and a.status = 'confirmed' and (a.slot_time at time zone public.clinic_tz(p_clinic))::date = p_date) then
    return json_build_object('ok', false, 'error', 'You already have an appointment with this doctor on that day.');
  end if;
  begin
    insert into public.appointments (clinic_id, patient_id, doctor_id, slot_time, source)
    values (p_clinic, pid, p_doctor_id, slot, 'whatsapp') returning id into new_id;
  exception when unique_violation then
    return json_build_object('ok', false, 'error', 'That slot has just been taken. Please choose another time.');
  end;
  select * into d from public.doctors where id = p_doctor_id;
  return json_build_object('ok', true, 'appointment_id', new_id, 'doctor', d.name,
                           'department', d.department, 'when', public.fmt_local(p_clinic, slot));
end $$;

create or replace function public.reschedule_appointment_at(p_clinic uuid, p_phone text, p_appointment_id bigint, p_new_slot timestamptz)
returns json language plpgsql as $$
declare
  a public.appointments;
  problem text;
begin
  select a2.* into a from public.appointments a2 join public.patients p on p.id = a2.patient_id
  where a2.id = p_appointment_id and a2.clinic_id = p_clinic and p.phone = p_phone and a2.status = 'confirmed';
  if not found then return json_build_object('ok', false, 'error', 'No upcoming appointment with that ID was found for you.'); end if;
  problem := public.slot_problem(p_clinic, a.doctor_id, p_new_slot, a.id);
  if problem is not null then return json_build_object('ok', false, 'error', problem); end if;
  begin
    update public.appointments set slot_time = p_new_slot, rescheduled = true,
      reminder_24h_sent = false, reminder_2h_sent = false, updated_at = now()
    where id = a.id and clinic_id = p_clinic;
  exception when unique_violation then
    return json_build_object('ok', false, 'error', 'That slot has just been taken. Please choose another time.');
  end;
  return json_build_object('ok', true, 'appointment_id', a.id, 'when', public.fmt_local(p_clinic, p_new_slot));
end $$;

create or replace function public.reschedule_appointment(p_clinic uuid, p_phone text, p_appointment_id bigint, p_date date, p_time text)
returns json language plpgsql as $$
declare slot timestamptz;
begin
  begin
    slot := (p_date + p_time::time) at time zone public.clinic_tz(p_clinic);
  exception when others then
    return json_build_object('ok', false, 'error', 'Please give the time as HH:MM, for example 10:30.');
  end;
  return public.reschedule_appointment_at(p_clinic, p_phone, p_appointment_id, slot);
end $$;

create or replace function public.cancel_appointment(p_clinic uuid, p_phone text, p_appointment_id bigint)
returns json language plpgsql as $$
declare a_id bigint; a_slot timestamptz;
begin
  update public.appointments a set status = 'cancelled', updated_at = now()
  from public.patients p
  where a.id = p_appointment_id and a.clinic_id = p_clinic and p.id = a.patient_id and p.phone = p_phone and a.status = 'confirmed'
  returning a.id, a.slot_time into a_id, a_slot;
  if a_id is null then return json_build_object('ok', false, 'error', 'No upcoming appointment with that ID was found for you.'); end if;
  return json_build_object('ok', true, 'appointment_id', a_id, 'cancelled', public.fmt_local(p_clinic, a_slot));
end $$;

-- Report status only — never links or results.
create or replace function public.my_reports(p_clinic uuid, p_phone text) returns json
language sql stable as $$
  select coalesce(json_agg(json_build_object('report_type', r.report_type,
    'ready_since', public.fmt_local(p_clinic, r.created_at)) order by r.created_at desc), '[]'::json)
  from public.reports r join public.patients p on p.id = r.patient_id
  where r.clinic_id = p_clinic and p.phone = p_phone
$$;

create or replace function public.create_escalation(p_clinic uuid, p_phone text, p_reason text, p_urgency text default 'normal')
returns json language plpgsql as $$
declare new_id bigint;
begin
  insert into public.escalations (clinic_id, patient_phone, patient_id, reason, urgency)
  values (p_clinic, p_phone, public.patient_id_for(p_clinic, p_phone),
          left(coalesce(nullif(trim(p_reason), ''), 'Patient asked for help'), 2000),
          case when lower(coalesce(p_urgency, '')) ~ '(urgent|emergenc)' then 'urgent' else 'normal' end)
  returning id into new_id;
  return json_build_object('ok', true, 'escalation_id', new_id);
end $$;

-- ---------- For the automation: which clinic is this? ----------
-- Settings for the clinic that owns a WhatsApp number. "allowed" is false when the
-- clinic is suspended or cancelled, so the automation only sends the paused notice.
-- Everything the automation needs to know about one clinic.
create or replace function public.clinic_json(c public.clinics) returns json
language sql stable as $$
  select json_build_object(
    'clinic_id', c.id, 'name', c.name, 'status', c.status, 'allowed', c.status in ('trial','active'),
    'timezone', c.timezone, 'contact_phone', c.contact_phone, 'alert_email', c.alert_email,
    'google_review_link', c.google_review_link, 'template_lang', c.template_lang,
    'wa_phone_number_id', c.wa_phone_number_id, 'wa_token_enc', c.wa_token_enc,
    'sms_enabled', c.sms_enabled, 'sms_number', c.sms_number, 'preferred_channel', c.preferred_channel,
    'remind_24h', c.remind_24h, 'remind_2h', c.remind_2h, 'ask_feedback', c.ask_feedback)
$$;

create or replace function public.clinic_for_whatsapp(p_phone_number_id text) returns json
language sql stable as $$
  select coalesce((select public.clinic_json(c) from public.clinics c where c.wa_phone_number_id = p_phone_number_id), '{}'::json)
$$;

-- The clinic that owns an SMS number (digits compared, so +1 (305) … and 1305… match).
create or replace function public.clinic_for_sms(p_to text) returns json
language sql stable as $$
  select coalesce((select public.clinic_json(c) from public.clinics c
                   where c.sms_enabled and c.sms_number is not null
                     and regexp_replace(c.sms_number, '\D', '', 'g') = regexp_replace(coalesce(p_to, ''), '\D', '', 'g')
                     and length(regexp_replace(coalesce(p_to, ''), '\D', '', 'g')) >= 8), '{}'::json)
$$;

create or replace function public.clinic_for_report_secret(p_secret_sha256 text) returns json
language sql stable as $$
  select coalesce((select public.clinic_json(c) from public.clinics c where c.report_secret_hash = lower(p_secret_sha256)), '{}'::json)
$$;

create or replace function public.clinic_by_id(p_clinic uuid) returns json
language sql stable as $$
  select coalesce((select public.clinic_json(c) from public.clinics c where c.id = p_clinic), '{}'::json)
$$;

-- SMS STOP / START: record the patient's choice (the SMS provider also enforces it).
create or replace function public.set_sms_opt_out(p_clinic uuid, p_phone text, p_out boolean) returns json
language plpgsql as $$
begin
  insert into public.patients (clinic_id, phone, last_message_at, channel, sms_opt_out)
  values (p_clinic, p_phone, now(), 'sms', p_out)
  on conflict (clinic_id, phone) do update set sms_opt_out = p_out, last_message_at = now();
  return json_build_object('ok', true, 'sms_opt_out', p_out);
end $$;

-- Replace one doctor's weekly sessions in a single step (dashboard).
-- p_sessions: [{"weekday":1,"start":"09:00","end":"13:00"}, …]
create or replace function public.set_doctor_sessions(p_clinic uuid, p_doctor_id bigint, p_sessions json) returns json
language plpgsql as $$
declare days smallint[];
begin
  if not exists (select 1 from public.doctors where id = p_doctor_id and clinic_id = p_clinic) then
    return json_build_object('ok', false, 'error', 'That doctor no longer exists.');
  end if;
  delete from public.doctor_sessions where doctor_id = p_doctor_id and clinic_id = p_clinic;
  insert into public.doctor_sessions (clinic_id, doctor_id, weekday, start_time, end_time)
  select p_clinic, p_doctor_id, (x->>'weekday')::smallint, (x->>'start')::time, (x->>'end')::time
  from json_array_elements(p_sessions) x;
  select array_agg(distinct weekday order by weekday) into days from public.doctor_sessions where doctor_id = p_doctor_id;
  update public.doctors set
    working_days = coalesce(days, '{}'),
    start_time = coalesce((select min(start_time) from public.doctor_sessions where doctor_id = p_doctor_id), start_time),
    end_time = coalesce((select max(end_time) from public.doctor_sessions where doctor_id = p_doctor_id), end_time)
  where id = p_doctor_id and clinic_id = p_clinic;
  return json_build_object('ok', true);
end $$;

-- ---------- Monitoring ----------
create or replace function public.beat(p_name text, p_detail text default null) returns json
language sql as $$
  insert into public.platform_heartbeat (name, seen_at, detail) values (p_name, now(), p_detail)
  on conflict (name) do update set seen_at = now(), detail = excluded.detail
  returning json_build_object('ok', true, 'seen_at', seen_at)
$$;

create or replace function public.health_check() returns json
language sql stable as $$
  select json_build_object('ok', true, 'db_time', now(),
    'scheduler_seen_at', (select seen_at from public.platform_heartbeat where name = 'scheduler'))
$$;

-- ---------- Usage this month, for plan limits (counts only) ----------
create or replace function public.clinic_usage(p_since timestamptz) returns table (
  clinic_id uuid, appointments bigint, messages bigint
) language sql stable as $$
  select c.id,
    (select count(*) from public.appointments a where a.clinic_id = c.id and a.created_at >= p_since),
    (select count(*) from public.processed_messages m where m.clinic_id = c.id and m.received_at >= p_since)
  from public.clinics c
$$;

-- ---------- Data retention (run daily by the automation) ----------
create or replace function public.purge_old_data() returns json
language plpgsql as $$
declare
  c record;
  cutoff timestamptz;
  x int;
  n_msgs int; n_err int; n_appt int := 0; n_rep int := 0; n_esc int := 0; n_calls int := 0; n_pat int := 0;
begin
  delete from public.processed_messages where received_at < now() - interval '90 days';
  get diagnostics n_msgs = row_count;
  delete from public.error_log where created_at < now() - interval '180 days';
  get diagnostics n_err = row_count;
  delete from public.doctor_time_off where ends_on < current_date - 365;
  for c in select id, retention_months from public.clinics where retention_months is not null loop
    cutoff := now() - make_interval(months => c.retention_months);
    delete from public.feedback where clinic_id = c.id and requested_at < cutoff;
    delete from public.appointments where clinic_id = c.id and slot_time < cutoff;
    get diagnostics x = row_count; n_appt := n_appt + x;
    delete from public.reports where clinic_id = c.id and created_at < cutoff;
    get diagnostics x = row_count; n_rep := n_rep + x;
    delete from public.escalations where clinic_id = c.id and created_at < cutoff and resolved;
    get diagnostics x = row_count; n_esc := n_esc + x;
    delete from public.calls where clinic_id = c.id and created_at < cutoff;
    get diagnostics x = row_count; n_calls := n_calls + x;
    delete from public.patients p where p.clinic_id = c.id and coalesce(p.last_message_at, p.created_at) < cutoff
      and not exists (select 1 from public.appointments a where a.patient_id = p.id)
      and not exists (select 1 from public.reports r where r.patient_id = p.id)
      and not exists (select 1 from public.escalations e where e.patient_id = p.id);
    get diagnostics x = row_count; n_pat := n_pat + x;
  end loop;
  return json_build_object('processed_messages', n_msgs, 'error_log', n_err, 'appointments', n_appt,
    'reports', n_rep, 'handoffs', n_esc, 'calls', n_calls, 'patients', n_pat);
end $$;

-- A paused clinic answers each patient at most once a day ("please call the clinic").
-- Returns true when the notice should be sent now, and records that it was.
drop function if exists public.claim_paused_notice(uuid, text);
create or replace function public.claim_paused_notice(p_clinic uuid, p_phone text) returns json
language plpgsql as $$
declare claimed int;
begin
  insert into public.patients (clinic_id, phone, last_message_at)
  values (p_clinic, p_phone, now())
  on conflict (clinic_id, phone) do update set last_message_at = now();
  update public.patients set paused_notice_at = now()
   where clinic_id = p_clinic and phone = p_phone
     and (paused_notice_at is null or paused_notice_at < now() - interval '24 hours');
  get diagnostics claimed = row_count;
  return json_build_object('send', claimed > 0);
end $$;

-- ---------- For the owner console: health of every clinic, counts only ----------
create or replace function public.operator_clinic_health() returns table (
  clinic_id uuid,
  last_message_at timestamptz,
  messages_24h bigint,
  bookings_7d bigint,
  upcoming bigint,
  open_handoffs bigint,
  urgent_handoffs bigint,
  send_failures_24h bigint,
  patients bigint,
  doctors bigint,
  staff bigint
) language sql stable as $$
  select c.id,
    (select max(received_at) from public.processed_messages m where m.clinic_id = c.id),
    (select count(*) from public.processed_messages m where m.clinic_id = c.id and m.received_at > now() - interval '24 hours'),
    (select count(*) from public.appointments a where a.clinic_id = c.id and a.created_at > now() - interval '7 days'),
    (select count(*) from public.appointments a where a.clinic_id = c.id and a.status = 'confirmed' and a.slot_time > now()),
    (select count(*) from public.escalations e where e.clinic_id = c.id and not e.resolved),
    (select count(*) from public.escalations e where e.clinic_id = c.id and not e.resolved and e.urgency = 'urgent'),
    (select count(*) from public.error_log x where x.clinic_id = c.id and x.created_at > now() - interval '24 hours'),
    (select count(*) from public.patients p where p.clinic_id = c.id),
    (select count(*) from public.doctors d where d.clinic_id = c.id and d.active),
    (select count(*) from public.staff_members s where s.clinic_id = c.id)
  from public.clinics c
$$;

-- Only the server-side key (dashboard server, n8n) may call these functions.
do $$
declare f text;
begin
  foreach f in array array[
    'clinic_tz(uuid)', 'fmt_local(uuid,timestamptz)', 'slot_problem(uuid,bigint,timestamptz,bigint)', 'patient_id_for(uuid,text)',
    'list_doctors(uuid)', 'available_slots(uuid,bigint,date)', 'my_appointments(uuid,text)',
    'book_appointment(uuid,text,bigint,date,text)', 'reschedule_appointment_at(uuid,text,bigint,timestamptz)',
    'reschedule_appointment(uuid,text,bigint,date,text)', 'cancel_appointment(uuid,text,bigint)',
    'my_reports(uuid,text)', 'create_escalation(uuid,text,text,text)',
    'clinic_for_whatsapp(text)', 'clinic_for_report_secret(text)', 'clinic_by_id(uuid)', 'claim_paused_notice(uuid,text)',
    'operator_clinic_health()', 'doctor_off(uuid,bigint,date)', 'doctor_day_hours(bigint,smallint)', 'clinic_json(public.clinics)',
    'clinic_for_sms(text)', 'set_sms_opt_out(uuid,text,boolean)', 'beat(text,text)', 'health_check()', 'clinic_usage(timestamptz)',
    'purge_old_data()', 'set_doctor_sessions(uuid,bigint,json)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
