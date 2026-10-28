"use client";

import Link from "next/link";
import { useState } from "react";
import type { FormEvent } from "react";
import { requestPasswordReset } from "@/app/auth-actions";
import { Flash, Spinner } from "@/app/(app)/ui";

export function ForgotForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const r = await requestPasswordReset(email);
    setBusy(false);
    setResult(r.ok ? { ok: true, text: r.message ?? "Check your email." } : { ok: false, text: r.error });
  }

  return (
    <form className="form-stack" onSubmit={submit}>
      <h1>Set a new password</h1>
      <p className="soft">Enter the email you sign in with. We will email you a link to choose a new password.</p>
      <label className="field">
        <span>Email address</span>
        <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <Flash result={result} />
      <div className="button-row">
        <button className="button-primary" type="submit" disabled={busy}>
          {busy ? <Spinner /> : null}
          Email me a link
        </button>
        <Link className="button-secondary" href="/login">Back to sign in</Link>
      </div>
    </form>
  );
}
