"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { reopenHandoff, resolveHandoff } from "@/app/actions";
import { EmptyState, Flash, Modal, Spinner } from "@/app/(app)/ui";
import { displayPhone, whatsappLink } from "@/lib/phone";
import { formatAgo, formatDateTime } from "@/lib/time";
import type { Handoff } from "@/types/db";

export function HandoffList({ rows, tz, closed }: { rows: Handoff[]; tz: string; closed: boolean }) {
  const router = useRouter();
  const [closing, setClosing] = useState<Handoff | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function close() {
    if (!closing) return;
    setBusy(true);
    const r = await resolveHandoff(closing.id, note);
    setBusy(false);
    if (r.ok) {
      setClosing(null);
      setNote("");
      setResult({ ok: true, text: r.message ?? "Closed." });
      router.refresh();
    } else {
      setResult({ ok: false, text: r.error });
    }
  }

  async function reopen(h: Handoff) {
    const r = await reopenHandoff(h.id);
    setResult(r.ok ? { ok: true, text: r.message ?? "Reopened." } : { ok: false, text: r.error });
    if (r.ok) router.refresh();
  }

  return (
    <>
      {result && !closing ? <div style={{ padding: "0 24px 14px" }}><Flash result={result} /></div> : null}
      {rows.length ? (
        <div className="attention-list">
          {rows.map((h) => {
            const who = h.patient?.name || displayPhone(h.patient_phone);
            return (
              <div key={h.id} className={`attention-item ${closed ? "" : h.urgency === "urgent" ? "bad" : "warn"}`}>
                <span>
                  <strong>
                    {h.urgency === "urgent" && !closed ? <span className="pill urgent" style={{ marginRight: 8 }}>Urgent</span> : null}
                    {h.patient_id ? <Link href={`/patients/${h.patient_id}`}>{who}</Link> : who}
                    {h.patient?.name ? <span className="faint small"> {displayPhone(h.patient_phone)}</span> : null}
                  </strong>
                  <p>{h.reason}</p>
                  {closed ? (
                    <p>
                      Closed by {h.resolved_by ?? "staff"} {h.resolved_at ? formatAgo(h.resolved_at, tz) : ""}
                      {h.staff_note ? `: ${h.staff_note}` : "."}
                    </p>
                  ) : null}
                  <span className="action-row" style={{ marginTop: 10 }}>
                    {h.patient_phone ? (
                      <a className="button-quiet" href={whatsappLink(h.patient_phone)} target="_blank" rel="noreferrer">
                        Open in WhatsApp
                      </a>
                    ) : null}
                    {closed ? (
                      <button className="button-quiet" type="button" onClick={() => reopen(h)}>
                        Reopen
                      </button>
                    ) : (
                      <button className="button-secondary" type="button" onClick={() => { setClosing(h); setResult(null); }}>
                        Close handoff
                      </button>
                    )}
                  </span>
                </span>
                <time title={formatDateTime(h.created_at, tz)}>{formatAgo(h.created_at, tz)}</time>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState title={closed ? "No closed handoffs yet" : "No one is waiting"}>
          {closed ? "Closed handoffs and what was done about them appear here." : "When the assistant cannot help a patient, they appear here and the front desk is emailed."}
        </EmptyState>
      )}

      {closing ? (
        <Modal title="Close handoff" description={`${closing.patient?.name || displayPhone(closing.patient_phone)}: ${closing.reason}`} onClose={() => setClosing(null)}>
          <div className="field">
            <label className="field-label" htmlFor="handoff-note">What did you do?</label>
            <textarea id="handoff-note" aria-describedby="handoff-note-hint" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="For example: called back, booked with Dr. Khan for Thursday" />
            <span id="handoff-note-hint" className="field-hint">Saved with your name so the team can see how it was handled.</span>
          </div>
          {result && !result.ok ? <Flash result={result} /> : null}
          <div className="dialog-actions">
            <button className="button-secondary" type="button" onClick={() => setClosing(null)}>
              Cancel
            </button>
            <button className="button-primary" type="button" disabled={busy} onClick={close}>
              {busy ? <Spinner /> : null}
              Close handoff
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
