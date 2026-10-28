"use server";

import { revalidatePath } from "next/cache";
import { AccessError, requireAdmin, requireStaff } from "@/lib/auth";
import type { Staff } from "@/lib/auth";
import { getAppointment, getClinic } from "@/lib/data";
import { listStaffUsers } from "@/lib/staff-users";
import { notifyPatient } from "@/lib/notify";
import type { NotifyResult } from "@/lib/notify";
import { normalizePhone } from "@/lib/phone";
import { db } from "@/lib/supabase/admin";
import { isDateKey, isValidTimeZone } from "@/lib/time";
import type { ActionResult, AppointmentStatus } from "@/types/db";

// Every action checks who is asking before touching data: Server Actions can be
// called directly with a POST request, not only from the dashboard's buttons.

type RpcResult = { ok: boolean; error?: string; appointment_id?: number; when?: string; cancelled?: string; free_times_24h?: string[]; note?: string | null };

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
  const { error } = await db().from("staff_activity").insert({ staff_email: staff.email, action, detail: detail.slice(0, 500) });
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

function notifyMessage(n: NotifyResult, done: string): string {
  return n.sent ? `${done} The patient was sent a WhatsApp message.` : `${done} The patient was not messaged: ${n.reason}`;
}

function refresh() {
  revalidatePath("/", "layout");
}

/* ---------------- Appointments ---------------- */

export async function getFreeTimes(doctorId: number, date: string): Promise<ActionResult<{ times: string[]; note: string | null }>> {
  return run(async () => {
    await requireStaff();
    if (!int(doctorId) || !isDateKey(date)) return { ok: false, error: "Choose a doctor and a date." };
    const { data, error } = await db().rpc("available_slots", { p_doctor_id: doctorId, p_date: date });
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

    const client = db();
    const existing = await client.from("patients").select("id, name").eq("phone", phone.phone).maybeSingle();
    if (existing.error) throw existing.error;
    let patientName = existing.data?.name ?? null;
    if (!existing.data) {
      const inserted = await client.from("patients").insert({ phone: phone.phone, name: name || null }).select("id").single();
      if (inserted.error) throw inserted.error;
      patientName = name || null;
    } else if (name && !existing.data.name) {
      const updated = await client.from("patients").update({ name }).eq("id", existing.data.id);
      if (updated.error) throw updated.error;
      patientName = name;
    }

    const { data, error } = await client.rpc("book_appointment", {
      p_phone: phone.phone,
      p_doctor_id: doctorId,
      p_date: form.date,
      p_time: form.time,
    });
    if (error) throw error;
    const r = data as RpcResult & { doctor?: string };
    if (!r.ok || !r.appointment_id) return { ok: false, error: r.error ?? "That time could not be booked." };

    const tagged = await client.from("appointments").update({ source: "staff", notes: notes || null }).eq("id", r.appointment_id);
    if (tagged.error) throw tagged.error;

    const n = await notifyPatient({ type: "booked", phone: phone.phone, patientName, doctor: r.doctor ?? "", when: r.when ?? "" });
    await log(staff, "Booked appointment", `#${r.appointment_id} for +${phone.phone} with ${r.doctor} on ${r.when}`);
    refresh();
    return { ok: true, data: { id: r.appointment_id }, message: notifyMessage(n, `Booked for ${r.when}.`) };
  });
}

export async function rescheduleAppointment(id: number, date: string, time: string): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireStaff();
    if (!int(id) || !isDateKey(date) || !TIME.test(time)) return { ok: false, error: "Choose a new date and time." };
    const appt = await getAppointment(id);
    if (!appt?.patient) return { ok: false, error: "That appointment no longer exists." };
    const { data, error } = await db().rpc("reschedule_appointment", {
      p_phone: appt.patient.phone,
      p_appointment_id: id,
      p_date: date,
      p_time: time,
    });
    if (error) throw error;
    const r = data as RpcResult;
    if (!r.ok) return { ok: false, error: r.error ?? "That time could not be booked." };
    const n = await notifyPatient({ type: "rescheduled", phone: appt.patient.phone, patientName: appt.patient.name, doctor: appt.doctor?.name ?? "", when: r.when ?? "" });
    await log(staff, "Moved appointment", `#${id} for +${appt.patient.phone} to ${r.when}`);
    refresh();
    return { ok: true, message: notifyMessage(n, `Moved to ${r.when}.`) };
  });
}

