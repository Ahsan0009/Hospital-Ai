"use server";

import { revalidatePath } from "next/cache";
import { AccessError, requireAdmin, requireStaff } from "@/lib/auth";
import type { Staff } from "@/lib/auth";
import { getAppointment } from "@/lib/data";
import { notifyPatient } from "@/lib/notify";
import type { NotifyResult } from "@/lib/notify";
import { normalizePhone, safeLink } from "@/lib/phone";
import { db } from "@/lib/supabase/admin";
import { dayRange, isDateKey, isValidTimeZone } from "@/lib/time";
import type { ActionResult, AppointmentStatus } from "@/types/db";

// Every action checks who is asking before touching data: Server Actions can be
// called directly with a POST request, not only from the dashboard's buttons.
// Every write is pinned to the caller's clinic: the clinic id always comes from
// the signed-in account, never from the request, and every UPDATE/DELETE filters
// on it, so a record id from another clinic simply matches nothing.

type RpcResult = { ok: boolean; error?: string; appointment_id?: number; when?: string; cancelled?: string; free_times_24h?: string[]; note?: string | null; doctor?: string };

async function run<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (cause) {
    if (cause instanceof AccessError) return { ok: false, error: cause.message };
    console.error(cause);
    return { ok: false, error: "Something went wrong while saving. Nothing was changed; try again in a moment." };
  }
}

async function log(staff: Staff, action: string, detail: string) {
  const { error } = await db()
    .from("staff_activity")
    .insert({ clinic_id: staff.clinicId, staff_email: staff.email, action, detail: detail.slice(0, 500) });
  if (error) console.error("staff_activity insert failed", error.message);
}

function int(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function text(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function notifyMessage(n: NotifyResult, done: string): string {
  if (!n.sent) return `${done} The patient was not messaged: ${n.reason}`;
  return `${done} The patient was sent ${n.channel === "sms" ? "a text message" : "a WhatsApp message"}.`;
}

function refresh() {
  revalidatePath("/", "layout");
}

/* ---------------- Appointments ---------------- */

export async function getFreeTimes(doctorId: number, date: string): Promise<ActionResult<{ times: string[]; note: string | null }>> {
  return run(async () => {
    const staff = await requireStaff();
    if (!int(doctorId) || !isDateKey(date)) return { ok: false, error: "Choose a doctor and a date." };
    const { data, error } = await db().rpc("available_slots", { p_clinic: staff.clinicId, p_doctor_id: doctorId, p_date: date });
    if (error) throw error;
    const r = data as RpcResult;
    if (!r.ok) return { ok: false, error: r.error ?? "No times are available." };
    return { ok: true, data: { times: r.free_times_24h ?? [], note: r.note ?? null } };
  });
}

export async function bookAppointment(form: {
  phone: string;
  name: string;
  doctorId: number;
  date: string;
  time: string;
  notes: string;
}): Promise<ActionResult<{ id: number }>> {
  return run(async () => {
    const staff = await requireStaff();
    const phone = normalizePhone(form.phone);
    if (!phone.ok) return { ok: false, error: phone.error };
    const doctorId = int(form.doctorId);
    if (!doctorId) return { ok: false, error: "Choose a doctor." };
    if (!isDateKey(form.date)) return { ok: false, error: "Choose a date." };
    if (!TIME.test(form.time)) return { ok: false, error: "Choose a time." };
    const name = text(form.name, 80);
    const notes = text(form.notes, 500);
    const clinic = staff.clinicId;

    const client = db();
    const existing = await client.from("patients").select("id, name").eq("clinic_id", clinic).eq("phone", phone.phone).maybeSingle();
    if (existing.error) throw existing.error;
    let patientName = existing.data?.name ?? null;
    if (!existing.data) {
      const pref = await client.from("clinics").select("preferred_channel, sms_enabled").eq("id", clinic).single();
      if (pref.error) throw pref.error;
      const channel = pref.data.sms_enabled && pref.data.preferred_channel === "sms" ? "sms" : "whatsapp";
      const inserted = await client.from("patients").insert({ clinic_id: clinic, phone: phone.phone, name: name || null, channel }).select("id").single();
      if (inserted.error) throw inserted.error;
      patientName = name || null;
    } else if (name && !existing.data.name) {
      const updated = await client.from("patients").update({ name }).eq("clinic_id", clinic).eq("id", existing.data.id);
      if (updated.error) throw updated.error;
      patientName = name;
    }

    const { data, error } = await client.rpc("book_appointment", {
      p_clinic: clinic,
      p_phone: phone.phone,
      p_doctor_id: doctorId,
      p_date: form.date,
      p_time: form.time,
    });
    if (error) throw error;
    const r = data as RpcResult;
    if (!r.ok || !r.appointment_id) return { ok: false, error: r.error ?? "That time could not be booked." };

    const tagged = await client.from("appointments").update({ source: "staff", notes: notes || null }).eq("clinic_id", clinic).eq("id", r.appointment_id);
    if (tagged.error) throw tagged.error;

    const n = await notifyPatient({ clinicId: clinic, type: "booked", phone: phone.phone, patientName, doctor: r.doctor ?? "", when: r.when ?? "" });
    await log(staff, "Booked appointment", `#${r.appointment_id} for +${phone.phone} with ${r.doctor} on ${r.when}`);
    refresh();
    return { ok: true, data: { id: r.appointment_id }, message: notifyMessage(n, `Booked for ${r.when}.`) };
  });
}

export async function rescheduleAppointment(id: number, date: string, time: string): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireStaff();
    if (!int(id) || !isDateKey(date) || !TIME.test(time)) return { ok: false, error: "Choose a new date and time." };
    const appt = await getAppointment(staff.clinicId, id);
    if (!appt?.patient) return { ok: false, error: "That appointment no longer exists." };
    const { data, error } = await db().rpc("reschedule_appointment", {
      p_clinic: staff.clinicId,
      p_phone: appt.patient.phone,
      p_appointment_id: id,
      p_date: date,
      p_time: time,
    });
    if (error) throw error;
    const r = data as RpcResult;
    if (!r.ok) return { ok: false, error: r.error ?? "That time could not be booked." };
    const n = await notifyPatient({ clinicId: staff.clinicId, type: "rescheduled", phone: appt.patient.phone, patientName: appt.patient.name, doctor: appt.doctor?.name ?? "", when: r.when ?? "" });
    await log(staff, "Moved appointment", `#${id} for +${appt.patient.phone} to ${r.when}`);
    refresh();
    return { ok: true, message: notifyMessage(n, `Moved to ${r.when}.`) };
  });
}

