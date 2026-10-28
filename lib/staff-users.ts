import "server-only";

import { db } from "@/lib/supabase/admin";
import type { Role } from "@/lib/auth";

export type StaffUser = {
  id: string;
  email: string;
  role: Role | null;
  createdAt: string;
  lastSignInAt: string | null;
};

// Sign-in accounts live in Supabase Auth. The role sits in app_metadata,
// which only the service-role key can change; users cannot edit it themselves.
export async function listStaffUsers(): Promise<StaffUser[]> {
  const { data, error } = await db().auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`Could not load staff accounts. ${error.message}`);
  return data.users
    .map((u) => {
      const role = u.app_metadata?.role;
      return {
        id: u.id,
        email: u.email ?? "",
        role: role === "admin" || role === "staff" ? role : null,
        createdAt: u.created_at,
        lastSignInAt: u.last_sign_in_at ?? null,
      };
    })
    .sort((a, b) => Number(b.role === "admin") - Number(a.role === "admin") || a.email.localeCompare(b.email));
}
