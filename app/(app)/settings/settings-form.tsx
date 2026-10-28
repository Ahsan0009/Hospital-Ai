"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import { saveSettings } from "@/app/actions";
import { Flash, Spinner } from "@/app/(app)/ui";
import type { Clinic } from "@/types/db";

const COMMON = ["Asia/Karachi", "Asia/Dubai", "Asia/Riyadh", "Asia/Kolkata", "Europe/London", "America/New_York", "America/Chicago", "America/Los_Angeles", "UTC"];

export function SettingsForm({ clinic, canEdit }: { clinic: Clinic; canEdit: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(clinic.name);
  const [tz, setTz] = useState(clinic.timezone);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const r = await saveSettings({ name, timezone: tz });
    setBusy(false);
    setResult(r.ok ? { ok: true, text: r.message ?? "Saved." } : { ok: false, text: r.error });
    if (r.ok) router.refresh();
  }

  return (
    <form className="form-stack" onSubmit={submit} style={{ maxWidth: 560 }}>
      <div className="field-row">
        <label className="field">
          <span>Clinic name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} maxLength={80} required />
        </label>
        <label className="field">
          <span>Time zone</span>
          <input className="input" list="tz-list" value={tz} onChange={(e) => setTz(e.target.value)} disabled={!canEdit} required />
          <datalist id="tz-list">
            {COMMON.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </label>
      </div>
      <span className="field-hint">Keep these the same as CLINIC_NAME and CLINIC_TIMEZONE on the automation server, so WhatsApp messages match what the desk sees.</span>
      <Flash result={result} />
      {canEdit ? (
        <div>
          <button className="button-primary" type="submit" disabled={busy || (name === clinic.name && tz === clinic.timezone)}>
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
