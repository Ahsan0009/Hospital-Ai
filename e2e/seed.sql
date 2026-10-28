-- Test data for the local e2e stack only. Never run this against the real project.
-- Three clinics: A (the main fixture), B (a second, separate clinic) and C (suspended).
insert into clinics (id, name, status, plan, monthly_fee, currency, paid_until, timezone, contact_phone, alert_email, wa_phone_number_id, wa_display_number) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'City Care Clinic', 'active', 'growth', 25000, 'PKR', current_date + 20, 'Asia/Karachi', '042 111 222 333', 'desk@clinic.test', '100000000000001', '+92 300 1110001'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'Green Valley Hospital', 'active', 'pro', 45000, 'PKR', current_date - 3, 'Asia/Karachi', '051 444 555 666', 'ops@valley.test', '100000000000002', '+92 300 2220002'),
  ('cccccccc-0000-4000-8000-000000000003', 'Paused Dental', 'suspended', 'starter', 12000, 'PKR', current_date - 40, 'Asia/Karachi', '021 777 888 999', null, null, null);

insert into staff_members (user_id, clinic_id, role, email) values
  ('00000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'admin', 'admin@clinic.test'),
  ('00000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'staff', 'desk@clinic.test'),
  ('00000000-0000-4000-8000-000000000004', 'bbbbbbbb-0000-4000-8000-000000000002', 'admin', 'admin@valley.test'),
  ('00000000-0000-4000-8000-000000000005', 'cccccccc-0000-4000-8000-000000000003', 'admin', 'admin@paused.test');

insert into doctors (clinic_id, name, department, consultation_fee, working_days, start_time, end_time, slot_minutes, notes) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Sarah Mitchell', 'Cardiology',       3000, '{1,2,3,4,5}',   '09:00', '17:00', 30, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'James Carter',   'Orthopedics',      2500, '{1,2,4,5}',     '10:00', '16:00', 30, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Ayesha Khan',    'General Medicine', 1500, '{1,2,3,4,5,6}', '09:00', '13:00', 15, 'Walk-ins after 12:00'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Bilal Ahmed',    'Paediatrics',      2000, '{1,3,5,6}',     '15:00', '19:00', 20, null);

insert into patients (clinic_id, phone, name, last_message_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '923001111111', 'Ali Raza',      now() - interval '20 minutes'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '923002222222', 'Sara Malik',    now() - interval '2 hours'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '923003333333', 'Omar Farooq',   now() - interval '1 day'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '923004444444', 'Hina Aslam',    now() - interval '3 hours'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '923005555555', 'Usman Tariq',   now() - interval '5 days'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '923006666666', 'Zainab Noor',   now() - interval '40 minutes'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '923007777777', 'Fahad Iqbal',   now() - interval '2 days'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '923008888888', 'Maryam Javed',  now() - interval '6 hours'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '923009999999', 'Kamran Shah',   null),
  ('aaaaaaaa-0000-4000-8000-000000000001', '923000000010', 'Nida Hassan',   now() - interval '9 days'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '923000000011', null,            now() - interval '10 minutes'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '923000000012', 'Rehan Ali',     now() - interval '30 days');

-- Helper: a slot on a day relative to today, in the clinic's time zone.
create or replace function pg_temp.slot(day_offset int, t text) returns timestamptz
language sql as $$
  select (((now() at time zone 'Asia/Karachi')::date + day_offset) + t::time) at time zone 'Asia/Karachi'
$$;

insert into appointments (clinic_id, patient_id, doctor_id, slot_time, status, source, reminder_24h_sent, feedback_sent, notes) values
  -- today
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923001111111'), 1, pg_temp.slot(0,'09:00'), 'completed', 'whatsapp', true, false, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923002222222'), 1, pg_temp.slot(0,'09:30'), 'no_show',   'whatsapp', true, false, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923003333333'), 1, pg_temp.slot(0,'11:00'), 'confirmed', 'whatsapp', true, false, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923004444444'), 1, pg_temp.slot(0,'15:30'), 'confirmed', 'staff',    true, false, 'Bring previous ECG'),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923005555555'), 2, pg_temp.slot(0,'10:00'), 'completed', 'whatsapp', true, false, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923006666666'), 2, pg_temp.slot(0,'13:30'), 'confirmed', 'whatsapp', true, false, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923007777777'), 3, pg_temp.slot(0,'09:15'), 'completed', 'whatsapp', true, false, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923008888888'), 3, pg_temp.slot(0,'10:45'), 'cancelled', 'whatsapp', true, false, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923009999999'), 3, pg_temp.slot(0,'12:00'), 'confirmed', 'staff',    false, false, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923000000010'), 4, pg_temp.slot(0,'16:20'), 'confirmed', 'whatsapp', true, false, null),
  -- yesterday
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923000000012'), 1, pg_temp.slot(-1,'10:00'), 'completed', 'whatsapp', true, true, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923006666666'), 3, pg_temp.slot(-1,'09:30'), 'completed', 'whatsapp', true, true, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923007777777'), 2, pg_temp.slot(-1,'11:00'), 'completed', 'whatsapp', true, true, null),
  -- coming days
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923001111111'), 2, pg_temp.slot(1,'10:30'), 'confirmed', 'whatsapp', false, false, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923002222222'), 1, pg_temp.slot(1,'14:00'), 'confirmed', 'whatsapp', false, false, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923000000011'), 4, pg_temp.slot(2,'15:00'), 'confirmed', 'whatsapp', false, false, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923008888888'), 3, pg_temp.slot(3,'09:45'), 'confirmed', 'whatsapp', false, false, null);

