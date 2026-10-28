// End-to-end test of the dashboard against a real Postgres + PostgREST with the
// hospital schema, a fake Supabase Auth, and a fake n8n notify endpoint.
//
// Needs: a running Postgres (PG_HOST / PG_PORT), PGREST_BIN pointing at a PostgREST
// binary, Playwright with Chromium, and `npm run build` done with e2e/.env values.
// Usage: PGREST_BIN=/path/to/postgrest npm run e2e
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ROOT = new URL("..", import.meta.url).pathname;
const PG_HOST = process.env.PG_HOST || "/var/tmp/hpg";
const PG_PORT = process.env.PG_PORT || "54329";
const BASE = "http://127.0.0.1:3100";
const SHOTS = `${ROOT}e2e/shots`;
fs.mkdirSync(SHOTS, { recursive: true });

const psql = (args, input) =>
  execFileSync("psql", ["-h", PG_HOST, "-p", PG_PORT, "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-At", ...args], { input, encoding: "utf8" }).trim();
const sql = (q) => psql(["-d", "hosp", "-c", q]);

// ---------- fresh database ----------
psql(["-d", "postgres", "-c", "drop database if exists hosp with (force)"]);
psql(["-d", "postgres", "-c", "create database hosp"]);
psql(["-d", "hosp"], `
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit password 'pw'; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`);
psql(["-d", "hosp", "-f", process.env.SCHEMA_SQL || `${ROOT}supabase/hospital-ai-schema.sql`]);
psql(["-d", "hosp", "-f", `${ROOT}supabase/dashboard.sql`]);
psql(["-d", "hosp", "-f", `${ROOT}e2e/seed.sql`]);

// ---------- services ----------
const { start, ANON_KEY, SERVICE_KEY } = await import("./stack.mjs");
const stack = start();

const notified = [];
const notify = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.headers["x-dashboard-secret"] !== "e2e-notify-secret") {
      res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    notified.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sent: true }));
  });
});
notify.listen(54399, "127.0.0.1");