export async function cancelAppointment(id: number): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireStaff();
    if (!int(id)) return { ok: false, error: "That appointment could not be found." };
    const appt = await getAppointment(id);
    if (!appt?.patient) return { ok: false, error: "That appointment no longer exists." };
    const { data, error } = await db().rpc("cancel_appointment", { p_phone: appt.patient.phone, p_appointment_id: id });
    if (error) throw error;
    const r = data as RpcResult;
    if (!r.ok) return { ok: false, error: r.error ?? "Only upcoming appointments can be cancelled." };
    const n = await notifyPatient({ type: "cancelled", phone: appt.patient.phone, patientName: appt.patient.name, doctor: appt.doctor?.name ?? "", when: r.cancelled ?? "" });
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
    const appt = int(id) ? await getAppointment(id) : null;
    if (!appt) return { ok: false, error: "That appointment no longer exists." };
    if (!STATUS_CHANGES[appt.status]?.includes(status)) return { ok: false, error: "That change is not possible for this appointment." };
    if (status !== "confirmed" && Date.parse(appt.slot_time) > Date.now() + 60 * 60 * 1000) {
      return { ok: false, error: "You can mark a visit as seen or missed from an hour before its time." };
    }
    const { error } = await db().from("appointments").update({ status, updated_at: new Date().toISOString() }).eq("id", id).eq("status", appt.status);
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
    const { error } = await db().from("appointments").update({ notes: text(notes, 500) || null }).eq("id", id);
    if (error) throw error;
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
      .eq("id", id)
      .eq("resolved", false)
      .select("id, patient_phone");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "Someone already closed this handoff." };
    await log(staff, "Closed handoff", `#${id} for +${data[0].patient_phone ?? "?"}`);
    refresh();
    return { ok: true, message: "Handoff closed." };
  });
}

export async function reopenHandoff(id: number): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireStaff();
    if (!int(id)) return { ok: false, error: "That handoff could not be found." };
    const { error } = await db().from("escalations").update({ resolved: false, resolved_at: null, resolved_by: null }).eq("id", id);
    if (error) throw error;
    await log(staff, "Reopened handoff", `#${id}`);
    refresh();
    return { ok: true, message: "Handoff reopened." };
  });
}

/* ---------------- Doctors (admins) ---------------- */

export async function saveDoctor(form: {
  id?: number;
  name: string;
  department: string;
  fee: string;
  workingDays: number[];
  start: string;
  end: string;
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
    const days = [...new Set((form.workingDays ?? []).map(Number))].filter((d) => d >= 1 && d <= 7).sort();
    if (!days.length) return { ok: false, error: "Pick at least one working day." };
    if (!TIME.test(form.start) || !TIME.test(form.end) || form.start >= form.end) return { ok: false, error: "The finishing time must be after the starting time." };
    const slot = Number(form.slotMinutes);
    if (!Number.isInteger(slot) || slot < 5 || slot > 240) return { ok: false, error: "Appointment length must be between 5 and 240 minutes." };

    const id = form.id ? int(form.id) : null;
    if (id && !form.active) {
      const { count, error } = await db()
        .from("appointments")
        .select("id", { count: "exact", head: true })
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
      working_days: days,
      start_time: form.start,
      end_time: form.end,
      slot_minutes: slot,
      notes: text(form.notes, 300) || null,
      active: Boolean(form.active),
    };
    const result = id ? await db().from("doctors").update(row).eq("id", id) : await db().from("doctors").insert(row);
    if (result.error) throw result.error;
    await log(staff, id ? "Updated doctor" : "Added doctor", `${name} (${department})`);
    refresh();
    return { ok: true, message: id ? "Doctor updated." : "Doctor added. Patients can book them on WhatsApp now." };
  });
}

/* ---------------- Settings (admins) ---------------- */

