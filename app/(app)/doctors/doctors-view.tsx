"use client";

import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { saveDoctor } from "@/app/actions";
import { EmptyState, Flash, Modal, PageHeading, Spinner } from "@/app/(app)/ui";
import { formatClock } from "@/lib/time";
import type { Doctor } from "@/types/db";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function days(list: number[]) {
  const sorted = [...list].sort();
  if (sorted.join() === "1,2,3,4,5") return "Monday to Friday";
  if (sorted.join() === "1,2,3,4,5,6") return "Monday to Saturday";
  if (sorted.length === 7) return "Every day";
  return sorted.map((d) => DAYS[d - 1]).join(", ");
}

export function DoctorsView({ doctors, canEdit }: { doctors: Doctor[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<Doctor | "new" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <div className="page-stack">
      <PageHeading
        title="Doctors"
        description="The schedule the WhatsApp assistant books from. Changes apply to new bookings straight away."
        action={
          canEdit ? (
            <button className="button-primary" type="button" onClick={() => setEditing("new")}>
              <Plus size={16} aria-hidden="true" />
              Add doctor
            </button>
          ) : null
        }
      />
      {message ? <Flash result={message} /> : null}
      <section className="panel">
        {!canEdit ? <div className="panel-footnote" style={{ borderTop: 0 }}>Only clinic admins can change doctors and their hours.</div> : null}
        {doctors.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Doctor</th>
                  <th>Working days</th>
                  <th>Hours</th>
                  <th>Visit length</th>
                  <th>Fee</th>
                  <th>Booking</th>
                  {canEdit ? <th className="cell-actions"><span className="sr-only">Edit</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {doctors.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <span className="cell-main">Dr. {d.name}</span>
                      <span className="cell-sub">{d.department}{d.notes ? `. ${d.notes}` : ""}</span>
                    </td>
                    <td>{days(d.working_days)}</td>
                    <td className="nowrap">{formatClock(d.start_time)} to {formatClock(d.end_time)}</td>
                    <td>{d.slot_minutes} min</td>
                    <td>{d.consultation_fee === null ? <span className="faint">Not set</span> : d.consultation_fee.toLocaleString()}</td>
                    <td>{d.active ? <span className="pill completed">Open</span> : <span className="pill neutral">Off the schedule</span>}</td>
                    {canEdit ? (
                      <td className="cell-actions">
                        <button className="button-quiet" type="button" onClick={() => setEditing(d)}>Edit</button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No doctors yet">{canEdit ? "Add the clinic's doctors so patients can book them on WhatsApp." : "Ask a clinic admin to add the doctors."}</EmptyState>
        )}
      </section>
      {editing ? (
        <DoctorDialog
          doctor={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            setMessage({ ok: true, text });
          }}
        />
      ) : null}
    </div>
  );
}

function DoctorDialog({ doctor, onClose, onSaved }: { doctor: Doctor | null; onClose: () => void; onSaved: (text: string) => void }) {
  const router = useRouter();
  const [name, setName] = useState(doctor?.name ?? "");
  const [department, setDepartment] = useState(doctor?.department ?? "");
  const [fee, setFee] = useState(doctor?.consultation_fee?.toString() ?? "");
  const [workingDays, setWorkingDays] = useState<number[]>(doctor?.working_days ?? [1, 2, 3, 4, 5]);
  const [start, setStart] = useState(doctor?.start_time ?? "09:00");
  const [end, setEnd] = useState(doctor?.end_time ?? "17:00");
  const [slot, setSlot] = useState(doctor?.slot_minutes ?? 15);
  const [notes, setNotes] = useState(doctor?.notes ?? "");
  const [active, setActive] = useState(doctor?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const r = await saveDoctor({ id: doctor?.id, name, department, fee, workingDays, start, end, slotMinutes: slot, notes, active });
    setBusy(false);
    if (r.ok) {
      router.refresh();
      onSaved(r.message ?? "Saved.");
    } else {
      setError({ ok: false, text: r.error });
    }
  }

  return (
    <Modal title={doctor ? `Edit Dr. ${doctor.name}` : "Add a doctor"} description="Patients can only book inside these hours, on these days." onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <div className="field-row">
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Without Dr." required maxLength={80} />
          </label>
          <label className="field">
            <span>Department</span>
            <input className="input" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Cardiology" required maxLength={60} />
          </label>
        </div>
        <div className="field" role="group" aria-labelledby="days-label">
          <span id="days-label" className="field-label">Working days</span>
          <div className="check-row">
            {DAYS.map((label, i) => (
              <label key={label} className="check-chip">
                <input
                  type="checkbox"
                  checked={workingDays.includes(i + 1)}
                  onChange={(e) => setWorkingDays(e.target.checked ? [...workingDays, i + 1] : workingDays.filter((d) => d !== i + 1))}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="field-row three">
          <label className="field">
            <span>Starts</span>
            <input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
          </label>
          <label className="field">
            <span>Finishes</span>
            <input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
          </label>
          <label className="field">
            <span>Visit length (min)</span>
            <input className="input" type="number" min={5} max={240} step={5} value={slot} onChange={(e) => setSlot(Number(e.target.value))} required />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Consultation fee</span>
            <input className="input" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="Leave empty to not mention it" />
          </label>
          <label className="field">
            <span>Note for patients</span>
            <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} placeholder="Walk-ins after 12:00" />
          </label>
        </div>
        <label className="toggle-line">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Patients can book this doctor
        </label>
        <Flash result={error} />
        <div className="dialog-actions">
          <button className="button-secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="button-primary" type="submit" disabled={busy}>
            {busy ? <Spinner /> : null}
            {doctor ? "Save changes" : "Add doctor"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