insert into escalations (clinic_id, patient_phone, patient_id, reason, urgency, notified, resolved, created_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '923006666666', (select id from patients where phone='923006666666'), 'Chest pain since morning, wants to speak to a doctor', 'urgent', true, false, now() - interval '25 minutes'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '923000000011', (select id from patients where phone='923000000011'), 'Asking whether insurance from State Life is accepted', 'normal', true, false, now() - interval '12 minutes'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '923004444444', (select id from patients where phone='923004444444'), 'Wants a home visit for elderly mother', 'normal', true, false, now() - interval '3 hours'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '923003333333', (select id from patients where phone='923003333333'), 'Asked for a refund of the consultation fee', 'normal', true, true, now() - interval '1 day');
update escalations set resolved_at = created_at + interval '2 hours', resolved_by = 'desk@clinic.test', staff_note = 'Called back, refund processed at counter' where resolved;

insert into reports (clinic_id, patient_id, report_type, report_link, summary, is_critical, created_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923001111111'), 'CBC', 'https://lab.example/r/abc', 'Report marks haemoglobin 7.9 g/dL as low (critical).', true, now() - interval '40 minutes'),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923003333333'), 'Lipid profile', 'https://lab.example/r/def', 'LDL 162 mg/dL, flagged high by the lab.', false, now() - interval '5 hours'),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923005555555'), 'X-ray left knee', null, 'No abnormalities flagged in the report.', false, now() - interval '1 day'),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923007777777'), 'HbA1c', 'https://lab.example/r/ghi', 'HbA1c 6.1%, within the range the lab marks as normal.', false, now() - interval '3 days'),
  ('aaaaaaaa-0000-4000-8000-000000000001', (select id from patients where phone='923007777777'), 'Ultrasound', 'javascript:alert(document.cookie)', 'Link from a misbehaving lab system; must never be clickable.', false, now() - interval '4 days');

insert into feedback (clinic_id, appointment_id, patient_phone, rating, requested_at, responded_at)
select a.clinic_id, a.id, p.phone, r.rating, now() - interval '20 hours', case when r.rating is null then null else now() - interval '19 hours' end
from (values ('923000000012', 5), ('923006666666', 2), ('923007777777', 4)) as r(phone, rating)
join patients p on p.phone = r.phone
join appointments a on a.patient_id = p.id and a.feedback_sent;

insert into error_log (clinic_id, source, patient_phone, error_detail, created_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'whatsapp_send', '923002222222', 'Template appointment_reminder_2h not approved yet', now() - interval '2 hours');

-- Clinic B: its own doctor, patients (one shares a phone number with clinic A), visits and a handoff.
insert into doctors (clinic_id, name, department, consultation_fee, working_days, start_time, end_time, slot_minutes) values
  ('bbbbbbbb-0000-4000-8000-000000000002', 'Valley Surgeon', 'Surgery', 5000, '{1,2,3,4,5,6,7}', '09:00', '17:00', 30);
insert into patients (clinic_id, phone, name, last_message_at) values
  ('bbbbbbbb-0000-4000-8000-000000000002', '923001111111', 'Valley Patient Shared', now() - interval '1 hour'),
  ('bbbbbbbb-0000-4000-8000-000000000002', '923330000001', 'Valley Patient Two', now() - interval '3 hours');
insert into appointments (clinic_id, patient_id, doctor_id, slot_time, status, source) values
  ('bbbbbbbb-0000-4000-8000-000000000002', (select id from patients where phone='923330000001'), (select id from doctors where name='Valley Surgeon'), pg_temp.slot(0,'12:00'), 'confirmed', 'whatsapp'),
  ('bbbbbbbb-0000-4000-8000-000000000002', (select id from patients where clinic_id='bbbbbbbb-0000-4000-8000-000000000002' and phone='923001111111'), (select id from doctors where name='Valley Surgeon'), pg_temp.slot(1,'10:00'), 'confirmed', 'whatsapp');
insert into escalations (clinic_id, patient_phone, patient_id, reason, urgency, notified, resolved) values
  ('bbbbbbbb-0000-4000-8000-000000000002', '923330000001', (select id from patients where phone='923330000001'), 'Valley-only question about surgery prep', 'normal', true, false);
insert into processed_messages (clinic_id, wa_message_id, received_at)
select 'aaaaaaaa-0000-4000-8000-000000000001', 'wamid.e2e.' || g, now() - (g || ' minutes')::interval from generate_series(1, 5) g;
