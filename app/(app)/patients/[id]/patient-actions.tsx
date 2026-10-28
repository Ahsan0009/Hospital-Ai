"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { BookDialog } from "@/app/(app)/book-dialog";
import { whatsappLink } from "@/lib/phone";
import type { Doctor, Patient } from "@/types/db";

export function PatientActions({ patient, doctors, todayKey }: { patient: Patient; doctors: Doctor[]; todayKey: string }) {
  const [booking, setBooking] = useState(false);
  return (
    <>
      <a className="button-secondary" href={whatsappLink(patient.phone)} target="_blank" rel="noreferrer">
        Open in WhatsApp
      </a>
      <button className="button-primary" type="button" onClick={() => setBooking(true)}>
        <Plus size={16} aria-hidden="true" />
        Book appointment
      </button>
      {booking ? <BookDialog doctors={doctors} todayKey={todayKey} initial={{ phone: patient.phone, name: patient.name ?? "" }} onClose={() => setBooking(false)} /> : null}
    </>
  );
}