export async function cancelAppointment(id: number): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireStaff();
    if (!int(id)) return { ok: false, error: "That appointment could not be found." };
    const appt = await getAppointment(staff.clinicId, id);
    if (!appt?.patient) return { ok: false, error: "That appointment no longer exists." };
    const { data, error } = await db().rpc("cancel_appointment", { p_clinic: staff.clinicId, p_phone: appt.patient.phone, p_appointment_id: id });
    if (error) throw error;
    const r = data as RpcResult;
    if (!r.ok) return { ok: false, error: r.error ?? "Only upcoming appointments can be cancelled." };
    const n = await notifyPatient({ clinicId: staff.clinicId, type: "cancelled", phone: appt.patient.phone, patientName: appt.patient.name, doctor: appt.doctor?.name ?? "", when: r.cancelled ?? "" });
    await log(staff, "Cancelled appointment", `#${id} for +${appt.patient.phone} (${r.cancelled})`);
    refresh();
    return { ok: true, message: notifyMessage(n, "Appointment cancelled.") };
  });
}

const STATUS_CHANGES: Record<AppointmentStatus, AppointmentStatus[]> = {
  confirmed: ["completed", "no_show"],
  completed: ["no_show", "confirmed"],
  no_show: ["completed", "confirmed"],
  cancelled: [],
};

export async function setAppointmentStatus(id: number, status: AppointmentStatus): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireStaff();
    const appt = int(id) ? await getAppointment(staff.clinicId, id) : null;
    if (!appt) return { ok: false, error: "That appointment no longer exists." };
    if (!STATUS_CHANGES[appt.status]?.includes(status)) return { ok: false, error: "That change is not possible for this appointment." };
    if (status !== "confirmed" && Date.parse(appt.slot_time) > Date.now() + 60 * 60 * 1000) {
      return { ok: false, error: "You can mark a visit as seen or missed from an hour before its time." };
    }
    const { error } = await db()
      .from("appointments")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("clinic_id", staff.clinicId)
      .eq("id", id)
      .eq("status", appt.status);
    if (error) {
      if (error.code === "23505") return { ok: false, error: "Someone else is booked in that slot now, so this visit cannot be reopened." };
      throw error;
    }
    const label = { completed: "Marked as seen", no_show: "Marked as missed", confirmed: "Reopened", cancelled: "Cancelled" }[status];
    await log(staff, label, `#${id} for +${appt.patient?.phone ?? "?"}`);
    refresh();
    return { ok: true, message: `${label}.` };
  });
}

