"use client";

import { useRouter } from "next/navigation";
import { LoaderCircle, LockKeyhole, Mail } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

const NO_ACCESS = "This account is not set up for the clinic dashboard. Ask the clinic admin to give it staff access.";

export function LoginForm({ reason }: { reason: "no-access" | null }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(reason === "no-access" ? NO_ACCESS : "");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // An account without a staff role keeps no session here.
    if (reason === "no-access") void getSupabaseBrowserClient().auth.signOut();
  }, [reason]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (signInError) {
        setError(signInError.message === "Invalid login credentials" ? "That email and password do not match. Check both and try again." : signInError.message);
        return;
      }
      const role = data.user?.app_metadata?.role;
      if (role !== "admin" && role !== "staff") {
        await supabase.auth.signOut();
        setError(NO_ACCESS);
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("The sign-in service could not be reached. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <h1>Sign in</h1>
      <p>Use the email and password the clinic admin set up for you.</p>
      {error ? (
        <div className="error-state" role="alert">
          <span>{error}</span>
        </div>
      ) : null}
      <label className="field" htmlFor="email">
        <span>Email address</span>
        <span className="input-wrap">
          <Mail size={17} aria-hidden="true" />
          <input autoComplete="email" id="email" name="email" onChange={(e) => setEmail(e.target.value)} placeholder="you@clinic.com" required type="email" value={email} />
        </span>
      </label>
      <label className="field" htmlFor="password">
        <span>Password</span>
        <span className="input-wrap">
          <LockKeyhole size={17} aria-hidden="true" />
          <input autoComplete="current-password" id="password" name="password" onChange={(e) => setPassword(e.target.value)} placeholder="Your password" required type="password" value={password} />
        </span>
      </label>
      <button className="button-primary" disabled={submitting} type="submit">
        {submitting ? (
          <>
            <LoaderCircle className="animate-spin" size={17} aria-hidden="true" />
            Signing in
          </>
        ) : (
          "Sign in"
        )}
      </button>
    </form>
  );
}
