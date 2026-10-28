"use server";

import { headers } from "next/headers";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/types/db";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sends a password-reset link. Always answers the same way, so it never reveals who has an account. */
export async function requestPasswordReset(emailInput: string): Promise<ActionResult> {
  const email = String(emailInput ?? "").trim().toLowerCase().slice(0, 200);
  if (!EMAIL.test(email)) return { ok: false, error: "Enter your email address." };
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  const origin = process.env.SITE_URL?.replace(/\/$/, "") || `${proto}://${host}`;
  try {
    const supabase = await getSupabaseServerClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/auth/confirm?next=/reset-password` });
    if (error) console.error("password reset request failed", error.message);
  } catch (cause) {
    console.error(cause);
  }
  return { ok: true, message: "If that email has an account, a link to set a new password is on its way. It works once and expires within an hour." };
}
