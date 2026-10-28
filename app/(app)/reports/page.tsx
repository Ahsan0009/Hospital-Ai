import type { Metadata } from "next";
import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { getClinic, listReports } from "@/lib/data";
import { displayPhone, safeLink } from "@/lib/phone";
import { formatDateTime } from "@/lib/time";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  await requireStaff();
  const params = await searchParams;
  const critical = params.critical === "1";
  const [clinic, reports] = await Promise.all([getClinic(), listReports({ criticalOnly: critical })]);
  const tz = clinic.timezone;

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <h1>Reports</h1>
          <p>Lab reports sent in by the lab system. Patients get a WhatsApp message that the report is ready; critical ones are also emailed to the clinic.</p>
        </div>
      </div>
      <section className="panel">
        <div className="toolbar">
          <div className="tabs" role="group" aria-label="Show">
            <Link className={`tab${critical ? "" : " active"}`} aria-current={critical ? undefined : "page"} href="/reports">
              All
            </Link>
            <Link className={`tab${critical ? " active" : ""}`} aria-current={critical ? "page" : undefined} href="/reports?critical=1">
              Critical only
            </Link>
          </div>
          <span className="count-tag">{reports.length} shown</span>
        </div>
        {reports.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Received</th>
                  <th>Patient</th>
                  <th>Report</th>
                  <th>Note for staff</th>
                  <th className="cell-actions"><span className="sr-only">Link</span></th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap soft">{formatDateTime(r.created_at, tz)}</td>
                    <td>
                      {r.patient ? (
                        <Link className="cell-main" href={`/patients/${r.patient.id}`}>{r.patient.name || "Name not given"}</Link>
                      ) : null}
                      <span className="cell-sub">{displayPhone(r.patient?.phone)}</span>
                    </td>
                    <td>
                      <span className="cell-main">{r.report_type}</span>
                      {r.is_critical ? <span className="pill critical">Critical</span> : null}
                    </td>
                    <td><span className="truncate-cell" title={r.summary ?? ""}>{r.summary || "No note"}</span></td>
                    <td className="cell-actions">
                      {safeLink(r.report_link) ? <a className="text-link" href={safeLink(r.report_link)!} target="_blank" rel="noreferrer">Open report</a> : <span className="faint">No link</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <strong>{critical ? "No critical reports" : "No reports yet"}</strong>
            <span>Reports appear here once the lab system is connected and sends them in.</span>
          </div>
        )}
      </section>
    </div>
  );
}
