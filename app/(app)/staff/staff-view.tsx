"use client";

import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { createStaffUser, deleteStaffUser, resetStaffPassword, setStaffRole } from "@/app/actions";
import { EmptyState, Flash, Modal, PageHeading, Spinner } from "@/app/(app)/ui";
import { formatAgo, formatDay } from "@/lib/time";
import type { ActionResult } from "@/types/db";

type User = { id: string; email: string; role: "admin" | "staff"; createdAt: string; lastSignInAt: string | null };
type Dialog = { kind: "add" } | { kind: "password"; user: User } | { kind: "delete"; user: User } | null;

const ROLE_HELP = [
  ["Clinic admin", "Everything the front desk can do, plus doctors and their hours, clinic settings, and staff accounts."],
  ["Front desk", "Today, appointments, handoffs, patients, reports and feedback. Can book, move, cancel and mark visits, and close handoffs."],
  ["Removing someone", "Delete their account. They are signed out of the dashboard on their next click."],
];

function tempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export function StaffView({ users, meId, tz }: { users: User[]; meId: string; tz: string }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(key: string, fn: () => Promise<ActionResult>, close = false) {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    setResult(r.ok ? { ok: true, text: r.message ?? "Saved." } : { ok: false, text: r.error });
    if (r.ok) {
      if (close) setDialog(null);
      router.refresh();
    }
    return r.ok;
  }

  return (
    <div className="page-stack">
      <PageHeading
        title="Staff"
        description="Who can sign in to this dashboard, and what they can do."
        action={
          <button className="button-primary" type="button" onClick={() => { setDialog({ kind: "add" }); setResult(null); }}>
            <Plus size={16} aria-hidden="true" />
            Add staff
          </button>
        }
      />
      {result && !dialog ? <Flash result={result} /> : null}

      <section className="panel">
        {users.length ? (
          <div className="table-scroll" style={{ borderTop: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Access</th>
                  <th>Last signed in</th>
                  <th className="cell-actions"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const me = u.id === meId;
                  return (
                    <tr key={u.id}>
                      <td>
                        <span className="cell-main">{u.email}{me ? " (you)" : ""}</span>
                        <span className="cell-sub">Added {formatDay(u.createdAt, tz)}</span>
                      </td>
                      <td>
                        <select
                          className="select"
                          aria-label={`Access for ${u.email}`}
                          value={u.role}
                          disabled={me || busy === u.id}
                          onChange={(e) => act(u.id, () => setStaffRole(u.id, e.target.value))}
                        >
                          <option value="admin">Clinic admin</option>
                          <option value="staff">Front desk</option>
                        </select>
                      </td>
                      <td className="soft">{u.lastSignInAt ? formatAgo(u.lastSignInAt, tz) : "Never"}</td>
                      <td className="cell-actions">
                        <button className="button-quiet" type="button" onClick={() => { setDialog({ kind: "password", user: u }); setResult(null); }}>
                          Set password
                        </button>
                        {!me ? (
                          <button className="button-quiet" type="button" onClick={() => { setDialog({ kind: "delete", user: u }); setResult(null); }}>
                            Delete
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No accounts yet" />
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>What each role can do</h2>
            <p>Roles are checked on the server for every page and every change, so a front-desk account cannot do admin work even by calling the server directly.</p>
          </div>
        </div>
        <dl className="detail-list panel-body">
          {ROLE_HELP.map(([r, d]) => (
            <div key={r} style={{ display: "contents" }}>
              <dt>{r}</dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
      </section>

      {dialog?.kind === "add" ? <AddDialog onClose={() => setDialog(null)} onSaved={(text) => { setDialog(null); setResult({ ok: true, text }); router.refresh(); }} /> : null}

      {dialog?.kind === "password" ? (
        <PasswordDialog user={dialog.user} result={result} busy={busy === "password"} onClose={() => setDialog(null)} onSave={(pw) => act("password", () => resetStaffPassword(dialog.user.id, pw), true)} />
      ) : null}

      {dialog?.kind === "delete" ? (
        <Modal title="Delete account" description={dialog.user.email} onClose={() => setDialog(null)}>
          <p>This person will no longer be able to sign in. Their past changes stay in the activity log.</p>
          {result && !result.ok ? <Flash result={result} /> : null}
          <div className="dialog-actions">
            <button className="button-secondary" type="button" onClick={() => setDialog(null)}>Keep account</button>
            <button className="button-danger" type="button" disabled={busy === "delete"} onClick={() => act("delete", () => deleteStaffUser(dialog.user.id), true)}>
              {busy === "delete" ? <Spinner /> : null}
              Delete account
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function AddDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (text: string) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("staff");
  const [password, setPassword] = useState(() => tempPassword());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const r = await createStaffUser({ email, role, password });
    setBusy(false);
    if (r.ok) onSaved(r.message ?? "Account created.");
    else setError({ ok: false, text: r.error });
  }

  return (
    <Modal title="Add staff" description="They sign in with this email and the temporary password, then change it under Settings." onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label className="field">
          <span>Email address</span>
          <input className="input" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span>Access</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="staff">Front desk</option>
            <option value="admin">Clinic admin</option>
          </select>
        </label>
        <div className="field">
          <label className="field-label" htmlFor="temp-password">Temporary password</label>
          <input id="temp-password" className="input" aria-describedby="temp-password-hint" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} required autoComplete="off" style={{ fontFamily: "var(--font-mono)" }} />
          <span id="temp-password-hint" className="field-hint">Copy it now and give it to them in person or by phone, not by email. At least 12 characters.</span>
        </div>
        <Flash result={error} />
        <div className="dialog-actions">
          <button className="button-secondary" type="button" onClick={() => setPassword(tempPassword())}>New password</button>
          <button className="button-primary" type="submit" disabled={busy}>
            {busy ? <Spinner /> : null}
            Create account
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PasswordDialog({ user, result, busy, onClose, onSave }: { user: User; result: { ok: boolean; text: string } | null; busy: boolean; onClose: () => void; onSave: (pw: string) => void }) {
  const [password, setPassword] = useState(() => tempPassword());
  return (
    <Modal title="Set a new password" description={user.email} onClose={onClose}>
      <form className="form-stack" onSubmit={(e) => { e.preventDefault(); onSave(password); }}>
        <div className="field">
          <label className="field-label" htmlFor="reset-password">New password</label>
          <input id="reset-password" className="input" aria-describedby="reset-password-hint" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} required autoComplete="off" style={{ fontFamily: "var(--font-mono)" }} />
          <span id="reset-password-hint" className="field-hint">Their current password stops working straight away.</span>
        </div>
        {result && !result.ok ? <Flash result={result} /> : null}
        <div className="dialog-actions">
          <button className="button-secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="button-primary" type="submit" disabled={busy}>
            {busy ? <Spinner /> : null}
            Set password
          </button>
        </div>
      </form>
    </Modal>
  );
}
