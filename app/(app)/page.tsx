import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { DaySheet } from "@/app/(app)/day-sheet";
import { requireStaff } from "@/lib/auth";
import { getClinic, getToday } from "@/lib/data";
import { displayPhone } from "@/lib/phone";
import { formatAgo, formatDayKey } from "@/lib/time";

export const metadata: Metadata = { title: "Today" };

type Item = { key: string; tone: "bad" | "warn" | "plain"; title: string; body: string; when?: string; href: string };

export default async function TodayPage() {
  await requireStaff();
  const clinic = await getClinic();
  const tz = clinic.timezone;
  const t = await getToday(tz);
  const now = new Date();

  const items: Item[] = [];
  for (const h of t.handoffs) {
    items.push({
      key: `h${h.id}`,
      tone: h.urgency === "urgent" ? "bad" : "warn",
      title: `${h.urgency === "urgent" ? "Urgent: " : ""}${h.patient?.name || displayPhone(h.patient_phone)} needs a person`,
      body: h.reason,
      when: formatAgo(h.created_at, tz, now),
      href: "/handoffs",
    });
  }
  for (const r of t.criticalReports) {
    items.push({
      key: `r${r.id}`,
      tone: "bad",
      title: `Critical ${r.report_type} for ${r.patient?.name || displayPhone(r.patient?.phone)}`,
      body: r.summary || "The lab marked this report as critical. The doctor was emailed.",
      when: formatAgo(r.created_at, tz, now),
      href: "/reports?critical=1",
    });
  }
  for (const f of t.lowRatings) {
    const who = f.appointment?.patient?.name || displayPhone(f.patient_phone);
    items.push({
      key: `f${f.id}`,
      tone: "warn",
      title: `${who} rated their visit ${f.rating} out of 5`,
      body: `Seen by Dr. ${f.appointment?.doctor?.name ?? "unknown"}. They were sent an apology; a call back helps.`,
      when: f.responded_at ? formatAgo(f.responded_at, tz, now) : undefined,
      href: f.appointment?.patient ? `/patients/${f.appointment.patient.id}` : "/feedback",
    });
  }
  const unmarked = t.appointments.filter((a) => a.status === "confirmed" && Date.parse(a.slot_time) < now.getTime() - 30 * 60 * 1000);
  if (unmarked.length) {
    items.push({
      key: "unmarked",
      tone: "plain",
      title: `${unmarked.length} earlier visit${unmarked.length === 1 ? " is" : "s are"} not marked as seen or missed`,
      body: "Mark missed visits soon: two hours after the time, booked visits count as seen and the patient is asked for a rating.",
      href: "/appointments?status=confirmed",
    });
  }
  if (t.errors.length) {
    items.push({
      key: "errors",
      tone: "warn",
      title: `${t.errors.length} WhatsApp message${t.errors.length === 1 ? "" : "s"} could not be sent in the last day`,
      body: t.errors[0].error_detail ?? "See Settings for details.",
      when: formatAgo(t.errors[0].created_at, tz, now),
      href: "/settings#problems",
    });
  }

  const active = t.appointments.filter((a) => a.status !== "cancelled").length;
  const shown = items.slice(0, 7);

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <h1>{formatDayKey(t.key)}</h1>
          <p>
            {active ? `${active} appointment${active === 1 ? "" : "s"} today` : "No appointments today yet"}
            {t.handoffs.length ? `, and ${t.handoffs.length} patient${t.handoffs.length === 1 ? "" : "s"} waiting for a person.` : "."}
          </p>
        </div>
      </div>

      <section className="panel" aria-labelledby="attention-title">
        <div className="panel-heading">
          <div>
            <h2 id="attention-title">Needs attention</h2>
            <p>Handoffs, critical reports, unhappy patients and failed messages, newest first within each kind.</p>
          </div>
          {items.length > shown.length ? <span className="count-tag">{items.length - shown.length} more</span> : null}
        </div>
        {shown.length ? (
          <div className="attention-list">
            {shown.map((i) => (
              <Link key={i.key} href={i.href} className={`attention-item ${i.tone}`}>
                <span>
                  <strong>{i.title}</strong>
                  <p>{i.body}</p>
                </span>
                {i.when ? <time>{i.when}</time> : <span />}
              </Link>
            ))}
          </div>
        ) : (
          <div className="all-clear">
            <CheckCircle2 size={18} aria-hidden="true" />
            Nothing is waiting. New handoffs and critical reports appear here as they arrive.
          </div>
        )}
      </section>

      <DaySheet doctors={t.doctors} appointments={t.appointments} tz={tz} todayKey={t.key} />
    </div>
  );
}
