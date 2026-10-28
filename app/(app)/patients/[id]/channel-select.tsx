"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { setPatientChannel } from "@/app/actions";
import { Flash } from "@/app/(app)/ui";

/** Which channel automatic messages use for this patient. Only shown when the clinic has SMS. */
export function ChannelSelect({ patientId, channel, optedOut }: { patientId: number; channel: "whatsapp" | "sms"; optedOut: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(channel);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="channel-select">
      <label className="field inline">
        <span>Messages by</span>
        <select
          value={value}
          onChange={async (e) => {
            const next = e.target.value as "whatsapp" | "sms";
            setValue(next);
            const r = await setPatientChannel(patientId, next);
            setResult(r.ok ? { ok: true, text: r.message ?? "Saved." } : { ok: false, text: r.error });
            if (r.ok) router.refresh();
            else setValue(channel);
          }}
        >
          <option value="whatsapp">WhatsApp</option>
          <option value="sms">SMS</option>
        </select>
      </label>
      {optedOut ? <span className="pill no_show">Opted out of SMS</span> : null}
      <Flash result={result} />
    </div>
  );
}