// Refuse to run against an old server that is still holding the port.
const stale = await fetch(`${BASE}/login`).then(() => true, () => false);
if (stale) {
  console.error("Port 3100 is already in use; stop the other server first.");
  process.exit(2);
}
const next = spawn(`${ROOT}node_modules/.bin/next`, ["start", "-p", "3100"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true });
let nextLog = "";
next.stdout.on("data", (d) => (nextLog += d));
next.stderr.on("data", (d) => (nextLog += d));
for (let i = 0; i < 60; i++) {
  try {
    await fetch(`${BASE}/login`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
await new Promise((r) => setTimeout(r, 1500)); // PostgREST schema cache

// ---------- tests ----------
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  pass  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  FAIL  ${name}\n        ${e.message.split("\n")[0]}`);
  }
}

const browser = await chromium.launch();
const errors = [];
async function newPage(viewport = { width: 1440, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return { ctx, page };
}
async function login(page, email, password) {
  await page.goto(`${BASE}/login`);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("button[type=submit]");
}

const tomorrowSarah = () => {
  // Next date (from tomorrow) on which Sarah Mitchell (Mon-Fri) works, in the clinic's time zone.
  return sql(`select d::date from generate_series(((now() at time zone clinic_tz())::date + 1), ((now() at time zone clinic_tz())::date + 7), interval '1 day') d where extract(isodow from d) between 1 and 5 limit 1`);
};

await test("Signed-out visitors are sent to sign in", async () => {
  const res = await fetch(`${BASE}/appointments`, { redirect: "manual" });
  assert.equal(res.status, 307);
  assert.match(res.headers.get("location"), /\/login$/);
});

await test("The public key cannot read any clinic table", async () => {
  const res = await fetch("http://127.0.0.1:54321/rest/v1/patients?select=phone", { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
  assert.ok(res.status >= 400, `status ${res.status}`);
  const body = await res.json();
  assert.ok(!Array.isArray(body), "anon received patient rows");
});

await test("Wrong password shows a clear error", async () => {
  const { ctx, page } = await newPage();
  await login(page, "desk@clinic.test", "wrong-password-1");
  await page.getByText("That email and password do not match").waitFor();
  await ctx.close();
});

await test("An account without a staff role is refused", async () => {
  const { ctx, page } = await newPage();
  await login(page, "patient@clinic.test", "nope-pass-12345");
  await page.getByText("not set up for the clinic dashboard").waitFor();
  assert.match(page.url(), /\/login/);
  await ctx.close();
});

const desk = await newPage();
const admin = await newPage();

await test("Front desk signs in and sees today", async () => {
  await login(desk.page, "desk@clinic.test", "desk-pass-12345");
  await desk.page.waitForURL(`${BASE}/`);
  await desk.page.getByRole("heading", { name: "Needs attention" }).waitFor();
  await desk.page.getByText("Urgent: Zainab Noor needs a person").waitFor();
  assert.equal(await desk.page.locator(".nav-count").innerText(), "3");
  assert.ok((await desk.page.locator(".visit").count()) >= 9, "day sheet visits missing");
  await desk.page.screenshot({ path: `${SHOTS}/today.png`, fullPage: true });
});

await test("Booking rejects a local number without the country code", async () => {
  const p = desk.page;
  await p.getByRole("button", { name: "Book appointment" }).first().click();
  await p.getByLabel("WhatsApp number").fill("0300 1234567");
  await p.getByLabel("Date").fill(tomorrowSarah());
  await p.locator(".slot").first().click();
  await p.getByRole("button", { name: "Book appointment" }).last().click();
  await p.getByText("Include the country code").waitFor();
});

let bookedId;
await test("Front desk books a walk-in; patient is created and messaged", async () => {
  const p = desk.page;
  await p.getByLabel("WhatsApp number").fill("92 311 1222333");
  await p.getByLabel("Patient name").fill("Test Walkin");
  await p.locator(".slot").first().click();
  await p.screenshot({ path: `${SHOTS}/book-dialog.png` });
  await p.getByRole("button", { name: "Book appointment" }).last().click();
  await p.getByText(/Booked for .* The patient was sent a WhatsApp message\./).waitFor();
  const row = sql(`select a.id || '|' || a.source || '|' || p.name from appointments a join patients p on p.id = a.patient_id where p.phone = '923111222333'`);
  const [id, source, name] = row.split("|");
  bookedId = Number(id);
  assert.equal(source, "staff");
  assert.equal(name, "Test Walkin");
  assert.equal(notified.at(-1).type, "booked");
  assert.equal(notified.at(-1).patient_phone, "923111222333");
  await p.getByRole("button", { name: "Done" }).click();
});

await test("Moving the booking frees the old time and messages the patient", async () => {
  const p = desk.page;
  const date = tomorrowSarah();
  await p.goto(`${BASE}/appointments?date=${date}&q=Walkin`);
  await p.getByRole("cell", { name: /Test Walkin/ }).click();
  const before = sql(`select slot_time from appointments where id = ${bookedId}`);
  await p.getByRole("button", { name: "Move", exact: true }).click();
  await p.locator(".drawer .slot").nth(2).click();
  await p.getByRole("button", { name: "Move appointment" }).click();
  await p.getByText(/Moved to .* The patient was sent a WhatsApp message\./).waitFor();
  const after = sql(`select slot_time from appointments where id = ${bookedId}`);
  assert.notEqual(after, before);
  assert.equal(notified.at(-1).type, "rescheduled");
  await p.screenshot({ path: `${SHOTS}/drawer.png` });
});

await test("Cancelling the booking messages the patient", async () => {
  const p = desk.page;
  await p.getByRole("button", { name: "Cancel appointment" }).click();
  await p.getByRole("button", { name: "Cancel appointment" }).last().click();
  await p.getByText(/Appointment cancelled\. The patient was sent a WhatsApp message\./).waitFor();
  assert.equal(sql(`select status from appointments where id = ${bookedId}`), "cancelled");
  assert.equal(notified.at(-1).type, "cancelled");
  await p.keyboard.press("Escape");
});

await test("A missed visit can be marked from the day sheet", async () => {
  const p = desk.page;
  const id = sql(`insert into appointments (patient_id, doctor_id, slot_time, status) values ((select id from patients where phone='923009999999'), 4, date_trunc('hour', now()) - interval '1 hour', 'confirmed') returning id`);
  await p.goto(`${BASE}/appointments?q=Kamran`);
  await p.locator("tr", { hasText: "Dr. Bilal Ahmed" }).click();
  await p.getByRole("button", { name: "Mark as missed" }).click();
  await p.getByText("Marked as missed.").waitFor();
  assert.equal(sql(`select status from appointments where id = ${id}`), "no_show");
  await p.keyboard.press("Escape");
});

await test("Closing a handoff records who did it and why", async () => {
  const p = desk.page;
  await p.goto(`${BASE}/handoffs`);
  await p.locator(".attention-item", { hasText: "Zainab Noor" }).getByRole("button", { name: "Close handoff" }).click();
  await p.getByLabel("What did you do?").fill("Called back, sent to emergency");
  await p.getByRole("button", { name: "Close handoff" }).last().click();
  await p.getByText("Handoff closed.").waitFor();
  const row = sql(`select resolved || '|' || resolved_by || '|' || staff_note from escalations where patient_phone = '923006666666'`);
  assert.equal(row, "true|desk@clinic.test|Called back, sent to emergency");
  await p.waitForFunction(() => document.querySelector(".nav-count")?.textContent === "2");
  await p.screenshot({ path: `${SHOTS}/handoffs.png`, fullPage: true });
});

await test("Front desk cannot edit doctors or settings", async () => {
  const p = desk.page;
  await p.goto(`${BASE}/doctors`);
  await p.getByText("Only clinic admins can change doctors").waitFor();
  assert.equal(await p.getByRole("button", { name: "Add doctor" }).count(), 0);
  await p.goto(`${BASE}/settings`);
  assert.ok(await p.getByLabel("Clinic name").isDisabled());
});

let doctorAction;
await test("Admin adds a doctor", async () => {
  const p = admin.page;
  await login(p, "admin@clinic.test", "admin-pass-1234");
  await p.waitForURL(`${BASE}/`);
  await p.goto(`${BASE}/doctors`);
  await p.getByRole("button", { name: "Add doctor" }).click();
  await p.getByLabel("Name").fill("Dr. Hamza Qureshi");
  await p.getByLabel("Department").fill("Dermatology");
  await p.locator(".check-chip", { hasText: "Sat" }).click();
  await p.getByLabel("Visit length (min)").fill("20");
  p.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"] && !doctorAction) doctorAction = { id: r.headers()["next-action"], body: r.postData(), router: r.headers()["next-router-state-tree"] };
  });
  await p.screenshot({ path: `${SHOTS}/doctor-dialog.png` });
  await p.getByRole("button", { name: "Add doctor" }).last().click();
  await p.getByText("Doctor added.").waitFor();
  assert.equal(sql(`select name || '|' || slot_minutes || '|' || array_to_string(working_days, ',') from doctors where department = 'Dermatology'`), "Hamza Qureshi|20|1,2,3,4,5,6");
});

await test("A doctor action replayed with a front-desk session is refused", async () => {
  assert.ok(doctorAction, "no server action request was captured");
  const cookies = (await desk.ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const res = await fetch(`${BASE}/doctors`, {
    method: "POST",
    headers: { "next-action": doctorAction.id, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component", cookie: cookies, ...(doctorAction.router ? { "next-router-state-tree": doctorAction.router } : {}) },
    body: doctorAction.body.replace("Hamza Qureshi", "Intruder Doctor"),
  });
  const text = await res.text();
  assert.match(text, /Only clinic admins can change this/);
  assert.equal(sql(`select count(*) from doctors where name = 'Intruder Doctor'`), "0");
});

await test("The same action with no session at all is refused", async () => {
  const res = await fetch(`${BASE}/doctors`, {
    method: "POST",
    headers: { "next-action": doctorAction.id, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" },
    body: doctorAction.body.replace("Hamza Qureshi", "Anonymous Doctor"),
    redirect: "manual",
  });
  assert.ok([307, 401, 403].includes(res.status) || /session has ended/.test(await res.text()));
  assert.equal(sql(`select count(*) from doctors where name = 'Anonymous Doctor'`), "0");
});

await test("A doctor with upcoming visits cannot be taken off the schedule", async () => {
  const p = admin.page;
  await p.locator("tr", { hasText: "Sarah Mitchell" }).getByRole("button", { name: "Edit" }).click();
  await p.getByLabel("Patients can book this doctor").uncheck();
  await p.getByRole("button", { name: "Save changes" }).click();
  await p.getByText(/still has \d+ upcoming appointment/).waitFor();
  assert.equal(sql(`select active from doctors where name = 'Sarah Mitchell'`), "t");
  await p.keyboard.press("Escape");
});

await test("Admin renames the clinic and the change is logged", async () => {
  const p = admin.page;
  await p.goto(`${BASE}/settings`);
  await p.getByLabel("Clinic name").fill("City Care Clinic Gulberg");
  await p.getByRole("button", { name: "Save changes" }).click();
  await p.getByText("Saved.").waitFor();
  await p.locator(".brand span", { hasText: "City Care Clinic Gulberg" }).waitFor();
  await p.getByText("Changed clinic settings").waitFor();
  await p.getByText("Closed handoff").waitFor();
  await p.screenshot({ path: `${SHOTS}/settings.png`, fullPage: true });
});

await test("Invalid time zone is rejected", async () => {
  const p = admin.page;
  await p.getByLabel("Time zone").fill("Mars/Olympus");
  await p.getByRole("button", { name: "Save changes" }).click();
  await p.getByText("That time zone is not recognised").waitFor();
  assert.equal(sql(`select value from clinic_settings where key = 'timezone'`), "Asia/Karachi");
});

await test("Patient search and history", async () => {
  const p = admin.page;
  await p.goto(`${BASE}/patients?q=Hina`);
  assert.equal(await p.locator("tbody tr").count(), 1);
  await p.getByRole("link", { name: "Hina Aslam" }).click();
  await p.getByRole("heading", { name: "Hina Aslam" }).waitFor();
  await p.getByText("Wants a home visit for elderly mother").waitFor();
  await p.screenshot({ path: `${SHOTS}/patient.png`, fullPage: true });
  await p.goto(`${BASE}/patients?q=${encodeURIComponent("a%,name.eq.x")}`);
  await p.getByRole("heading", { name: "Patients" }).waitFor();
});

await test("Reports and feedback pages show the right figures", async () => {
  const p = admin.page;
  await p.goto(`${BASE}/reports?critical=1`);
  assert.equal(await p.locator("tbody tr").count(), 1);
  await p.goto(`${BASE}/reports`);
  const unsafe = await p.locator('a[href^="javascript"]').evaluateAll((els) => els.map((e) => e.outerHTML));
  assert.equal(unsafe.length, 0, `unsafe report link rendered: ${unsafe.join(" ")}`);
  await p.goto(`${BASE}/feedback`);
  await p.getByText("3.7").waitFor();
  await p.screenshot({ path: `${SHOTS}/feedback.png`, fullPage: true });
});

await test("Dark theme and phone layout render", async () => {
  const p = admin.page;
  await p.goto(`${BASE}/`);
  await p.getByRole("button", { name: "Switch between light and dark theme" }).click();
  await p.screenshot({ path: `${SHOTS}/today-dark.png`, fullPage: true });
  await p.getByRole("button", { name: "Switch between light and dark theme" }).click();
  const phone = await newPage({ width: 390, height: 844 });
  await login(phone.page, "desk@clinic.test", "desk-pass-12345");
  await phone.page.waitForURL(`${BASE}/`);
  await phone.page.locator(".sheet-list").waitFor();
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px on a phone`);
  await phone.page.screenshot({ path: `${SHOTS}/today-phone.png`, fullPage: true });
  await phone.ctx.close();
});


