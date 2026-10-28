"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { AppointmentDrawer } from "@/app/(app)/appointment-drawer";
import { BookDialog } from "@/app/(app)/book-dialog";
import { EmptyState, PageHeading, STATUS_LABEL, StatusPill, sourceLabel } from "@/app/(app)/ui";
import { displayPhone } from "@/lib/phone";
import { addDays, formatDay, formatDayKey, formatTime } from "@/lib/time";
import type { Appointment, Doctor } from "@/types/db";

type Filters = { date: string; range: "day" | "week"; status: string; doctorId: number | null; q: string; end: string };

const TABS = ["all", "confirmed", "completed", "no_show", "cancelled"] as const;

export function AppointmentsView({
  rows,
  counts,
  doctors,
  tz,
  today,
  filters,
}: {
  rows: Appointment[];
  counts: Record<string, number>;
  doctors: Doctor[];
  tz: string;
  today: string;
  filters: Filters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [booking, setBooking] = useState(false);
  const [q, setQ] = useState(filters.q);

  function go(changes: Record<string, string | null>) {
    const next = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    router.push(`${pathname}${next.size ? `?${next}` : ""}`);
  }

  useEffect(() => {
    if (q === filters.q) return;
    const id = window.setTimeout(() => go({ q }), 300);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const step = filters.range === "week" ? 7 : 1;
  const title = filters.range === "week" ? `${formatDayKey(filters.date, "short")} to ${formatDayKey(filters.end, "short")}` : formatDayKey(filters.date);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="page-stack">
      <PageHeading
        title="Appointments"
        description={title}
        action={
          <button className="button-primary" type="button" onClick={() => setBooking(true)}>
            <Plus size={16} aria-hidden="true" />
            Book appointment
          </button>
        }
      />

      <section className="panel">
        <div className="toolbar">
          <div className="toolbar-group">
            <div className="date-nav">
              <button className="icon-button" type="button" aria-label="Earlier" onClick={() => go({ date: addDays(filters.date, -step) })}>
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <input className="input" type="date" aria-label="Date" value={filters.date} onChange={(e) => e.target.value && go({ date: e.target.value })} />
              <button className="icon-button" type="button" aria-label="Later" onClick={() => go({ date: addDays(filters.date, step) })}>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
              {filters.date !== today ? (
                <button className="button-quiet" type="button" onClick={() => go({ date: null })}>
                  Today
                </button>
              ) : null}
            </div>
            <div className="tabs" role="group" aria-label="Range">
              {(["day", "week"] as const).map((r) => (
                <button key={r} type="button" className={`tab${filters.range === r ? " active" : ""}`} aria-pressed={filters.range === r} onClick={() => go({ range: r === "day" ? null : r })}>
                  {r === "day" ? "Day" : "Week"}
                </button>
              ))}
            </div>
          </div>
          <div className="toolbar-group">
            <select className="select" aria-label="Doctor" value={filters.doctorId ?? ""} onChange={(e) => go({ doctor: e.target.value || null })}>
              <option value="">All doctors</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  Dr. {d.name}
                </option>
              ))}
            </select>
            <label className="input-wrap">
              <Search size={16} aria-hidden="true" />
              <input type="search" placeholder="Patient name or number" aria-label="Search patients" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
          </div>
        </div>

        <div className="toolbar" style={{ paddingTop: 0 }}>
          <div className="tabs" role="group" aria-label="Status">
            {TABS.map((t) => (
              <button key={t} type="button" className={`tab${filters.status === t ? " active" : ""}`} aria-pressed={filters.status === t} onClick={() => go({ status: t === "all" ? null : t })}>
                {t === "all" ? "All" : STATUS_LABEL[t]} <span>{counts[t] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>

        {rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{filters.range === "week" ? "Day and time" : "Time"}</th>
                  <th>Patient</th>
                  <th>Doctor</th>
                  <th>Booked through</th>
                  <th>Status</th>
                  <th className="cell-actions">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="is-clickable" onClick={() => setSelectedId(a.id)}>
                    <td className="nowrap">
                      {filters.range === "week" ? <span className="cell-sub">{formatDay(a.slot_time, tz)}</span> : null}
                      <span className="cell-main">{formatTime(a.slot_time, tz)}</span>
                    </td>
                    <td>
                      <span className="cell-main">{a.patient?.name || "Name not given"}</span>
                      <span className="cell-sub">{displayPhone(a.patient?.phone)}</span>
                    </td>
                    <td>
                      <span className="cell-main">Dr. {a.doctor?.name}</span>
                      <span className="cell-sub">{a.doctor?.department}</span>
                    </td>
                    <td className="source-tag">{sourceLabel(a.source)}</td>
                    <td>
                      <StatusPill status={a.status} />
                    </td>
                    <td className="cell-actions">
                      <button className="button-quiet" type="button" onClick={(e) => { e.stopPropagation(); setSelectedId(a.id); }}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title={filters.q ? "No patient matches that search" : "No appointments here"}>
            {filters.q ? "Try part of the name, or the last digits of the number." : "Change the date or filters, or book an appointment for a patient who called."}
          </EmptyState>
        )}
      </section>

      {selected ? <AppointmentDrawer key={selected.id} appointment={selected} tz={tz} todayKey={today} onClose={() => setSelectedId(null)} /> : null}
      {booking ? <BookDialog doctors={doctors.filter((d) => d.active)} todayKey={today} initial={{ date: filters.date >= today ? filters.date : today, doctorId: filters.doctorId ?? undefined }} onClose={() => setBooking(false)} /> : null}
    </div>
  );
}
