"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import { saveSettings } from "@/app/actions";
import { Flash, Spinner } from "@/app/(app)/ui";
import { TimeZoneSelect } from "@/app/timezone-select";
import type { ZoneOption } from "@/lib/timezones";
import type { Clinic } from "@/types/db";

export function SettingsForm({ clinic, canEdit, zones }: { clinic: Clinic; canEdit: boolean; zones: { common: ZoneOption[]; all: ZoneOption[] } }) {
  const router = useRouter();
  const initial = {
    name: clinic.name,
    timezone: clinic.timezone,
    contactPhone: clinic.contactPhone ?? "",
    alertEmail: clinic.alertEmail ?? "",
    googleReviewLink: clinic.googleReviewLink ?? "",
    remind24h: clinic.remind24h,
    remind2h: clinic.remind2h,
    askFeedback: clinic.askFeedback,
    preferredChannel: clinic.preferredChannel as string,
  };
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: "name" | "contactPhone" | "alertEmail" | "googleReviewLink") => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const flag = (k: "remind24h" | "remind2h" | "askFeedback") => (e: { target: { checked: boolean } }) => setForm({ ...form, [k]: e.target.checked });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const r = await saveSettings(form);
    setBusy(false);
    setResult(r.ok ? { ok: true, text: r.message ?? "Saved." } : { ok: false, text: r.error });
    if (r.ok) router.refresh();
  }

  const unchanged = JSON.stringify(form) === JSON.stringify(initial);

  return (
    <form className="form-stack" onSubmit={submit} style={{ maxWidth: 680 }}>
      <div className="field-row">
        <label className="field">
          <span>Clinic name</span>
          <input className="input" value={form.name} onChange={set("name")} disabled={!canEdit} maxLength={80} required />
        </label>
        <div className="field">
          <label className="field-label" htmlFor="clinic-tz">Time zone</label>
          <TimeZoneSelect id="clinic-tz" value={form.timezone} onChange={(timezone) => setForm({ ...form, timezone })} zones={zones} disabled={!canEdit} />
        </div>
      </div>
      {form.timezone !== initial.timezone ? (
        <span className="field-hint">Booked visits keep their real time. The hours on screen, in messages and the doctors&rsquo; schedules are read in the new zone, so check doctors&rsquo; hours after saving.</span>
      ) : null}
      <div className="field-row">
        <label className="field">
          <span>Alert email</span>
          <input className="input" type="email" value={form.alertEmail} onChange={set("alertEmail")} disabled={!canEdit} placeholder="frontdesk@clinic.com" />
        </label>
        <label className="field">
          <span>Clinic phone number</span>
          <input className="input" inputMode="tel" value={form.contactPhone} onChange={set("contactPhone")} disabled={!canEdit} placeholder="042 111 222 333" />
        </label>
      </div>
      <label className="field">
        <span>Google review link</span>
        <input className="input" value={form.googleReviewLink} onChange={set("googleReviewLink")} disabled={!canEdit} placeholder="https://g.page/r/..." />
      </label>

      <fieldset className="field toggles" disabled={!canEdit}>
        <legend className="field-label">Automatic messages to patients</legend>
        <label className="toggle-line">
          <input type="checkbox" checked={form.remind24h} onChange={flag("remind24h")} />
          Reminder a day before the visit
        </label>
        <label className="toggle-line">
          <input type="checkbox" checked={form.remind2h} onChange={flag("remind2h")} />
          Reminder 2 hours before the visit
        </label>
        <label className="toggle-line">
          <input type="checkbox" checked={form.askFeedback} onChange={flag("askFeedback")} />
          Ask for a rating after the visit
        </label>
      </fieldset>

      {clinic.smsEnabled ? (
        <label className="field">
          <span>New patients booked at the desk get messages by</span>
          <select value={form.preferredChannel} onChange={(e) => setForm({ ...form, preferredChannel: e.target.value })} disabled={!canEdit}>
            <option value="whatsapp">WhatsApp</option>
            <option value="sms">SMS (text message)</option>
          </select>
        </label>
      ) : null}

      <span className="field-hint">
        The alert email gets handoffs, unhappy patients and critical reports. The review link is sent to patients who rate a visit 4 or 5.
        {clinic.smsEnabled ? ` Text messages come from ${clinic.smsNumber}. Patients who write by SMS are answered by SMS.` : ""}
      </span>
      <Flash result={result} />
      {canEdit ? (
        <div>
          <button className="button-primary" type="submit" disabled={busy || unchanged}>
            {busy ? <Spinner /> : null}
            Save changes
          </button>
        </div>
      ) : (
        <span className="field-hint">Only clinic admins can change these.</span>
      )}
    </form>
  );
}
