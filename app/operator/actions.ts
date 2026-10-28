"use server";

import { revalidatePath } from "next/cache";
import { AccessError, requireOperator } from "@/lib/auth";
import type { Operator } from "@/lib/auth";
import { encryptSecret, randomSecret, sha256Hex } from "@/lib/crypto";
import { safeLink } from "@/lib/phone";
import { db } from "@/lib/supabase/admin";
import { isValidTimeZone } from "@/lib/time";
import type { ActionResult } from "@/types/db";

// Owner-console actions. Each one checks requireOperator() first and is
// written to operator_audit.

const STATUSES = ["trial", "active", "suspended", "cancelled"] as const;
const PLANS = ["starter", "growth", "pro", "custom"] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (cause) {
    if (cause instanceof AccessError) return { ok: false, error: cause.message };
    console.error(cause);
    return { ok: false, error: "Something went wrong. Nothing was changed; try again in a moment." };
  }
}

function text(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function money(value: unknown): number | null {
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 && n <= 100_000_000 ? Math.round(n * 100) / 100 : null;
}

function isoDate(value: unknown): string | null {
  const s = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : null;
}

function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function audit(op: Operator, action: string, clinicId: string | null, detail: string) {
  const { error } = await db().from("operator_audit").insert({ operator_email: op.email, action, clinic_id: clinicId, detail: detail.slice(0, 1000) });
  if (error) console.error("operator_audit insert failed", error.message);
}

async function clinicExists(id: string): Promise<{ id: string; name: string; status: string; paid_until: string | null; currency: string } | null> {
  if (!UUID.test(id)) return null;
  const { data, error } = await db().from("clinics").select("id, name, status, paid_until, currency").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

function refresh(id?: string) {
  revalidatePath("/operator");
  if (id) revalidatePath(`/operator/clinics/${id}`);
}

/* ---------- Clinics ---------- */

export async function createClinic(form: {
  name: string;
  plan: string;
  monthlyFee: string;
  currency: string;
  trialDays: string;
  timezone: string;
  contactPhone: string;
  alertEmail: string;
  adminEmail: string;
  adminPassword: string;
}): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const op = await requireOperator();
    const name = text(form.name, 80);
    const plan = (PLANS as readonly string[]).includes(form.plan) ? form.plan : null;
    const fee = money(form.monthlyFee);
    const currency = text(form.currency, 3).toUpperCase();
    const trialDays = Math.max(0, Math.min(90, Number(form.trialDays) || 0));
    const tz = text(form.timezone, 64);
    const alertEmail = text(form.alertEmail, 120).toLowerCase();
    const adminEmail = text(form.adminEmail, 120).toLowerCase();
    const password = String(form.adminPassword ?? "");
    if (name.length < 2) return { ok: false, error: "Enter the clinic's name." };
    if (!plan) return { ok: false, error: "Choose a plan." };
    if (fee === null) return { ok: false, error: "Enter the monthly fee as a number." };
    if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "Use a 3-letter currency code such as PKR or USD." };
    if (!isValidTimeZone(tz)) return { ok: false, error: "That time zone is not recognised." };
    if (!EMAIL.test(alertEmail)) return { ok: false, error: "Enter the clinic's alert email. Handoffs, unhappy patients and critical reports are sent there." };
    if (!EMAIL.test(adminEmail)) return { ok: false, error: "Enter the clinic admin's email." };
    if (password.length < 12) return { ok: false, error: "The admin's temporary password needs at least 12 characters." };

    const inserted = await db()
      .from("clinics")
      .insert({
        name,
        plan,
        monthly_fee: fee,
        currency,
        status: trialDays > 0 ? "trial" : "active",
        paid_until: trialDays > 0 ? new Date(Date.now() + trialDays * 86400000).toISOString().slice(0, 10) : today(),
        timezone: tz,
        contact_phone: text(form.contactPhone, 30) || null,
        alert_email: alertEmail || null,
      })
      .select("id")
      .single();
    if (inserted.error) throw inserted.error;
    const clinicId = inserted.data.id as string;

    const user = await db().auth.admin.createUser({ email: adminEmail, password, email_confirm: true, app_metadata: {} });
    if (user.error || !user.data.user) {
      await db().from("clinics").delete().eq("id", clinicId);
      if (user.error && /already/i.test(user.error.message)) return { ok: false, error: "That admin email already has an account. Use another email." };
      throw user.error ?? new Error("No user returned");
    }
    const member = await db().from("staff_members").insert({ user_id: user.data.user.id, clinic_id: clinicId, role: "admin", email: adminEmail });
    if (member.error) {
      await db().auth.admin.deleteUser(user.data.user.id);
      await db().from("clinics").delete().eq("id", clinicId);
      throw member.error;
    }
    await audit(op, "Created clinic", clinicId, `${name}, ${plan}, ${fee} ${currency}/month, admin ${adminEmail}`);
    refresh();
    return { ok: true, data: { id: clinicId }, message: `${name} created. Give ${adminEmail} the temporary password privately.` };
  });
}

