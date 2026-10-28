import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getOperator } from "@/lib/auth";
import { getClinicDetail } from "@/lib/operator-data";
import { formatAgo, formatDateTime, nowMs } from "@/lib/time";
import { BillingPanel, DangerZone, DetailsForm, ReportSecretPanel, SmsPanel, StaffPanel, StatusPanel, WhatsAppPanel } from "./panels";
import { limitsFor, usageLevel } from "@/lib/plans";
import { timeZoneOptions } from "@/lib/timezones";

export const metadata: Metadata = { title: "Clinic" };

const OPERATOR_TZ = process.env.OPERATOR_TIMEZONE || "Asia/Karachi";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ClinicPage(props: PageProps<"/operator/clinics/[id]">) {
  if (!(await getOperator())) notFound();
  const { id } = await props.params;
  const sp = await props.searchParams;
  if (!UUID.test(id)) notFound();
  const detail = await getClinicDetail(id, OPERATOR_TZ);
  if (!detail) notFound();
  const { clinic, staff, payments, audit, health, usage } = detail;
  const limits = limitsFor(clinic.plan, clinic);
  const today = new Date(nowMs()).toISOString().slice(0, 10);
  const webhookBase = (process.env.N8N_WEBHOOK_BASE || "").replace(/\/$/, "");

  const stats: [string, number | string][] = health
    ? [
        ["Messages in 24 h", health.messages_24h],
        ["Bookings in 7 days", health.bookings_7d],
        ["Upcoming visits", health.upcoming],
        ["Open handoffs", health.open_handoffs],
        ["Failed sends in 24 h", health.send_failures_24h],
        ["Patients", health.patients],
        ["Doctors", health.doctors],
        ["Staff accounts", health.staff],
      ]
    : [];

  return (
    <div className="page-stack">
      <Link href="/operator" className="back-link">
        <ArrowLeft size={15} aria-hidden="true" />
        All clinics
      </Link>
      <div className="page-heading">
        <div>
          <h1>{clinic.name}</h1>
          <p>
            <span className={`pill ${clinic.status}`}>{clinic.status[0].toUpperCase() + clinic.status.slice(1)}</span>{" "}
            Added {formatDateTime(clinic.created_at, OPERATOR_TZ)}.{" "}
            {health?.last_message_at ? `Last WhatsApp message ${formatAgo(health.last_message_at, OPERATOR_TZ)}.` : "No WhatsApp messages yet."}
          </p>
        </div>
      </div>

      {sp.created ? (
        <div className="success-state" role="status">
          <span>Clinic created. Next: connect its WhatsApp number below, then give the clinic admin their temporary password privately.</span>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Health</h2>
            <p>Counts only. Patient names, numbers and messages stay with the clinic.</p>
          </div>
        </div>
        <dl className="stat-grid">
          {stats.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Usage this month</h2>
            <p>Against the {clinic.plan} plan{clinic.limit_appointments || clinic.limit_messages ? " (this clinic has its own limits)" : ""}. Patient messages are what the AI answers.</p>
          </div>
        </div>
        <dl className="stat-grid two">
          {([["Appointments booked", usage.appointments, limits.appointments], ["Patient messages", usage.messages, limits.messages]] as const).map(([label, used, limit]) => {
            const level = usageLevel(used, limit);
            return (
              <div key={label} className="meter">
                <dt>{label}</dt>
                <dd>
                  <span className={`usage-${level}`}>{used.toLocaleString("en-US")}{limit ? ` of ${limit.toLocaleString("en-US")}` : " (no limit)"}</span>
                  {limit ? (
                    <span className={`meter-bar ${level}`} aria-hidden="true">
                      <i style={{ width: `${Math.min(100, Math.round((used / limit) * 100))}%` }} />
                    </span>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      <BillingPanel clinic={clinic} payments={payments} today={today} />
      <StatusPanel clinic={clinic} />
      <WhatsAppPanel clinic={clinic} webhookUrl={webhookBase ? `${webhookBase}/whatsapp-webhook` : null} />
      <SmsPanel clinic={clinic} webhookUrl={webhookBase ? `${webhookBase}/sms-inbound` : null} />
      <ReportSecretPanel clinic={clinic} webhookUrl={webhookBase ? `${webhookBase}/report-ready` : null} />
      <StaffPanel clinicId={clinic.id} staff={staff} tz={OPERATOR_TZ} />
      <DetailsForm clinic={clinic} zones={timeZoneOptions()} />

      <section className="panel">
        <div className="panel-heading">
          <h2>Change history</h2>
          <span className="count-tag">{audit.length}</span>
        </div>
        {audit.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Change</th>
                  <th>Detail</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="nowrap soft">{formatDateTime(a.created_at, OPERATOR_TZ)}</td>
                    <td>{a.action}</td>
                    <td className="soft">{a.detail}</td>
                    <td className="soft">{a.operator_email}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <strong>No changes recorded yet</strong>
          </div>
        )}
      </section>

      <DangerZone clinicId={clinic.id} clinicName={clinic.name} />
    </div>
  );
}