// ---------- staff accounts and roles ----------
let staffAction;
await test("Admin adds a front-desk account", async () => {
  const p = admin.page;
  p.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"] && r.url().endsWith("/staff") && !staffAction) staffAction = { id: r.headers()["next-action"], body: r.postData() };
  });
  await p.goto(`${BASE}/staff`);
  await p.getByRole("button", { name: "Add staff" }).click();
  await p.getByLabel("Email address").fill("nurse@clinic.test");
  await p.getByLabel("Temporary password").fill("nurse-temp-pass-1");
  await p.screenshot({ path: `${SHOTS}/staff-add.png` });
  await p.getByRole("button", { name: "Create account" }).click();
  await p.getByText("Account created for nurse@clinic.test").waitFor();
  await p.getByRole("cell", { name: /nurse@clinic\.test/ }).waitFor();
  await p.screenshot({ path: `${SHOTS}/staff.png`, fullPage: true });
});

const nurse = await newPage();
await test("The new front-desk account signs in without admin pages", async () => {
  await login(nurse.page, "nurse@clinic.test", "nurse-temp-pass-1");
  await nurse.page.waitForURL(`${BASE}/`);
  assert.equal(await nurse.page.locator(".sidebar-nav a", { hasText: "Staff" }).count(), 0, "front desk sees the Staff link");
  await nurse.page.goto(`${BASE}/staff`);
  await nurse.page.getByText("Only clinic admins can add staff").waitFor();
  assert.equal(await nurse.page.locator("table").count(), 0, "front desk can see the staff list");
});

