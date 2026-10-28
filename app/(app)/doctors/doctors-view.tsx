"use client";

import { useRouter } from "next/navigation";
import { CalendarOff, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { addTimeOff, deleteTimeOff, saveDoctor } from "@/app/actions";
import { EmptyState, Flash, Modal, PageHeading, Spinner } from "@/app/(app)/ui";
import { DAY_LONG, DAY_SHORT, scheduleSummary, sessionsFor } from "@/lib/schedule";
import { formatDayKey } from "@/lib/time";
import type { Doctor, Session, TimeOff } from "@/types/db";

type Result = { ok: boolean; text: string } | null;

function dateRange(o: TimeOff) {
  return o.startsOn === o.endsOn ? formatDayKey(o.startsOn, "short") : `${formatDayKey(o.startsOn, "short")} to ${formatDayKey(o.endsOn, "short")}`;
}

export function DoctorsView({ doctors, timeOff, canEdit, todayKey }: { doctors: Doctor[]; timeOff: TimeOff[]; canEdit: boolean; todayKey: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState<Doctor | "new" | null>(null);
  const [addingOff, setAddingOff] = useState(false);
  const [message, setMessage] = useState<Result>(null);
  const [removing, setRemoving] = useState<number | null>(null);

  async function remove(id: number) {
    setRemoving(id);
    const r = await deleteTimeOff(id);
    setRemoving(null);
    setMessage(r.ok ? { ok: true, text: r.message ?? "Removed." } : { ok: false, text: r.error });
    if (r.ok) router.refresh();
  }

  return (
    <div className="page-stack">
      <PageHeading
        title="Doctors"
        description="The schedule patients book from. Changes apply to new bookings straight away."
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
                  <th>Days and hours</th>
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
                    <td>
                      {d.sessions.length ? (
                        scheduleSummary(d.sessions).map((g) => (
                          <span key={g.days} className="schedule-line">
                            <b>{g.days}</b> {g.hours}
                          </span>
                        ))
                      ) : (
                        <span className="faint">No hours set</span>
                      )}
                    </td>
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
          <EmptyState title="No doctors yet">{canEdit ? "Add the clinic's doctors so patients can book them." : "Ask a clinic admin to add the doctors."}</EmptyState>
        )}
      </section>

      <section className="panel" id="time-off" aria-labelledby="time-off-title">
        <div className="panel-heading">
          <div>
            <h2 id="time-off-title">Days off and closures</h2>
            <p>Leave, conferences and public holidays. Nobody can book a doctor on these days; visits already booked stay until you move or cancel them.</p>
          </div>
          {canEdit ? (
            <button className="button-secondary" type="button" onClick={() => setAddingOff(true)} disabled={!doctors.length}>
              <CalendarOff size={16} aria-hidden="true" />
              Add days off
            </button>
          ) : null}
        </div>
        {timeOff.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Dates</th>
                  <th>Reason (staff only)</th>
                  {canEdit ? <th className="cell-actions"><span className="sr-only">Remove</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {timeOff.map((o) => (
                  <tr key={o.id}>
                    <td className="cell-main">{o.doctorId === null ? "Whole clinic closed" : `Dr. ${o.doctorName ?? ""}`}</td>
                    <td className="nowrap">{dateRange(o)}</td>
                    <td className="soft">{o.reason ?? ""}</td>
                    {canEdit ? (
                      <td className="cell-actions">
                        <button className="button-quiet" type="button" onClick={() => remove(o.id)} disabled={removing === o.id} aria-label={`Remove ${o.doctorId === null ? "clinic closure" : `days off for Dr. ${o.doctorName}`} on ${dateRange(o)}`}>
                          <Trash2 size={15} aria-hidden="true" />
                          Remove
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No days off planned">Add leave or a public holiday before patients try to book it.</EmptyState>
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
      {addingOff ? (
        <TimeOffDialog
          doctors={doctors}
          todayKey={todayKey}
          onClose={() => setAddingOff(false)}
          onSaved={(text) => {
            setAddingOff(false);
            setMessage({ ok: true, text });
          }}
        />
      ) : null}
    </div>
  );
}

const DEFAULT_SESSIONS: Session[] = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "09:00", end: "17:00" }));

function DoctorDialog({ doctor, onClose, onSaved }: { doctor: Doctor | null; onClose: () => void; onSaved: (text: string) => void }) {
  const router = useRouter();
  const [name, setName] = useState(doctor?.name ?? "");
  const [department, setDepartment] = useState(doctor?.department ?? "");
  const [fee, setFee] = useState(doctor?.consultation_fee?.toString() ?? "");
  const [sessions, setSessions] = useState<Session[]>(doctor?.sessions.length ? doctor.sessions : DEFAULT_SESSIONS);
  const [slot, setSlot] = useState(doctor?.slot_minutes ?? 15);
  const [notes, setNotes] = useState(doctor?.notes ?? "");
  const [active, setActive] = useState(doctor?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Result>(null);

  const setDay = (weekday: number, list: Session[]) => setSessions([...sessions.filter((s) => s.weekday !== weekday), ...list]);
  const toggleDay = (weekday: number, on: boolean) => {
    if (!on) return setDay(weekday, []);
    const model = sessions.length ? sessionsFor(sessions, sessions[0].weekday) : [{ weekday, start: "09:00", end: "17:00" }];
    setDay(weekday, model.map((s) => ({ ...s, weekday })));
  };
  const copyToAll = () => {
    const days = [...new Set(sessions.map((s) => s.weekday))].sort((a, b) => a - b);
    if (!days.length) return;
    const model = sessionsFor(sessions, days[0]);
    setSessions(days.flatMap((d) => model.map((s) => ({ ...s, weekday: d }))));
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const r = await saveDoctor({ id: doctor?.id, name, department, fee, sessions, slotMinutes: slot, notes, active });
    setBusy(false);
    if (r.ok) {
      router.refresh();
      onSaved(r.message ?? "Saved.");
    } else {
      setError({ ok: false, text: r.error });
    }
  }

  return (
    <Modal title={doctor ? `Edit Dr. ${doctor.name}` : "Add a doctor"} description="Patients can only book inside these hours. Add a second sitting for doctors who also see patients in the evening." onClose={onClose}>
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

        <div className="field" role="group" aria-labelledby="hours-label">
          <div className="week-head">
            <span id="hours-label" className="field-label">Days and hours</span>
            <button type="button" className="button-quiet small" onClick={copyToAll}>Same hours every working day</button>
          </div>
          <div className="week">
            {DAY_LONG.map((label, i) => {
              const weekday = i + 1;
              const list = sessionsFor(sessions, weekday);
              const works = list.length > 0;
              return (
                <div key={label} className={`week-row${works ? "" : " off"}`}>
                  <label className="week-day">
                    <input type="checkbox" checked={works} onChange={(e) => toggleDay(weekday, e.target.checked)} />
                    <span>{DAY_SHORT[i]}</span>
                  </label>
                  <div className="week-sessions">
                    {works ? (
                      list.map((s, si) => (
                        <span key={si} className="week-session">
                          <input
                            className="input"
                            type="time"
                            aria-label={`${label} sitting ${si + 1} starts`}
                            value={s.start}
                            onChange={(e) => setDay(weekday, list.map((x, xi) => (xi === si ? { ...x, start: e.target.value } : x)))}
                            required
                          />
                          <span className="faint">to</span>
                          <input
                            className="input"
                            type="time"
                            aria-label={`${label} sitting ${si + 1} finishes`}
                            value={s.end}
                            onChange={(e) => setDay(weekday, list.map((x, xi) => (xi === si ? { ...x, end: e.target.value } : x)))}
                            required
                          />
                          {list.length > 1 ? (
                            <button type="button" className="icon-button" aria-label={`Remove ${label} sitting ${si + 1}`} onClick={() => setDay(weekday, list.filter((_, xi) => xi !== si))}>
                              <X size={15} aria-hidden="true" />
                            </button>
                          ) : null}
                        </span>
                      ))
                    ) : (
                      <span className="faint small">Not working</span>
                    )}
                    {works && list.length < 3 ? (
                      <button
                        type="button"
                        className="button-quiet small"
                        aria-label={`Add a sitting on ${label}`}
                        onClick={() => setDay(weekday, [...list, { weekday, start: "17:00", end: "21:00" }])}
                      >
                        <Plus size={14} aria-hidden="true" />
                        Sitting
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="field-row three">
          <label className="field">
            <span>Visit length (min)</span>
            <input className="input" type="number" min={5} max={240} step={5} value={slot} onChange={(e) => setSlot(Number(e.target.value))} required />
          </label>
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

function TimeOffDialog({ doctors, todayKey, onClose, onSaved }: { doctors: Doctor[]; todayKey: string; onClose: () => void; onSaved: (text: string) => void }) {
  const router = useRouter();
  const [who, setWho] = useState(String(doctors[0]?.id ?? "clinic"));
  const [from, setFrom] = useState(todayKey);
  const [to, setTo] = useState(todayKey);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Result>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const r = await addTimeOff({ doctorId: who, from, to, reason });
    setBusy(false);
    if (r.ok) {
      router.refresh();
      onSaved(r.message ?? "Saved.");
    } else setError({ ok: false, text: r.error });
  }

  return (
    <Modal title="Add days off" description="Leave for one doctor, or a day the whole clinic is closed." onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label className="field">
          <span>Who</span>
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>Dr. {d.name}</option>
            ))}
            <option value="clinic">Whole clinic (holiday)</option>
          </select>
        </label>
        <div className="field-row">
          <label className="field">
            <span>First day</span>
            <input className="input" type="date" value={from} min={todayKey} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} required />
          </label>
          <label className="field">
            <span>Last day</span>
            <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required />
          </label>
        </div>
        <label className="field">
          <span>Reason (staff only)</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Annual leave, Eid holiday" />
        </label>
        <Flash result={error} />
        <div className="dialog-actions">
          <button className="button-secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="button-primary" type="submit" disabled={busy}>
            {busy ? <Spinner /> : null}
            Save days off
          </button>
        </div>
      </form>
    </Modal>
  );
}
