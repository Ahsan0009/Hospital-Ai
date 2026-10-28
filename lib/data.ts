import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { db } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";
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
  TimeOff,
} from "@/types/db";

/**
 * Reads run as the signed-in staff member, so row-level security in the
 * database only returns their own clinic's rows. Every query also filters on
 * clinic_id explicitly: two independent locks, either one alone is enough.
 */
export type Scope = { client: SupabaseClient; clinicId: string };

export async function scopeFor(staff: Staff): Promise<Scope> {
  return { client: await getSupabaseServerClient(), clinicId: staff.clinicId };
}

const APPOINTMENT_FIELDS =
  "id, slot_time, status, source, notes, rescheduled, reminder_24h_sent, reminder_2h_sent, feedback_sent, created_at, patient:patients(id, name, phone), doctor:doctors(id, name, department, slot_minutes)";

function fail(context: string, error: { message: string } | null): never {
  throw new Error(`Could not load ${context}. ${error?.message ?? ""}`.trim());
}

export async function getClinic(s: Scope): Promise<Clinic> {
  const { data, error } = await s.client
    .from("clinics")
    .select("id, name, timezone, contact_phone, alert_email, google_review_link, wa_display_number, remind_24h, remind_2h, ask_feedback, sms_enabled, sms_number, preferred_channel")
    .eq("id", s.clinicId)
    .single();
  if (error) fail("clinic settings", error);
  return {
    id: data.id,
    name: data.name,
    timezone: isValidTimeZone(data.timezone) ? data.timezone : "UTC",
    contactPhone: data.contact_phone,
    alertEmail: data.alert_email,
    googleReviewLink: data.google_review_link,
    whatsappNumber: data.wa_display_number,
    remind24h: data.remind_24h !== false,
    remind2h: data.remind_2h !== false,
    askFeedback: data.ask_feedback !== false,
    smsEnabled: data.sms_enabled === true,
    smsNumber: data.sms_number,
    preferredChannel: data.preferred_channel === "sms" ? "sms" : "whatsapp",
  };
}

export async function getNavCounts(s: Scope): Promise<{ openHandoffs: number; urgentHandoffs: number }> {
  const { data, error } = await s.client.from("escalations").select("urgency").eq("clinic_id", s.clinicId).eq("resolved", false);
  if (error) fail("handoffs", error);
  return {
    openHandoffs: data?.length ?? 0,
    urgentHandoffs: data?.filter((r) => r.urgency === "urgent").length ?? 0,
  };
}

export async function listDoctors(s: Scope, opts: { activeOnly?: boolean } = {}): Promise<Doctor[]> {
  let q = s.client
    .from("doctors")
    .select("id, name, department, consultation_fee, working_days, start_time, end_time, slot_minutes, active, notes, sessions:doctor_sessions(weekday, start_time, end_time)")
    .eq("clinic_id", s.clinicId)
    .order("department")
    .order("name");
  if (opts.activeOnly) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) fail("doctors", error);
  return (data ?? []).map((d) => {
    const { sessions, ...rest } = d as typeof d & { sessions: { weekday: number; start_time: string; end_time: string }[] | null };
    return {
      ...rest,
      start_time: String(d.start_time).slice(0, 5),
      end_time: String(d.end_time).slice(0, 5),
      consultation_fee: d.consultation_fee === null ? null : Number(d.consultation_fee),
      sessions: (sessions ?? [])
        .map((x) => ({ weekday: Number(x.weekday), start: String(x.start_time).slice(0, 5), end: String(x.end_time).slice(0, 5) }))
        .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start)),
    };
  }) as Doctor[];
}

/** Days off and closures that end on or after `fromKey` (YYYY-MM-DD), soonest first. */
export async function listTimeOff(s: Scope, fromKey: string): Promise<TimeOff[]> {
  const { data, error } = await s.client
    .from("doctor_time_off")
    .select("id, doctor_id, starts_on, ends_on, reason, doctor:doctors(name)")
    .eq("clinic_id", s.clinicId)
    .gte("ends_on", fromKey)
    .order("starts_on")
    .limit(200);
  if (error) fail("days off", error);
  return (data ?? []).map((r) => ({
    id: r.id,
    doctorId: r.doctor_id,
    doctorName: (r.doctor as unknown as { name: string } | null)?.name ?? null,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    reason: r.reason,
  }));
}

