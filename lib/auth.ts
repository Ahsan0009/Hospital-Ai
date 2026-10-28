import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export type Role = "admin" | "staff";
export type Staff = { id: string; email: string; role: Role };

export class AccessError extends Error {}

export async function getStaff(): Promise<Staff | null> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const role = user.app_metadata?.role;
  if (role !== "admin" && role !== "staff") return null;
  return { id: user.id, email: user.email ?? "", role };
}

export async function getSignedInEmail(): Promise<string | null> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.email ?? null;
}

export async function requireStaff(): Promise<Staff> {
  const staff = await getStaff();
  if (!staff) throw new AccessError("Your session has ended or this account has no clinic access. Sign in again.");
  return staff;
}

export async function requireAdmin(): Promise<Staff> {
  const staff = await requireStaff();
  if (staff.role !== "admin") throw new AccessError("Only clinic admins can change this.");
  return staff;
}
