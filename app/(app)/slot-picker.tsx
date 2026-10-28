"use client";

import { useEffect, useState } from "react";
import { getFreeTimes } from "@/app/actions";
import { formatClock } from "@/lib/time";
import { Spinner } from "@/app/(app)/ui";

type Loaded = { key: string; times: string[]; message: string };

export function SlotPicker({
  doctorId,
  date,
  minDate,
  value,
  onDate,
  onChange,
}: {
  doctorId: number | null;
  date: string;
  minDate: string;
  value: string;
  onDate: (date: string) => void;
  onChange: (time: string) => void;
}) {
  const key = doctorId && date ? `${doctorId}|${date}` : "";
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!key || !doctorId) return;
    let live = true;
    getFreeTimes(doctorId, date).then((r) => {
      if (!live) return;
      if (r.ok) {
        const times = r.data?.times ?? [];
        setLoaded({ key, times, message: times.length ? "" : r.data?.note || "No free times on this day." });
      } else {
        setLoaded({ key, times: [], message: r.error });
      }
    });
    return () => {
      live = false;
    };
  }, [key, doctorId, date]);

  const current = loaded?.key === key ? loaded : null;
  const loading = Boolean(key) && !current;
  const message = !doctorId ? "Choose a doctor first." : !date ? "Choose a date." : current?.message ?? "";
  const times = current?.times ?? [];

  useEffect(() => {
    if (current && value && !current.times.includes(value)) onChange("");
  }, [current, value, onChange]);

  return (
    <div className="form-stack">
      <label className="field">
        <span>Date</span>
        <input className="input" type="date" min={minDate} value={date} onChange={(e) => onDate(e.target.value)} required />
      </label>
      <div className="field" role="group" aria-labelledby="slot-label">
        <span id="slot-label" className="field-label">
          Time {loading ? <Spinner /> : null}
        </span>
        {message ? <span className="field-hint">{message}</span> : null}
        {times.length ? (
          <div className="slot-grid">
            {times.map((t) => (
              <button key={t} type="button" className="slot" aria-pressed={value === t} onClick={() => onChange(t)}>
                {formatClock(t)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
