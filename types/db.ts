export type AppointmentStatus = "confirmed" | "completed" | "no_show" | "cancelled";

export type Doctor = {
  id: number;
  name: string;
  department: string;
  consultation_fee: number | null;
  working_days: number[];
  start_time: string;
  end_time: string;
  slot_minutes: number;
  active: boolean;
  notes: string | null;
};

export type PatientRef = { id: number; name: string | null; phone: string };
export type DoctorRef = { id: number; name: string; department: string; slot_minutes: number };

export type Appointment = {
  id: number;
  slot_time: string;
  status: AppointmentStatus;
  source: string;
  notes: string | null;
  rescheduled: boolean;
  reminder_24h_sent: boolean;
  reminder_2h_sent: boolean;
  feedback_sent: boolean;
  created_at: string;
  patient: PatientRef | null;
  doctor: DoctorRef | null;
};

export type Patient = {
  id: number;
  phone: string;
  name: string | null;
  last_message_at: string | null;
  created_at: string;
};

export type Handoff = {
  id: number;
  patient_phone: string | null;
  patient_id: number | null;
  reason: string;
  urgency: "normal" | "urgent";
  resolved: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
  staff_note: string | null;
  created_at: string;
  patient: { id: number; name: string | null } | null;
};

export type Report = {
  id: number;
  report_type: string;
  report_link: string | null;
  summary: string | null;
  is_critical: boolean;
  created_at: string;
  patient: PatientRef | null;
};

export type Feedback = {
  id: number;
  rating: number | null;
  patient_phone: string;
  requested_at: string;
  responded_at: string | null;
  appointment: { id: number; slot_time: string; doctor: { name: string } | null; patient: { id: number; name: string | null } | null } | null;
};

export type ErrorLog = { id: number; source: string | null; patient_phone: string | null; error_detail: string | null; created_at: string };
export type Activity = { id: number; staff_email: string; action: string; detail: string | null; created_at: string };

export type Clinic = { name: string; timezone: string };

export type ActionResult<T = undefined> = { ok: true; message?: string; data?: T } | { ok: false; error: string };
