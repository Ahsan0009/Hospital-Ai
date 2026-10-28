"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export function SignOutButton({ className = "button-secondary" }: { className?: string }) {
  const router = useRouter();
  return (
    <button
      className={className}
      type="button"
      onClick={async () => {
        await getSupabaseBrowserClient().auth.signOut();
        router.replace("/login");
        router.refresh();
      }}
    >
      <LogOut size={16} aria-hidden="true" />
      Sign out
    </button>
  );
}
