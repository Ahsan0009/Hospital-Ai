"use client";

import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { Flash, Modal, Spinner } from "@/app/(app)/ui";
import { createClinic } from "@/app/operator/actions";
import { TimeZoneSelect } from "@/app/timezone-select";
import type { ZoneOption } from "@/lib/timezones";

type Zones = { common: ZoneOption[]; all: ZoneOption[] };

function tempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export function NewClinicButton({ zones }: { zones: Zones }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="button-primary" type="button" onClick={() => setOpen(true)}>
        <Plus size={16} aria-hidden="true" />
        Add clinic
      </button>
      {open ? <NewClinicDialog zones={zones} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function NewClinicDialog({ zones, onClose }: { zones: Zones; onClose: () => void }) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: "",
    plan: "growth",
    monthlyFee: "",
    currency: "PKR",
    trialDays: "14",
    timezone: "Asia/Karachi",
    contactPhone: "",
    alertEmail: "",
    adminEmail: "",
    adminPassword: tempPassword(),
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const r = await createClinic(form);
    setBusy(false);
    if (r.ok && r.data) {
      router.push(`/operator/clinics/${r.data.id}?created=1`);
    } else if (!r.ok) {
      setResult({ ok: false, text: r.error });
    }
  }

  return (
    <Modal title="Add a clinic" description="Creates the clinic and its first admin account. You connect WhatsApp on the next page." onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label className="field">
          <span>Clinic name</span>
          <input className="input" value={form.name} onChange={set("name")} required maxLength={80} />
        </label>
        <div className="field-row three">
          <label className="field">
            <span>Plan</span>
            <select value={form.plan} onChange={set("plan")}>
              <option value="starter">Starter</option>
              <option value="growth">Growth</option>
              <option value="pro">Pro</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label className="field">
            <span>Monthly fee</span>
            <input className="input" inputMode="decimal" value={form.monthlyFee} onChange={set("monthlyFee")} required />
          </label>
          <label className="field">
            <span>Currency</span>
            <input className="input" value={form.currency} onChange={set("currency")} maxLength={3} required />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Free trial (days)</span>
            <input className="input" type="number" min={0} max={90} value={form.trialDays} onChange={set("trialDays")} />
          </label>
          <div className="field">
            <label className="field-label" htmlFor="new-clinic-tz">Time zone</label>
            <TimeZoneSelect id="new-clinic-tz" value={form.timezone} onChange={(timezone) => setForm({ ...form, timezone })} zones={zones} />
          </div>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Clinic phone</span>
            <input className="input" value={form.contactPhone} onChange={set("contactPhone")} />
          </label>
          <label className="field">
            <span>Alert email</span>
            <input className="input" type="email" value={form.alertEmail} onChange={set("alertEmail")} required />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Clinic admin email</span>
            <input className="input" type="email" value={form.adminEmail} onChange={set("adminEmail")} required />
          </label>
          <div className="field">
            <label className="field-label" htmlFor="admin-temp-password">Temporary password</label>
            <input id="admin-temp-password" className="input" value={form.adminPassword} onChange={set("adminPassword")} minLength={12} required style={{ fontFamily: "var(--font-mono)" }} />
          </div>
        </div>
        <Flash result={result} />
        <div className="dialog-actions">
          <button className="button-secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="button-primary" type="submit" disabled={busy}>
            {busy ? <Spinner /> : null}
            Create clinic
          </button>
        </div>
      </form>
    </Modal>
  );
}
