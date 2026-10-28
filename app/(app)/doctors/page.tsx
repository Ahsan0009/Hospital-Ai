import type { Metadata } from "next";
import { DoctorsView } from "@/app/(app)/doctors/doctors-view";
import { requireStaff } from "@/lib/auth";
import { listDoctors } from "@/lib/data";

export const metadata: Metadata = { title: "Doctors" };

export default async function DoctorsPage() {
  const staff = await requireStaff();
  const doctors = await listDoctors();
  return <DoctorsView doctors={doctors} canEdit={staff.role === "admin"} />;
}
