import type { Metadata } from "next";
import { LoginForm } from "@/app/login/login-form";
import { BrandMark } from "@/app/brand";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const reason = params.reason === "no-access" ? "no-access" : params.reason === "link-expired" ? "link-expired" : null;
  return (
    <main className="login-page">
      <aside className="login-aside">
        <span className="brand">
          <BrandMark />
          <span>Clinic desk</span>
        </span>
        <div className="login-pitch">
          <p className="login-headline">The clinic&rsquo;s day, as the WhatsApp assistant sees it.</p>
          <p>Today&rsquo;s visits by doctor, patients waiting for a person, critical reports and feedback, in one place for the front desk.</p>
        </div>
        <p className="login-legal">For clinic staff only.</p>
      </aside>
      <div className="login-main">
        <LoginForm reason={reason} />
      </div>
    </main>
  );
}
