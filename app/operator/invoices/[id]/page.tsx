import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getOperator } from "@/lib/auth";
import { db } from "@/lib/supabase/admin";
import { PrintButton } from "./print-button";

export const metadata: Metadata = { title: "Invoice" };

function money(n: number, currency: string) {
  return `${currency} ${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function longDate(iso: string) {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

// A paid invoice (receipt) for one recorded payment, ready to print or save as PDF.
export default async function InvoicePage(props: PageProps<"/operator/invoices/[id]">) {
  if (!(await getOperator())) notFound();
  const { id } = await props.params;
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) notFound();
  const { data: pay } = await db().from("payments").select("*").eq("id", pid).maybeSingle();
  if (!pay) notFound();
  const { data: clinic } = pay.clinic_id
    ? await db().from("clinics").select("name, contact_phone, alert_email, plan").eq("id", pay.clinic_id).maybeSingle()
    : { data: null };
  const fromName = process.env.INVOICE_FROM_NAME || "Hospital AI";
  const fromLines = (process.env.INVOICE_FROM_DETAILS || "").split("|").map((l) => l.trim()).filter(Boolean);
  const number = `INV-${String(pay.recorded_at).slice(0, 4)}-${String(pay.id).padStart(5, "0")}`;

  return (
    <div className="page-stack invoice">
      <div className="no-print button-row">
        <PrintButton />
      </div>
      <section className="panel">
        <div className="panel-body invoice-body">
          <div className="invoice-head">
            <div>
              <h1>Invoice</h1>
              <p className="soft">{number}</p>
            </div>
            <div className="invoice-from">
              <strong>{fromName}</strong>
              {fromLines.map((l) => (
                <span key={l}>{l}</span>
              ))}
            </div>
          </div>
          <div className="invoice-meta">
            <div>
              <span className="field-label">Billed to</span>
              <strong>{clinic?.name ?? pay.clinic_name}</strong>
              {clinic?.alert_email ? <span>{clinic.alert_email}</span> : null}
              {clinic?.contact_phone ? <span>{clinic.contact_phone}</span> : null}
            </div>
            <div>
              <span className="field-label">Date</span>
              <strong>{longDate(pay.recorded_at)}</strong>
              <span className="pill completed">Paid</span>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Description</th>
                <th>Period</th>
                <th style={{ textAlign: "right" }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Hospital AI subscription{clinic?.plan ? `, ${clinic.plan[0].toUpperCase()}${clinic.plan.slice(1)} plan` : ""}{pay.note ? ` (${pay.note})` : ""}</td>
                <td className="nowrap">{longDate(pay.period_from)} to {longDate(pay.period_to)}</td>
                <td style={{ textAlign: "right" }}>{money(pay.amount, pay.currency)}</td>
              </tr>
              <tr>
                <td colSpan={2}><strong>Total paid</strong></td>
                <td style={{ textAlign: "right" }}><strong>{money(pay.amount, pay.currency)}</strong></td>
              </tr>
            </tbody>
          </table>
          <p className="soft small">
            Paid by {pay.method || "bank transfer"}{pay.reference ? `, reference ${pay.reference}` : ""}. Prices exclude WhatsApp and SMS fees billed by Meta or the SMS provider.
          </p>
        </div>
      </section>
    </div>
  );
}