await test("A staff-account action replayed by the front desk is refused", async () => {
  assert.ok(staffAction, "no staff action captured");
  const cookies = (await nurse.ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const res = await fetch(`${BASE}/staff`, {
    method: "POST",
    headers: { "next-action": staffAction.id, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component", cookie: cookies },
    body: staffAction.body.replace("nurse@clinic.test", "sneaky@clinic.test"),
  });
  assert.match(await res.text(), /Only clinic admins can change this/);
  const users = await (await fetch("http://127.0.0.1:54321/auth/v1/admin/users", { headers: { Authorization: `Bearer ${SERVICE_KEY}` } })).json();
  assert.ok(!users.users.some((u) => u.email === "sneaky@clinic.test"), "front desk created an account");
});

await test("Promoting to admin gives the admin pages straight away", async () => {
  const p = admin.page;
  await p.goto(`${BASE}/staff`);
  await p.getByLabel("Access for nurse@clinic.test").selectOption("admin");
  await p.getByText("nurse@clinic.test is now clinic admin.").waitFor();
  await nurse.page.goto(`${BASE}/`);
  await nurse.page.locator(".sidebar-nav a", { hasText: "Staff" }).waitFor();
});

await test("An admin cannot change their own access", async () => {
  const p = admin.page;
  assert.ok(await p.getByLabel("Access for admin@clinic.test").isDisabled());
});

await test("Removing access locks the account out on its next page load", async () => {
  const p = admin.page;
  await p.getByLabel("Access for nurse@clinic.test").selectOption("none");
  await p.getByText("can no longer open the dashboard").waitFor();
  await nurse.page.goto(`${BASE}/appointments`);
  await nurse.page.waitForURL(/\/login/);
  await nurse.page.getByText("not set up for the clinic dashboard").waitFor();
});

await test("An admin can set a new password, and the old one stops working", async () => {
  const p = admin.page;
  await p.getByLabel("Access for nurse@clinic.test").selectOption("staff");
  await p.getByText("is now front desk").waitFor();
  await p.locator("tr", { hasText: "nurse@clinic.test" }).getByRole("button", { name: "Set password" }).click();
  await p.getByLabel("New password", { exact: true }).fill("nurse-second-pass-2");
  await p.getByRole("button", { name: "Set password" }).last().click();
  await p.getByText("New password set for nurse@clinic.test").waitFor();
  const fresh = await newPage();
  await login(fresh.page, "nurse@clinic.test", "nurse-temp-pass-1");
  await fresh.page.getByText("That email and password do not match").waitFor();
  await login(fresh.page, "nurse@clinic.test", "nurse-second-pass-2");
  await fresh.page.waitForURL(`${BASE}/`);
  await fresh.ctx.close();
});

await test("Staff change their own password from Settings", async () => {
  const fresh = await newPage();
  await login(fresh.page, "nurse@clinic.test", "nurse-second-pass-2");
  await fresh.page.waitForURL(`${BASE}/`);
  await fresh.page.goto(`${BASE}/settings`);
  await fresh.page.getByLabel("New password", { exact: true }).fill("short");
  await fresh.page.getByLabel("Type it again").fill("short");
  await fresh.page.getByRole("button", { name: "Change password" }).click();
  await fresh.page.getByText("Use at least 12 characters.").waitFor();
  await fresh.page.getByLabel("New password", { exact: true }).fill("nurse-own-pass-333");
  await fresh.page.getByLabel("Type it again").fill("nurse-own-pass-333");
  await fresh.page.getByRole("button", { name: "Change password" }).click();
  await fresh.page.getByText("Password changed.").waitFor();
  await fresh.ctx.close();
  const again = await newPage();
  await login(again.page, "nurse@clinic.test", "nurse-own-pass-333");
  await again.page.waitForURL(`${BASE}/`);
  await again.ctx.close();
});

await test("Deleting an account stops it signing in", async () => {
  const p = admin.page;
  await p.goto(`${BASE}/staff`);
  await p.locator("tr", { hasText: "nurse@clinic.test" }).getByRole("button", { name: "Delete" }).click();
  await p.getByRole("button", { name: "Delete account" }).click();
  await p.getByText("nurse@clinic.test was deleted.").waitFor();
  const fresh = await newPage();
  await login(fresh.page, "nurse@clinic.test", "nurse-own-pass-333");
  await fresh.page.getByText("That email and password do not match").waitFor();
  await fresh.ctx.close();
});

await test("Accessibility: no serious or critical issues on any page (axe)", async () => {
  const axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  const p = admin.page;
  const problems = [];
  for (const path of ["/", "/appointments", "/handoffs", "/patients", "/reports", "/feedback", "/doctors", "/staff", "/settings"]) {
    await p.goto(`${BASE}${path}`);
    await p.waitForLoadState("networkidle");
    await p.addScriptTag({ content: axeSource });
    const r = await p.evaluate(async () => await window.axe.run(document, { resultTypes: ["violations"] }));
    for (const v of r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")) {
      problems.push(`${path}: ${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes[0].target.join(" ")}`);
    }
  }
  const login = await newPage();
  await login.page.goto(`${BASE}/login`);
  await login.page.addScriptTag({ content: axeSource });
  const r = await login.page.evaluate(async () => await window.axe.run(document, { resultTypes: ["violations"] }));
  for (const v of r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")) problems.push(`/login: ${v.id} x${v.nodes.length}: ${v.nodes[0].target.join(" ")}`);
  await login.ctx.close();
  assert.equal(problems.length, 0, problems.join("\n        "));
});

await test("Sign out ends the session", async () => {
  const p = desk.page;
  await p.goto(`${BASE}/`);
  await p.getByRole("button", { name: "Sign out" }).click();
  await p.waitForURL(`${BASE}/login`);
  await p.goto(`${BASE}/`);
  assert.match(p.url(), /\/login$/);
});

await test("No browser errors on any page", async () => {
  assert.equal(errors.length, 0, errors.slice(0, 5).join("\n        "));
});

await browser.close();
process.kill(-next.pid, "SIGTERM");
notify.close();
stack.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} / ${results.length} passed`);
if (failed.length) {
  console.log(nextLog.split("\n").filter((l) => /error|Error/.test(l)).slice(-20).join("\n"));
  process.exit(1);
}
