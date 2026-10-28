# Clinic desk: multi-clinic dashboard for the Hospital AI assistant

One deployment serves many clinics, in Pakistan on WhatsApp and in the US on
WhatsApp or SMS. Each clinic's staff see only their own clinic; you (the
platform owner) get a private **owner console** at `/operator` for clinics,
billing, usage and health. It reads and writes the same Supabase database the
n8n workflow uses.

| Page | Who | What happens there |
|---|---|---|
| **Today** | clinic staff | What needs attention (handoffs, critical reports, low ratings, failed messages, unmarked visits, visits booked on a day off) and the day sheet. |
| **Appointments** | clinic staff | Browse by day or week, book walk-ins and phone callers, mark seen or missed, move or cancel. |
| **Handoffs** | clinic staff | Patients the assistant passed to a person; close each with a note. |
| **Patients** | clinic staff | Search; a patient's visits, reports, ratings and handoffs; WhatsApp or SMS per patient when the clinic has SMS. |
| **Reports / Feedback** | clinic staff | Lab reports with the staff note; ratings by doctor. |
| **Doctors** | clinic admins edit | Each doctor's week, with up to three sittings a day (morning and evening clinics), and days off, leave and clinic holidays. |
| **Staff** | clinic admins | Add accounts, Clinic admin or Front desk, new password, delete. |
| **Settings** | clinic staff | Clinic name, time zone, alert email, phone, review link, which automatic messages patients get (admins); own password; send problems; activity log. |
| **Forgot password** | anyone | Email link to choose a new password. |
| **Owner console** `/operator` | you only | Every clinic with paid-until, channels, usage this month against its plan, and health; automation check-in; add clinics; record payments and print invoices; suspend, resume, cancel, delete; connect WhatsApp, SMS and the lab system; time zone, limits and data retention per clinic. Never shows patient data. |

## How clinics are kept apart

- Every table has a `clinic_id`. Links between tables use `(clinic_id, id)`
  keys, so an appointment can never point at another clinic's patient or doctor.
- Signed-in staff can only **read** rows of their own clinic (row-level
  security through `my_clinic_id()`), and only while the clinic is on trial or
  active. All writes happen on the server with an explicit clinic filter, after
  the server has looked up the person's clinic in `staff_members`.
- The automation finds the clinic from the WhatsApp number or SMS number a
  patient wrote to, from the lab system's secret, or from the clinic id the
  dashboard sends. Every database function takes the clinic id first.
- The owner console is protected twice: your account must have the `operator`
  role in Supabase app metadata (users cannot set this) **and** your email must
  be in `OPERATOR_EMAILS`. Anyone else gets "not found".
- A clinic's own WhatsApp token is encrypted (AES-256-GCM) with
  `CLINIC_SECRETS_KEY` before it reaches the database; the lab secret is stored
  only as a SHA-256 fingerprint and shown once. Twilio requests are checked
  against Twilio's signature; unsigned requests are refused.
- Suspended or cancelled clinics: staff see a paused screen, patients who
  message get one notice a day with the clinic's phone number, reminders and
  feedback stop. Nothing is deleted until you delete the clinic.

## Update the live project to this version

The database is already multi-clinic. This version adds doctor sittings, days
off, SMS, message switches, usage, monitoring and data retention. Do these in
order; nothing changes for patients until step 6.

1. **Back up**: Supabase → Database → Backups, confirm today's backup exists.
2. **SQL Editor: run `supabase/multi-clinic.sql` again.** It is safe to run
   more than once. It adds the new tables and columns, turns every doctor's
   working days into sittings, and replaces the functions.
3. **Supabase → Authentication → URL Configuration**: Site URL = the dashboard
   address; add `https://<dashboard>/auth/confirm` to Redirect URLs.
   **Authentication → Email Templates → Reset Password**: make the link
   `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password`.
   Set up custom SMTP (Authentication → SMTP) before clinics rely on it; the
   built-in sender is limited to a few emails an hour.
