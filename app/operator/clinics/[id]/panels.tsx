"use client";

import { useRouter } from "next/navigation";
import { Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Flash, Modal, Spinner } from "@/app/(app)/ui";
import {
  addClinicAdmin,
  deleteClinic,
  newReportSecret,
  recordPayment,
  resetClinicUserPassword,
  saveSms,
  saveWhatsApp,
  setClinicStatus,
  updateClinic,
} from "@/app/operator/actions";
import type { ClinicRow } from "@/lib/operator-data";
import type { ZoneOption } from "@/lib/timezones";
import { TimeZoneSelect } from "@/app/timezone-select";
import { formatAgo } from "@/lib/time";

type Result = { ok: boolean; text: string } | null;
type Payment = { id: number; amount: number; currency: string; period_from: string; period_to: string; method: string | null; reference: string | null; note: string | null; recorded_by: string; recorded_at: string };
type StaffRow = { user_id: string; role: string; email: string; last_sign_in_at: string | null };

function tempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function Panel({ title, description, children, id }: { title: string; description?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="panel" id={id}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  async function go(fn: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>, onOk?: () => void) {
    setBusy(true);
    setResult(null);
    const r = await fn();
    setBusy(false);
    setResult(r.ok ? { ok: true, text: r.message ?? "Saved." } : { ok: false, text: r.error });
    if (r.ok) {
      onOk?.();
      router.refresh();
    }
  }
  return { busy, result, go };
}

/* ---------- Billing ---------- */

export function BillingPanel({ clinic, payments, today }: { clinic: ClinicRow; payments: Payment[]; today: string }) {
  const start = clinic.paid_until && clinic.paid_until >= today ? clinic.paid_until : today;
  const [form, setForm] = useState({
    amount: String(clinic.monthly_fee || ""),
    currency: clinic.currency,
    months: "1",
    periodFrom: start,
    method: "Bank transfer",
    reference: "",
    note: "",
    reactivate: true,
  });
  const { busy, result, go } = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const overdue = (clinic.status === "active" || clinic.status === "trial") && clinic.paid_until && clinic.paid_until < today;

  return (
    <Panel
      title="Billing"
      id="billing"
      description={
        <>
          {clinic.monthly_fee.toLocaleString("en-US")} {clinic.currency} a month on the {clinic.plan} plan. Paid until{" "}
          <b className={overdue ? "overdue" : undefined}>{clinic.paid_until ?? "not set"}</b>
          {overdue ? " (overdue)" : ""}. Payments are recorded by hand when money reaches you.
        </>
      }
    >
      <form
        className="form-stack"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          go(() => recordPayment(clinic.id, form), () => setForm((f) => ({ ...f, reference: "", note: "" })));
        }}
      >
        <div className="field-row three">
          <label className="field">
            <span>Amount received</span>
            <input className="input" inputMode="decimal" value={form.amount} onChange={set("amount")} required />
          </label>
          <label className="field">
            <span>Currency</span>
            <input className="input" value={form.currency} onChange={set("currency")} maxLength={3} required />
          </label>
          <label className="field">
            <span>Months covered</span>
            <input className="input" type="number" min={1} max={24} value={form.months} onChange={set("months")} required />
          </label>
        </div>
        <div className="field-row three">
          <label className="field">
            <span>Period starts</span>
            <input className="input" type="date" value={form.periodFrom} onChange={set("periodFrom")} required />
          </label>
          <label className="field">
            <span>Method</span>
            <input className="input" value={form.method} onChange={set("method")} list="pay-methods" />
            <datalist id="pay-methods">
              <option value="Bank transfer" />
              <option value="JazzCash" />
              <option value="Easypaisa" />
              <option value="Cash" />
              <option value="Wise" />
              <option value="Payoneer" />
            </datalist>
          </label>
          <label className="field">
            <span>Reference</span>
            <input className="input" value={form.reference} onChange={set("reference")} placeholder="Transaction ID" />
          </label>
        </div>
        <label className="field">
          <span>Note</span>
          <input className="input" value={form.note} onChange={set("note")} />
        </label>
        {clinic.status === "suspended" || clinic.status === "trial" ? (
          <label className="check">
            <input type="checkbox" checked={form.reactivate} onChange={(e) => setForm({ ...form, reactivate: e.target.checked })} />
            <span>Make the clinic active once this payment is recorded</span>
          </label>
        ) : null}
        <Flash result={result} />
        <div>
          <button className="button-primary" type="submit" disabled={busy}>
            {busy ? <Spinner /> : null}
            Record payment
          </button>
        </div>
      </form>

      {payments.length ? (
        <div className="table-scroll" style={{ marginTop: 20 }}>
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>Amount</th>
                <th>Covers</th>
                <th>Method</th>
                <th>Reference</th>
                <th className="cell-actions"><span className="sr-only">Invoice</span></th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="nowrap soft">{p.recorded_at.slice(0, 10)}</td>
                  <td className="nowrap">{Number(p.amount).toLocaleString("en-US")} {p.currency}</td>
                  <td className="nowrap">{p.period_from} to {p.period_to}</td>
                  <td>{p.method ?? ""}</td>
                  <td className="soft">{[p.reference, p.note].filter(Boolean).join(", ")}</td>
                  <td className="cell-actions">
                    <a className="text-link" href={`/operator/invoices/${p.id}`} target="_blank" rel="noreferrer">Invoice</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="field-hint" style={{ marginTop: 16 }}>No payments recorded yet.</p>
      )}
    </Panel>
  );
}

