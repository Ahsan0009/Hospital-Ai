import "server-only";

import type { Role } from "@/lib/auth";
import type { Scope } from "@/lib/data";
import { db } from "@/lib/supabase/admin";

export type StaffUser = {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  lastSignInAt: string | null;
};

/** Accounts of this clinic only. Other clinics' accounts are never listed. */
export async function listClinicStaff(s: Scope): Promise<StaffUser[]> {
  const { data, error } = await s.client
    .from("staff_members")
    .select("user_id, role, email, created_at")
    .eq("clinic_id", s.clinicId)
    .order("role")
    .order("email");
  if (error) throw new Error(`Could not load staff accounts. ${error.message}`);
  const lastSignIn = await Promise.all(
    (data ?? []).map(async (m) => {
      const { data: u } = await db().auth.admin.getUserById(m.user_id);
      return u?.user?.last_sign_in_at ?? null;
    }),
  );
  return (data ?? []).map((m, i) => ({
    id: m.user_id,
    email: m.email,
    role: m.role as Role,
    createdAt: m.created_at,
    lastSignInAt: lastSignIn[i],
  }));
}
