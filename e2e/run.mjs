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
psql(["-d", "hosp", "-f", `${ROOT}e2e/prelude.sql`]);
if (process.env.LEGACY_SCHEMA_DIR) {
  // Upgrade path: build the old single-clinic database first, then migrate it.
  psql(["-d", "hosp", "-f", `${process.env.LEGACY_SCHEMA_DIR}/hospital-ai-schema.sql`]);
  psql(["-d", "hosp", "-f", `${process.env.LEGACY_SCHEMA_DIR}/dashboard.sql`]);
}
psql(["-d", "hosp", "-f", `${ROOT}supabase/multi-clinic.sql`]);
psql(["-d", "hosp", "-f", `${ROOT}e2e/seed.sql`]);

// ---------- services ----------
const { start, ANON_KEY, SERVICE_KEY, sign, USERS } = await import("./stack.mjs");
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
    console.log(`  FAIL  ${name}\n        ${e.message.split("\n").slice(0, 6).join("\n        ")}`);
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

const CLINIC_A = "aaaaaaaa-0000-4000-8000-000000000001";
/** Polls a query until it returns the wanted value (server actions finish after the click returns). */
async function until(q, want, ms = 10000) {
  let got;
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
    got = sql(q);
    if (got === want) return;
  }
  assert.equal(got, want);
}
const CLINIC_B = "bbbbbbbb-0000-4000-8000-000000000002";
const tomorrowSarah = () => {
  // Next date (from tomorrow) on which Sarah Mitchell (Mon-Fri) works, in the clinic's time zone.
  return sql(`select d::date from generate_series(((now() at time zone 'Asia/Karachi')::date + 1), ((now() at time zone 'Asia/Karachi')::date + 7), interval '1 day') d where extract(isodow from d) between 1 and 5 limit 1`);
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

await test("An account not linked to a clinic is refused", async () => {
  const { ctx, page } = await newPage();
  await login(page, "patient@clinic.test", "nope-pass-12345");
  await page.getByText("This account is not linked to a clinic").waitFor();
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

let statusAction;
await test("A missed visit can be marked from the day sheet", async () => {
  const p = desk.page;
  p.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"] && /no_show/.test(r.postData() ?? "") && !statusAction) statusAction = { id: r.headers()["next-action"], body: r.postData(), url: r.url() };
  });
  const id = sql(`insert into appointments (clinic_id, patient_id, doctor_id, slot_time, status) values ('${CLINIC_A}', (select id from patients where phone='923009999999'), 4, date_trunc('hour', now()) - interval '1 hour', 'confirmed') returning id`);
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
  // Mon to Fri 9 to 5 is the default; add Saturday, then split Monday into a morning and an evening sitting.
  await p.locator(".week-day", { hasText: "Sat" }).getByRole("checkbox").check();
  await p.getByLabel("Monday sitting 1 finishes").fill("13:00");
  await p.getByRole("button", { name: "Add a sitting on Monday" }).click();
  await p.getByLabel("Monday sitting 2 starts").fill("17:00");
  await p.getByLabel("Monday sitting 2 finishes").fill("21:00");
  await p.getByLabel("Visit length (min)").fill("20");
  p.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"] && !doctorAction) doctorAction = { id: r.headers()["next-action"], body: r.postData(), router: r.headers()["next-router-state-tree"] };
  });
  await p.screenshot({ path: `${SHOTS}/doctor-dialog.png` });
  await p.getByRole("button", { name: "Add doctor" }).last().click();
  await p.getByText("Doctor added.").waitFor();
  assert.equal(sql(`select name || '|' || slot_minutes || '|' || array_to_string(working_days, ',') from doctors where department = 'Dermatology'`), "Hamza Qureshi|20|1,2,3,4,5,6");
  assert.equal(sql(`select count(*) from doctor_sessions s join doctors d on d.id = s.doctor_id where d.department = 'Dermatology'`), "7");
  await p.locator("tr", { hasText: "Hamza Qureshi" }).getByText("9:00 AM to 1:00 PM, 5:00 PM to 9:00 PM").waitFor();
});

