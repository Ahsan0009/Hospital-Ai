# Clinic desk: staff dashboard for the Hospital AI WhatsApp assistant

A web dashboard for the clinic's front desk and admins, built on the same design
system as the PayloadPipe dashboard (palette J, IBM Plex, three type sizes).
It reads and writes the same Supabase database the n8n workflow uses.

| Page | What staff do there |
|---|---|
| **Today** | See what needs attention (handoffs, critical reports, low ratings, failed messages, unmarked visits) and the day sheet: every doctor's visits, hour by hour. |
| **Appointments** | Browse by day or week, filter by doctor and status, book walk-ins and phone callers, mark visits seen or missed, move or cancel. |
| **Handoffs** | Patients the assistant passed to a person. Contact them and close each one with a note. |
| **Patients** | Search by name or number; open a patient's visits, reports, ratings and handoffs. |
| **Reports** | Lab reports received, with the staff-only note. Critical filter. |
| **Feedback** | Average rating, spread, by-doctor averages, latest replies. |
| **Doctors** | The schedule the assistant books from (admins edit it). |
| **Staff** (admins only) | Add accounts, set each one to Clinic admin, Front desk or No access, set a new password, delete. |
| **Settings** | Clinic name and time zone (admins), each person's own password, WhatsApp send problems, staff activity log. |

Voice calls are not in the dashboard; they are a later phase.

## How it keeps patient data safe

- The browser never reads clinic tables. The public (anon) key can only sign in;
  every table has row-level security with no policies.
- Every page and every action runs on the server, checks the signed-in user's
  role (`staff` or `admin` in Supabase **app metadata**, which users cannot edit),
  and only then uses the service-role key, which never leaves the server.
- Admin-only actions (doctors, settings) are checked again on the server, so a
  front-desk account cannot call them even by replaying the request.
- Bookings, moves and cancellations go through the same database functions the
  WhatsApp assistant uses, so double-booking and out-of-hours bookings are refused.
- Every change made from the dashboard is written to `staff_activity`.
- Lab report links are only clickable if they are `https://` links.

## Set up

### 1. Database (Supabase, the `hospital-ai` project)

1. SQL Editor: run `supabase/hospital-ai-schema.sql` if it has not been run yet,
   then run `supabase/dashboard.sql`. Both are safe to run again.
2. Authentication → Sign In / Providers: turn **off** "Allow new users to sign up".
   Staff accounts are created by an admin only.
3. Create the **first admin** only: Authentication → Users → **Add user** (email,
   a password of at least 12 characters, "Auto confirm" on), then in the SQL Editor:

   ```sql
   update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'
   where email = 'owner@clinic.com';
   ```

4. Sign in to the dashboard as that admin and add everyone else from the **Staff**
   page. An account without a role cannot open the dashboard.

### Roles

| Role | Can do |
|---|---|
| `admin` (Clinic admin) | Everything below, plus doctors and hours, clinic settings, and staff accounts. Cannot change or delete their own access, and the last admin cannot be removed. |
| `staff` (Front desk) | Today, appointments, handoffs, patients, reports, feedback. Book, move, cancel and mark visits; close handoffs; change their own password. |
| none | Cannot open the dashboard (signed out with a message). |

Removing a role takes effect on the person's next page load; no need to wait for
their session to expire.

### 2. Automatic WhatsApp messages for desk changes

When staff book, move or cancel, the dashboard asks the n8n workflow
(`POST /webhook/dashboard-notify`) to message the patient.

1. On the n8n server, add `DASHBOARD_NOTIFY_SECRET` (a long random string, for
   example from `openssl rand -hex 32`) to `hospital.env`, then
   `sudo docker compose up -d`.
2. Submit and get approved two more WhatsApp templates (Utility, English):
   - `appointment_booked`: "Hi {{1}}, your appointment with Dr. {{2}} is booked for {{3}}. Reply to this message if you need to change it."
   - `appointment_cancelled`: "Hi {{1}}, your appointment with Dr. {{2}} on {{3}} has been cancelled. Reply to this message to book a new time."
   (`appointment_rescheduled` is already on the list.)

Without these, the dashboard still works; it just says the patient was not messaged.

### 3. Deploy (Vercel)

1. Push this folder to a new private GitHub repository.
2. In Vercel, **Add New → Project**, import the repository (framework: Next.js).
3. Add these environment variables (Production and Preview):

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the **anon / publishable** key from the same page |
   | `SUPABASE_SERVICE_ROLE_KEY` | the **service_role** key (server only; never prefix it with `NEXT_PUBLIC_`) |
   | `N8N_NOTIFY_URL` | `https://agent.websoul.tech/webhook/dashboard-notify` |
   | `DASHBOARD_NOTIFY_SECRET` | the same value as on the n8n server |

4. Deploy, then in Supabase → Authentication → URL Configuration set the
   **Site URL** to the Vercel address.

## Develop and test

```bash
npm install
npm run dev          # needs .env.local with the variables above
npm run lint && npm run typecheck && npm run build
```

`npm run e2e` runs 33 end-to-end checks (including an axe accessibility scan of every page) in a real browser against a real
Postgres + PostgREST with the hospital schema, a stand-in for Supabase Auth and
a stand-in for the n8n notify webhook (see `e2e/`). It needs a local Postgres
(`PG_HOST`, `PG_PORT`), a PostgREST binary (`PGREST_BIN`) and Playwright with
Chromium, and the app built with the `.env.local` that points at the stand-in
(`http://127.0.0.1:54321`). Never point the tests at the real project: they
drop and recreate the database.
