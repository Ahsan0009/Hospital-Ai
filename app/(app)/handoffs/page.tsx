import type { Metadata } from "next";
import Link from "next/link";
import { HandoffList } from "@/app/(app)/handoffs/handoff-list";
import { requireStaff } from "@/lib/auth";
import { getClinic, listHandoffs } from "@/lib/data";

export const metadata: Metadata = { title: "Handoffs" };

export default async function HandoffsPage({ searchParams }: PageProps<"/handoffs">) {
  await requireStaff();
  const params = await searchParams;
  const closed = params.show === "closed";
  const [clinic, open, done] = await Promise.all([getClinic(), listHandoffs(false), listHandoffs(true, closed ? 100 : 1)]);

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <h1>Handoffs</h1>
          <p>Patients the WhatsApp assistant passed to a person. Contact them, then close the handoff with what you did.</p>
        </div>
      </div>
      <section className="panel">
        <div className="toolbar">
          <div className="tabs" role="group" aria-label="Show">
            <Link className={`tab${closed ? "" : " active"}`} aria-current={closed ? undefined : "page"} href="/handoffs">
              Open <span>{open.length}</span>
            </Link>
            <Link className={`tab${closed ? " active" : ""}`} aria-current={closed ? "page" : undefined} href="/handoffs?show=closed">
              Closed
            </Link>
          </div>
        </div>
        <HandoffList rows={closed ? done : open} tz={clinic.timezone} closed={closed} />
      </section>
    </div>
  );
}
