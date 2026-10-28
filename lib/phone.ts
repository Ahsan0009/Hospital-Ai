// WhatsApp numbers are stored as digits only, with the country code: 923001234567.

export type PhoneResult = { ok: true; phone: string } | { ok: false; error: string };

export function normalizePhone(input: string): PhoneResult {
  const raw = String(input ?? "").trim();
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!digits) return { ok: false, error: "Enter the patient's WhatsApp number." };
  if (digits.startsWith("0") && !raw.startsWith("+")) {
    return { ok: false, error: "Include the country code, for example 92 300 1234567 instead of 0300 1234567." };
  }
  if (digits.length < 8 || digits.length > 15) {
    return { ok: false, error: "That number looks too short or too long. Use the full international number." };
  }
  return { ok: true, phone: digits };
}

export function displayPhone(phone: string | null | undefined): string {
  return phone ? `+${phone}` : "";
}

export function whatsappLink(phone: string, text?: string): string {
  return `https://wa.me/${phone}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

/** Only plain https links from the lab system are ever made clickable. */
export function safeLink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}