4. **Vercel → Settings → Environment Variables**, add or check:

   | Name | Value |
   |---|---|
   | `OPERATOR_EMAILS` | your owner email (comma-separate if more than one) |
   | `CLINIC_SECRETS_KEY` | 64 hex characters: `openssl rand -hex 32`. Same value on the n8n server. Losing it means re-entering clinic tokens. |
   | `SUPPORT_CONTACT` | what paused clinics should do, e.g. `WhatsApp 0300 1234567` |
   | `N8N_WEBHOOK_BASE` | `https://<your-n8n-server>/webhook` (shown on clinic pages) |
   | `SITE_URL` | the dashboard address, used in password-reset links |
   | `INVOICE_FROM_NAME`, `INVOICE_FROM_DETAILS` | your business name and address lines for invoices (lines separated by `\|`) |
   | `OPERATOR_TIMEZONE` | optional, default `Asia/Karachi` |

   Then **Redeploy**. Vercel Hobby does not allow commercial use: move the
   project to Vercel Pro before the first paying clinic.
5. **n8n server** (`hospital.env`, then `sudo docker compose up -d`): the same
   `CLINIC_SECRETS_KEY` and `DASHBOARD_NOTIFY_SECRET` as Vercel. Only if a
   clinic will use SMS: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and
   `TWILIO_SMS_WEBHOOK_URL` = `https://<your-n8n-server>/webhook/sms-inbound`
   (exactly as entered in Twilio, or the signature check fails).
6. **Publish** the updated n8n workflow.
7. **Monitoring**: add a free UptimeRobot (or similar) HTTP monitor on
   `https://<your-n8n-server>/webhook/health`. It answers 200 when the database
   answers and the schedulers checked in during the last 15 minutes, 503
   otherwise. The owner console also shows the last check-in.

## Add a new clinic

1. Owner console → **Add clinic**: name, time zone, plan, fee, trial days, alert
   email, and the clinic admin's email with a temporary password (give it to
   them privately).
2. **WhatsApp**: connect their number to your Meta app (same webhook URL for
   every clinic) and enter the **phone number ID** on the clinic page. If the
   number is in the clinic's own WhatsApp account with its own token, paste the
   token; it is encrypted and never shown again. Submit the WhatsApp templates
   on that account and wait for approval.
3. **SMS (US clinics)**: buy a number in Twilio, register it for A2P 10DLC
   (brand plus campaign, about a week), set its messaging webhook to the URL
   shown on the clinic page (HTTP POST), then turn SMS on in the clinic's SMS
   panel with that number. Patients who text the number are answered by text;
   choose whether desk bookings default to SMS.
4. The clinic admin signs in, adds doctors (with their sittings and days off)
   and staff, and picks which automatic messages patients get. Done.

## Billing (manual)

Record payments in the owner console when money arrives: the clinic's
paid-until date moves forward and overdue clinics are listed at the top. Each
payment has a printable invoice (Invoice link, then Print or save as PDF).
Suspend after the grace period; recording a payment with "make the clinic
active" ticked brings them back at once. Usage this month is shown against the
plan's limits; clinics over a limit are flagged. Prices and Meta and Twilio
costs are in the pricing documents.

## Data retention

The workflow's daily cleanup removes processed-message ids after 90 days,
error logs after 180 days, and days off that ended over a year ago. If you set
a retention period for a clinic in the owner console (6 to 120 months), its
visits, reports, ratings, calls and closed handoffs older than that are deleted
too; with no period set, clinic records are kept.

## Develop and test

```bash
npm install
npm run dev          # needs .env.local with the variables above
npm run lint && npm run typecheck && npm run build
PGREST_BIN=/path/to/postgrest npm run e2e
```

`npm run e2e` runs 57 end-to-end checks in a real browser against a real
Postgres + PostgREST built from `supabase/multi-clinic.sql`, with stand-ins for
Supabase Auth (including password-reset emails) and the n8n webhook. Besides
the staff workflows (split shifts, days off, time zone and message switches,
SMS, invoices, forgot password) it attacks the isolation: a second clinic's
admin, replayed actions with another clinic's ids, direct database calls with
a clinic user's token, a suspended clinic, an operator flag without the owner
email, and every owner-console action. Set `LEGACY_SCHEMA_DIR` to a folder
holding the old `hospital-ai-schema.sql` and `dashboard.sql` to run the same
checks on an upgraded database instead of a new one. Never point the tests at
the real project: they drop and recreate the database.