export async function saveAppointmentNote(id: number, notes: string): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireStaff();
    if (!int(id)) return { ok: false, error: "That appointment could not be found." };
    const { data, error } = await db()
      .from("appointments")
      .update({ notes: text(notes, 500) || null })
      .eq("clinic_id", staff.clinicId)
      .eq("id", id)
      .select("id");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "That appointment no longer exists." };
    await log(staff, "Edited appointment note", `#${id}`);
    refresh();
    return { ok: true, message: "Note saved." };
  });
}

/* ---------------- Handoffs ---------------- */

export async function resolveHandoff(id: number, note: string): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireStaff();
    if (!int(id)) return { ok: false, error: "That handoff could not be found." };
    const { data, error } = await db()
      .from("escalations")
      .update({ resolved: true, resolved_at: new Date().toISOString(), resolved_by: staff.email, staff_note: text(note, 500) || null })
      .eq("clinic_id", staff.clinicId)
      .eq("id", id)
      .eq("resolved", false)
      .select("id, patient_phone");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "This handoff is already closed or no longer exists." };
    await log(staff, "Closed handoff", `#${id} for +${data[0].patient_phone ?? "?"}`);
    refresh();
    return { ok: true, message: "Handoff closed." };
  });
}

export async function reopenHandoff(id: number): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireStaff();
    if (!int(id)) return { ok: false, error: "That handoff could not be found." };
    const { data, error } = await db()
      .from("escalations")
      .update({ resolved: false, resolved_at: null, resolved_by: null })
      .eq("clinic_id", staff.clinicId)
      .eq("id", id)
      .select("id");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "That handoff no longer exists." };
    await log(staff, "Reopened handoff", `#${id}`);
    refresh();
    return { ok: true, message: "Handoff reopened." };
  });
}

/* ---------------- Doctors (clinic admins) ---------------- */

export async function saveDoctor(form: {
  id?: number;
  name: string;
  department: string;
  fee: string;
  sessions: { weekday: number; start: string; end: string }[];
  slotMinutes: number;
  notes: string;
  active: boolean;
}): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireAdmin();
    const name = text(form.name, 80).replace(/^dr\.?\s+/i, "");
    const department = text(form.department, 60);
    if (name.length < 2) return { ok: false, error: "Enter the doctor's name." };
    if (department.length < 2) return { ok: false, error: "Enter the department." };
    const feeText = text(form.fee, 12);
    const fee = feeText === "" ? null : Number(feeText);
    if (fee !== null && (!Number.isFinite(fee) || fee < 0 || fee > 10_000_000)) return { ok: false, error: "The fee must be a number, or leave it empty." };
    const slot = Number(form.slotMinutes);
    if (!Number.isInteger(slot) || slot < 5 || slot > 240) return { ok: false, error: "Appointment length must be between 5 and 240 minutes." };
    const checked = checkSessions(form.sessions, slot);
    if (!checked.ok) return { ok: false, error: checked.error };
    const sessions = checked.sessions;

    const id = form.id ? int(form.id) : null;
    if (id && !form.active) {
      const { count, error } = await db()
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", staff.clinicId)
        .eq("doctor_id", id)
        .eq("status", "confirmed")
        .gte("slot_time", new Date().toISOString());
      if (error) throw error;
      if (count) return { ok: false, error: `This doctor still has ${count} upcoming appointment${count === 1 ? "" : "s"}. Move or cancel them before taking the doctor off the schedule.` };
    }

    const row = {
      name,
      department,
      consultation_fee: fee,
      working_days: [...new Set(sessions.map((x) => x.weekday))].sort(),
      start_time: sessions.reduce((m, x) => (x.start < m ? x.start : m), sessions[0].start),
      end_time: sessions.reduce((m, x) => (x.end > m ? x.end : m), sessions[0].end),
      slot_minutes: slot,
      notes: text(form.notes, 300) || null,
      active: Boolean(form.active),
    };
    let doctorId = id;
    if (id) {
      const { data, error } = await db().from("doctors").update(row).eq("clinic_id", staff.clinicId).eq("id", id).select("id");
      if (error) throw error;
      if (!data?.length) return { ok: false, error: "That doctor no longer exists." };
    } else {
      const { data, error } = await db().from("doctors").insert({ ...row, clinic_id: staff.clinicId }).select("id").single();
      if (error) throw error;
      doctorId = data.id as number;
    }
    const saved = await db().rpc("set_doctor_sessions", { p_clinic: staff.clinicId, p_doctor_id: doctorId, p_sessions: sessions });
    if (saved.error) throw saved.error;
    if (!(saved.data as RpcResult).ok) return { ok: false, error: (saved.data as RpcResult).error ?? "The hours could not be saved." };
    await log(staff, id ? "Updated doctor" : "Added doctor", `${name} (${department}), ${sessions.length} session${sessions.length === 1 ? "" : "s"} a week`);
    refresh();
    return { ok: true, message: id ? "Doctor updated." : "Doctor added. Patients can book them now." };
  });
}

