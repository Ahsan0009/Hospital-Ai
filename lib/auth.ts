import "server-only";

import { cache } from "react";

import { db } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export type Role = "admin" | "staff";
export type ClinicStatus = "trial" | "active" | "suspended" | "cancelled";
export type Staff = { id: string; email: string; role: Role; clinicId: string; clinicName: string; clinicStatus: ClinicStatus };
export type Operator = { id: string; email: string };

export class AccessError extends Error {}

async function signedInUser() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** The operator is the platform owner. Two locks: the role in app metadata (only
 * the service-role key can set it) and the email being listed in OPERATOR_EMAILS. */
function isOperator(user: { email?: string | null; app_metadata?: Record<string, unknown> } | null): boolean {
  if (!user?.email || user.app_metadata?.role !== "operator") return false;
  const allowed = (process.env.OPERATOR_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(user.email.toLowerCase());
}

export type Who =
  | { kind: "none" }
  | { kind: "operator"; operator: Operator }
  | { kind: "staff"; staff: Staff }
  | { kind: "paused"; email: string; clinicName: string; status: ClinicStatus }
  | { kind: "no-access"; email: string };

/** Who is signed in, looked up fresh on every request (no stale roles), once per request. */
export const whoAmI = cache(async function whoAmI(): Promise<Who> {
  const user = await signedInUser();
  if (!user) return { kind: "none" };
  if (isOperator(user)) return { kind: "operator", operator: { id: user.id, email: user.email ?? "" } };
  const { data, error } = await db()
    .from("staff_members")
    .select("role, clinic_id, clinic:clinics(name, status)")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw new Error(`Could not check access. ${error.message}`);
  const clinic = data?.clinic as unknown as { name: string; status: ClinicStatus } | null;
  if (!data || !clinic || (data.role !== "admin" && data.role !== "staff")) return { kind: "no-access", email: user.email ?? "" };
  if (clinic.status !== "trial" && clinic.status !== "active") {
    return { kind: "paused", email: user.email ?? "", clinicName: clinic.name, status: clinic.status };
  }
  return {
    kind: "staff",
    staff: { id: user.id, email: user.email ?? "", role: data.role, clinicId: data.clinic_id, clinicName: clinic.name, clinicStatus: clinic.status },
  };
});

export async function getStaff(): Promise<Staff | null> {
  const who = await whoAmI();
  return who.kind === "staff" ? who.staff : null;
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

export async function getOperator(): Promise<Operator | null> {
  const who = await whoAmI();
  return who.kind === "operator" ? who.operator : null;
}

export async function requireOperator(): Promise<Operator> {
  const op = await getOperator();
  if (!op) throw new AccessError("This area is only for the platform owner.");
  return op;
}
