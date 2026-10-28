"use client";

import { AlertCircle, CheckCircle2, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { AppointmentStatus } from "@/types/db";

export function PageHeading({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="page-actions">{action}</div> : null}
    </div>
  );
}

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  confirmed: "Booked",
  completed: "Seen",
  no_show: "Missed",
  cancelled: "Cancelled",
};

export function StatusPill({ status }: { status: AppointmentStatus }) {
  return <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>;
}

export function sourceLabel(source: string): string {
  return source === "staff" ? "Front desk" : source === "whatsapp" ? "WhatsApp" : source.replace(/^./, (c) => c.toUpperCase());
}

export function Stars({ rating }: { rating: number }) {
  return (
    <span className="stars" aria-label={`${rating} out of 5`}>
      {"★★★★★".slice(0, rating)}
      <span className="off">{"★★★★★".slice(rating)}</span>
    </span>
  );
}

export function Flash({ result }: { result: { ok: boolean; text: string } | null }) {
  if (!result) return null;
  return (
    <div className={result.ok ? "success-state" : "error-state"} role={result.ok ? "status" : "alert"}>
      {result.ok ? <CheckCircle2 size={17} aria-hidden="true" /> : <AlertCircle size={17} aria-hidden="true" />}
      <span>{result.text}</span>
    </div>
  );
}

export function Spinner() {
  return <LoaderCircle className="animate-spin" size={16} aria-hidden="true" />;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {children ? <span>{children}</span> : null}
    </div>
  );
}

/** Modal used for both centred dialogs and the right-hand drawer. Escape and the backdrop close it. */
export function Modal({
  title,
  description,
  onClose,
  children,
  drawer = false,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusable = node?.querySelector<HTMLElement>("input, select, textarea, button:not(.modal-close)") ?? node?.querySelector<HTMLElement>("button");
    focusable?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeRef.current();
      if (event.key === "Tab" && node) {
        const items = [...node.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input, select, textarea")];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);

  return (
    <div
      className={`dialog-backdrop${drawer ? " drawer-backdrop" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={ref} className={`dialog${drawer ? " drawer" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="dialog-head">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button className="icon-button modal-close" type="button" onClick={onClose} aria-label="Close">
            <X size={17} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