/* ---------- Status ---------- */

export function StatusPanel({ clinic }: { clinic: ClinicRow }) {
  const [reason, setReason] = useState("");
  const { busy, result, go } = useAction();
  const options: { status: ClinicRow["status"]; label: string; tone: string }[] = [
    { status: "active", label: "Make active", tone: "button-primary" },
    { status: "trial", label: "Put on trial", tone: "button-secondary" },
    { status: "suspended", label: "Suspend", tone: "button-danger" },
    { status: "cancelled", label: "Cancel subscription", tone: "button-secondary" },
  ];
  return (
    <Panel
      title="Access"
      description="Suspended or cancelled clinics cannot sign in, and their automation stops. Patients who message are told to call the clinic. Nothing is deleted."
    >
      <div className="form-stack">
        <label className="field">
          <span>Reason (kept in the change history)</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: March invoice unpaid" />
        </label>
        <div className="button-row">
          {options
            .filter((o) => o.status !== clinic.status)
            .map((o) => (
              <button key={o.status} className={o.tone} type="button" disabled={busy} onClick={() => go(() => setClinicStatus(clinic.id, o.status, reason), () => setReason(""))}>
                {o.label}
              </button>
            ))}
        </div>
        <Flash result={result} />
      </div>
    </Panel>
  );
}

/* ---------- WhatsApp ---------- */

export function WhatsAppPanel({ clinic, webhookUrl }: { clinic: ClinicRow; webhookUrl: string | null }) {
  const [form, setForm] = useState({ phoneNumberId: clinic.wa_phone_number_id ?? "", displayNumber: clinic.wa_display_number ?? "", token: "", clearToken: false });
  const { busy, result, go } = useAction();
  const set = (k: "phoneNumberId" | "displayNumber" | "token") => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <Panel
      title="WhatsApp connection"
      id="whatsapp"
      description="Messages arriving on this phone number ID are handled for this clinic only. The access token is encrypted and can never be shown again."
    >
      <form
        className="form-stack"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          go(() => saveWhatsApp(clinic.id, form), () => setForm((f) => ({ ...f, token: "", clearToken: false })));
        }}
      >
        <div className="field-row">
          <label className="field">
            <span>Phone number ID</span>
            <input className="input" inputMode="numeric" value={form.phoneNumberId} onChange={set("phoneNumberId")} style={{ fontFamily: "var(--font-mono)" }} />
          </label>
          <label className="field">
            <span>Number shown to staff</span>
            <input className="input" value={form.displayNumber} onChange={set("displayNumber")} placeholder="+92 300 1234567" />
          </label>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="wa-token">
            Access token {clinic.has_own_token ? "(one is saved; leave empty to keep it)" : "(none saved; the platform token is used)"}
          </label>
          <input id="wa-token" className="input" type="password" autoComplete="off" value={form.token} onChange={set("token")} disabled={form.clearToken} />
        </div>
        {clinic.has_own_token ? (
          <label className="check">
            <input type="checkbox" checked={form.clearToken} onChange={(e) => setForm({ ...form, clearToken: e.target.checked, token: "" })} />
            <span>Remove the saved token</span>
          </label>
        ) : null}
        {webhookUrl ? (
          <p className="field-hint">
            Meta webhook URL for this app: <code>{webhookUrl}</code>
          </p>
        ) : null}
        <Flash result={result} />
        <div>
          <button className="button-primary" type="submit" disabled={busy}>
            {busy ? <Spinner /> : null}
            Save connection
          </button>
        </div>
      </form>
    </Panel>
  );
}

