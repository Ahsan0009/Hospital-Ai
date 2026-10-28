import type { Metadata } from "next";
import { AppointmentsView } from "@/app/(app)/appointments/appointments-view";
import { requireStaff } from "@/lib/auth";
import { getClinic, listAppointments, listDoctors } from "@/lib/data";
import { addDays, dateKey, isDateKey } from "@/lib/time";
import type { AppointmentStatus } from "@/types/db";

export const metadata: Metadata = { title: "Appointments" };

const STATUSES = ["all", "confirmed", "completed", "no_show", "cancelled"] as const;

export default async function AppointmentsPage({ searchParams }: PageProps<"/appointments">) {
  await requireStaff();
  const params = await searchParams;
  const clinic = await getClinic();
  const tz = clinic.timezone;
  const today = dateKey(new Date(), tz);
  const date = isDateKey(params.date) ? params.date : today;
  const range = params.range === "week" ? "week" : "day";
  const status = (STATUSES as readonly string[]).includes(String(params.status)) ? (params.status as AppointmentStatus | "all") : "all";
  const doctorId = Number(params.doctor) || undefined;
  const q = typeof params.q === "string" ? params.q.slice(0, 60) : "";

  const [doctors, all] = await Promise.all([
    listDoctors(),
    listAppointments({ from: date, days: range === "week" ? 7 : 1, tz, doctorId }),
  ]);
  const term = q.toLowerCase().trim();
  const digits = term.replace(/\D/g, "");
  const matching = term
    ? all.filter((a) => (a.patient?.name ?? "").toLowerCase().includes(term) || (digits.length >= 3 && (a.patient?.phone ?? "").includes(digits)))
    : all;
  const counts = Object.fromEntries(STATUSES.map((s) => [s, s === "all" ? matching.length : matching.filter((a) => a.status === s).length]));
  const rows = status === "all" ? matching : matching.filter((a) => a.status === status);

  return (
    <AppointmentsView
      rows={rows}
      counts={counts}
      doctors={doctors}
      tz={tz}
      today={today}
      filters={{ date, range, status, doctorId: doctorId ?? null, q, end: addDays(date, range === "week" ? 6 : 0) }}
    />
  );
}