/** Valid weekly sittings: weekday 1-7, start before end, no overlaps on a day, at least one visit long. */
function checkSessions(
  input: { weekday: number; start: string; end: string }[] | undefined,
  slot: number,
): { ok: true; sessions: { weekday: number; start: string; end: string }[] } | { ok: false; error: string } {
  const list = (Array.isArray(input) ? input : []).slice(0, 30).map((x) => ({ weekday: Number(x?.weekday), start: String(x?.start ?? ""), end: String(x?.end ?? "") }));
  if (!list.length) return { ok: false, error: "Add at least one working day with its hours." };
  const DAY = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  for (const x of list) {
    if (!Number.isInteger(x.weekday) || x.weekday < 1 || x.weekday > 7) return { ok: false, error: "Unknown weekday." };
    if (!TIME.test(x.start) || !TIME.test(x.end)) return { ok: false, error: `Enter the start and finish times for ${DAY[x.weekday]}.` };
    if (x.start >= x.end) return { ok: false, error: `On ${DAY[x.weekday]}, the finishing time must be after the starting time.` };
    const [sh, sm] = x.start.split(":").map(Number);
    const [eh, em] = x.end.split(":").map(Number);
    if (eh * 60 + em - (sh * 60 + sm) < slot) return { ok: false, error: `The ${x.start} session on ${DAY[x.weekday]} is shorter than one visit (${slot} minutes).` };
  }
  list.sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
  for (let i = 1; i < list.length; i++) {
    if (list[i].weekday === list[i - 1].weekday && list[i].start < list[i - 1].end) {
      return { ok: false, error: `On ${DAY[list[i].weekday]}, the sessions ${list[i - 1].start}–${list[i - 1].end} and ${list[i].start}–${list[i].end} overlap.` };
    }
  }
  return { ok: true, sessions: list };
}

/* ---------------- Days off and clinic closures (clinic admins) ---------------- */

export async function addTimeOff(form: { doctorId: string; from: string; to: string; reason: string }): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireAdmin();
    const whole = form.doctorId === "clinic";
    const doctorId = whole ? null : int(form.doctorId);
    if (!whole && !doctorId) return { ok: false, error: "Choose a doctor, or the whole clinic." };
    if (!isDateKey(form.from) || !isDateKey(form.to)) return { ok: false, error: "Choose the first and last day." };
    if (form.to < form.from) return { ok: false, error: "The last day must be on or after the first day." };
    let doctorName = "the whole clinic";
    if (doctorId) {
      const { data, error } = await db().from("doctors").select("name").eq("clinic_id", staff.clinicId).eq("id", doctorId).maybeSingle();
      if (error) throw error;
      if (!data) return { ok: false, error: "That doctor no longer exists." };
      doctorName = `Dr. ${data.name}`;
    }
    const { error } = await db().from("doctor_time_off").insert({
      clinic_id: staff.clinicId,
      doctor_id: doctorId,
      starts_on: form.from,
      ends_on: form.to,
      reason: text(form.reason, 200) || null,
      created_by: staff.email,
    });
    if (error) throw error;
    // Visits already booked in this period are not cancelled automatically; staff decide.
    const { data: tz } = await db().from("clinics").select("timezone").eq("id", staff.clinicId).single();
    const zone = isValidTimeZone(tz?.timezone ?? "") ? (tz?.timezone as string) : "UTC";
    let q = db()
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", staff.clinicId)
      .eq("status", "confirmed")
      .gte("slot_time", dayRange(form.from, zone).start.toISOString())
      .lt("slot_time", dayRange(form.to, zone).end.toISOString());
    if (doctorId) q = q.eq("doctor_id", doctorId);
    const { count } = await q;
    await log(staff, "Added days off", `${doctorName}: ${form.from} to ${form.to}`);
    refresh();
    return {
      ok: true,
      message: count
        ? `Saved. ${count} booked visit${count === 1 ? " falls" : "s fall"} in this period. They are listed on Today; move or cancel them.`
        : "Saved. Patients cannot book in this period.",
    };
  });
}

