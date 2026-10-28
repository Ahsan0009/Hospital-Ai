"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { Flash, Spinner } from "@/app/(app)/ui";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export function ChangePassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < 12) return setResult({ ok: false, text: "Use at least 12 characters." });
    if (password !== confirm) return setResult({ ok: false, text: "The two passwords do not match." });
    setBusy(true);
    const { error } = await getSupabaseBrowserClient().auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setResult({
        ok: false,
        text: /reauthenticat/i.test(error.message) ? "For security, sign out and sign in again, then change your password straight away." : error.message,
      });
      return;
    }
    setPassword("");
    setConfirm("");
    setResult({ ok: true, text: "Password changed. Use the new one next time you sign in." });
  }

  return (
    <form className="form-stack" onSubmit={submit} style={{ maxWidth: 560 }}>
      <div className="field-row">
        <label className="field">
          <span>New password</span>
          <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label className="field">
          <span>Type it again</span>
          <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
      </div>
      <span className="field-hint">At least 12 characters. If you were given a temporary password, change it here.</span>
      <Flash result={result} />
      <div>
        <button className="button-secondary" type="submit" disabled={busy}>
          {busy ? <Spinner /> : null}
          Change password
        </button>
      </div>
    </form>
  );
}
