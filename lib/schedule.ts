import { formatClock } from "@/lib/time";
import type { Session } from "@/types/db";

export const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const DAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** "9:00 AM to 1:00 PM, 5:00 PM to 9:00 PM" for the sessions of one day. */
export function dayHours(sessions: Session[]): string {
  return sessions.map((s) => `${formatClock(s.start)} to ${formatClock(s.end)}`).join(", ");
}

/** Groups days with identical hours: "Mon to Fri: 9:00 AM to 1:00 PM · Sat: 10:00 AM to 2:00 PM". */
export function scheduleSummary(sessions: Session[]): { days: string; hours: string }[] {
  const byDay = new Map<number, Session[]>();
  for (const s of sessions) byDay.set(s.weekday, [...(byDay.get(s.weekday) ?? []), s]);
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const groups: { from: number; to: number; key: string; hours: string }[] = [];
  for (const d of days) {
    const list = (byDay.get(d) ?? []).sort((a, b) => a.start.localeCompare(b.start));
    const key = list.map((s) => `${s.start}-${s.end}`).join(",");
    const last = groups[groups.length - 1];
    if (last && last.key === key && last.to === d - 1) last.to = d;
    else groups.push({ from: d, to: d, key, hours: dayHours(list) });
  }
  return groups.map((g) => ({
    days: g.from === g.to ? DAY_SHORT[g.from - 1] : `${DAY_SHORT[g.from - 1]} to ${DAY_SHORT[g.to - 1]}`,
    hours: g.hours,
  }));
}

export function sessionsFor(sessions: Session[], weekday: number): Session[] {
  return sessions.filter((s) => s.weekday === weekday).sort((a, b) => a.start.localeCompare(b.start));
}
