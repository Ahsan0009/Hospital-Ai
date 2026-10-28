"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CalendarDays, FileText, LogOut, MessageSquareWarning, Moon, Settings, Star, Stethoscope, Sun, SunMedium, UserCog, Users } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Brand } from "@/app/brand";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { formatDayKey, formatTime, dateKey } from "@/lib/time";
import type { Clinic } from "@/types/db";

const NAV = [
  { label: "Today", href: "/", icon: SunMedium },
  { label: "Appointments", href: "/appointments", icon: CalendarDays },
  { label: "Handoffs", href: "/handoffs", icon: MessageSquareWarning },
  { label: "Patients", href: "/patients", icon: Users },
  { label: "Reports", href: "/reports", icon: FileText },
  { label: "Feedback", href: "/feedback", icon: Star },
  { label: "Doctors", href: "/doctors", icon: Stethoscope },
  { label: "Staff", href: "/staff", icon: UserCog, adminOnly: true },
  { label: "Settings", href: "/settings", icon: Settings },
];

function useClinicClock(tz: string) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now ? `${formatDayKey(dateKey(now, tz), "short")}, ${formatTime(now, tz)}` : "";
}

export function Shell({
  clinic,
  staff,
  counts,
  children,
}: {
  clinic: Clinic;
  staff: { email: string; role: "admin" | "staff" };
  counts: { openHandoffs: number; urgentHandoffs: number };
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const clock = useClinicClock(clinic.timezone);
  const [signOutError, setSignOutError] = useState("");
  const current = NAV.find((n) => (n.href === "/" ? pathname === "/" : pathname.startsWith(n.href)));

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem("clinic-desk-theme", next);
    } catch {
      // Private windows can block storage; the theme still switches for this visit.
    }
  }

  async function signOut() {
    const { error } = await getSupabaseBrowserClient().auth.signOut();
    if (error) {
      setSignOutError("Could not sign out. Check your connection and try again.");
      return;
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand name={clinic.name} />
        <nav className="sidebar-nav" aria-label="Main navigation">
          {NAV.filter((n) => !n.adminOnly || staff.role === "admin").map(({ label, href, icon: Icon }) => {
            const active = current?.href === href;
            const count = href === "/handoffs" ? counts.openHandoffs : 0;
            return (
              <Link key={href} href={href} className={`nav-link${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
                <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
                <span>{label}</span>
                {count ? (
                  <span className={`nav-count${counts.urgentHandoffs ? " urgent" : ""}`} aria-label={`${count} open${counts.urgentHandoffs ? `, ${counts.urgentHandoffs} urgent` : ""}`}>
                    {count}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <button className="sidebar-link" onClick={signOut} type="button" aria-label="Sign out">
            <LogOut size={18} strokeWidth={1.8} aria-hidden="true" />
            <span>Sign out</span>
          </button>
          <div className="sidebar-account">
            <span className="avatar" aria-hidden="true">{staff.email.charAt(0).toUpperCase()}</span>
            <span>
              <strong>{staff.email}</strong>
              <span>{staff.role === "admin" ? "Clinic admin" : "Front desk"}</span>
            </span>
          </div>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <p className="topbar-title">
            {clinic.name} / <strong>{current?.label ?? "Patient"}</strong>
          </p>
          <div className="topbar-actions">
            <span className="clock" suppressHydrationWarning>
              {clock}
            </span>
            <button className="icon-button" type="button" onClick={toggleTheme} aria-label="Switch between light and dark theme" title="Switch theme">
              <Moon className="theme-to-dark" size={17} aria-hidden="true" />
              <Sun className="theme-to-light" size={17} aria-hidden="true" />
            </button>
          </div>
        </header>
        <main className="content-area">
          {signOutError ? <div className="error-state" role="alert">{signOutError}</div> : null}
          {children}
        </main>
      </div>
    </div>
  );
}