export async function updateClinic(
  id: string,
  form: {
    name: string;
    plan: string;
    monthlyFee: string;
    currency: string;
    timezone: string;
    contactPhone: string;
    alertEmail: string;
    googleReviewLink: string;
    templateLang: string;
    notes: string;
    limitAppointments?: string;
    limitMessages?: string;
    retentionMonths?: string;
  },
): Promise<ActionResult> {
  return run(async () => {
    const op = await requireOperator();
    const clinic = await clinicExists(id);
    if (!clinic) return { ok: false, error: "That clinic no longer exists." };
    const name = text(form.name, 80);
    const plan = (PLANS as readonly string[]).includes(form.plan) ? form.plan : null;
    const fee = money(form.monthlyFee);
    const currency = text(form.currency, 3).toUpperCase();
    const tz = text(form.timezone, 64);
    const alertEmail = text(form.alertEmail, 120).toLowerCase();
    const reviewRaw = text(form.googleReviewLink, 500);
    const review = reviewRaw ? safeLink(reviewRaw) : null;
    const lang = text(form.templateLang, 10);
    if (name.length < 2) return { ok: false, error: "Enter the clinic's name." };
    if (!plan) return { ok: false, error: "Choose a plan." };
    if (fee === null) return { ok: false, error: "Enter the monthly fee as a number." };
    if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "Use a 3-letter currency code such as PKR or USD." };
    if (!isValidTimeZone(tz)) return { ok: false, error: "That time zone is not recognised." };
    if (!EMAIL.test(alertEmail)) return { ok: false, error: "Enter the clinic's alert email. Handoffs, unhappy patients and critical reports are sent there." };
    if (reviewRaw && !review) return { ok: false, error: "The review link must start with https://." };
    if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(lang)) return { ok: false, error: "Template language must look like en or en_US." };
    const whole = (v: unknown) => {
      const t = String(v ?? "").trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isInteger(n) && n > 0 ? n : NaN;
    };
    const limitAppointments = whole(form.limitAppointments);
    const limitMessages = whole(form.limitMessages);
    const retentionMonths = whole(form.retentionMonths);
    if (Number.isNaN(limitAppointments) || Number.isNaN(limitMessages)) return { ok: false, error: "Limits must be whole numbers, or empty for the plan's limits." };
    if (Number.isNaN(retentionMonths) || (retentionMonths !== null && (retentionMonths < 6 || retentionMonths > 120))) return { ok: false, error: "Keep records for 6 to 120 months, or leave it empty to keep everything." };
    const { error } = await db()
      .from("clinics")
      .update({
        name,
        plan,
        monthly_fee: fee,
        currency,
        timezone: tz,
        contact_phone: text(form.contactPhone, 30) || null,
        alert_email: alertEmail || null,
        google_review_link: review,
        template_lang: lang,
        notes: text(form.notes, 2000) || null,
        limit_appointments: limitAppointments,
        limit_messages: limitMessages,
        retention_months: retentionMonths,
      })
      .eq("id", id);
    if (error) throw error;
    await audit(op, "Updated clinic details", id, `${name}, ${plan}, ${fee} ${currency}/month`);
    refresh(id);
    return { ok: true, message: "Saved." };
  });
}