/** Booked (confirmed) visits from now on that fall on a day off or a closure. */
export async function listTimeOffClashes(s: Scope, tz: string, timeOff: TimeOff[]) {
  if (!timeOff.length) return [] as { appointmentId: number; doctorName: string; when: string; patient: string; slotTime: string }[];
  const last = timeOff.reduce((m, o) => (o.endsOn > m ? o.endsOn : m), timeOff[0].endsOn);
  const { end } = dayRange(last, tz);
  const { data, error } = await s.client
    .from("appointments")
    .select("id, slot_time, doctor_id, doctor:doctors(name), patient:patients(name, phone)")
    .eq("clinic_id", s.clinicId)
    .eq("status", "confirmed")
    .gte("slot_time", new Date().toISOString())
    .lt("slot_time", end.toISOString())
    .order("slot_time")
    .limit(500);
  if (error) fail("booked visits", error);
  return (data ?? [])
    .filter((a) => {
      const k = dateKey(a.slot_time, tz);
      return timeOff.some((o) => (o.doctorId === null || o.doctorId === a.doctor_id) && k >= o.startsOn && k <= o.endsOn);
    })
    .map((a) => ({
      appointmentId: a.id,
      slotTime: a.slot_time,
      doctorName: (a.doctor as unknown as { name: string } | null)?.name ?? "",
      when: a.slot_time,
      patient: (a.patient as unknown as { name: string | null; phone: string } | null)?.name || (a.patient as unknown as { phone: string } | null)?.phone || "",
    }));
}

export async function listAppointmentsForDay(s: Scope, key: string, tz: string): Promise<Appointment[]> {
  const { start, end } = dayRange(key, tz);
  const { data, error } = await s.client
    .from("appointments")
    .select(APPOINTMENT_FIELDS)
    .eq("clinic_id", s.clinicId)
    .gte("slot_time", start.toISOString())
    .lt("slot_time", end.toISOString())
    .order("slot_time");
  if (error) fail("appointments", error);
  return (data ?? []) as unknown as Appointment[];
}

export async function listAppointments(s: Scope, opts: {
  from: string;
  days: number;
  tz: string;
  status?: AppointmentStatus | "all";
  doctorId?: number;
}): Promise<Appointment[]> {
  const start = dayRange(opts.from, opts.tz).start;
  const end = dayRange(addDays(opts.from, opts.days - 1), opts.tz).end;
  let q = s.client
    .from("appointments")
    .select(APPOINTMENT_FIELDS)
    .eq("clinic_id", s.clinicId)
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

/** Used by server actions: a service-role read, always pinned to the caller's clinic. */
export async function getAppointment(clinicId: string, id: number): Promise<Appointment | null> {
  const { data, error } = await db().from("appointments").select(APPOINTMENT_FIELDS).eq("clinic_id", clinicId).eq("id", id).maybeSingle();
  if (error) fail("the appointment", error);
  return (data as unknown as Appointment) ?? null;
}

export async function listHandoffs(s: Scope, resolved: boolean, limit = 100): Promise<Handoff[]> {
  const { data, error } = await s.client
    .from("escalations")
    .select("id, patient_phone, patient_id, reason, urgency, resolved, resolved_at, resolved_by, staff_note, created_at, patient:patients(id, name)")
    .eq("clinic_id", s.clinicId)
    .eq("resolved", resolved)
    .order(resolved ? "resolved_at" : "created_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) fail("handoffs", error);
  const rows = (data ?? []) as unknown as Handoff[];
  // Urgent ones first while they are open.
  return resolved ? rows : rows.sort((a, b) => Number(b.urgency === "urgent") - Number(a.urgency === "urgent"));
}

export async function listReports(s: Scope, opts: { criticalOnly?: boolean; limit?: number } = {}): Promise<Report[]> {
  let q = s.client
    .from("reports")
    .select("id, report_type, report_link, summary, is_critical, created_at, patient:patients(id, name, phone)")
    .eq("clinic_id", s.clinicId)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 200);
  if (opts.criticalOnly) q = q.eq("is_critical", true);
  const { data, error } = await q;
  if (error) fail("reports", error);
  return (data ?? []) as unknown as Report[];
}

export async function listFeedback(s: Scope, sinceIso: string): Promise<Feedback[]> {
  const { data, error } = await s.client
    .from("feedback")
    .select("id, rating, patient_phone, requested_at, responded_at, appointment:appointments(id, slot_time, doctor:doctors(name), patient:patients(id, name))")
    .eq("clinic_id", s.clinicId)
    .gte("requested_at", sinceIso)
    .order("requested_at", { ascending: false })
    .limit(1000);
  if (error) fail("feedback", error);
  return (data ?? []) as unknown as Feedback[];
}

export async function listRecentErrors(s: Scope, sinceIso: string, limit = 20): Promise<ErrorLog[]> {
  const { data, error } = await s.client
    .from("error_log")
    .select("id, source, patient_phone, error_detail, created_at")
    .eq("clinic_id", s.clinicId)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) fail("delivery problems", error);
  return (data ?? []) as ErrorLog[];
}