await test("Split shifts: patients can book the evening sitting but not the gap between", async () => {
  const id = sql(`select id from doctors where department = 'Dermatology'`);
  const monday = sql(`select d::date from generate_series(((now() at time zone 'Asia/Karachi')::date + 1), ((now() at time zone 'Asia/Karachi')::date + 7), interval '1 day') d where extract(isodow from d) = 1 limit 1`);
  const at = (t) => `('${monday} ${t}'::timestamp at time zone 'Asia/Karachi')`;
  assert.equal(sql(`select coalesce(slot_problem('${CLINIC_A}', ${id}, ${at("10:00")}), 'ok')`), "ok");
  assert.equal(sql(`select coalesce(slot_problem('${CLINIC_A}', ${id}, ${at("18:00")}), 'ok')`), "ok");
  assert.notEqual(sql(`select coalesce(slot_problem('${CLINIC_A}', ${id}, ${at("14:00")}), 'ok')`), "ok");
  const slots = JSON.parse(sql(`select available_slots('${CLINIC_A}', ${id}, '${monday}')::text`));
  const list = JSON.stringify(slots);
  assert.ok(list.includes("17:00") || list.includes("5:00"), `no evening slots: ${list.slice(0, 200)}`);
  assert.ok(!list.includes("14:00") && !list.includes("2:00 PM"), "slots offered in the gap between sittings");
  // A doctor inserted outside the dashboard still gets a week of sessions.
  sql(`insert into doctors (clinic_id, name, department, working_days, start_time, end_time) values ('${CLINIC_A}', 'Imported Doctor', 'Imported', '{2,4}', '10:00', '12:00')`);
  assert.equal(sql(`select count(*) from doctor_sessions s join doctors d on d.id = s.doctor_id where d.name = 'Imported Doctor'`), "2");
  sql(`delete from doctors where name = 'Imported Doctor'`);
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

await test("Days off block booking and flag visits already booked", async () => {
  const p = admin.page;
  const day = tomorrowSarah();
  const sarah = sql(`select id from doctors where name = 'Sarah Mitchell' and clinic_id = '${CLINIC_A}'`);
  sql(`insert into appointments (clinic_id, patient_id, doctor_id, slot_time, status, source) values ('${CLINIC_A}', (select id from patients where phone = '923003333333'), ${sarah}, ('${day} 12:00'::timestamp at time zone 'Asia/Karachi'), 'confirmed', 'staff')`);
  await p.goto(`${BASE}/doctors`);
  await p.getByRole("button", { name: "Add days off" }).click();
  await p.getByLabel("Who").selectOption({ label: "Dr. Sarah Mitchell" });
  await p.getByLabel("First day").fill(day);
  await p.getByLabel("Last day").fill(day);
  await p.getByLabel("Reason (staff only)").fill("Cardiology conference");
  await p.getByRole("button", { name: "Save days off" }).click();
  await p.getByText(/\d+ booked visits? falls? in this period/).waitFor();
  await p.locator("#time-off").getByText("Cardiology conference").waitFor();
  const problem = sql(`select slot_problem('${CLINIC_A}', ${sarah}, ('${day} 15:00'::timestamp at time zone 'Asia/Karachi'))`);
  assert.match(problem, /not seeing patients/);
  assert.ok(!problem.includes("conference"), "the private reason leaks to patients");
  assert.equal(sql(`select available_slots('${CLINIC_A}', ${sarah}, '${day}')::json ->> 'ok'`), "false");
  await p.screenshot({ path: `${SHOTS}/doctors.png`, fullPage: true });
  await p.goto(`${BASE}/`);
  await p.getByText(/\d+ booked visits? falls? on a day off or closure/).waitFor();
});

await test("A clinic holiday closes every doctor; removing it reopens booking", async () => {
  const p = admin.page;
  const day = tomorrowSarah();
  await p.goto(`${BASE}/doctors`);
  await p.getByRole("button", { name: "Add days off" }).click();
  await p.getByLabel("Who").selectOption("clinic");
  await p.getByLabel("First day").fill(day);
  await p.getByLabel("Last day").fill(day);
  await p.getByRole("button", { name: "Save days off" }).click();
  await p.getByText(/Saved\./).waitFor();
  const omar = sql(`select id from doctors where clinic_id = '${CLINIC_A}' and name <> 'Sarah Mitchell' and active order by id limit 1`);
  assert.match(sql(`select slot_problem('${CLINIC_A}', ${omar}, ('${day} 10:00'::timestamp at time zone 'Asia/Karachi'))`), /clinic is closed/);
  await p.getByRole("button", { name: /^Remove clinic closure on / }).click();
  await p.getByRole("button", { name: /^Remove days off for Dr\. Sarah Mitchell on / }).click();
  await p.locator("#time-off").getByText("Cardiology conference").waitFor({ state: "detached" });
  assert.equal(sql(`select count(*) from doctor_time_off where clinic_id = '${CLINIC_A}'`), "0");
  sql(`delete from appointments where clinic_id = '${CLINIC_A}' and source = 'staff' and slot_time = ('${day} 12:00'::timestamp at time zone 'Asia/Karachi')`);
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
  // The picker only lists real zones, so slip a fake option in to test the server check.
  await p.locator("#clinic-tz").evaluate((el) => el.add(new Option("Mars", "Mars/Olympus")));
  await p.getByLabel("Time zone").selectOption("Mars/Olympus");
  await p.getByRole("button", { name: "Save changes" }).click();
  await p.getByText("That time zone is not recognised").waitFor();
  assert.equal(sql(`select timezone from clinics where id = '${CLINIC_A}'`), "Asia/Karachi");
});

await test("The clinic can change its own time zone and message settings", async () => {
  const p = admin.page;
  await p.goto(`${BASE}/settings`);
  await p.getByLabel("Time zone").selectOption("America/New_York");
  await p.getByLabel("Reminder 2 hours before the visit").uncheck();
  await p.getByLabel("Ask for a rating after the visit").uncheck();
  await p.getByRole("button", { name: "Save changes" }).click();
  await until(`select timezone || '|' || remind_24h || '|' || remind_2h || '|' || ask_feedback from clinics where id = '${CLINIC_A}'`, "America/New_York|true|false|false");
  assert.equal(sql(`select clinic_by_id('${CLINIC_A}')::json ->> 'remind_2h'`), "false");
  await p.getByLabel("Time zone").selectOption("Asia/Karachi");
  await p.getByLabel("Reminder 2 hours before the visit").check();
  await p.getByLabel("Ask for a rating after the visit").check();
  await p.getByRole("button", { name: "Save changes" }).click();
  await until(`select timezone || '|' || remind_2h || '|' || ask_feedback from clinics where id = '${CLINIC_A}'`, "Asia/Karachi|true|true");
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

let roleAction;
await test("Promoting to admin gives the admin pages straight away", async () => {
  const p = admin.page;
  p.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"] && /"admin"/.test(r.postData() ?? "") && r.url().endsWith("/staff") && !roleAction) roleAction = { id: r.headers()["next-action"], body: r.postData() };
  });
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


// ---------- clinics are kept apart ----------
const valley = await newPage();
const cookiesOf = async (ctx) => (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
async function replay(ctx, action, url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "next-action": action.id, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component", cookie: await cookiesOf(ctx) },
    body,
  });
  return res.text();
}
const userJwt = (email) => {
  const u = USERS.find((x) => x.email === email);
  return sign({ sub: u.id, role: "authenticated", aud: "authenticated", email, exp: Math.floor(Date.now() / 1000) + 600 });
};

await test("A second clinic's admin sees only their own clinic", async () => {
  const p = valley.page;
  await login(p, "admin@valley.test", "valley-pass-1234");
  await p.waitForURL(`${BASE}/`);
  await p.locator(".brand span", { hasText: "Green Valley Hospital" }).waitFor();
  await p.getByText("Valley Surgeon").first().waitFor();
  const html = await p.content();
  for (const other of ["Sarah Mitchell", "Zainab Noor", "City Care"]) assert.ok(!html.includes(other), `clinic B sees ${other}`);
  await p.goto(`${BASE}/patients`);
  assert.equal(await p.locator("tbody tr").count(), 2);
  await p.getByText("Valley Patient Shared").waitFor();
  assert.equal(await p.getByText("Ali Raza").count(), 0, "clinic A patient with the same phone number leaks into clinic B");
  for (const path of ["/handoffs", "/reports", "/feedback", "/doctors", "/staff", "/settings"]) {
    await p.goto(`${BASE}${path}`);
    const body = await p.content();
    for (const other of ["Zainab Noor", "Sarah Mitchell", "admin@clinic.test", "desk@clinic.test", "haemoglobin", "City Care Clinic"]) assert.ok(!body.includes(other), `${path} in clinic B shows ${other}`);
  }
  await p.screenshot({ path: `${SHOTS}/clinic-b.png`, fullPage: true });
});

await test("Opening another clinic's patient by its id shows not found", async () => {
  const id = sql(`select id from patients where clinic_id = '${CLINIC_A}' and phone = '923004444444'`);
  const res = await valley.page.goto(`${BASE}/patients/${id}`);
  assert.equal(res.status(), 404);
  assert.equal(await valley.page.getByText("Hina Aslam").count(), 0);
});

await test("Another clinic's appointment cannot be changed by replaying an action", async () => {
  assert.ok(statusAction, "no appointment action captured");
  const target = sql(`insert into appointments (clinic_id, patient_id, doctor_id, slot_time, status) values ('${CLINIC_A}', (select id from patients where phone='923002222222'), 1, now() - interval '3 hours', 'confirmed') returning id`);
  const body = statusAction.body.replace(/^\[\d+/, `[${target}`);
  const text = await replay(valley.ctx, statusAction, statusAction.url, body);
  assert.match(text, /no longer exists/);
  assert.equal(sql(`select status from appointments where id = ${target}`), "confirmed");
  // and the clinic's own staff can, proving the replay itself was well formed
  const own = await replay(desk.ctx, statusAction, statusAction.url, body);
  assert.match(own, /Marked as missed/);
  assert.equal(sql(`select status from appointments where id = ${target}`), "no_show");
});

await test("Another clinic's staff account cannot be changed by replaying an action", async () => {
  assert.ok(roleAction, "no staff-role action captured");
  const deskId = USERS.find((u) => u.email === "desk@clinic.test").id;
  const body = roleAction.body.replace(/^\["[0-9a-f-]+"/, `["${deskId}"`);
  const text = await replay(valley.ctx, roleAction, `${BASE}/staff`, body);
  assert.match(text, /not part of this clinic/);
  assert.equal(sql(`select role from staff_members where user_id = '${deskId}'`), "staff");
});

await test("Direct database calls with a clinic user's token only reach that clinic", async () => {
  const jwt = userJwt("admin@valley.test");
  const h = { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, "content-type": "application/json" };
  const rest = "http://127.0.0.1:54321/rest/v1";
  for (const table of ["patients", "appointments", "doctors", "escalations", "reports", "feedback", "staff_members", "error_log", "staff_activity"]) {
    const rows = await (await fetch(`${rest}/${table}?select=clinic_id`, { headers: h })).json();
    assert.ok(Array.isArray(rows), `${table}: ${JSON.stringify(rows).slice(0, 120)}`);
    assert.ok(rows.every((r) => r.clinic_id === CLINIC_B), `${table} returned another clinic's rows`);
  }
  const clinics = await (await fetch(`${rest}/clinics?select=id,name`, { headers: h })).json();
  assert.deepEqual(clinics.map((c) => c.id), [CLINIC_B]);
  const token = await fetch(`${rest}/clinics?select=wa_token_enc`, { headers: h });
  assert.ok(token.status >= 400, "clinic users can read the WhatsApp token column");
  const write = await fetch(`${rest}/patients`, { method: "POST", headers: h, body: JSON.stringify({ clinic_id: CLINIC_A, phone: "923990000000", name: "Injected" }) });
  assert.ok(write.status >= 400, `insert allowed: ${write.status}`);
  const upd = await fetch(`${rest}/clinics?id=eq.${CLINIC_B}`, { method: "PATCH", headers: h, body: JSON.stringify({ status: "active", paid_until: "2099-01-01" }) });
  assert.ok(upd.status >= 400, "a clinic can extend its own subscription");
  const rpc = await fetch(`${rest}/rpc/my_appointments`, { method: "POST", headers: h, body: JSON.stringify({ p_clinic: CLINIC_A, p_phone: "923001111111" }) });
  assert.ok(rpc.status >= 400, "clinic users can call the automation's functions");
  const pay = await (await fetch(`${rest}/payments?select=*`, { headers: h })).json().catch(() => null);
  assert.ok(!Array.isArray(pay) || pay.length === 0, "clinic users can read payments");
  assert.equal(sql(`select count(*) from patients where phone = '923990000000'`), "0");
});

await test("A suspended clinic's staff see a paused notice and no data", async () => {
  const { ctx, page } = await newPage();
  await login(page, "admin@paused.test", "paused-pass-1234");
  await page.getByRole("heading", { name: "Paused Dental is paused" }).waitFor();
  await page.getByText("Call 0300 0000000").waitFor();
  await page.screenshot({ path: `${SHOTS}/paused.png` });
  const rows = await (await fetch("http://127.0.0.1:54321/rest/v1/clinics?select=id", { headers: { apikey: ANON_KEY, Authorization: `Bearer ${userJwt("admin@paused.test")}` } })).json();
  assert.equal(rows.length, 0);
  await ctx.close();
});

// ---------- owner console ----------
const owner = await newPage();
await test("Clinic staff get not found for the owner console", async () => {
  for (const pg of [admin.page, valley.page]) {
    const res = await pg.goto(`${BASE}/operator`);
    assert.equal(res.status(), 404);
    assert.equal(await pg.getByText("Monthly revenue").count(), 0);
  }
});

await test("An operator flag without being on the owner list gets no access", async () => {
  const { ctx, page } = await newPage();
  await login(page, "rogue@clinic.test", "rogue-pass-12345");
  await page.getByText("This account is not linked to a clinic").waitFor();
  const res = await page.goto(`${BASE}/operator`);
  assert.ok([404, 307].includes(res.status()) || /\/login/.test(page.url()), `status ${res.status()}`);
  assert.equal(await page.getByText("Monthly revenue").count(), 0);
  await ctx.close();
});

let opAction;
await test("The owner signs in to the console with health and revenue, no patient data", async () => {
  const p = owner.page;
  p.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"] && /Bank transfer/.test(r.postData() ?? "") && !opAction) opAction = { id: r.headers()["next-action"], body: r.postData(), url: r.url() };
  });
  await login(p, "owner@platform.test", "owner-pass-12345");
  await p.waitForURL(`${BASE}/operator`);
  await p.getByText("PKR 70,000").waitFor();
  await p.getByText("Green Valley Hospital: payment overdue").waitFor();
  await p.getByText("Paused Dental").first().waitFor();
  const html = await p.content();
  for (const secret of ["Zainab Noor", "923006666666", "Chest pain", "haemoglobin"]) assert.ok(!html.includes(secret), `owner console shows patient data: ${secret}`);
  await p.screenshot({ path: `${SHOTS}/operator.png`, fullPage: true });
  await p.goto(`${BASE}/`);
  await p.waitForURL(`${BASE}/operator`);
});

await test("Recording a payment extends the paid period and clears the overdue flag", async () => {
  const p = owner.page;
  await p.goto(`${BASE}/operator/clinics/${CLINIC_B}`);
  await p.getByRole("heading", { name: "Green Valley Hospital" }).waitFor();
  const html = await p.content();
  assert.ok(!html.includes("Valley Patient"), "clinic page shows patient names");
  await p.getByLabel("Amount received").fill("45000");
  await p.getByLabel("Reference").fill("IBFT-7781");
  await p.getByRole("button", { name: "Record payment" }).click();
  await p.getByText(/Payment recorded\. Paid until/).waitFor();
  const paid = sql(`select paid_until > current_date from clinics where id = '${CLINIC_B}'`);
  assert.equal(paid, "t");
  assert.equal(sql(`select count(*) from payments where clinic_id = '${CLINIC_B}' and reference = 'IBFT-7781'`), "1");
  assert.equal(sql(`select count(*) from operator_audit where clinic_id = '${CLINIC_B}' and action = 'Recorded payment'`), "1");
  await p.screenshot({ path: `${SHOTS}/operator-clinic.png`, fullPage: true });
});

await test("Each payment has a printable invoice only the owner can open", async () => {
  const p = owner.page;
  const pid = sql(`select id from payments where reference = 'IBFT-7781'`);
  const [inv] = await Promise.all([p.context().waitForEvent("page"), p.locator("tr", { hasText: "IBFT-7781" }).getByRole("link", { name: "Invoice" }).click()]);
  await inv.waitForLoadState();
  await inv.getByRole("heading", { name: "Invoice" }).waitFor();
  await inv.getByText("Green Valley Hospital").first().waitFor();
  await inv.getByText("PKR 45,000.00").first().waitFor();
  await inv.getByRole("button", { name: "Print or save as PDF" }).waitFor();
  await inv.screenshot({ path: `${SHOTS}/invoice.png`, fullPage: true });
  await inv.close();
  const res = await valley.page.goto(`${BASE}/operator/invoices/${pid}`);
  assert.equal(res.status(), 404);
});

await test("The owner console shows usage against the plan and the automation check-in", async () => {
  const p = owner.page;
  sql(`insert into platform_heartbeat (name, seen_at) values ('scheduler', now() - interval '40 minutes') on conflict (name) do update set seen_at = excluded.seen_at`);
  await p.goto(`${BASE}/operator`);
  await p.getByText(/The automation has not checked in for \d+ minutes/).waitFor();
  await p.getByRole("columnheader", { name: "This month" }).waitFor();
  sql(`select beat('scheduler')`);
  await p.reload();
  await p.getByText(/checked in .*(just now|minute|second)/).waitFor();
  assert.equal(await p.getByText(/The automation has not checked in for/).count(), 0);
  assert.equal(sql(`select (health_check()::json ->> 'ok')`), "true");
  await p.goto(`${BASE}/operator/clinics/${CLINIC_A}`);
  await p.getByRole("heading", { name: "Usage this month" }).waitFor();
});

await test("SMS: the owner turns it on, staff choose each patient's channel, a number serves one clinic", async () => {
  const p = owner.page;
  await p.goto(`${BASE}/operator/clinics/${CLINIC_A}`);
  await p.getByLabel("SMS on for this clinic").check();
  await p.getByLabel("SMS number (with country code)").fill("+1 305 555 0100");
  await p.getByLabel("New desk bookings get messages by").selectOption("sms");
  await p.getByRole("button", { name: "Save SMS settings" }).click();
  await p.getByText("SMS on. Point the Twilio number +13055550100 at the webhook shown here.").waitFor();
  assert.equal(sql(`select sms_enabled || '|' || regexp_replace(sms_number, '[^0-9]', '', 'g') || '|' || preferred_channel from clinics where id = '${CLINIC_A}'`), "true|13055550100|sms");
  assert.equal(sql(`select clinic_for_sms('+13055550100')::json ->> 'clinic_id'`), CLINIC_A);
  assert.equal(sql(`select clinic_for_sms('+13055550199')::text`), "{}");

  // Same number on a second clinic is refused.
  await p.goto(`${BASE}/operator/clinics/${CLINIC_B}`);
  await p.getByLabel("SMS on for this clinic").check();
  await p.getByLabel("SMS number (with country code)").fill("+1 305 555 0100");
  await p.getByRole("button", { name: "Save SMS settings" }).click();
  await p.getByText("That SMS number is already used by another clinic.").waitFor();

  // Clinic staff switch one patient to SMS.
  const a = admin.page;
  const pid = sql(`select id from patients where clinic_id = '${CLINIC_A}' and phone = '923001111111'`);
  await a.goto(`${BASE}/patients/${pid}`);
  await a.getByLabel("Messages by").selectOption("sms");
  await a.getByText("Messages to this patient now go by SMS.").waitFor();
  assert.equal(sql(`select channel from patients where id = ${pid}`), "sms");
  await a.screenshot({ path: `${SHOTS}/patient-sms.png`, fullPage: true });

  // Turning SMS off moves everyone back to WhatsApp.
  await p.goto(`${BASE}/operator/clinics/${CLINIC_A}`);
  await p.getByLabel("New desk bookings get messages by").selectOption("whatsapp");
  await p.getByLabel("SMS on for this clinic").uncheck();
  await p.getByRole("button", { name: "Save SMS settings" }).click();
  await p.getByText("SMS off. Patients on SMS were moved back to WhatsApp.").waitFor();
  assert.equal(sql(`select sms_enabled::text from clinics where id = '${CLINIC_A}'`), "false");
  assert.equal(sql(`select count(*) from patients where clinic_id = '${CLINIC_A}' and channel = 'sms'`), "0");
  await p.goto(`${BASE}/operator/clinics/${CLINIC_B}`);
});

await test("An owner action replayed by a clinic admin is refused", async () => {
  assert.ok(opAction, "no owner action captured");
  const before = sql(`select count(*) from payments`);
  const text = await replay(valley.ctx, opAction, opAction.url, opAction.body.replace("IBFT-7781", "SELF-PAID"));
  assert.match(text, /only for the platform owner/);
  assert.equal(sql(`select count(*) from payments`), before);
});

await test("WhatsApp token is stored encrypted and a number cannot serve two clinics", async () => {
  const p = owner.page;
  await p.getByLabel("Phone number ID").fill("100000000000001");
  await p.getByRole("button", { name: "Save connection" }).click();
  await p.getByText("already connected to another clinic").waitFor();
  await p.getByLabel("Phone number ID").fill("100000000000002");
  await p.getByLabel(/Access token/).fill("EAAGtestTOKENvalue1234567890abcdef");
  await p.getByRole("button", { name: "Save connection" }).click();
  await p.getByText("WhatsApp connection saved").waitFor();
  const stored = sql(`select wa_token_enc from clinics where id = '${CLINIC_B}'`);
  assert.match(stored, /^v1\./);
  assert.ok(!stored.includes("EAAGtest"), "token stored in plain text");
  assert.ok(!(await p.content()).includes("EAAGtestTOKEN"), "token shown back on the page");
});

await test("Lab secret is shown once and only its fingerprint is stored", async () => {
  const p = owner.page;
  await p.getByRole("button", { name: "Create secret" }).click();
  const secret = (await p.locator(".secret-box code").innerText()).trim();
  assert.ok(secret.length >= 32);
  const crypto = await import("node:crypto");
  assert.equal(sql(`select report_secret_hash from clinics where id = '${CLINIC_B}'`), crypto.createHash("sha256").update(secret).digest("hex"));
  await p.reload();
  assert.ok(!(await p.content()).includes(secret), "secret shown again after reload");
});

await test("Suspending a clinic locks its staff out; resuming lets them back", async () => {
  const p = owner.page;
  await p.getByLabel(/Reason/).fill("Test suspension");
  await p.getByRole("button", { name: "Suspend" }).click();
  await p.getByText("Green Valley Hospital is now suspended").waitFor();
  await valley.page.goto(`${BASE}/appointments`);
  await valley.page.getByRole("heading", { name: "Green Valley Hospital is paused" }).waitFor();
  assert.equal(await valley.page.getByText("Valley Patient").count(), 0);
  await p.getByRole("button", { name: "Make active" }).click();
  await p.getByText("Green Valley Hospital is now active").waitFor();
  await valley.page.goto(`${BASE}/patients`);
  await valley.page.getByText("Valley Patient Two").waitFor();
});

let newClinicId;
await test("The owner adds a clinic and its admin can sign in to an empty clinic", async () => {
  const p = owner.page;
  await p.goto(`${BASE}/operator`);
  await p.getByRole("button", { name: "Add clinic" }).click();
  await p.getByLabel("Clinic name").fill("Test Smile Clinic");
  await p.getByLabel("Monthly fee").fill("15000");
  await p.getByLabel("Alert email").fill("desk@smile.test");
  await p.getByLabel("Clinic admin email").fill("admin@smile.test");
  await p.getByLabel("Temporary password").fill("smile-temp-pass-1");
  await p.screenshot({ path: `${SHOTS}/operator-new-clinic.png` });
  await p.getByRole("button", { name: "Create clinic" }).click();
  await p.waitForURL(/\/operator\/clinics\/[0-9a-f-]+\?created=1/);
  newClinicId = p.url().match(/clinics\/([0-9a-f-]+)/)[1];
  assert.equal(sql(`select status from clinics where id = '${newClinicId}'`), "trial");
  const fresh = await newPage();
  await login(fresh.page, "admin@smile.test", "smile-temp-pass-1");
  await fresh.page.waitForURL(`${BASE}/`);
  await fresh.page.locator(".brand span", { hasText: "Test Smile Clinic" }).waitFor();
  await fresh.page.goto(`${BASE}/patients`);
  await fresh.page.getByText("No patients").first().waitFor();
  await fresh.ctx.close();
});

await test("Deleting a clinic needs its exact name and removes its data and accounts", async () => {
  const p = owner.page;
  sql(`insert into payments (clinic_id, clinic_name, amount, currency, period_from, period_to, recorded_by) values ('${newClinicId}', 'Test Smile Clinic', 15000, 'PKR', current_date, current_date + 30, 'owner@platform.test')`);
  sql(`insert into patients (clinic_id, phone, name) values ('${newClinicId}', '923441234567', 'Smile Patient')`);
  await p.goto(`${BASE}/operator/clinics/${newClinicId}`);
  await p.getByRole("button", { name: "Delete Test Smile Clinic" }).click();
  await p.getByLabel("Clinic name", { exact: true }).last().fill("Test Smile");
  assert.ok(await p.getByRole("button", { name: "Delete permanently" }).isDisabled());
  await p.getByLabel("Clinic name", { exact: true }).last().fill("Test Smile Clinic");
  await p.getByRole("button", { name: "Delete permanently" }).click();
  await p.waitForURL(`${BASE}/operator`);
  assert.equal(sql(`select count(*) from clinics where id = '${newClinicId}'`), "0");
  assert.equal(sql(`select count(*) from patients where phone = '923441234567'`), "0");
  assert.equal(sql(`select count(*) from staff_members where email = 'admin@smile.test'`), "0");
  assert.equal(sql(`select count(*) || '|' || count(clinic_id) from payments where clinic_name = 'Test Smile Clinic'`), "1|0");
  assert.ok(!USERS.some((u) => u.email === "admin@smile.test"), "the clinic's login still exists");
  assert.ok(Number(sql(`select count(*) from patients where clinic_id = '${CLINIC_A}'`)) > 10, "other clinics' data was touched");
});

await test("Accessibility: owner console pages have no serious issues (axe)", async () => {
  const axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  const p = owner.page;
  const problems = [];
  const invoice = sql(`select id from payments order by id limit 1`);
  for (const path of ["/operator", `/operator/clinics/${CLINIC_A}`, `/operator/invoices/${invoice}`]) {
    await p.goto(`${BASE}${path}`);
    await p.waitForLoadState("networkidle");
    await p.addScriptTag({ content: axeSource });
    const r = await p.evaluate(async () => await window.axe.run(document, { resultTypes: ["violations"] }));
    for (const v of r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")) problems.push(`${path}: ${v.id} x${v.nodes.length}: ${v.nodes[0].target.join(" ")}`);
  }
  const phone = await newPage({ width: 390, height: 844 });
  await login(phone.page, "owner@platform.test", "owner-pass-12345");
  await phone.page.waitForURL(`${BASE}/operator`);
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `owner console scrolls sideways by ${overflow}px on a phone`);
  await phone.page.screenshot({ path: `${SHOTS}/operator-phone.png`, fullPage: true });
  await phone.ctx.close();
  assert.equal(problems.length, 0, problems.join("\n        "));
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

await test("Forgot password: the emailed link lets staff choose a new password once", async () => {
  const { RECOVERY } = await import("./stack.mjs");
  const { ctx, page: p } = await newPage();
  await p.goto(`${BASE}/login`);
  await p.getByRole("link", { name: "Forgot your password?" }).click();
  await p.waitForURL(`${BASE}/forgot-password`);
  await p.getByLabel("Email").fill("nobody@nowhere.test");
  await p.getByRole("button", { name: "Email me a link" }).click();
  const generic = p.locator(".flash, [role=status]").first();
  await generic.waitFor();
  const unknownText = await generic.textContent();
  assert.equal(RECOVERY.size, 0, "a token was issued for an unknown email");
  await p.getByLabel("Email").fill("desk@clinic.test");
  await p.getByRole("button", { name: "Email me a link" }).click();
  await p.waitForFunction(() => true);
  for (let i = 0; i < 20 && !RECOVERY.size; i++) await new Promise((r) => setTimeout(r, 200));
  assert.equal(RECOVERY.size, 1);
  assert.equal(await p.locator(".flash, [role=status]").first().textContent(), unknownText, "the answer reveals whether the email exists");
  const [[token, info]] = [...RECOVERY.entries()];
  assert.match(info.redirectTo ?? "", /\/auth\/confirm\?next=\/reset-password$/);
  await p.goto(`${BASE}/auth/confirm?token_hash=${token}&type=recovery&next=/reset-password`);
  await p.waitForURL(`${BASE}/reset-password`);
  await p.getByLabel("New password", { exact: true }).fill("desk-reset-pass-9876");
  await p.getByLabel("Type it again").fill("desk-reset-pass-9876");
  await p.screenshot({ path: `${SHOTS}/reset-password.png` });
  await p.getByRole("button", { name: "Save new password" }).click();
  await p.waitForURL(`${BASE}/`);
  await ctx.close();
  // The link works once only.
  const again = await newPage();
  await again.page.goto(`${BASE}/auth/confirm?token_hash=${token}&type=recovery&next=/reset-password`);
  await again.page.waitForURL(/\/login\?reason=link-expired/);
  await again.page.getByText("That link has expired or was already used").waitFor();
  // An outside "next" is ignored.
  const evil = await fetch(`${BASE}/auth/confirm?token_hash=x&type=recovery&next=https://evil.test/`, { redirect: "manual" });
  assert.ok(!String(evil.headers.get("location")).includes("evil.test"), "open redirect");
  await login(again.page, "desk@clinic.test", "desk-reset-pass-9876");
  await again.page.waitForURL(`${BASE}/`);
  await again.ctx.close();
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
