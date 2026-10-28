import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { BrandMark } from "@/app/brand";
import { SignOutButton } from "@/app/sign-out-button";
import { whoAmI } from "@/lib/auth";

export const metadata: Metadata = { title: { default: "Owner console", template: "%s | Owner console" } };

// Only the platform owner gets past this layout. Everyone else gets a plain 404,
// so the console's existence is not revealed.
export default async function OperatorLayout({ children }: { children: ReactNode }) {
  const who = await whoAmI();
  if (who.kind === "none") redirect("/login");
  if (who.kind !== "operator") notFound();
  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <Link href="/operator" className="brand">
          <BrandMark />
          <span>Owner console</span>
        </Link>
        <div className="admin-topbar-actions">
          <span className="small" style={{ color: "var(--rail-soft)" }}>{who.operator.email}</span>
          <SignOutButton className="sidebar-link" />
        </div>
      </header>
      <main className="content-area">{children}</main>
    </div>
  );
}
