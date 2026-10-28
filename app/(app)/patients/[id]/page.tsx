import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChannelSelect } from "@/app/(app)/patients/[id]/channel-select";
import { PatientActions } from "@/app/(app)/patients/[id]/patient-actions";
import { getStaff } from "@/lib/auth";
import { getClinic, getPatient, listDoctors, scopeFor } from "@/lib/data";
import { displayPhone, safeLink } from "@/lib/phone";
import { dateKey, formatAgo, formatDateTime, nowMs } from "@/lib/time";

export const metadata: Metadata = { title: "Patient" };

const LABEL = { confirmed: "Booked", completed: "Seen", no_show: "Missed", cancelled: "Cancelled" } as const;

export default async function PatientPage({ params }: PageProps<"/patients/[id]">) {
  const staff = await getStaff();
  if (!staff) return null; // the layout shows sign-in, paused or no-access
  const s = await scopeFor(staff);
  const { id } = await params;
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) notFound();
  const [clinic, data, doctors] = await Promise.all([getClinic(s), getPatient(s, pid), listDoctors(s, { activeOnly: true })]);
  if (!data) notFound();
  const tz = clinic.timezone;
  const { patient, appointments, reports, feedback, handoffs } = data;
  const now = nowMs();
  const upcoming = appointments.filter((a) => a.status === "confirmed" && Date.parse(a.slot_time) >= now).reverse();
  const past = appointments.filter((a) => !(a.status === "confirmed" && Date.parse(a.slot_time) >= now));

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <p className="small" style={{ marginTop: 0, marginBottom: 6 }}>
            <Link className="text-link" href="/patients">All patients</Link>
          </p>
          <h1>{patient.name || displayPhone(patient.phone)}</h1>
          <p>
            {displayPhone(patient.phone)}. {patient.last_message_at ? `Last messaged ${formatAgo(patient.last_message_at, tz)}.` : "Has not messaged the clinic yet."}
          </p>
          {clinic.smsEnabled ? <ChannelSelect patientId={patient.id} channel={patient.channel === "sms" ? "sms" : "whatsapp"} optedOut={patient.sms_opt_out === true} /> : null}
        </div>
        <div className="page-actions">
          <PatientActions patient={patient} doctors={doctors} todayKey={dateKey(new Date(), tz)} />
        </div>
      </div>

      <div className="two-col">
        <section className="panel">
          <div className="panel-heading">
            <h2>Upcoming</h2>
            <span className="count-tag">{upcoming.length}</span>
          </div>
          {upcoming.length ? (
            <div className="timeline">
              {upcoming.map((a) => (
                <div key={a.id} className="timeline-row">
                  <span>{formatDateTime(a.slot_time, tz)}</span>
                  <span>Dr. {a.doctor?.name}, {a.doctor?.department}</span>
                  <span className="pill confirmed">Booked</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state"><span>No upcoming visits.</span></div>
          )}
        </section>

        <section className="panel">
          <div className="panel-heading">
            <h2>Handoffs</h2>
            <span className="count-tag">{handoffs.filter((h) => !h.resolved).length} open</span>
          </div>
          {handoffs.length ? (
            <div className="timeline">
              {handoffs.map((h) => (
                <div key={h.id} className="timeline-row">
                  <span className="soft">{formatDateTime(h.created_at, tz)}</span>
                  <span>{h.reason}{h.staff_note ? <span className="cell-sub">{h.staff_note}</span> : null}</span>
                  <span className={`pill ${h.resolved ? "neutral" : h.urgency === "urgent" ? "urgent" : "warn"}`}>{h.resolved ? "Closed" : h.urgency === "urgent" ? "Urgent" : "Open"}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state"><span>Never asked for a person.</span></div>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <h2>Visit history</h2>
          <span className="count-tag">{past.length}</span>
        </div>
        {past.length ? (
          <div className="timeline">
            {past.map((a) => {
              const rating = feedback.find((f) => f.appointment?.id === a.id)?.rating;
              return (
                <div key={a.id} className="timeline-row">
                  <span className="soft">{formatDateTime(a.slot_time, tz)}</span>
                  <span>
                    Dr. {a.doctor?.name}, {a.doctor?.department}
                    {rating ? <span className="cell-sub">Rated {rating} out of 5</span> : null}
                    {a.notes ? <span className="cell-sub">Note: {a.notes}</span> : null}
                  </span>
                  <span className={`pill ${a.status}`}>{LABEL[a.status]}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty-state"><span>No past visits.</span></div>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Reports</h2>
            <p>The note is written for staff by the assistant from the lab&rsquo;s text. Patients only hear that a report is ready.</p>
          </div>
        </div>
        {reports.length ? (
          <div className="timeline">
            {reports.map((r) => (
              <div key={r.id} className="timeline-row">
                <span className="soft">{formatDateTime(r.created_at, tz)}</span>
                <span>
                  <span className="cell-main">{r.report_type}</span>
                  {r.summary ? <span className="cell-sub">{r.summary}</span> : null}
                </span>
                <span className="action-row">
                  {r.is_critical ? <span className="pill critical">Critical</span> : null}
                  {safeLink(r.report_link) ? <a className="text-link" href={safeLink(r.report_link)!} target="_blank" rel="noreferrer">Open report</a> : null}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state"><span>No reports received.</span></div>
        )}
      </section>
    </div>
  );
}
