import type { Metadata } from "next";
import { StaffView } from "@/app/(app)/staff/staff-view";
import { getStaff } from "@/lib/auth";
import { getClinic, scopeFor } from "@/lib/data";
import { listClinicStaff } from "@/lib/staff-users";

export const metadata: Metadata = { title: "Staff" };

export default async function StaffPage() {
  const me = await getStaff();
  if (!me) return null; // the layout shows sign-in, paused or no-access
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
  const s = await scopeFor(me);
  const [clinic, users] = await Promise.all([getClinic(s), listClinicStaff(s)]);
  return <StaffView users={users} meId={me.id} tz={clinic.timezone} />;
}
