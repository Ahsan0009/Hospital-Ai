import "server-only";

import { db } from "@/lib/supabase/admin";

export type NotifyType = "booked" | "rescheduled" | "cancelled";
export type NotifyResult = { sent: boolean; reason?: string; channel?: "whatsapp" | "sms" };

/**
 * Asks the n8n workflow to message the patient about a desk change, on the
 * patient's channel (WhatsApp template or SMS). The dashboard never holds
 * WhatsApp or SMS credentials itself.
 */
export async function notifyPatient(input: {
  clinicId: string;
  type: NotifyType;
  phone: string;
  patientName: string | null;
  doctor: string;
  when: string;
}): Promise<NotifyResult> {
  const url = process.env.N8N_NOTIFY_URL;
  const secret = process.env.DASHBOARD_NOTIFY_SECRET;
  if (!url || !secret) return { sent: false, reason: "Automatic messages are not set up for the dashboard yet." };

  const { data: patient } = await db()
    .from("patients")
    .select("channel, sms_opt_out")
    .eq("clinic_id", input.clinicId)
    .eq("phone", input.phone)
    .maybeSingle();
  const channel = patient?.channel === "sms" ? "sms" : "whatsapp";
  if (channel === "sms" && patient?.sms_opt_out) return { sent: false, channel, reason: "the patient has opted out of text messages (STOP)." };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dashboard-secret": secret },
      body: JSON.stringify({
        clinic_id: input.clinicId,
        type: input.type,
        channel,
        patient_phone: input.phone,
        patient_name: input.patientName ?? "",
        doctor: input.doctor,
        when: input.when,
      }),
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { channel?: string };
      return { sent: true, channel: body.channel === "sms" ? "sms" : channel };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { sent: false, channel, reason: body.error ? `the message service said: ${body.error}` : `the message service answered ${res.status}.` };
  } catch {
    return { sent: false, channel, reason: "the message service could not be reached." };
  }
}
