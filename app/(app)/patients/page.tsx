import type { Metadata } from "next";
import Link from "next/link";
import { PatientSearch } from "@/app/(app)/patients/patient-search";
import { requireStaff } from "@/lib/auth";
import { getClinic, listPatients } from "@/lib/data";
import { displayPhone } from "@/lib/phone";
import { formatAgo, formatDateTime, formatDay } from "@/lib/time";

export const metadata: Metadata = { title: "Patients" };

const PAGE = 25;

export default async function PatientsPage({ searchParams }: PageProps<"/patients">) {
  await requireStaff();
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";
  const page = Math.max(0, Number(params.page) || 0);
  const [clinic, { rows, total }] = await Promise.all([getClinic(), listPatients({ q, page, pageSize: PAGE })]);
  const tz = clinic.timezone;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const link = (p: number) => `/patients?${new URLSearchParams({ ...(q ? { q } : {}), ...(p ? { page: String(p) } : {}) })}`;

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <h1>Patients</h1>
          <p>Everyone who has messaged the clinic on WhatsApp or been booked at the desk.</p>
        </div>
      </div>
      <section className="panel">
        <div className="toolbar">
          <PatientSearch initial={q} />
          <span className="count-tag">
            {total} patient{total === 1 ? "" : "s"}
          </span>
        </div>
        {rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Last WhatsApp message</th>
                  <th>Next visit</th>
                  <th>Last seen</th>
                  <th>Visits</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/patients/${p.id}`} className="cell-main text-link" style={{ color: "var(--ink)" }}>
                        {p.name || "Name not given"}
                      </Link>
                      <span className="cell-sub">{displayPhone(p.phone)}</span>
                    </td>
                    <td className="soft">{p.last_message_at ? formatAgo(p.last_message_at, tz) : "Never"}</td>
                    <td>{p.next_visit ? formatDateTime(p.next_visit, tz) : <span className="faint">None booked</span>}</td>
                    <td className="soft">{p.last_visit ? formatDay(p.last_visit, tz) : "Not yet"}</td>
                    <td>{p.visits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <strong>{q ? "No patient matches that search" : "No patients yet"}</strong>
            <span>{q ? "Try part of the name, or the last digits of the number." : "Patients appear here after their first WhatsApp message."}</span>
          </div>
        )}
        {pages > 1 ? (
          <div className="pager">
            <span>
              Page {page + 1} of {pages}
            </span>
            <div>
              {page > 0 ? <Link className="button-secondary" href={link(page - 1)}>Previous</Link> : null}
              {page + 1 < pages ? <Link className="button-secondary" href={link(page + 1)}>Next</Link> : null}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