export async function deleteTimeOff(id: number): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireAdmin();
    if (!int(id)) return { ok: false, error: "Unknown entry." };
    const { data, error } = await db().from("doctor_time_off").delete().eq("clinic_id", staff.clinicId).eq("id", id).select("starts_on, ends_on");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "That entry no longer exists." };
    await log(staff, "Removed days off", `${data[0].starts_on} to ${data[0].ends_on}`);
    refresh();
    return { ok: true, message: "Removed. Patients can book those days again." };
  });
}

/* ---------------- Patients ---------------- */

export async function setPatientChannel(patientId: number, channel: string): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireStaff();
    if (!int(patientId)) return { ok: false, error: "Unknown patient." };
    if (channel !== "whatsapp" && channel !== "sms") return { ok: false, error: "Choose WhatsApp or SMS." };
    if (channel === "sms") {
      const { data } = await db().from("clinics").select("sms_enabled").eq("id", staff.clinicId).single();
      if (!data?.sms_enabled) return { ok: false, error: "SMS is not set up for this clinic." };
    }
    const { data, error } = await db().from("patients").update({ channel }).eq("clinic_id", staff.clinicId).eq("id", patientId).select("phone");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "That patient no longer exists." };
    await log(staff, "Changed patient's message channel", `+${data[0].phone} to ${channel === "sms" ? "SMS" : "WhatsApp"}`);
    refresh();
    return { ok: true, message: `Messages to this patient now go by ${channel === "sms" ? "SMS" : "WhatsApp"}.` };
  });
}

/* ---------------- Clinic settings (clinic admins) ---------------- */

export async function saveSettings(form: {
  name: string;
  timezone: string;
  contactPhone: string;
  alertEmail: string;
  googleReviewLink: string;
  remind24h?: boolean;
  remind2h?: boolean;
  askFeedback?: boolean;
  preferredChannel?: string;
}): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireAdmin();
    const name = text(form.name, 80);
    const tz = text(form.timezone, 64);
    const contactPhone = text(form.contactPhone, 30);
    const alertEmail = text(form.alertEmail, 120).toLowerCase();
    const reviewRaw = text(form.googleReviewLink, 500);
    if (name.length < 2) return { ok: false, error: "Enter the clinic's name." };
    if (!isValidTimeZone(tz)) return { ok: false, error: "That time zone is not recognised. Choose one from the list." };
    if (alertEmail && !EMAIL.test(alertEmail)) return { ok: false, error: "Enter a valid alert email, or leave it empty." };
    const review = reviewRaw ? safeLink(reviewRaw) : null;
    if (reviewRaw && !review) return { ok: false, error: "The review link must start with https://." };
    const current = await db().from("clinics").select("timezone, sms_enabled").eq("id", staff.clinicId).single();
    if (current.error) throw current.error;
    const changes: Record<string, unknown> = {
      name,
      timezone: tz,
      contact_phone: contactPhone || null,
      alert_email: alertEmail || null,
      google_review_link: review,
    };
    if (typeof form.remind24h === "boolean") changes.remind_24h = form.remind24h;
    if (typeof form.remind2h === "boolean") changes.remind_2h = form.remind2h;
    if (typeof form.askFeedback === "boolean") changes.ask_feedback = form.askFeedback;
    if (form.preferredChannel === "sms" || form.preferredChannel === "whatsapp") {
      if (form.preferredChannel === "sms" && !current.data.sms_enabled) return { ok: false, error: "SMS is not set up for this clinic yet." };
      changes.preferred_channel = form.preferredChannel;
    }
    const { error } = await db().from("clinics").update(changes).eq("id", staff.clinicId);
    if (error) throw error;
    const tzNote = current.data.timezone !== tz ? `, time zone ${current.data.timezone} to ${tz}` : "";
    await log(staff, "Changed clinic settings", `name "${name}"${tzNote}`);
    refresh();
    return {
      ok: true,
      message: tzNote
        ? `Saved. Times now show in ${tz}. Booked visits keep their actual time; the hours on the screen move to the new zone.`
        : "Saved.",
    };
  });
}

/* ---------------- Staff accounts (clinic admins) ---------------- */

