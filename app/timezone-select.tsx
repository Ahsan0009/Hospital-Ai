"use client";

import type { ZoneOption } from "@/lib/timezones";

/** A time-zone picker: common zones first, then every zone by UTC offset. The list is built on the server. */
export function TimeZoneSelect({
  id,
  value,
  onChange,
  zones,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (zone: string) => void;
  zones: { common: ZoneOption[]; all: ZoneOption[] };
  disabled?: boolean;
}) {
  const known = zones.all.some((z) => z.value === value);
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} required>
      {!known ? <option value={value}>{value}</option> : null}
      <optgroup label="Common">
        {zones.common.map((z) => (
          <option key={`c-${z.value}`} value={z.value}>
            {z.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="All time zones">
        {zones.all.map((z) => (
          <option key={z.value} value={z.value}>
            {z.label}
          </option>
        ))}
      </optgroup>
    </select>
  );
}
