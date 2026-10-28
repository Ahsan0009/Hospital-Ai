"use client";

import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { AppointmentDrawer } from "@/app/(app)/appointment-drawer";
import { BookDialog } from "@/app/(app)/book-dialog";
import { STATUS_LABEL, StatusPill } from "@/app/(app)/ui";
import { displayPhone } from "@/lib/phone";
import { formatDayKey, formatTime, isoWeekday, minutesInDay, timeToMinutes } from "@/lib/time";
import { dayHours, sessionsFor } from "@/lib/schedule";
import type { Appointment, Doctor, TimeOff } from "@/types/db";

const HOUR = 88;

function hourLabel(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  return `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
}

function useNowMinutes(tz: string) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(minutesInDay(new Date(), tz));
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [tz]);
  return now;
}

/** Keeps the front desk's view current without a manual reload. */
function useAutoRefresh(ms: number, paused: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, ms);
    return () => window.clearInterval(id);
  }, [ms, paused, router]);
}

export function DaySheet({ doctors, appointments, tz, todayKey, timeOff = [] }: { doctors: Doctor[]; appointments: Appointment[]; tz: string; todayKey: string; timeOff?: TimeOff[] }) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [booking, setBooking] = useState(false);
  const nowMin = useNowMinutes(tz);
  useAutoRefresh(60_000, selectedId !== null || booking);

  const weekday = isoWeekday(todayKey);
  const clinicClosed = timeOff.some((o) => o.doctorId === null && todayKey >= o.startsOn && todayKey <= o.endsOn);
  const awayToday = (id: number) => clinicClosed || timeOff.some((o) => o.doctorId === id && todayKey >= o.startsOn && todayKey <= o.endsOn);
  const todays = (d: Doctor) => (awayToday(d.id) ? [] : sessionsFor(d.sessions, weekday));
  const withVisits = new Set(appointments.map((a) => a.doctor?.id));
  const columns = doctors.filter((d) => sessionsFor(d.sessions, weekday).length > 0 || withVisits.has(d.id));

  const range = (() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const d of columns) {
      for (const x of sessionsFor(d.sessions, weekday)) {
        lo = Math.min(lo, timeToMinutes(x.start));
        hi = Math.max(hi, timeToMinutes(x.end));
      }
    }
    for (const a of appointments) {
      const m = minutesInDay(a.slot_time, tz);
      lo = Math.min(lo, m);
      hi = Math.max(hi, m + (a.doctor?.slot_minutes ?? 15));
    }
    if (!Number.isFinite(lo)) return { start: 9 * 60, end: 17 * 60 };
    return { start: Math.floor(lo / 60) * 60, end: Math.min(24 * 60, Math.ceil(hi / 60) * 60) };
  })();

  const px = (min: number) => ((min - range.start) / 60) * HOUR;
  const height = px(range.end);
  const hours: number[] = [];
  for (let m = range.start; m <= range.end; m += 60) hours.push(m);

  const counts = {
    confirmed: appointments.filter((a) => a.status === "confirmed").length,
    completed: appointments.filter((a) => a.status === "completed").length,
    no_show: appointments.filter((a) => a.status === "no_show").length,
    cancelled: appointments.filter((a) => a.status === "cancelled").length,
  };

  const showNow = nowMin !== null && nowMin >= range.start && nowMin <= range.end;
  const selected = appointments.find((a) => a.id === selectedId) ?? null;
  const sorted = [...appointments].sort((a, b) => a.slot_time.localeCompare(b.slot_time));

  return (
    <section className="panel" aria-labelledby="sheet-title">
      <div className="panel-heading">
        <div>
          <h2 id="sheet-title">Day sheet</h2>
          <p>Every doctor working today, hour by hour. Select a visit to mark it, move it or cancel it.</p>
        </div>
        <button className="button-primary" type="button" onClick={() => setBooking(true)}>
          <Plus size={16} aria-hidden="true" />
          Book appointment
        </button>
      </div>

      <div className="sheet-summary" aria-label="Today's visits by status">
        {(["confirmed", "completed", "no_show", "cancelled"] as const).map((s) => (
          <span key={s}>
            <i className={`key ${s}`} aria-hidden="true" />
            {STATUS_LABEL[s]} <b>{counts[s]}</b>
          </span>
        ))}
      </div>

      {columns.length ? (
        <>
          <div className="sheet-scroll">
            <div className="sheet" style={{ "--cols": columns.length, "--height": `${height}px`, "--hour": `${HOUR}px` } as CSSProperties}>
              <div className="sheet-corner" />
              {columns.map((d) => (
                <div key={d.id} className="sheet-doctor">
                  <strong>Dr. {d.name}</strong>
                  <span>
                    {d.department}
                    {awayToday(d.id) ? (clinicClosed ? ", clinic closed today" : ", away today") : todays(d).length ? `, ${dayHours(todays(d))}` : ", not on today's rota"}
                  </span>
                </div>
              ))}

              <div className="sheet-hours" aria-hidden="true">
                {hours.slice(0, -1).map((m) => (
                  <span key={m} style={{ top: px(m) }}>
                    {hourLabel(m)}
                  </span>
                ))}
              </div>

              {columns.map((d, ci) => {
                // Shade everything outside today's sittings (or the whole column when away).
                const gaps: [number, number][] = [];
                let cursor = range.start;
                for (const x of todays(d)) {
                  const a = timeToMinutes(x.start);
                  if (a > cursor) gaps.push([cursor, a]);
                  cursor = Math.max(cursor, timeToMinutes(x.end));
                }
                if (cursor < range.end) gaps.push([cursor, range.end]);
                const visits = appointments
                  .filter((a) => a.doctor?.id === d.id)
                  .sort((a, b) => Number(a.status !== "cancelled") - Number(b.status !== "cancelled"));
                return (
                  <div key={d.id} className="sheet-col" role="group" aria-label={`Dr. ${d.name}`}>
                    {gaps.map(([a, b]) => (
                      <div key={a} className="sheet-off" style={{ top: px(a), height: px(b) - px(a) }} />
                    ))}
                    {showNow ? (
                      <div className={`now-line${ci === 0 ? " lead" : ""}`} style={{ top: px(nowMin ?? 0) }} aria-hidden="true">
                        {ci === columns.length - 1 ? <span className="now-label">Now</span> : null}
                      </div>
                    ) : null}
                    {visits.map((a) => {
                      const m = minutesInDay(a.slot_time, tz);
                      const len = a.doctor?.slot_minutes ?? d.slot_minutes;
                      const overlapsLive = a.status === "cancelled" && visits.some((v) => v.status !== "cancelled" && minutesInDay(v.slot_time, tz) === m);
                      const tall = (len / 60) * HOUR - 3 >= 40;
                      return (
                        <button
                          key={a.id}
                          type="button"
                          className={`visit ${a.status}`}
                          style={{ top: px(m) + 1, height: Math.max((len / 60) * HOUR - 3, 22), ...(overlapsLive ? { left: "55%", zIndex: 0 } : {}) }}
                          onClick={() => setSelectedId(a.id)}
                          aria-label={`${formatTime(a.slot_time, tz)}, ${a.patient?.name || displayPhone(a.patient?.phone)}, ${STATUS_LABEL[a.status]}`}
                        >
                          <strong>
                            {formatTime(a.slot_time, tz)} {a.patient?.name || displayPhone(a.patient?.phone)}
                          </strong>
                          {tall ? <span>{a.notes || STATUS_LABEL[a.status]}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                );
              })}

            </div>
          </div>

          <div className="sheet-list">
            {sorted.length ? (
              sorted.map((a) => (
                <button key={a.id} type="button" className="sheet-list-row" onClick={() => setSelectedId(a.id)}>
                  <span>{formatTime(a.slot_time, tz)}</span>
                  <span>
                    <span className="cell-main">{a.patient?.name || displayPhone(a.patient?.phone)}</span>
                    <span className="cell-sub">Dr. {a.doctor?.name}</span>
                  </span>
                  <StatusPill status={a.status} />
                </button>
              ))
            ) : (
              <div className="empty-state">
                <strong>No appointments today yet</strong>
                <span>Bookings made on WhatsApp appear here within a minute.</span>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="empty-state">
          <strong>No doctor is on the rota for {formatDayKey(todayKey)}</strong>
          <span>Patients can still book other days on WhatsApp. Working days are set under Doctors.</span>
        </div>
      )}

      {selected ? <AppointmentDrawer key={selected.id} appointment={selected} tz={tz} todayKey={todayKey} onClose={() => setSelectedId(null)} /> : null}
      {booking ? <BookDialog doctors={doctors} todayKey={todayKey} onClose={() => setBooking(false)} /> : null}
    </section>
  );
}
