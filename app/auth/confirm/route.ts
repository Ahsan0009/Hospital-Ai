import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// Landing point for the links in Supabase emails (password reset).
// Accepts either the token-hash link (recommended email template) or the default PKCE code link.
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const next = url.searchParams.get("next");
  const safeNext = next && /^\/[a-z0-9/-]*$/i.test(next) && !next.startsWith("//") ? next : "/";
  const supabase = await getSupabaseServerClient();
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  const code = url.searchParams.get("code");
  let ok = false;
  if (tokenHash && type === "recovery") {
    const { error } = await supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
    ok = !error;
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    ok = !error;
  }
  // A relative Location keeps the visitor on the host they arrived on, behind any proxy.
  return new NextResponse(null, { status: 303, headers: { Location: ok ? safeNext : "/login?reason=link-expired" } });
}
