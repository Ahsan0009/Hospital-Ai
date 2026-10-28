"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import { Flash, Spinner } from "@/app/(app)/ui";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export function ResetForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < 12) return setResult({ ok: false, text: "Use at least 12 characters." });
    if (password !== again) return setResult({ ok: false, text: "The two passwords do not match." });
    setBusy(true);
    const { error } = await getSupabaseBrowserClient().auth.updateUser({ password });
    setBusy(false);
    if (error) return setResult({ ok: false, text: "The link has expired or was already used. Ask for a new one from the sign-in page." });
    setResult({ ok: true, text: "Password changed. Opening your dashboard…" });
    router.replace("/");
    router.refresh();
  }

  return (
    <form className="form-stack" onSubmit={submit}>
      <h1>Choose a new password</h1>
      <p className="soft">At least 12 characters. You will stay signed in on this device.</p>
      <label className="field">
        <span>New password</span>
        <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} />
      </label>
      <label className="field">
        <span>Type it again</span>
        <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required minLength={12} />
      </label>
      <Flash result={result} />
      <div>
        <button className="button-primary" type="submit" disabled={busy}>
          {busy ? <Spinner /> : null}
          Save new password
        </button>
      </div>
    </form>
  );
}