export async function saveSettings(form: { name: string; timezone: string }): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireAdmin();
    const name = text(form.name, 80);
    const tz = text(form.timezone, 64);
    if (name.length < 2) return { ok: false, error: "Enter the clinic's name." };
    if (!isValidTimeZone(tz)) return { ok: false, error: "That time zone is not recognised. Use a name like Asia/Karachi." };
    const before = await getClinic();
    const { error } = await db()
      .from("clinic_settings")
      .upsert([
        { key: "clinic_name", value: name },
        { key: "timezone", value: tz },
      ]);
    if (error) throw error;
    await log(staff, "Changed clinic settings", `name "${name}", time zone ${tz}`);
    refresh();
    return {
      ok: true,
      message: before.timezone !== tz ? "Saved. Also update CLINIC_TIMEZONE on the automation server so WhatsApp messages use the same time zone." : "Saved.",
    };
  });
}

/* ---------------- Staff accounts (admins) ---------------- */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function role(value: unknown): "admin" | "staff" | null {
  return value === "admin" || value === "staff" ? value : null;
}

function passwordProblem(password: string): string | null {
  if (password.length < 12) return "Use at least 12 characters for the password.";
  if (password.length > 72) return "Use at most 72 characters for the password.";
  return null;
}

async function targetUser(id: string) {
  const users = await listStaffUsers();
  return { users, user: users.find((u) => u.id === id) ?? null };
}

export async function createStaffUser(form: { email: string; role: string; password: string }): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireAdmin();
    const email = text(form.email, 120).toLowerCase();
    const r = role(form.role);
    if (!EMAIL.test(email)) return { ok: false, error: "Enter a valid email address." };
    if (!r) return { ok: false, error: "Choose Front desk or Clinic admin." };
    const problem = passwordProblem(String(form.password ?? ""));
    if (problem) return { ok: false, error: problem };
    const { error } = await db().auth.admin.createUser({ email, password: String(form.password), email_confirm: true, app_metadata: { role: r } });
    if (error) {
      if (/already/i.test(error.message)) return { ok: false, error: "An account with this email already exists. Change its access in the list instead." };
      throw error;
    }
    await log(staff, "Added staff account", `${email} as ${r}`);
    refresh();
    return { ok: true, message: `Account created for ${email}. Share the temporary password privately and ask them to change it under Settings after signing in.` };
  });
}

export async function setStaffRole(id: string, newRole: string): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireAdmin();
    const r = newRole === "none" ? null : role(newRole);
    if (newRole !== "none" && !r) return { ok: false, error: "Choose a role." };
    if (id === staff.id) return { ok: false, error: "You cannot change your own access. Ask another admin." };
    const { users, user } = await targetUser(text(id, 64));
    if (!user) return { ok: false, error: "That account no longer exists." };
    if (user.role === "admin" && r !== "admin" && users.filter((u) => u.role === "admin").length <= 1) {
      return { ok: false, error: "The clinic needs at least one admin." };
    }
    const { error } = await db().auth.admin.updateUserById(user.id, { app_metadata: { role: r } });
    if (error) throw error;
    const label = r === "admin" ? "clinic admin" : r === "staff" ? "front desk" : "no access";
    await log(staff, "Changed staff access", `${user.email} is now ${label}`);
    refresh();
    return { ok: true, message: r ? `${user.email} is now ${label}.` : `${user.email} can no longer open the dashboard.` };
  });
}

export async function resetStaffPassword(id: string, password: string): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireAdmin();
    const problem = passwordProblem(String(password ?? ""));
    if (problem) return { ok: false, error: problem };
    const { user } = await targetUser(text(id, 64));
    if (!user) return { ok: false, error: "That account no longer exists." };
    const { error } = await db().auth.admin.updateUserById(user.id, { password: String(password) });
    if (error) throw error;
    await log(staff, "Reset staff password", user.email);
    refresh();
    return { ok: true, message: `New password set for ${user.email}. Share it privately.` };
  });
}

export async function deleteStaffUser(id: string): Promise<ActionResult> {
  return run(async () => {
    const staff = await requireAdmin();
    if (id === staff.id) return { ok: false, error: "You cannot delete your own account." };
    const { users, user } = await targetUser(text(id, 64));
    if (!user) return { ok: false, error: "That account no longer exists." };
    if (user.role === "admin" && users.filter((u) => u.role === "admin").length <= 1) return { ok: false, error: "The clinic needs at least one admin." };
    const { error } = await db().auth.admin.deleteUser(user.id);
    if (error) throw error;
    await log(staff, "Deleted staff account", user.email);
    refresh();
    return { ok: true, message: `${user.email} was deleted.` };
  });
}
