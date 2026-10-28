"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import { bookAppointment } from "@/app/actions";
import { SlotPicker } from "@/app/(app)/slot-picker";
import { Flash, Modal, Spinner } from "@/app/(app)/ui";
import type { Doctor } from "@/types/db";

export function BookDialog({
  doctors,
  todayKey,
  initial,
  onClose,
}: {
  doctors: Doctor[];
  todayKey: string;
  initial?: { phone?: string; name?: string; doctorId?: number; date?: string };
  onClose: () => void;
}) {
  const router = useRouter();
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [doctorId, setDoctorId] = useState<number | null>(initial?.doctorId ?? doctors[0]?.id ?? null);
  const [date, setDate] = useState(initial?.date ?? todayKey);
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const clearTime = useCallback((t: string) => setTime(t), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!doctorId || !time) {
      setResult({ ok: false, text: "Choose a doctor, a date and a free time." });
      return;
    }
    setBusy(true);
    setResult(null);
    const r = await bookAppointment({ phone, name, doctorId, date, time, notes });
    setBusy(false);
    if (r.ok) {
      setResult({ ok: true, text: r.message ?? "Booked." });
      setTime("");
      router.refresh();
    } else {
      setResult({ ok: false, text: r.error });
    }
  }

  if (!doctors.length) {
    return (
      <Modal title="Book an appointment" onClose={onClose}>
        <p className="soft">There are no doctors on the schedule yet. An admin can add them under Doctors.</p>
      </Modal>
    );
  }

  return (
    <Modal title="Book an appointment" description="For patients who call or walk in. The same free times are offered on WhatsApp." onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <div className="field-row">
          <label className="field">
            <span>WhatsApp number</span>
            <input className="input" inputMode="tel" autoComplete="off" placeholder="92 300 1234567" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          </label>
          <label className="field">
            <span>Patient name</span>
            <input className="input" autoComplete="off" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </label>
        </div>
        <label className="field">
          <span>Doctor</span>
          <select value={doctorId ?? ""} onChange={(e) => setDoctorId(Number(e.target.value) || null)} required>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                Dr. {d.name}, {d.department}
              </option>
            ))}
          </select>
        </label>
        <SlotPicker doctorId={doctorId} date={date} minDate={todayKey} value={time} onDate={setDate} onChange={clearTime} />
        <label className="field">
          <span>Note for the front desk (optional)</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="For example: bring previous reports" />
        </label>
        <Flash result={result} />
        <div className="dialog-actions">
          <button className="button-secondary" type="button" onClick={onClose}>
            {result?.ok ? "Done" : "Cancel"}
          </button>
          <button className="button-primary" type="submit" disabled={busy || !time}>
            {busy ? <Spinner /> : null}
            Book appointment
          </button>
        </div>
      </form>
    </Modal>
  );
}