export async function listActivity(s: Scope, limit = 25): Promise<Activity[]> {
  const { data, error } = await s.client
    .from("staff_activity")
    .select("id, staff_email, action, detail, created_at")
    .eq("clinic_id", s.clinicId)
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

export async function listPatients(s: Scope, opts: { q?: string; page: number; pageSize: number }): Promise<{ rows: PatientRow[]; total: number }> {
  const term = cleanSearch(opts.q);
  let q = s.client
    .from("patients")
    .select("id, phone, name, last_message_at, created_at, appointments(slot_time, status)", { count: "exact" })
    .eq("clinic_id", s.clinicId)
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

export async function getPatient(s: Scope, id: number) {
  const client = s.client;
  const c = s.clinicId;
  const [patient, appointments, reports, feedback, handoffs] = await Promise.all([
    client.from("patients").select("id, phone, name, last_message_at, created_at, channel, sms_opt_out").eq("clinic_id", c).eq("id", id).maybeSingle(),
    client.from("appointments").select(APPOINTMENT_FIELDS).eq("clinic_id", c).eq("patient_id", id).order("slot_time", { ascending: false }).limit(100),
    client.from("reports").select("id, report_type, report_link, summary, is_critical, created_at, patient:patients(id, name, phone)").eq("clinic_id", c).eq("patient_id", id).order("created_at", { ascending: false }),
    client.from("feedback").select("id, rating, patient_phone, requested_at, responded_at, appointment:appointments!inner(id, slot_time, patient_id, doctor:doctors(name), patient:patients(id, name))").eq("clinic_id", c).eq("appointment.patient_id", id).order("requested_at", { ascending: false }),
    client.from("escalations").select("id, patient_phone, patient_id, reason, urgency, resolved, resolved_at, resolved_by, staff_note, created_at, patient:patients(id, name)").eq("clinic_id", c).eq("patient_id", id).order("created_at", { ascending: false }),
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

export async function getToday(s: Scope, tz: string) {
  const now = new Date();
  const key = dateKey(now, tz);
  const day24 = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const day2 = new Date(now.getTime() - 48 * 3600 * 1000).toISOString();
  const [doctors, appointments, handoffs, critical, feedback, errors, timeOff] = await Promise.all([
    listDoctors(s, { activeOnly: true }),
    listAppointmentsForDay(s, key, tz),
    listHandoffs(s, false, 20),
    s.client
      .from("reports")
      .select("id, report_type, report_link, summary, is_critical, created_at, patient:patients(id, name, phone)")
      .eq("clinic_id", s.clinicId)
      .eq("is_critical", true)
      .gte("created_at", day24)
      .order("created_at", { ascending: false }),
    s.client
      .from("feedback")
      .select("id, rating, patient_phone, requested_at, responded_at, appointment:appointments(id, slot_time, doctor:doctors(name), patient:patients(id, name))")
      .eq("clinic_id", s.clinicId)
      .lte("rating", 3)
      .gte("responded_at", day2)
      .order("responded_at", { ascending: false }),
    listRecentErrors(s, day24, 5),
    listTimeOff(s, key),
  ]);
  if (critical.error) fail("critical reports", critical.error);
  const clashes = await listTimeOffClashes(s, tz, timeOff);
  if (feedback.error) fail("feedback", feedback.error);
  return {
    key,
    doctors,
    appointments,
    handoffs,
    criticalReports: (critical.data ?? []) as unknown as Report[],
    lowRatings: (feedback.data ?? []) as unknown as Feedback[],
    errors,
    timeOff,
    clashes,
  };
}
