import type { Metadata } from "next";
import { BrandMark } from "@/app/brand";
import { ForgotForm } from "@/app/forgot-password/forgot-form";

export const metadata: Metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return (
    <main className="workspace-center">
      <div className="workspace-card">
        <BrandMark />
        <ForgotForm />
      </div>
    </main>
  );
}
