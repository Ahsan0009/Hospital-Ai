// Time helpers. Everything a person sees is in the clinic's time zone,
// whatever time zone the server or the browser happens to be in.

function parts(date: Date, tz: string) {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date)) {
    out[p.type] = p.value;
  }
  return out;
}

function offsetMs(date: Date, tz: string): number {
  const p = parts(date, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DD of an instant, in the clinic's time zone. */
export function dateKey(value: Date | string, tz: string): string {
  const p = parts(new Date(value), tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function isDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** The instant a clinic wall-clock time happens. */
export function zonedToUtc(key: string, hhmm: string, tz: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = offsetMs(new Date(guess), tz);
  let t = guess - first;
  const second = offsetMs(new Date(t), tz);
  if (second !== first) t = guess - second;
  return new Date(t);
}

/** [start, end) of a clinic day, as instants. */
export function dayRange(key: string, tz: string): { start: Date; end: Date } {
  return { start: zonedToUtc(key, "00:00", tz), end: zonedToUtc(addDays(key, 1), "00:00", tz) };
}

export function addDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ISO weekday of a date key: 1 = Monday … 7 = Sunday. */
export function isoWeekday(key: string): number {
  const day = new Date(`${key}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function minutesInDay(value: Date | string, tz: string): number {
  const p = parts(new Date(value), tz);
  return (+p.hour % 24) * 60 + +p.minute;
}

export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function formatTime(value: Date | string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function formatClock(hhmm: string): string {
  const mins = timeToMinutes(hhmm);
  const d = new Date(Date.UTC(2000, 0, 1, Math.floor(mins / 60), mins % 60));
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(d);
}

export function formatDay(value: Date | string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(value));
}

export function formatDayKey(key: string, style: "long" | "short" = "long"): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: style,
    day: "numeric",
    month: style === "long" ? "long" : "short",
    year: style === "long" ? "numeric" : undefined,
  }).format(new Date(`${key}T12:00:00Z`));
}

export function formatDateTime(value: Date | string, tz: string): string {
  return `${formatDay(value, tz)}, ${formatTime(value, tz)}`;
}

export function formatAgo(value: Date | string, tz: string, now: Date = new Date()): string {
  const diff = Math.round((now.getTime() - new Date(value).getTime()) / 60000);
  if (diff < 1) return "just now";
  if (diff < 60) return `${diff} min ago`;
  if (diff < 24 * 60 && dateKey(value, tz) === dateKey(now, tz)) return `${Math.floor(diff / 60)} h ago`;
  if (dateKey(value, tz) === addDays(dateKey(now, tz), -1)) return `Yesterday, ${formatTime(value, tz)}`;
  return formatDateTime(value, tz);
}

/** An ISO instant `days` days before now. */
export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400 * 1000).toISOString();
}

export function nowMs(): number {
  return Date.now();
}