export async function setClinicStatus(id: string, status: string, reason: string): Promise<ActionResult> {
  return run(async () => {
    const op = await requireOperator();
    const clinic = await clinicExists(id);
    if (!clinic) return { ok: false, error: "That clinic no longer exists." };
    if (!(STATUSES as readonly string[]).includes(status)) return { ok: false, error: "Unknown status." };
    const { error } = await db().from("clinics").update({ status, status_changed_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
    await audit(op, `Status: ${clinic.status} to ${status}`, id, text(reason, 500));
    refresh(id);
    const words: Record<string, string> = {
      suspended: "suspended. Its staff are signed out on their next click, and patients who message are asked to call the clinic.",
      active: "active.",
      trial: "on trial.",
      cancelled: "cancelled. Its data is kept until you delete the clinic.",
    };
    return { ok: true, message: `${clinic.name} is now ${words[status]}` };
  });
}

/* ---------- Billing (manual) ---------- */

export async function recordPayment(
  id: string,
  form: { amount: string; currency: string; months: string; periodFrom: string; method: string; reference: string; note: string; reactivate: boolean },
): Promise<ActionResult> {
  return run(async () => {
    const op = await requireOperator();
    const clinic = await clinicExists(id);
    if (!clinic) return { ok: false, error: "That clinic no longer exists." };
    const amount = money(form.amount);
    const currency = text(form.currency, 3).toUpperCase();
    const months = Math.max(1, Math.min(24, Number(form.months) || 0));
    const from = isoDate(form.periodFrom);
    if (!amount) return { ok: false, error: "Enter the amount received." };
    if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "Use a 3-letter currency code." };
    if (!from) return { ok: false, error: "Choose the date the paid period starts." };
    const to = addMonths(from, months);
    const pay = await db().from("payments").insert({
      clinic_id: id,
      clinic_name: clinic.name,
      amount,
      currency,
      period_from: from,
      period_to: to,
      method: text(form.method, 40) || null,
      reference: text(form.reference, 80) || null,
      note: text(form.note, 500) || null,
      recorded_by: op.email,
    });
    if (pay.error) throw pay.error;
    const paidUntil = clinic.paid_until && clinic.paid_until > to ? clinic.paid_until : to;
    const changes: Record<string, unknown> = { paid_until: paidUntil };
    if (form.reactivate && (clinic.status === "suspended" || clinic.status === "trial")) {
      changes.status = "active";
      changes.status_changed_at = new Date().toISOString();
    }
    const upd = await db().from("clinics").update(changes).eq("id", id);
    if (upd.error) throw upd.error;
    await audit(op, "Recorded payment", id, `${amount} ${currency} for ${from} to ${to}${changes.status ? ", reactivated" : ""}`);
    refresh(id);
    return { ok: true, message: `Payment recorded. Paid until ${paidUntil}${changes.status ? "; the clinic is active again" : ""}.` };
  });
}

/* ---------- Connections ---------- */

export async function saveWhatsApp(id: string, form: { phoneNumberId: string; displayNumber: string; token: string; clearToken: boolean }): Promise<ActionResult> {
  return run(async () => {
    const op = await requireOperator();
    const clinic = await clinicExists(id);
    if (!clinic) return { ok: false, error: "That clinic no longer exists." };
    const phoneNumberId = text(form.phoneNumberId, 32);
    if (phoneNumberId && !/^\d{6,20}$/.test(phoneNumberId)) return { ok: false, error: "The phone number ID is the long number from Meta's API setup page (digits only)." };
    const changes: Record<string, unknown> = {
      wa_phone_number_id: phoneNumberId || null,
      wa_display_number: text(form.displayNumber, 30) || null,
    };
    const token = String(form.token ?? "").trim();
    if (form.clearToken) changes.wa_token_enc = null;
    else if (token) {
      if (token.length < 20 || /\s/.test(token)) return { ok: false, error: "That does not look like a WhatsApp access token." };
      changes.wa_token_enc = encryptSecret(token);
    }
    const { error } = await db().from("clinics").update(changes).eq("id", id);
    if (error) {
      if (error.code === "23505") return { ok: false, error: "That WhatsApp number is already connected to another clinic." };
      throw error;
    }
    await audit(op, "Updated WhatsApp connection", id, `phone number ID ${phoneNumberId || "removed"}${token ? ", new token" : form.clearToken ? ", token removed" : ""}`);
    refresh(id);
    return { ok: true, message: phoneNumberId ? "WhatsApp connection saved. Messages to this number now reach this clinic." : "WhatsApp disconnected." };
  });
}

export async function saveSms(id: string, form: { enabled: boolean; number: string; preferredChannel: string }): Promise<ActionResult> {
  return run(async () => {
    const op = await requireOperator();
    const clinic = await clinicExists(id);
    if (!clinic) return { ok: false, error: "That clinic no longer exists." };
    const enabled = Boolean(form.enabled);
    const digits = String(form.number ?? "").replace(/[^0-9]/g, "");
    if (enabled && (digits.length < 10 || digits.length > 15)) return { ok: false, error: "Enter the SMS number with its country code, for example +1 305 555 0123." };
    const preferred = form.preferredChannel === "sms" && enabled ? "sms" : "whatsapp";
    const { error } = await db()
      .from("clinics")
      .update({ sms_enabled: enabled, sms_number: enabled ? `+${digits}` : null, preferred_channel: preferred })
      .eq("id", id);
    if (error) {
      if (error.code === "23505") return { ok: false, error: "That SMS number is already used by another clinic." };
      throw error;
    }
    if (!enabled) await db().from("patients").update({ channel: "whatsapp" }).eq("clinic_id", id).eq("channel", "sms");
    await audit(op, "Updated SMS settings", id, enabled ? `SMS on, number +${digits}, new bookings by ${preferred}` : "SMS off");
    refresh(id);
    return { ok: true, message: enabled ? `SMS on. Point the Twilio number +${digits} at the webhook shown here.` : "SMS off. Patients on SMS were moved back to WhatsApp." };
  });
}

export async function newReportSecret(id: string): Promise<ActionResult<{ secret: string }>> {
  return run(async () => {
    const op = await requireOperator();
    const clinic = await clinicExists(id);
    if (!clinic) return { ok: false, error: "That clinic no longer exists." };
    const secret = randomSecret(32);
    const { error } = await db().from("clinics").update({ report_secret_hash: sha256Hex(secret) }).eq("id", id);
    if (error) throw error;
    await audit(op, "Issued new lab-report secret", id, "previous secret stopped working");
    refresh(id);
    return { ok: true, data: { secret }, message: "New secret issued. The old one stopped working." };
  });
}

/* ---------- Clinic accounts ---------- */

export async function addClinicAdmin(id: string, form: { email: string; password: string }): Promise<ActionResult> {
  return run(async () => {
    const op = await requireOperator();
    const clinic = await clinicExists(id);
    if (!clinic) return { ok: false, error: "That clinic no longer exists." };
    const email = text(form.email, 120).toLowerCase();
    const password = String(form.password ?? "");
    if (!EMAIL.test(email)) return { ok: false, error: "Enter a valid email." };
    if (password.length < 12) return { ok: false, error: "The temporary password needs at least 12 characters." };
    const user = await db().auth.admin.createUser({ email, password, email_confirm: true, app_metadata: {} });
    if (user.error || !user.data.user) {
      if (user.error && /already/i.test(user.error.message)) return { ok: false, error: "That email already has an account." };
      throw user.error ?? new Error("No user returned");
    }
    const member = await db().from("staff_members").insert({ user_id: user.data.user.id, clinic_id: id, role: "admin", email });
    if (member.error) {
      await db().auth.admin.deleteUser(user.data.user.id);
      throw member.error;
    }
    await audit(op, "Added clinic admin", id, email);
    refresh(id);
    return { ok: true, message: `${email} added as clinic admin.` };
  });
}

export async function resetClinicUserPassword(id: string, userId: string, password: string): Promise<ActionResult> {
  return run(async () => {
    const op = await requireOperator();
    if (String(password ?? "").length < 12) return { ok: false, error: "The password needs at least 12 characters." };
    const { data, error } = await db().from("staff_members").select("user_id, email").eq("clinic_id", id).eq("user_id", text(userId, 64)).maybeSingle();
    if (error) throw error;
    if (!data) return { ok: false, error: "That account is not part of this clinic." };
    const r = await db().auth.admin.updateUserById(data.user_id, { password: String(password) });
    if (r.error) throw r.error;
    await audit(op, "Reset clinic user password", id, data.email);
    refresh(id);
    return { ok: true, message: `New password set for ${data.email}.` };
  });
}

/* ---------- Delete ---------- */

export async function deleteClinic(id: string, confirmName: string): Promise<ActionResult> {
  return run(async () => {
    const op = await requireOperator();
    const clinic = await clinicExists(id);
    if (!clinic) return { ok: false, error: "That clinic no longer exists." };
    if (text(confirmName, 80) !== clinic.name) return { ok: false, error: "Type the clinic's name exactly to confirm." };
    const { data: members, error } = await db().from("staff_members").select("user_id").eq("clinic_id", id);
    if (error) throw error;
    // Removing the clinic removes every patient, appointment, report and staff link with it (cascade).
    const del = await db().from("clinics").delete().eq("id", id);
    if (del.error) throw del.error;
    for (const m of members ?? []) {
      const r = await db().auth.admin.deleteUser(m.user_id);
      if (r.error) console.error("could not delete clinic user", m.user_id, r.error.message);
    }
    await audit(op, "Deleted clinic", null, `${clinic.name} (${id}) and ${members?.length ?? 0} staff accounts`);
    refresh();
    return { ok: true, message: `${clinic.name} and all its data were deleted.` };
  });
}