/* ---------- SMS ---------- */

export function SmsPanel({ clinic, webhookUrl }: { clinic: ClinicRow; webhookUrl: string | null }) {
  const [form, setForm] = useState({ enabled: clinic.sms_enabled, number: clinic.sms_number ?? "", preferredChannel: clinic.preferred_channel as string });
  const { busy, result, go } = useAction();
  return (
    <Panel
      title="SMS (text messages)"
      id="sms"
      description="For clinics whose patients text rather than use WhatsApp, mainly in the US. Patients who text the number are answered by text; reminders follow each patient's channel."
    >
      <form
        className="form-stack"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          go(() => saveSms(clinic.id, form));
        }}
      >
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          <span>SMS on for this clinic</span>
        </label>
        <div className="field-row">
          <label className="field">
            <span>SMS number (with country code)</span>
            <input className="input" inputMode="tel" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} placeholder="+1 305 555 0123" disabled={!form.enabled} />
          </label>
          <label className="field">
            <span>New desk bookings get messages by</span>
            <select value={form.preferredChannel} onChange={(e) => setForm({ ...form, preferredChannel: e.target.value })}>
              <option value="whatsapp">WhatsApp</option>
              <option value="sms" disabled={!form.enabled}>SMS</option>
            </select>
          </label>
        </div>
        {webhookUrl ? (
          <p className="field-hint">
            Twilio messaging webhook for this number (HTTP POST): <code>{webhookUrl}</code>
          </p>
        ) : null}
        <Flash result={result} />
        <div>
          <button className="button-primary" type="submit" disabled={busy}>
            {busy ? <Spinner /> : null}
            Save SMS settings
          </button>
        </div>
      </form>
    </Panel>
  );
}

/* ---------- Lab report secret ---------- */

export function ReportSecretPanel({ clinic, webhookUrl }: { clinic: ClinicRow; webhookUrl: string | null }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const { busy, result, go } = useAction();
  return (
    <Panel
      title="Lab report connection"
      description="The lab sends reports to the webhook with this secret in the x-report-secret header. Only a fingerprint is stored, so a lost secret is replaced, not recovered."
    >
      <div className="form-stack">
        <p className="field-hint">
          {clinic.has_report_secret ? "A secret is set." : "No secret yet, so lab reports are refused for this clinic."}
          {webhookUrl ? (
            <>
              {" "}Webhook: <code>{webhookUrl}</code>
            </>
          ) : null}
        </p>
        {secret ? (
          <div className="secret-box">
            <code>{secret}</code>
            <button
              type="button"
              className="button-secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(secret);
                setCopied(true);
              }}
            >
              <Copy size={15} aria-hidden="true" />
              {copied ? "Copied" : "Copy"}
            </button>
            <span className="field-hint">Shown once. Send it to the lab privately.</span>
          </div>
        ) : null}
        <Flash result={result} />
        <div>
          <button className="button-secondary" type="button" disabled={busy} onClick={() => (clinic.has_report_secret ? setConfirming(true) : issue())}>
            <KeyRound size={15} aria-hidden="true" />
            {clinic.has_report_secret ? "Replace secret" : "Create secret"}
          </button>
        </div>
      </div>
      {confirming ? (
        <Modal title="Replace the lab secret?" description="The current secret stops working immediately. The lab must switch to the new one." onClose={() => setConfirming(false)}>
          <div className="dialog-actions">
            <button className="button-secondary" type="button" onClick={() => setConfirming(false)}>Keep current</button>
            <button
              className="button-danger"
              type="button"
              onClick={() => {
                setConfirming(false);
                issue();
              }}
            >
              Replace secret
            </button>
          </div>
        </Modal>
      ) : null}
    </Panel>
  );

  function issue() {
    setCopied(false);
    go(async () => {
      const r = await newReportSecret(clinic.id);
      if (r.ok && r.data) setSecret(r.data.secret);
      return r;
    });
  }
}

