import type { Metadata } from "next";
import { StaffView } from "@/app/(app)/staff/staff-view";
import { requireStaff } from "@/lib/auth";
import { getClinic } from "@/lib/data";
import { listStaffUsers } from "@/lib/staff-users";

export const metadata: Metadata = { title: "Staff" };

export default async function StaffPage() {
  const me = await requireStaff();
  if (me.role !== "admin") {
    return (
      <div className="page-stack">
        <div className="page-heading">
          <div>
            <h1>Staff</h1>
            <p>Only clinic admins can add staff or change who can sign in. Ask your clinic admin.</p>
          </div>
        </div>
      </div>
    );
  }
  const [clinic, users] = await Promise.all([getClinic(), listStaffUsers()]);
  return <StaffView users={users} meId={me.id} tz={clinic.timezone} />;
}
