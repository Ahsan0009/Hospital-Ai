import type { Metadata } from "next";
import { ChangePassword } from "@/app/(app)/settings/change-password";
import { SettingsForm } from "@/app/(app)/settings/settings-form";
import { getStaff } from "@/lib/auth";
import { getClinic, listActivity, listRecentErrors, scopeFor } from "@/lib/data";
import { displayPhone } from "@/lib/phone";
import { daysAgoIso, formatAgo } from "@/lib/time";
import { timeZoneOptions } from "@/lib/timezones";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const staff = await getStaff();
  if (!staff) return null; // the layout shows sign-in, paused or no-access
  const s = await scopeFor(staff);
  const since = daysAgoIso(7);
  const [clinic, errors, activity] = await Promise.all([getClinic(s), listRecentErrors(s, since, 30), listActivity(s, 30)]);
  const tz = clinic.timezone;

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
          <p>Signed in as {staff.email} ({staff.role === "admin" ? "clinic admin" : "front desk"}).</p>
        </div>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Clinic</h2>
            <p>Clinic details, the time zone every date and time is shown in, and which automatic messages patients get.</p>
          </div>
        </div>
        <div className="panel-body">
          <SettingsForm clinic={clinic} canEdit={staff.role === "admin"} zones={timeZoneOptions()} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Your password</h2>
            <p>Only changes the password for {staff.email}.</p>
          </div>
        </div>
        <div className="panel-body">
          <ChangePassword />
        </div>
      </section>

      <section className="panel" id="problems">
        <div className="panel-heading">
          <div>
            <h2>Message problems</h2>
            <p>Messages that could not be sent in the last 7 days, usually because a WhatsApp template is not approved yet, a number is not on WhatsApp, or a patient opted out of texts.</p>
          </div>
          <span className="count-tag">{errors.length}</span>
        </div>
        {errors.length ? (
          <div className="timeline">
            {errors.map((e) => (
              <div key={e.id} className="timeline-row">
                <span className="soft">{formatAgo(e.created_at, tz)}</span>
                <span>
                  {e.error_detail || "No detail recorded"}
                  {e.patient_phone ? <span className="cell-sub">{displayPhone(e.patient_phone)}</span> : null}
                </span>
                <span className="pill warn">{(e.source || "message").replace(/_/g, " ")}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state"><span>No problems in the last 7 days.</span></div>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Staff activity</h2>
            <p>Changes made from this dashboard, newest first.</p>
          </div>
        </div>
        {activity.length ? (
          <div className="timeline">
            {activity.map((a) => (
              <div key={a.id} className="timeline-row">
                <span className="soft">{formatAgo(a.created_at, tz)}</span>
                <span>
                  {a.action}
                  {a.detail ? <span className="cell-sub">{a.detail}</span> : null}
                </span>
                <span className="faint small">{a.staff_email}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state"><span>Nothing changed from the dashboard yet.</span></div>
        )}
      </section>
    </div>
  );
}