/* ---------- Staff ---------- */

export function StaffPanel({ clinicId, staff, tz }: { clinicId: string; staff: StaffRow[]; tz: string }) {
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<StaffRow | null>(null);
  return (
    <Panel title="Clinic accounts" description="The clinic's admins add their own staff. You can add another admin or set a new password if they are locked out.">
      {staff.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Last signed in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {staff.map((m) => (
                <tr key={m.user_id}>
                  <td>{m.email}</td>
                  <td>{m.role === "admin" ? "Admin" : "Staff"}</td>
                  <td className="soft nowrap">{m.last_sign_in_at ? formatAgo(m.last_sign_in_at, tz) : "Never"}</td>
                  <td className="cell-actions">
                    <button className="button-secondary small" type="button" onClick={() => setResetting(m)}>
                      Set new password
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">
          <strong>No accounts</strong>
          <span>Add an admin so the clinic can sign in.</span>
        </div>
      )}
      <div style={{ marginTop: 16 }}>
        <button className="button-secondary" type="button" onClick={() => setAdding(true)}>
          Add clinic admin
        </button>
      </div>
      {adding ? <AddAdminDialog clinicId={clinicId} onClose={() => setAdding(false)} /> : null}
      {resetting ? <ResetDialog clinicId={clinicId} member={resetting} onClose={() => setResetting(null)} /> : null}
    </Panel>
  );
}

function AddAdminDialog({ clinicId, onClose }: { clinicId: string; onClose: () => void }) {
  const [form, setForm] = useState({ email: "", password: tempPassword() });
  const { busy, result, go } = useAction();
  return (
    <Modal title="Add clinic admin" description="Give them the temporary password privately; they can change it after signing in." onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          go(() => addClinicAdmin(clinicId, form), onClose);
        }}
      >
        <label className="field">
          <span>Email</span>
          <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        </label>
        <div className="field">
          <label className="field-label" htmlFor="new-admin-password">Temporary password</label>
          <input id="new-admin-password" className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={12} required style={{ fontFamily: "var(--font-mono)" }} />
        </div>
        <Flash result={result} />
        <div className="dialog-actions">
          <button className="button-secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="button-primary" type="submit" disabled={busy}>
            {busy ? <Spinner /> : null}
            Add admin
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResetDialog({ clinicId, member, onClose }: { clinicId: string; member: StaffRow; onClose: () => void }) {
  const [password, setPassword] = useState(tempPassword());
  const [done, setDone] = useState(false);
  const { busy, result, go } = useAction();
  return (
    <Modal title={`New password for ${member.email}`} description="Their old password stops working. Give them this one privately." onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          go(() => resetClinicUserPassword(clinicId, member.user_id, password), () => setDone(true));
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="reset-password">New password</label>
          <input id="reset-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} required readOnly={done} style={{ fontFamily: "var(--font-mono)" }} />
        </div>
        <Flash result={result} />
        <div className="dialog-actions">
          <button className="button-secondary" type="button" onClick={onClose}>{done ? "Close" : "Cancel"}</button>
          {done ? null : (
            <button className="button-primary" type="submit" disabled={busy}>
              {busy ? <Spinner /> : null}
              Set password
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

/* ---------- Details ---------- */

export function DetailsForm({ clinic, zones }: { clinic: ClinicRow; zones: { common: ZoneOption[]; all: ZoneOption[] } }) {
  const initial = {
    name: clinic.name,
    plan: clinic.plan,
    monthlyFee: String(clinic.monthly_fee),
    currency: clinic.currency,
    timezone: clinic.timezone,
    contactPhone: clinic.contact_phone ?? "",
    alertEmail: clinic.alert_email ?? "",
    googleReviewLink: clinic.google_review_link ?? "",
    templateLang: clinic.template_lang,
    notes: clinic.notes ?? "",
    limitAppointments: clinic.limit_appointments ? String(clinic.limit_appointments) : "",
    limitMessages: clinic.limit_messages ? String(clinic.limit_messages) : "",
    retentionMonths: clinic.retention_months ? String(clinic.retention_months) : "",
  };
  const [form, setForm] = useState(initial);
  const { busy, result, go } = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const unchanged = JSON.stringify(form) === JSON.stringify(initial);
  return (
    <Panel title="Clinic details" description="Plan, price and the settings the automation uses. Notes are visible only to you.">
      <form
        className="form-stack"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          go(() => updateClinic(clinic.id, form));
        }}
      >
        <div className="field-row">
          <label className="field">
            <span>Clinic name</span>
            <input className="input" value={form.name} onChange={set("name")} maxLength={80} required />
          </label>
          <div className="field">
            <label className="field-label" htmlFor="op-clinic-tz">Time zone</label>
            <TimeZoneSelect id="op-clinic-tz" value={form.timezone} onChange={(timezone) => setForm({ ...form, timezone })} zones={zones} />
          </div>
        </div>
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
        <div className="field-row three">
          <label className="field">
            <span>Clinic phone</span>
            <input className="input" value={form.contactPhone} onChange={set("contactPhone")} />
          </label>
          <label className="field">
            <span>Alert email</span>
            <input className="input" type="email" value={form.alertEmail} onChange={set("alertEmail")} required />
          </label>
          <label className="field">
            <span>Template language</span>
            <input className="input" value={form.templateLang} onChange={set("templateLang")} maxLength={10} />
          </label>
        </div>
        <label className="field">
          <span>Google review link</span>
          <input className="input" value={form.googleReviewLink} onChange={set("googleReviewLink")} placeholder="https://g.page/r/..." />
        </label>
        <div className="field-row three">
          <label className="field">
            <span>Own appointment limit</span>
            <input className="input" inputMode="numeric" value={form.limitAppointments} onChange={set("limitAppointments")} placeholder="Plan default" />
          </label>
          <label className="field">
            <span>Own message limit</span>
            <input className="input" inputMode="numeric" value={form.limitMessages} onChange={set("limitMessages")} placeholder="Plan default" />
          </label>
          <label className="field">
            <span>Delete records older than (months)</span>
            <input className="input" inputMode="numeric" value={form.retentionMonths} onChange={set("retentionMonths")} placeholder="Keep everything" />
          </label>
        </div>
        <label className="field">
          <span>Private notes</span>
          <textarea className="input" rows={3} value={form.notes} onChange={set("notes")} maxLength={2000} />
        </label>
        <Flash result={result} />
        <div>
          <button className="button-primary" type="submit" disabled={busy || unchanged}>
            {busy ? <Spinner /> : null}
            Save details
          </button>
        </div>
      </form>
    </Panel>
  );
}

/* ---------- Delete ---------- */

export function DangerZone({ clinicId, clinicName }: { clinicId: string; clinicName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  return (
    <section className="panel danger-zone">
      <div className="panel-heading">
        <div>
          <h2>Delete clinic</h2>
          <p>Permanently removes the clinic, every patient, appointment, report and message log, and all its staff accounts. Payment history is kept. This cannot be undone; suspend instead if you might need the data.</p>
        </div>
      </div>
      <div className="panel-body">
        <button className="button-danger" type="button" onClick={() => setOpen(true)}>
          Delete {clinicName}
        </button>
      </div>
      {open ? (
        <Modal title={`Delete ${clinicName}?`} description="Type the clinic's name to confirm." onClose={() => setOpen(false)}>
          <form
            className="form-stack"
            onSubmit={async (e: FormEvent) => {
              e.preventDefault();
              setBusy(true);
              const r = await deleteClinic(clinicId, typed);
              setBusy(false);
              if (r.ok) router.replace("/operator");
              else setResult({ ok: false, text: r.error });
            }}
          >
            <label className="field">
              <span>Clinic name</span>
              <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            </label>
            <Flash result={result} />
            <div className="dialog-actions">
              <button className="button-secondary" type="button" onClick={() => setOpen(false)}>Keep clinic</button>
              <button className="button-danger" type="submit" disabled={busy || typed !== clinicName}>
                {busy ? <Spinner /> : null}
                Delete permanently
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </section>
  );
}
