import "server-only";

import { db } from "@/lib/supabase/admin";
import { addDays, dateKey, dayRange, isValidTimeZone } from "@/lib/time";
import type {
  Activity,
  Appointment,
  AppointmentStatus,
  Clinic,
  Doctor,
  ErrorLog,
  Feedback,
  Handoff,
  Patient,
  Report,
} from "@/types/db";

// Every function here runs on the server with the service-role key.
// Callers must have checked requireStaff()/requireAdmin() first.

const APPOINTMENT_FIELDS =
  "id, slot_time, status, source, notes, rescheduled, reminder_24h_sent, reminder_2h_sent, feedback_sent, created_at, patient:patients(id, name, phone), doctor:doctors(id, name, department, slot_minutes)";

function fail(context: string, error: { message: string } | null): never {
  throw new Error(`Could not load ${context}. ${error?.message ?? ""}`.trim());
}

export async function getClinic(): Promise<Clinic> {
  const { data, error } = await db().from("clinic_settings").select("key, value").in("key", ["timezone", "clinic_name"]);
  if (error) fail("clinic settings", error);
  const map = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  const timezone = isValidTimeZone(map.timezone) ? map.timezone : "UTC";
  return { name: map.clinic_name || "Clinic", timezone };
}

export async function getNavCounts(): Promise<{ openHandoffs: number; urgentHandoffs: number }> {
  const { data, error } = await db().from("escalations").select("urgency").eq("resolved", false);
  if (error) fail("handoffs", error);
  return {
    openHandoffs: data?.length ?? 0,
    urgentHandoffs: data?.filter((r) => r.urgency === "urgent").length ?? 0,
  };
}

export async function listDoctors(opts: { activeOnly?: boolean } = {}): Promise<Doctor[]> {
  let q = db()
    .from("doctors")
    .select("id, name, department, consultation_fee, working_days, start_time, end_time, slot_minutes, active, notes")
    .order("department")
    .order("name");
  if (opts.activeOnly) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) fail("doctors", error);
  return (data ?? []).map((d) => ({
    ...d,
    start_time: String(d.start_time).slice(0, 5),
    end_time: String(d.end_time).slice(0, 5),
    consultation_fee: d.consultation_fee === null ? null : Number(d.consultation_fee),
  })) as Doctor[];
}

export async function listAppointmentsForDay(key: string, tz: string): Promise<Appointment[]> {
  const { start, end } = dayRange(key, tz);
  const { data, error } = await db()
    .from("appointments")
    .select(APPOINTMENT_FIELDS)
    .gte("slot_time", start.toISOString())
    .lt("slot_time", end.toISOString())
    .order("slot_time");
  if (error) fail("appointments", error);
  return (data ?? []) as unknown as Appointment[];
}

export async function listAppointments(opts: {
  from: string;
  days: number;
  tz: string;
  status?: AppointmentStatus | "all";
  doctorId?: number;
}): Promise<Appointment[]> {
  const start = dayRange(opts.from, opts.tz).start;
  const end = dayRange(addDays(opts.from, opts.days - 1), opts.tz).end;
  let q = db()
    .from("appointments")
    .select(APPOINTMENT_FIELDS)
    .gte("slot_time", start.toISOString())
    .lt("slot_time", end.toISOString())
    .order("slot_time")
    .limit(500);
  if (opts.status && opts.status !== "all") q = q.eq("status", opts.status);
  if (opts.doctorId) q = q.eq("doctor_id", opts.doctorId);
  const { data, error } = await q;
  if (error) fail("appointments", error);
  return (data ?? []) as unknown as Appointment[];
}

export async function getAppointment(id: number): Promise<Appointment | null> {
  const { data, error } = await db().from("appointments").select(APPOINTMENT_FIELDS).eq("id", id).maybeSingle();
  if (error) fail("the appointment", error);
  return (data as unknown as Appointment) ?? null;
}

export async function listHandoffs(resolved: boolean, limit = 100): Promise<Handoff[]> {
  const { data, error } = await db()
    .from("escalations")
    .select("id, patient_phone, patient_id, reason, urgency, resolved, resolved_at, resolved_by, staff_note, created_at, patient:patients(id, name)")
    .eq("resolved", resolved)
    .order(resolved ? "resolved_at" : "created_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) fail("handoffs", error);
  const rows = (data ?? []) as unknown as Handoff[];
  // Urgent ones first while they are open.
  return resolved ? rows : rows.sort((a, b) => Number(b.urgency === "urgent") - Number(a.urgency === "urgent"));
}

export async function listReports(opts: { criticalOnly?: boolean; limit?: number } = {}): Promise<Report[]> {
  let q = db()
    .from("reports")
    .select("id, report_type, report_link, summary, is_critical, created_at, patient:patients(id, name, phone)")
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 200);
  if (opts.criticalOnly) q = q.eq("is_critical", true);
  const { data, error } = await q;
  if (error) fail("reports", error);
  return (data ?? []) as unknown as Report[];
}

export async function listFeedback(sinceIso: string): Promise<Feedback[]> {
  const { data, error } = await db()
    .from("feedback")
    .select("id, rating, patient_phone, requested_at, responded_at, appointment:appointments(id, slot_time, doctor:doctors(name), patient:patients(id, name))")
    .gte("requested_at", sinceIso)
    .order("requested_at", { ascending: false })
    .limit(1000);
  if (error) fail("feedback", error);
  return (data ?? []) as unknown as Feedback[];
}

