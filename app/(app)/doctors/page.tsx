import type { Metadata } from "next";
import { DoctorsView } from "@/app/(app)/doctors/doctors-view";
import { getStaff } from "@/lib/auth";
import { getClinic, listDoctors, listTimeOff, scopeFor } from "@/lib/data";
import { dateKey } from "@/lib/time";

export const metadata: Metadata = { title: "Doctors" };

export default async function DoctorsPage() {
  const staff = await getStaff();
  if (!staff) return null; // the layout shows sign-in, paused or no-access
  const s = await scopeFor(staff);
  const clinic = await getClinic(s);
  const todayKey = dateKey(new Date(), clinic.timezone);
  const [doctors, timeOff] = await Promise.all([listDoctors(s), listTimeOff(s, todayKey)]);
  return <DoctorsView doctors={doctors} timeOff={timeOff} canEdit={staff.role === "admin"} todayKey={todayKey} />;
}
