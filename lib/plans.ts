// Monthly limits per plan (see the pricing documents). A clinic can carry its own
// limits instead (owner console → clinic details); "custom" plans have none by default.
export const PLAN_LIMITS: Record<string, { appointments: number | null; messages: number | null }> = {
  starter: { appointments: 300, messages: 2000 },
  growth: { appointments: 1000, messages: 6000 },
  pro: { appointments: 2500, messages: 15000 },
  custom: { appointments: null, messages: null },
};

export function limitsFor(plan: string, own: { limit_appointments: number | null; limit_messages: number | null }) {
  const base = PLAN_LIMITS[plan] ?? { appointments: null, messages: null };
  return { appointments: own.limit_appointments ?? base.appointments, messages: own.limit_messages ?? base.messages };
}

/** "ok" under 80% of the limit, "near" from 80%, "over" above 100%. */
export function usageLevel(used: number, limit: number | null): "ok" | "near" | "over" {
  if (!limit) return "ok";
  if (used > limit) return "over";
  return used >= limit * 0.8 ? "near" : "ok";
}