export async function listRecentErrors(sinceIso: string, limit = 20): Promise<ErrorLog[]> {
  const { data, error } = await db()
    .from("error_log")
    .select("id, source, patient_phone, error_detail, created_at")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) fail("delivery problems", error);
  return (data ?? []) as ErrorLog[];
}

export async function listActivity(limit = 25): Promise<Activity[]> {
  const { data, error } = await db()
    .from("staff_activity")
    .select("id, staff_email, action, detail, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) fail("staff activity", error);
  return (data ?? []) as Activity[];
}

/** Characters that would change the meaning of a PostgREST filter are removed. */
export function cleanSearch(q: string | undefined): string {
  return String(q ?? "").replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, 60);
}

export type PatientRow = Patient & { visits: number; next_visit: string | null; last_visit: string | null };

export async function listPatients(opts: { q?: string; page: number; pageSize: number }): Promise<{ rows: PatientRow[]; total: number }> {
  const term = cleanSearch(opts.q);
  let q = db()
    .from("patients")
    .select("id, phone, name, last_message_at, created_at, appointments(slot_time, status)", { count: "exact" })
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .range(opts.page * opts.pageSize, opts.page * opts.pageSize + opts.pageSize - 1);
  if (term) {
    const digits = term.replace(/\D/g, "");
    q = digits.length >= 3 ? q.or(`name.ilike.%${term}%,phone.like.%${digits}%`) : q.ilike("name", `%${term}%`);
  }
  const { data, error, count } = await q;
  if (error) fail("patients", error);
  const now = Date.now();
  const rows = (data ?? []).map((p) => {
    const visits = (p.appointments ?? []) as { slot_time: string; status: AppointmentStatus }[];
    const upcoming = visits
      .filter((v) => v.status === "confirmed" && Date.parse(v.slot_time) >= now)
      .map((v) => v.slot_time)
      .sort()[0];
    const past = visits
      .filter((v) => v.status === "completed")
      .map((v) => v.slot_time)
      .sort()
      .at(-1);
    return {
      id: p.id,
      phone: p.phone,
      name: p.name,
      last_message_at: p.last_message_at,
      created_at: p.created_at,
      visits: visits.filter((v) => v.status === "completed").length,
      next_visit: upcoming ?? null,
      last_visit: past ?? null,
    };
  });
  return { rows, total: count ?? rows.length };
}

export async function getPatient(id: number) {
  const client = db();
  const [patient, appointments, reports, feedback, handoffs] = await Promise.all([
    client.from("patients").select("id, phone, name, last_message_at, created_at").eq("id", id).maybeSingle(),
    client.from("appointments").select(APPOINTMENT_FIELDS).eq("patient_id", id).order("slot_time", { ascending: false }).limit(100),
    client.from("reports").select("id, report_type, report_link, summary, is_critical, created_at, patient:patients(id, name, phone)").eq("patient_id", id).order("created_at", { ascending: false }),
    client.from("feedback").select("id, rating, patient_phone, requested_at, responded_at, appointment:appointments!inner(id, slot_time, patient_id, doctor:doctors(name), patient:patients(id, name))").eq("appointment.patient_id", id).order("requested_at", { ascending: false }),
    client.from("escalations").select("id, patient_phone, patient_id, reason, urgency, resolved, resolved_at, resolved_by, staff_note, created_at, patient:patients(id, name)").eq("patient_id", id).order("created_at", { ascending: false }),
  ]);
  for (const [name, r] of [["the patient", patient], ["appointments", appointments], ["reports", reports], ["feedback", feedback], ["handoffs", handoffs]] as const) {
    if (r.error) fail(name, r.error);
  }
  if (!patient.data) return null;
  return {
    patient: patient.data as Patient,
    appointments: (appointments.data ?? []) as unknown as Appointment[],
    reports: (reports.data ?? []) as unknown as Report[],
    feedback: (feedback.data ?? []) as unknown as Feedback[],
    handoffs: (handoffs.data ?? []) as unknown as Handoff[],
  };
}

export async function getToday(tz: string) {
  const now = new Date();
  const key = dateKey(now, tz);
  const day24 = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const day2 = new Date(now.getTime() - 48 * 3600 * 1000).toISOString();
  const [doctors, appointments, handoffs, critical, feedback, errors] = await Promise.all([
    listDoctors({ activeOnly: true }),
    listAppointmentsForDay(key, tz),
    listHandoffs(false, 20),
    db()
      .from("reports")
      .select("id, report_type, report_link, summary, is_critical, created_at, patient:patients(id, name, phone)")
      .eq("is_critical", true)
      .gte("created_at", day24)
      .order("created_at", { ascending: false }),
    db()
      .from("feedback")
      .select("id, rating, patient_phone, requested_at, responded_at, appointment:appointments(id, slot_time, doctor:doctors(name), patient:patients(id, name))")
      .lte("rating", 3)
      .gte("responded_at", day2)
      .order("responded_at", { ascending: false }),
    listRecentErrors(day24, 5),
  ]);
  if (critical.error) fail("critical reports", critical.error);
  if (feedback.error) fail("feedback", feedback.error);
  return {
    key,
    doctors,
    appointments,
    handoffs,
    criticalReports: (critical.data ?? []) as unknown as Report[],
    lowRatings: (feedback.data ?? []) as unknown as Feedback[],
    errors,
  };
}
