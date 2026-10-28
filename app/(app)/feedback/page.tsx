import type { Metadata } from "next";
import Link from "next/link";
import { Stars } from "@/app/(app)/ui";
import { getStaff } from "@/lib/auth";
import { getClinic, listFeedback, scopeFor } from "@/lib/data";
import { displayPhone, whatsappLink } from "@/lib/phone";
import { daysAgoIso, formatDay, formatDateTime } from "@/lib/time";

export const metadata: Metadata = { title: "Feedback" };

const PERIODS = { "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days" } as const;

export default async function FeedbackPage({ searchParams }: PageProps<"/feedback">) {
  const staff = await getStaff();
  if (!staff) return null; // the layout shows sign-in, paused or no-access
  const s = await scopeFor(staff);
  const params = await searchParams;
  const period = (Object.keys(PERIODS) as (keyof typeof PERIODS)[]).includes(params.days as keyof typeof PERIODS) ? (params.days as keyof typeof PERIODS) : "30";
  const since = daysAgoIso(Number(period));
  const [clinic, rows] = await Promise.all([getClinic(s), listFeedback(s, since)]);
  const tz = clinic.timezone;

  const rated = rows.filter((r) => r.rating !== null) as (typeof rows[number] & { rating: number })[];
  const average = rated.length ? rated.reduce((s, r) => s + r.rating, 0) / rated.length : null;
  const dist = [5, 4, 3, 2, 1].map((n) => ({ n, count: rated.filter((r) => r.rating === n).length }));
  const max = Math.max(1, ...dist.map((d) => d.count));
  const replyRate = rows.length ? Math.round((rated.length / rows.length) * 100) : null;

  const byDoctor = new Map<string, number[]>();
  for (const r of rated) {
    const name = r.appointment?.doctor?.name ?? "Unknown";
    byDoctor.set(name, [...(byDoctor.get(name) ?? []), r.rating]);
  }
  const doctors = [...byDoctor.entries()].map(([name, list]) => ({ name, count: list.length, avg: list.reduce((a, b) => a + b, 0) / list.length })).sort((a, b) => a.avg - b.avg);

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <h1>Feedback</h1>
          <p>After each visit, patients are asked on WhatsApp to rate it from 1 to 5. Ratings of 4 or 5 get a Google review link; 3 or lower get an apology and alert the front desk.</p>
        </div>
        <div className="tabs" role="group" aria-label="Period">
          {(Object.keys(PERIODS) as (keyof typeof PERIODS)[]).map((p) => (
            <Link key={p} className={`tab${p === period ? " active" : ""}`} aria-current={p === period ? "page" : undefined} href={p === "30" ? "/feedback" : `/feedback?days=${p}`}>
              {PERIODS[p]}
            </Link>
          ))}
        </div>
      </div>

      <div className="split">
        <section className="panel">
          <div className="panel-heading">
            <h2>Ratings</h2>
          </div>
          <div className="rating-hero">
            <span className="rating-number">
              {average === null ? "No ratings" : average.toFixed(1)} {average === null ? null : <small>out of 5 from {rated.length} rating{rated.length === 1 ? "" : "s"}</small>}
            </span>
            {replyRate !== null ? <span className="soft small">{replyRate}% of patients asked replied</span> : null}
          </div>
          <div className="bars">
            {dist.map((d) => (
              <div key={d.n} className="bar-row">
                <span>{d.n} star{d.n === 1 ? "" : "s"}</span>
                <span className="bar-track"><span className={`bar-fill${d.n <= 3 ? " low" : ""}`} style={{ display: "block", width: `${(d.count / max) * 100}%` }} /></span>
                <span>{d.count}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>By doctor</h2>
              <p>Lowest average first.</p>
            </div>
          </div>
          {doctors.length ? (
            <div className="timeline">
              {doctors.map((d) => (
                <div key={d.name} className="timeline-row" style={{ gridTemplateColumns: "minmax(0,1fr) auto auto" }}>
                  <span>Dr. {d.name}</span>
                  <span className="faint">{d.count}</span>
                  <span className={d.avg <= 3 ? "pill critical" : "pill neutral"}>{d.avg.toFixed(1)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state"><span>No ratings in this period.</span></div>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <h2>Latest replies</h2>
          <span className="count-tag">{rows.length} asked</span>
        </div>
        {rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Visit</th>
                  <th>Patient</th>
                  <th>Doctor</th>
                  <th>Rating</th>
                  <th className="cell-actions"><span className="sr-only">Contact</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 100).map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap soft">{r.appointment ? formatDay(r.appointment.slot_time, tz) : formatDateTime(r.requested_at, tz)}</td>
                    <td>
                      {r.appointment?.patient ? <Link className="cell-main" href={`/patients/${r.appointment.patient.id}`}>{r.appointment.patient.name || "Name not given"}</Link> : null}
                      <span className="cell-sub">{displayPhone(r.patient_phone)}</span>
                    </td>
                    <td>Dr. {r.appointment?.doctor?.name ?? "unknown"}</td>
                    <td>{r.rating ? <Stars rating={r.rating} /> : <span className="faint">No reply yet</span>}</td>
                    <td className="cell-actions">
                      {r.rating !== null && r.rating <= 3 ? <a className="text-link" href={whatsappLink(r.patient_phone)} target="_blank" rel="noreferrer">Open in WhatsApp</a> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <strong>No feedback requests in this period</strong>
            <span>Requests go out two hours after each visit.</span>
          </div>
        )}
      </section>
    </div>
  );
}
