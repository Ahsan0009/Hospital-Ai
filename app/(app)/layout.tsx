import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Shell } from "@/app/(app)/shell";
import { getSignedInEmail, getStaff } from "@/lib/auth";
import { getClinic, getNavCounts } from "@/lib/data";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const staff = await getStaff();
  if (!staff) {
    const email = await getSignedInEmail();
    redirect(email ? "/login?reason=no-access" : "/login");
  }
  const [clinic, counts] = await Promise.all([getClinic(), getNavCounts()]);
  return (
    <Shell clinic={clinic} staff={staff} counts={counts}>
      {children}
    </Shell>
  );
}
