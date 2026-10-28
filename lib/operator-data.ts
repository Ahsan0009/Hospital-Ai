import "server-only";

import { db } from "@/lib/supabase/admin";
import { dateKey, dayRange } from "@/lib/time";

// The owner console sees clinics, billing and health counts. It never loads
// patient names, numbers, messages or reports.

export type ClinicRow = {
  id: string;
  name: string;
  status: "trial" | "active" | "suspended" | "cancelled";
  plan: string;
  monthly_fee: number;
  currency: string;
  paid_until: string | null;
  timezone: string;
  contact_phone: string | null;
  alert_email: string | null;
  google_review_link: string | null;
  template_lang: string;
  wa_phone_number_id: string | null;
  wa_display_number: string | null;
  has_own_token: boolean;
  has_report_secret: boolean;
  notes: string | null;
  created_at: string;
  status_changed_at: string;
  sms_enabled: boolean;
  sms_number: string | null;
  preferred_channel: "whatsapp" | "sms";
  limit_appointments: number | null;
  limit_messages: number | null;
  retention_months: number | null;
};

export type Usage = { appointments: number; messages: number };

export type Health = {
  clinic_id: string;
  last_message_at: string | null;
  messages_24h: number;
  bookings_7d: number;
  upcoming: number;
  open_handoffs: number;
  urgent_handoffs: number;
  send_failures_24h: number;
  patients: number;
  doctors: number;
  staff: number;
};

const CLINIC_FIELDS =
  "id, name, status, plan, monthly_fee, currency, paid_until, timezone, contact_phone, alert_email, google_review_link, template_lang, wa_phone_number_id, wa_display_number, wa_token_enc, report_secret_hash, notes, created_at, status_changed_at, sms_enabled, sms_number, preferred_channel, limit_appointments, limit_messages, retention_months";

/** First day of the current month in the owner's time zone, as an instant. */
export function monthStart(tz: string): Date {
  const today = dateKey(new Date(), tz);
  return dayRange(`${today.slice(0, 7)}-01`, tz).start;
}

async function usageSince(since: Date): Promise<Record<string, Usage>> {
  const { data, error } = await db().rpc("clinic_usage", { p_since: since.toISOString() });
  if (error) throw new Error(`Could not load usage. ${error.message}`);
  const out: Record<string, Usage> = {};
  for (const r of (data ?? []) as { clinic_id: string; appointments: number; messages: number }[]) {
    out[r.clinic_id] = { appointments: Number(r.appointments), messages: Number(r.messages) };
  }
  return out;
}

/** When the automation last checked in (null if never). */
export async function getHeartbeat(): Promise<string | null> {
  const { data, error } = await db().from("platform_heartbeat").select("seen_at").eq("name", "scheduler").maybeSingle();
  if (error) throw new Error(`Could not load the automation status. ${error.message}`);
  return data?.seen_at ?? null;
}

function toRow(c: Record<string, unknown>): ClinicRow {
  const { wa_token_enc, report_secret_hash, ...rest } = c;
  return {
    ...(rest as Omit<ClinicRow, "has_own_token" | "has_report_secret">),
    monthly_fee: Number(c.monthly_fee),
    has_own_token: Boolean(wa_token_enc),
    has_report_secret: Boolean(report_secret_hash),
  };
}

export async function listClinics(tz = "Asia/Karachi"): Promise<{ clinics: ClinicRow[]; health: Record<string, Health>; usage: Record<string, Usage>; heartbeat: string | null }> {
  const [clinics, health, usage, heartbeat] = await Promise.all([
    db().from("clinics").select(CLINIC_FIELDS).order("created_at", { ascending: false }),
    db().rpc("operator_clinic_health"),
    usageSince(monthStart(tz)),
    getHeartbeat(),
  ]);
  if (clinics.error) throw new Error(`Could not load clinics. ${clinics.error.message}`);
  if (health.error) throw new Error(`Could not load clinic health. ${health.error.message}`);
  const byId: Record<string, Health> = {};
  for (const h of (health.data ?? []) as Health[]) byId[h.clinic_id] = h;
  return { clinics: (clinics.data ?? []).map(toRow), health: byId, usage, heartbeat };
}

export async function getClinicDetail(id: string, tz = "Asia/Karachi") {
  const [clinic, staff, payments, audit, health, usage] = await Promise.all([
    db().from("clinics").select(CLINIC_FIELDS).eq("id", id).maybeSingle(),
    db().from("staff_members").select("user_id, role, email, created_at").eq("clinic_id", id).order("role").order("email"),
    db().from("payments").select("*").eq("clinic_id", id).order("recorded_at", { ascending: false }).limit(50),
    db().from("operator_audit").select("*").eq("clinic_id", id).order("created_at", { ascending: false }).limit(30),
    db().rpc("operator_clinic_health"),
    usageSince(monthStart(tz)),
  ]);
  for (const r of [clinic, staff, payments, audit, health]) if (r.error) throw new Error(r.error.message);
  if (!clinic.data) return null;
  const lastSignIn = await Promise.all(
    (staff.data ?? []).map(async (m) => (await db().auth.admin.getUserById(m.user_id)).data?.user?.last_sign_in_at ?? null),
  );
  return {
    clinic: toRow(clinic.data),
    staff: (staff.data ?? []).map((m, i) => ({ ...m, last_sign_in_at: lastSignIn[i] })),
    payments: payments.data ?? [],
    audit: audit.data ?? [],
    health: ((health.data ?? []) as Health[]).find((h) => h.clinic_id === id) ?? null,
    usage: usage[id] ?? { appointments: 0, messages: 0 },
  };
}
