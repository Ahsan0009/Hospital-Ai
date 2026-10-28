import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Shell } from "@/app/(app)/shell";
import { PausedNotice } from "@/app/paused-notice";
import { whoAmI } from "@/lib/auth";
import { getClinic, getNavCounts, scopeFor } from "@/lib/data";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const who = await whoAmI();
  if (who.kind === "none") redirect("/login");
  if (who.kind === "operator") redirect("/operator");
  if (who.kind === "no-access") redirect("/login?reason=no-access");
  if (who.kind === "paused") return <PausedNotice clinicName={who.clinicName} cancelled={who.status === "cancelled"} />;
  const s = await scopeFor(who.staff);
  const [clinic, counts] = await Promise.all([getClinic(s), getNavCounts(s)]);
  return (
    <Shell clinic={clinic} staff={who.staff} counts={counts}>
      {children}
    </Shell>
  );
}
