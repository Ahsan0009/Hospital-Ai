import "server-only";

export type NotifyType = "booked" | "rescheduled" | "cancelled";
export type NotifyResult = { sent: boolean; reason?: string };

/**
 * Asks the n8n workflow to send the patient a WhatsApp template message.
 * The dashboard never holds WhatsApp credentials itself.
 */
export async function notifyPatient(input: {
  type: NotifyType;
  phone: string;
  patientName: string | null;
  doctor: string;
  when: string;
}): Promise<NotifyResult> {
  const url = process.env.N8N_NOTIFY_URL;
  const secret = process.env.DASHBOARD_NOTIFY_SECRET;
  if (!url || !secret) return { sent: false, reason: "Automatic WhatsApp messages are not set up for the dashboard yet." };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dashboard-secret": secret },
      body: JSON.stringify({
        type: input.type,
        patient_phone: input.phone,
        patient_name: input.patientName ?? "",
        doctor: input.doctor,
        when: input.when,
      }),
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (res.ok) return { sent: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { sent: false, reason: body.error ? `WhatsApp said: ${body.error}` : `The message service answered ${res.status}.` };
  } catch {
    return { sent: false, reason: "The message service could not be reached." };
  }
}
