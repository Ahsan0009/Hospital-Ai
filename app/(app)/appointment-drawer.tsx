"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { cancelAppointment, rescheduleAppointment, saveAppointmentNote, setAppointmentStatus } from "@/app/actions";
import { SlotPicker } from "@/app/(app)/slot-picker";
import { Flash, Modal, Spinner, StatusPill, sourceLabel } from "@/app/(app)/ui";
import { displayPhone, whatsappLink } from "@/lib/phone";
import { dateKey, formatDateTime } from "@/lib/time";
import type { ActionResult, Appointment, AppointmentStatus } from "@/types/db";

type Mode = "view" | "move" | "cancel";

export function AppointmentDrawer({
  appointment,
  tz,
  todayKey,
  onClose,
}: {
  appointment: Appointment;
  tz: string;
  todayKey: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [date, setDate] = useState(dateKey(appointment.slot_time, tz));
  const [time, setTime] = useState("");
  const [note, setNote] = useState(appointment.notes ?? "");
  const pickTime = useCallback((t: string) => setTime(t), []);

  const a = appointment;
  const [openedAt] = useState(() => Date.now());
  const start = Date.parse(a.slot_time);
  const canMark = start <= openedAt + 60 * 60 * 1000;
  const upcoming = a.status === "confirmed" && start > openedAt;

  async function act(label: string, fn: () => Promise<ActionResult>, after?: () => void) {
    setBusy(label);
    setResult(null);
    const r = await fn();
    setBusy(null);
    setResult(r.ok ? { ok: true, text: r.message ?? "Saved." } : { ok: false, text: r.error });
    if (r.ok) {
      after?.();
      router.refresh();
    }
  }

  const status = (s: AppointmentStatus, label: string, className = "button-secondary") => (
    <button className={className} type="button" disabled={!!busy} onClick={() => act(label, () => setAppointmentStatus(a.id, s))}>
      {busy === label ? <Spinner /> : null}
      {label}
    </button>
  );

  const patientName = a.patient?.name || displayPhone(a.patient?.phone) || "Patient";

  return (
    <Modal drawer title={patientName} description={a.patient?.name ? displayPhone(a.patient.phone) : undefined} onClose={onClose}>
      <dl className="detail-list">
        <dt>Status</dt>
        <dd>
          <StatusPill status={a.status} />
          {a.rescheduled ? <span className="faint small"> moved once</span> : null}
        </dd>
        <dt>When</dt>
        <dd>{formatDateTime(a.slot_time, tz)}</dd>
        <dt>Doctor</dt>
        <dd>{a.doctor ? `Dr. ${a.doctor.name}, ${a.doctor.department}` : "Unknown"}</dd>
        <dt>Booked through</dt>
        <dd>
          {sourceLabel(a.source)} on {formatDateTime(a.created_at, tz)}
        </dd>
        <dt>Reminders</dt>
        <dd>
          {a.reminder_24h_sent ? "Day-before sent" : "Day-before not sent"}
          {", "}
          {a.reminder_2h_sent ? "2-hour sent" : "2-hour not sent"}
        </dd>
        {a.feedback_sent ? (
          <>
            <dt>Feedback</dt>
            <dd>Rating request sent</dd>
          </>
        ) : null}
      </dl>

      <Flash result={result} />

      {mode === "view" ? (
        <>
          {a.status === "confirmed" ? (
            <div className="action-row">
              {canMark ? status("completed", "Mark as seen", "button-primary") : null}
              {canMark ? status("no_show", "Mark as missed") : null}
              {upcoming ? (
                <button className={canMark ? "button-secondary" : "button-primary"} type="button" onClick={() => { setMode("move"); setResult(null); }}>
                  Move
                </button>
              ) : null}
              {upcoming ? (
                <button className="button-danger" type="button" onClick={() => { setMode("cancel"); setResult(null); }}>
                  Cancel appointment
                </button>
              ) : null}
            </div>
          ) : null}
          {a.status === "completed" ? <div className="action-row">{status("no_show", "Change to missed")}{status("confirmed", "Undo")}</div> : null}
          {a.status === "no_show" ? <div className="action-row">{status("completed", "Change to seen")}{status("confirmed", "Undo")}</div> : null}

          <label className="field">
            <span>Front-desk note</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Only staff see this" />
          </label>
          <div className="action-row">
            <button className="button-secondary" type="button" disabled={!!busy || note === (a.notes ?? "")} onClick={() => act("note", () => saveAppointmentNote(a.id, note))}>
              {busy === "note" ? <Spinner /> : null}
              Save note
            </button>
            {a.patient ? (
              <Link className="button-quiet" href={`/patients/${a.patient.id}`}>
                Patient history
              </Link>
            ) : null}
            {a.patient ? (
              <a className="button-quiet" href={whatsappLink(a.patient.phone)} target="_blank" rel="noreferrer">
                Open in WhatsApp
              </a>
            ) : null}
          </div>
        </>
      ) : null}

      {mode === "move" ? (
        <div className="form-stack">
          <h3>Move to another time with Dr. {a.doctor?.name}</h3>
          <SlotPicker doctorId={a.doctor?.id ?? null} date={date} minDate={todayKey} value={time} onDate={setDate} onChange={pickTime} />
          <div className="dialog-actions">
            <button className="button-secondary" type="button" onClick={() => setMode("view")}>
              Back
            </button>
            <button
              className="button-primary"
              type="button"
              disabled={!time || !!busy}
              onClick={() => act("move", () => rescheduleAppointment(a.id, date, time), () => setMode("view"))}
            >
              {busy === "move" ? <Spinner /> : null}
              Move appointment
            </button>
          </div>
        </div>
      ) : null}

      {mode === "cancel" ? (
        <div className="form-stack">
          <p>
            Cancel {patientName}&rsquo;s visit on {formatDateTime(a.slot_time, tz)}? The time becomes free for other patients.
          </p>
          <div className="dialog-actions">
            <button className="button-secondary" type="button" onClick={() => setMode("view")}>
              Keep appointment
            </button>
            <button className="button-danger" type="button" disabled={!!busy} onClick={() => act("cancel", () => cancelAppointment(a.id), () => setMode("view"))}>
              {busy === "cancel" ? <Spinner /> : null}
              Cancel appointment
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