function role(value: unknown): "admin" | "staff" | null {
  return value === "admin" || value === "staff" ? value : null;
}

function passwordProblem(password: string): string | null {
  if (password.length < 12) return "Use at least 12 characters for the password.";
  if (password.length > 72) return "Use at most 72 characters for the password.";
  return null;
}

/** A member of the caller's own clinic, or null. Other clinics' accounts are invisible. */
async function memberOf(staff: Staff, userId: string) {
  const { data, error } = await db()
    .from("staff_members")
    .select("user_id, role, email")
    .eq("clinic_id", staff.clinicId)
    .eq("user_id", String(userId ?? "").trim().toLowerCase())
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function adminCount(clinicId: string): Promise<number> {
  const { count, error } = await db().from("staff_members").select("user_id", { count: "exact", head: true }).eq("clinic_id", clinicId).eq("role", "admin");
  if (error) throw error;
  return count ?? 0;
}

export async function createStaffUser(form: { email: string; role: string; password: string }): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireAdmin();
    const email = text(form.email, 120).toLowerCase();
    const r = role(form.role);
    const password = String(form.password ?? "");
    if (!EMAIL.test(email)) return { ok: false, error: "Enter a valid email address." };
    if (!r) return { ok: false, error: "Choose Front desk or Clinic admin." };
    const problem = passwordProblem(password);
    if (problem) return { ok: false, error: problem };
    const { data, error } = await db().auth.admin.createUser({ email, password, email_confirm: true, app_metadata: {} });
    if (error || !data.user) {
      if (error && /already/i.test(error.message)) return { ok: false, error: "This email already has an account. Use a different email address." };
      throw error ?? new Error("No user returned");
    }
    const member = await db().from("staff_members").insert({ user_id: data.user.id, clinic_id: staff.clinicId, role: r, email });
    if (member.error) {
      await db().auth.admin.deleteUser(data.user.id);
      throw member.error;
    }
    await log(staff, "Added staff account", `${email} as ${r}`);
    refresh();
    return { ok: true, message: `Account created for ${email}. Share the temporary password privately and ask them to change it under Settings after signing in.` };
  });
}

export async function setStaffRole(userId: string, newRole: string): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireAdmin();
    const r = role(newRole);
    if (!r) return { ok: false, error: "Choose a role." };
    const member = await memberOf(staff, userId);
    if (!member) return { ok: false, error: "That account is not part of this clinic." };
    if (member.user_id === staff.id) return { ok: false, error: "You cannot change your own access. Ask another admin." };
    if (member.role === "admin" && r !== "admin" && (await adminCount(staff.clinicId)) <= 1) return { ok: false, error: "The clinic needs at least one admin." };
    const { error } = await db().from("staff_members").update({ role: r }).eq("clinic_id", staff.clinicId).eq("user_id", member.user_id);
    if (error) throw error;
    const label = r === "admin" ? "clinic admin" : "front desk";
    await log(staff, "Changed staff access", `${member.email} is now ${label}`);
    refresh();
    return { ok: true, message: `${member.email} is now ${label}.` };
  });
}

export async function resetStaffPassword(userId: string, password: string): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireAdmin();
    const pw = String(password ?? "");
    const problem = passwordProblem(pw);
    if (problem) return { ok: false, error: problem };
    const member = await memberOf(staff, userId);
    if (!member) return { ok: false, error: "That account is not part of this clinic." };
    const { error } = await db().auth.admin.updateUserById(member.user_id, { password: pw });
    if (error) throw error;
    await log(staff, "Reset staff password", member.email);
    refresh();
    return { ok: true, message: `New password set for ${member.email}. Share it privately.` };
  });
}

export async function deleteStaffUser(userId: string): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireAdmin();
    const member = await memberOf(staff, userId);
    if (!member) return { ok: false, error: "That account is not part of this clinic." };
    if (member.user_id === staff.id) return { ok: false, error: "You cannot delete your own account." };
    if (member.role === "admin" && (await adminCount(staff.clinicId)) <= 1) return { ok: false, error: "The clinic needs at least one admin." };
    const removed = await db().from("staff_members").delete().eq("clinic_id", staff.clinicId).eq("user_id", member.user_id);
    if (removed.error) throw removed.error;
    const { error } = await db().auth.admin.deleteUser(member.user_id);
    if (error) console.error("auth user delete failed after membership removal", error.message);
    await log(staff, "Deleted staff account", member.email);
    refresh();
    return { ok: true, message: `${member.email} was deleted.` };
  });
}
