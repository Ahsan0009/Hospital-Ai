import "server-only";

export type ZoneOption = { value: string; label: string };

const COMMON = ["Asia/Karachi", "Asia/Dubai", "Asia/Riyadh", "Asia/Kolkata", "Europe/London", "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];

function offsetOf(zone: string, at: Date): { text: string; minutes: number } {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part);
  const minutes = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return { text: m ? `UTC${m[1]}${m[2]}:${m[3]}` : "UTC", minutes };
}

/** Every IANA time zone with its current UTC offset; the most common ones first. Built on the server. */
export function timeZoneOptions(at: Date = new Date()): { common: ZoneOption[]; all: ZoneOption[] } {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = COMMON;
  }
  if (!zones.includes("UTC")) zones = [...zones, "UTC"];
  const opt = (z: string) => {
    const o = offsetOf(z, at);
    return { value: z, label: `${z.replace(/_/g, " ")} (${o.text})`, minutes: o.minutes };
  };
  const all = zones.map(opt).sort((a, b) => a.minutes - b.minutes || a.value.localeCompare(b.value));
  return {
    common: COMMON.filter((z) => zones.includes(z)).map(opt).map(({ value, label }) => ({ value, label })),
    all: all.map(({ value, label }) => ({ value, label })),
  };
}
