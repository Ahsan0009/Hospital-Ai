import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { NewClinicButton } from "@/app/operator/new-clinic";
import { getOperator } from "@/lib/auth";
import { listClinics } from "@/lib/operator-data";
import type { ClinicRow, Health, Usage } from "@/lib/operator-data";
import { limitsFor, usageLevel } from "@/lib/plans";
import { formatAgo, nowMs } from "@/lib/time";
import { timeZoneOptions } from "@/lib/timezones";

export const metadata: Metadata = { title: "Clinics" };

const OPERATOR_TZ = process.env.OPERATOR_TIMEZONE || "Asia/Karachi";

function money(n: number, currency: string) {
  return `${currency} ${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

type Alert = { key: string; tone: "bad" | "warn"; clinic: ClinicRow; title: string; body: string };

function alertsFor(c: ClinicRow, h: Health | undefined, u: Usage | undefined, today: string, now: number): Alert[] {
  const out: Alert[] = [];
  const live = c.status === "active" || c.status === "trial";
  if (live && c.paid_until && c.paid_until < today) {
    out.push({ key: `${c.id}-paid`, tone: "bad", clinic: c, title: `${c.name}: payment overdue`, body: `Paid until ${c.paid_until}. Record a payment or suspend the clinic.` });
  }
  if (live && c.wa_phone_number_id && h && (!h.last_message_at || now - Date.parse(h.last_message_at) > 48 * 3600 * 1000)) {
    out.push({ key: `${c.id}-quiet`, tone: "warn", clinic: c, title: `${c.name}: no WhatsApp messages for 2 days`, body: "Check the number, the webhook subscription and the access token in Meta." });
  }
  if (live && u) {
    const lim = limitsFor(c.plan, c);
    const over = [
      usageLevel(u.appointments, lim.appointments) === "over" ? `${u.appointments} of ${lim.appointments} appointments` : null,
      usageLevel(u.messages, lim.messages) === "over" ? `${u.messages} of ${lim.messages} patient messages` : null,
    ].filter(Boolean);
    if (over.length) out.push({ key: `${c.id}-limit`, tone: "warn", clinic: c, title: `${c.name}: over its ${c.plan} plan this month`, body: `${over.join(" and ")}. Offer the next plan or charge the overage.` });
  }
  if (live && !c.wa_phone_number_id && !c.sms_enabled) {
    out.push({ key: `${c.id}-nochannel`, tone: "warn", clinic: c, title: `${c.name}: no WhatsApp or SMS number`, body: "Patients cannot reach the assistant until a number is connected." });
  }
  if (live && !c.alert_email) {
    out.push({ key: `${c.id}-email`, tone: "warn", clinic: c, title: `${c.name}: no alert email`, body: "Handoffs, unhappy patients and critical reports have nowhere to go. Add the front desk's email." });
  }
  if (h && h.send_failures_24h > 0) {
    out.push({ key: `${c.id}-fail`, tone: "warn", clinic: c, title: `${c.name}: ${h.send_failures_24h} failed send${h.send_failures_24h === 1 ? "" : "s"} in 24 hours`, body: "Usually an unapproved template or an expired token." });
  }
  if (h && h.urgent_handoffs > 0) {
    out.push({ key: `${c.id}-urgent`, tone: "bad", clinic: c, title: `${c.name}: ${h.urgent_handoffs} urgent handoff${h.urgent_handoffs === 1 ? "" : "s"} open`, body: "The clinic has been emailed; check they are responding." });
  }
  return out;
}

export default async function OperatorHome() {
  if (!(await getOperator())) notFound();
  const { clinics, health, usage, heartbeat } = await listClinics(OPERATOR_TZ);
  const today = new Date().toISOString().slice(0, 10);
  const count = (s: ClinicRow["status"]) => clinics.filter((c) => c.status === s).length;
  const revenue = new Map<string, number>();
  for (const c of clinics.filter((c) => c.status === "active")) revenue.set(c.currency, (revenue.get(c.currency) ?? 0) + c.monthly_fee);
  const now = nowMs();
  const alerts = clinics.flatMap((c) => alertsFor(c, health[c.id], usage[c.id], today, now));
  const beatAge = heartbeat ? Math.round((now - Date.parse(heartbeat)) / 60000) : null;
  const automationDown = beatAge === null || beatAge > 15;

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <h1>Clinics</h1>
          <p>Every clinic on the platform, whether it is paid up, and whether its automation is healthy. Patient details are never shown here.</p>
        </div>
        <div className="page-actions">
          <NewClinicButton zones={timeZoneOptions()} />
        </div>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <h2>This month</h2>
        </div>
        <div className="summary-line">
          <span className="revenue">
            Monthly revenue{" "}
            <b>{revenue.size ? [...revenue.entries()].map(([cur, n]) => money(n, cur)).join(" + ") : "0"}</b>
          </span>
          <span>Active <b>{count("active")}</b></span>
          <span>On trial <b>{count("trial")}</b></span>
          <span>Suspended <b>{count("suspended")}</b></span>
          <span>Cancelled <b>{count("cancelled")}</b></span>
          <span className={automationDown ? "overdue" : undefined}>
            Automation{" "}
            <b>{heartbeat ? `checked in ${formatAgo(heartbeat, OPERATOR_TZ)}` : "has not checked in yet"}</b>
          </span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Needs attention</h2>
            <p>Overdue payments and anything that stops a clinic&rsquo;s automation working.</p>
          </div>
        </div>
        {automationDown ? (
          <div className="attention-list">
            <div className="attention-item bad">
              <span>
                <strong>The automation has not checked in for {beatAge === null ? "a while" : `${beatAge} minutes`}</strong>
                <p>Reminders, replies and alerts may have stopped. Check that the n8n server is running and the workflow is published.</p>
              </span>
              <span />
            </div>
          </div>
        ) : null}
        {alerts.length ? (
          <div className="attention-list">
            {alerts.map((a) => (
              <Link key={a.key} href={`/operator/clinics/${a.clinic.id}`} className={`attention-item ${a.tone}`}>
                <span>
                  <strong>{a.title}</strong>
                  <p>{a.body}</p>
                </span>
                <span />
              </Link>
            ))}
          </div>
        ) : (
          <div className="all-clear">
            <CheckCircle2 size={18} aria-hidden="true" />
            Every clinic is paid up and working.
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>All clinics</h2>
          <span className="count-tag">{clinics.length}</span>
        </div>
        {clinics.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Clinic</th>
                  <th>Status</th>
                  <th>Paid until</th>
                  <th>Channels</th>
                  <th>This month</th>
                  <th>Last message</th>
                  <th>Messages 24 h</th>
                  <th>Bookings 7 d</th>
                  <th>Open handoffs</th>
                  <th>Failed sends 24 h</th>
                </tr>
              </thead>
              <tbody>
                {clinics.map((c) => {
                  const h = health[c.id];
                  const overdue = (c.status === "active" || c.status === "trial") && c.paid_until && c.paid_until < today;
                  return (
                    <tr key={c.id}>
                      <td>
                        <Link className="cell-main" href={`/operator/clinics/${c.id}`}>{c.name}</Link>
                        <span className="cell-sub">
                          {c.plan[0].toUpperCase() + c.plan.slice(1)}, {money(c.monthly_fee, c.currency)} a month
                        </span>
                      </td>
                      <td><span className={`pill ${c.status}`}>{c.status[0].toUpperCase() + c.status.slice(1)}</span></td>
                      <td className={overdue ? "overdue nowrap" : "nowrap"}>{c.paid_until ?? "Not set"}</td>
                      <td>
                        {c.wa_phone_number_id ? <span className="cell-main">WhatsApp {c.wa_display_number || ""}</span> : null}
                        {c.sms_enabled ? <span className="cell-sub">SMS {c.sms_number}</span> : null}
                        {!c.wa_phone_number_id && !c.sms_enabled ? <span className="faint">Not connected</span> : null}
                      </td>
                      <td className="nowrap">
                        <UsageCell used={usage[c.id]?.appointments ?? 0} limit={limitsFor(c.plan, c).appointments} label="visits" />
                        <UsageCell used={usage[c.id]?.messages ?? 0} limit={limitsFor(c.plan, c).messages} label="messages" />
                      </td>
                      <td className="soft nowrap">{h?.last_message_at ? formatAgo(h.last_message_at, OPERATOR_TZ) : "Never"}</td>
                      <td>{h?.messages_24h ?? 0}</td>
                      <td>{h?.bookings_7d ?? 0}</td>
                      <td>{h?.open_handoffs ?? 0}{h?.urgent_handoffs ? <span className="overdue"> ({h.urgent_handoffs} urgent)</span> : null}</td>
                      <td className={h?.send_failures_24h ? "overdue" : undefined}>{h?.send_failures_24h ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <strong>No clinics yet</strong>
            <span>Add the first clinic, then connect its WhatsApp number.</span>
          </div>
        )}
      </section>
    </div>
  );
}

function UsageCell({ used, limit, label }: { used: number; limit: number | null; label: string }) {
  const level = usageLevel(used, limit);
  return (
    <span className={`cell-sub usage-${level}`}>
      {used.toLocaleString("en-US")}
      {limit ? ` / ${limit.toLocaleString("en-US")}` : ""} {label}
    </span>
  );
}
