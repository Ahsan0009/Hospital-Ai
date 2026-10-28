import type { Metadata } from "next";
import { BrandMark } from "@/app/brand";
import { ResetForm } from "@/app/reset-password/reset-form";

export const metadata: Metadata = { title: "New password" };

export default function ResetPasswordPage() {
  return (
    <main className="workspace-center">
      <div className="workspace-card">
        <BrandMark />
        <ResetForm />
      </div>
    </main>
  );
}
