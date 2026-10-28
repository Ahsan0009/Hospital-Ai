"use client";

import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";

export function PatientSearch({ initial }: { initial: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initial);
  useEffect(() => {
    if (q === initial) return;
    const id = window.setTimeout(() => router.push(q.trim() ? `/patients?q=${encodeURIComponent(q.trim())}` : "/patients"), 300);
    return () => window.clearTimeout(id);
  }, [q, initial, router]);
  return (
    <label className="input-wrap">
      <Search size={16} aria-hidden="true" />
      <input type="search" placeholder="Name or WhatsApp number" aria-label="Search patients" value={q} onChange={(e) => setQ(e.target.value)} />
    </label>
  );
}
