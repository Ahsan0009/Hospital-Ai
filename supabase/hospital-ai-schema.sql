-- =====================================================================
-- Hospital AI — database setup (run ONCE in a NEW, dedicated Supabase project)
-- Supabase → SQL Editor → paste this whole file → Run.
-- Safe to re-run: it only creates what is missing.
--
-- Security model
--   * Every table has row-level security ON with no policies, so the public
--     (anon / authenticated) keys can read or change NOTHING.
--   * Only the n8n workflow, using the service_role key, can reach the data.
--   * The AI assistant never queries tables directly. It calls the functions at
--     the bottom, and the workflow (not the AI) passes the patient's WhatsApp
--     number, so a patient can only ever see or change their own records.
-- =====================================================================

-- ---------- Settings ----------
create table if not exists public.clinic_settings (
  key   text primary key,
  value text not null
);
-- CHANGE 'UTC' to the clinic's time zone, e.g. 'Asia/Karachi' or 'America/New_York'.
insert into public.clinic_settings (key, value) values ('timezone', 'UTC')
on conflict (key) do nothing;

-- ---------- Core tables ----------
create table if not exists public.patients (
  id              bigint generated always as identity primary key,
  phone           text not null unique check (phone ~ '^[0-9]{6,15}$'),
  name            text,
  last_message_at timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists public.doctors (
  id               bigint generated always as identity primary key,
  name             text not null,
  department       text not null,
  consultation_fee numeric(10,2),
  working_days     smallint[] not null default '{1,2,3,4,5}',  -- ISO days: 1=Mon … 7=Sun
  start_time       time not null default '09:00',
  end_time         time not null default '17:00',
  slot_minutes     smallint not null default 15 check (slot_minutes between 5 and 240),
  active           boolean not null default true,
  notes            text,
  check (end_time > start_time)
);

create table if not exists public.appointments (
  id                bigint generated always as identity primary key,
  patient_id        bigint not null references public.patients(id) on delete cascade,
  doctor_id         bigint not null references public.doctors(id),
  slot_time         timestamptz not null,
  status            text not null default 'confirmed'
                    check (status in ('confirmed','cancelled','completed','no_show')),
  source            text not null default 'whatsapp',
  rescheduled       boolean not null default false,
  reminder_24h_sent boolean not null default false,
  reminder_2h_sent  boolean not null default false,
  feedback_sent     boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- One confirmed booking per doctor per time slot, enforced by the database.
create unique index if not exists appointments_no_double_booking
  on public.appointments (doctor_id, slot_time) where status = 'confirmed';
create index if not exists appointments_status_slot on public.appointments (status, slot_time);
create index if not exists appointments_patient on public.appointments (patient_id);

create table if not exists public.processed_messages (
  wa_message_id text primary key,
  patient_phone text,
  received_at   timestamptz not null default now()
);

create table if not exists public.feedback (
  id             bigint generated always as identity primary key,
  appointment_id bigint references public.appointments(id) on delete cascade,
  patient_phone  text not null,
  rating         smallint check (rating between 1 and 5),
  requested_at   timestamptz not null default now(),
  responded_at   timestamptz
);
create unique index if not exists feedback_one_per_appointment on public.feedback (appointment_id);

create table if not exists public.reports (
  id          bigint generated always as identity primary key,
  patient_id  bigint not null references public.patients(id) on delete cascade,
  report_type text not null,
  report_link text,
  summary     text,          -- AI-written note for STAFF only; never sent to the patient
  is_critical boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.escalations (
  id            bigint generated always as identity primary key,
  patient_phone text,
  patient_id    bigint references public.patients(id) on delete set null,
  reason        text not null,
  urgency       text not null default 'normal' check (urgency in ('normal','urgent')),
  resolved      boolean not null default false,
  notified      boolean not null default false,
  created_at    timestamptz not null default now()
);

create table if not exists public.calls (
  id                 bigint generated always as identity primary key,
  call_id            text,
  appointment_id     bigint,
  patient_phone      text,
  outcome            text,
  transcript_summary text,
  created_at         timestamptz not null default now()
);

create table if not exists public.error_log (
  id            bigint generated always as identity primary key,
  source        text,
  patient_phone text,
  error_detail  text,
  created_at    timestamptz not null default now()
);

-- ---------- Lock everything down ----------
do $$
declare t text;
begin
  foreach t in array array['clinic_settings','patients','doctors','appointments','processed_messages',
                           'feedback','reports','escalations','calls','error_log']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ---------- Helpers ----------
create or replace function public.clinic_tz() returns text
language sql stable as $$
  select coalesce((select value from public.clinic_settings where key = 'timezone'), 'UTC')
$$;

create or replace function public.fmt_local(ts timestamptz) returns text
language sql stable as $$
  select to_char(ts at time zone public.clinic_tz(), 'FMDay, DD FMMonth YYYY, HH12:MI AM')
$$;

-- Returns NULL if the doctor can take this slot, otherwise a reason a patient can read.
create or replace function public.slot_problem(p_doctor_id bigint, p_slot timestamptz, p_ignore_appointment bigint default null)
returns text language plpgsql stable as $$
declare
  d public.doctors;
  local_ts timestamp := p_slot at time zone public.clinic_tz();
  t time := local_ts::time;
begin
  select * into d from public.doctors where id = p_doctor_id and active;
  if not found then return 'That doctor was not found or is not taking appointments.'; end if;
  if p_slot <= now() then return 'That time has already passed. Please choose a future time.'; end if;
  if extract(isodow from local_ts)::smallint <> all (d.working_days) then
    return format('Dr. %s does not work on %s.', d.name, trim(to_char(local_ts, 'Day')));
  end if;
  if t < d.start_time or t + make_interval(mins => d.slot_minutes) > d.end_time then
    return format('Dr. %s sees patients between %s and %s.', d.name,
                  to_char(d.start_time, 'HH12:MI AM'), to_char(d.end_time, 'HH12:MI AM'));
  end if;
  if (extract(epoch from (t - d.start_time)) / 60)::int % d.slot_minutes <> 0 then
    return format('Appointments with Dr. %s start every %s minutes from %s.', d.name, d.slot_minutes,
                  to_char(d.start_time, 'HH12:MI AM'));
  end if;
  if exists (select 1 from public.appointments a
             where a.doctor_id = p_doctor_id and a.slot_time = p_slot and a.status = 'confirmed'
               and a.id is distinct from p_ignore_appointment) then
    return 'That slot has just been taken. Please choose another time.';
  end if;
  return null;
end $$;

create or replace function public.patient_id_for(p_phone text) returns bigint
language sql stable as $$ select id from public.patients where phone = p_phone $$;

-- ---------- Functions the AI assistant can call (through the workflow) ----------

-- All active doctors with department, fee and hours.
create or replace function public.list_doctors() returns json
language sql stable as $$
  select coalesce(json_agg(json_build_object(
    'doctor_id', d.id, 'name', d.name, 'department', d.department,
    'consultation_fee', d.consultation_fee,
    'working_days', (select string_agg(case x when 1 then 'Mon' when 2 then 'Tue' when 3 then 'Wed'
                       when 4 then 'Thu' when 5 then 'Fri' when 6 then 'Sat' else 'Sun' end, ', ' order by x)
                     from unnest(d.working_days) x),
    'hours', to_char(d.start_time, 'HH12:MI AM') || ' – ' || to_char(d.end_time, 'HH12:MI AM'),
    'slot_minutes', d.slot_minutes, 'notes', d.notes
  ) order by d.department, d.name), '[]'::json)
  from public.doctors d where d.active
$$;

-- Free times for one doctor on one date (clinic time zone).
create or replace function public.available_slots(p_doctor_id bigint, p_date date) returns json
language plpgsql stable as $$
declare
  d public.doctors;
  tz text := public.clinic_tz();
  free text[] := '{}';
  t time;
  slot timestamptz;
begin
  select * into d from public.doctors where id = p_doctor_id and active;
  if not found then return json_build_object('ok', false, 'error', 'Doctor not found.'); end if;
  if p_date < (now() at time zone tz)::date then
    return json_build_object('ok', false, 'error', 'That date has already passed.');
  end if;
  if extract(isodow from p_date)::smallint <> all (d.working_days) then
    return json_build_object('ok', false, 'error',
      format('Dr. %s does not work on %s.', d.name, trim(to_char(p_date, 'Day'))));
  end if;
  t := d.start_time;
  while t + make_interval(mins => d.slot_minutes) <= d.end_time loop
    slot := (p_date + t) at time zone tz;
    if slot > now() and not exists (select 1 from public.appointments a
        where a.doctor_id = d.id and a.slot_time = slot and a.status = 'confirmed') then
      free := free || to_char(t, 'HH24:MI');
    end if;
    t := t + make_interval(mins => d.slot_minutes);
    exit when t = '00:00'::time;
  end loop;
  return json_build_object('ok', true, 'doctor', d.name, 'department', d.department,
    'date', to_char(p_date, 'FMDay, DD FMMonth YYYY'), 'free_times_24h', free,
    'note', case when array_length(free, 1) is null then 'Fully booked on this date.' else null end);
end $$;

-- This patient's upcoming confirmed appointments.
create or replace function public.my_appointments(p_phone text) returns json
language sql stable as $$
  select coalesce(json_agg(json_build_object(
    'appointment_id', a.id, 'doctor', d.name, 'department', d.department,
    'when', public.fmt_local(a.slot_time)) order by a.slot_time), '[]'::json)
  from public.appointments a
  join public.doctors d on d.id = a.doctor_id
  join public.patients p on p.id = a.patient_id
  where p.phone = p_phone and a.status = 'confirmed' and a.slot_time > now() - interval '1 hour'
$$;

create or replace function public.book_appointment(p_phone text, p_doctor_id bigint, p_date date, p_time text)
returns json language plpgsql as $$
declare
  pid bigint := public.patient_id_for(p_phone);
  slot timestamptz;
  problem text;
  new_id bigint;
  d public.doctors;
begin
  if pid is null then return json_build_object('ok', false, 'error', 'Patient record not found.'); end if;
  begin
    slot := (p_date + p_time::time) at time zone public.clinic_tz();
  exception when others then
    return json_build_object('ok', false, 'error', 'Please give the time as HH:MM, for example 10:30.');
  end;
  problem := public.slot_problem(p_doctor_id, slot);
  if problem is not null then return json_build_object('ok', false, 'error', problem); end if;
  if exists (select 1 from public.appointments a where a.patient_id = pid and a.doctor_id = p_doctor_id
             and a.status = 'confirmed'
             and (a.slot_time at time zone public.clinic_tz())::date = p_date) then
    return json_build_object('ok', false, 'error', 'You already have an appointment with this doctor on that day.');
  end if;
  begin
    insert into public.appointments (patient_id, doctor_id, slot_time, source)
    values (pid, p_doctor_id, slot, 'whatsapp') returning id into new_id;
  exception when unique_violation then
    return json_build_object('ok', false, 'error', 'That slot has just been taken. Please choose another time.');
  end;
  select * into d from public.doctors where id = p_doctor_id;
  return json_build_object('ok', true, 'appointment_id', new_id, 'doctor', d.name,
                           'department', d.department, 'when', public.fmt_local(slot));
end $$;

-- Shared by WhatsApp (date + time) and the voice-call callback (exact timestamp).
create or replace function public.reschedule_appointment_at(p_phone text, p_appointment_id bigint, p_new_slot timestamptz)
returns json language plpgsql as $$
declare
  a public.appointments;
  problem text;
begin
  select a2.* into a from public.appointments a2 join public.patients p on p.id = a2.patient_id
  where a2.id = p_appointment_id and p.phone = p_phone and a2.status = 'confirmed';
  if not found then return json_build_object('ok', false, 'error', 'No upcoming appointment with that ID was found for you.'); end if;
  problem := public.slot_problem(a.doctor_id, p_new_slot, a.id);
  if problem is not null then return json_build_object('ok', false, 'error', problem); end if;
  begin
    update public.appointments set slot_time = p_new_slot, rescheduled = true,
      reminder_24h_sent = false, reminder_2h_sent = false, updated_at = now()
    where id = a.id;
  exception when unique_violation then
    return json_build_object('ok', false, 'error', 'That slot has just been taken. Please choose another time.');
  end;
  return json_build_object('ok', true, 'appointment_id', a.id, 'when', public.fmt_local(p_new_slot));
end $$;

create or replace function public.reschedule_appointment(p_phone text, p_appointment_id bigint, p_date date, p_time text)
returns json language plpgsql as $$
declare slot timestamptz;
begin
  begin
    slot := (p_date + p_time::time) at time zone public.clinic_tz();
  exception when others then
    return json_build_object('ok', false, 'error', 'Please give the time as HH:MM, for example 10:30.');
  end;
  return public.reschedule_appointment_at(p_phone, p_appointment_id, slot);
end $$;

create or replace function public.cancel_appointment(p_phone text, p_appointment_id bigint)
returns json language plpgsql as $$
declare a_id bigint; a_slot timestamptz;
begin
  update public.appointments a set status = 'cancelled', updated_at = now()
  from public.patients p
  where a.id = p_appointment_id and p.id = a.patient_id and p.phone = p_phone and a.status = 'confirmed'
  returning a.id, a.slot_time into a_id, a_slot;
  if a_id is null then return json_build_object('ok', false, 'error', 'No upcoming appointment with that ID was found for you.'); end if;
  return json_build_object('ok', true, 'appointment_id', a_id, 'cancelled', public.fmt_local(a_slot));
end $$;

-- Report status only — never links or results.
create or replace function public.my_reports(p_phone text) returns json
language sql stable as $$
  select coalesce(json_agg(json_build_object('report_type', r.report_type,
    'ready_since', public.fmt_local(r.created_at)) order by r.created_at desc), '[]'::json)
  from public.reports r join public.patients p on p.id = r.patient_id
  where p.phone = p_phone
$$;

create or replace function public.create_escalation(p_phone text, p_reason text, p_urgency text default 'normal')
returns json language plpgsql as $$
declare new_id bigint;
begin
  insert into public.escalations (patient_phone, patient_id, reason, urgency)
  values (p_phone, public.patient_id_for(p_phone), left(coalesce(nullif(trim(p_reason), ''), 'Patient asked for help'), 2000),
          case when lower(coalesce(p_urgency, '')) ~ '(urgent|emergenc)' then 'urgent' else 'normal' end)
  returning id into new_id;
  return json_build_object('ok', true, 'escalation_id', new_id);
end $$;

-- Only the workflow's service_role key may call these functions.
do $$
declare f text;
begin
  foreach f in array array[
    'clinic_tz()', 'fmt_local(timestamptz)', 'slot_problem(bigint,timestamptz,bigint)', 'patient_id_for(text)',
    'list_doctors()', 'available_slots(bigint,date)', 'my_appointments(text)',
    'book_appointment(text,bigint,date,text)', 'reschedule_appointment_at(text,bigint,timestamptz)',
    'reschedule_appointment(text,bigint,date,text)', 'cancel_appointment(text,bigint)',
    'my_reports(text)', 'create_escalation(text,text,text)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ---------- Example doctors (edit or delete, then add the clinic's real doctors) ----------
-- insert into public.doctors (name, department, consultation_fee, working_days, start_time, end_time, slot_minutes)
-- values ('Ayesha Khan', 'General Medicine', 2000, '{1,2,3,4,5}', '09:00', '13:00', 15),
--        ('Bilal Ahmed', 'Paediatrics',      2500, '{1,3,5,6}',   '15:00', '19:00', 20);
