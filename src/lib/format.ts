/**
 * Remaining time until a reset timestamp.
 *
 * @param resetsAt - ISO timestamp or unix-ms string
 * @param now - Reference time
 * @returns Short remaining time, or null
 */
export function formatReset(resetsAt: string | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const ms = /^\d+$/.test(resetsAt) ? Number(resetsAt) : Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return null;
  const delta = ms - now;
  if (delta <= 0) return 'now';
  const minutes = Math.max(1, Math.round(delta / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  if (days > 0 && hours > 0) return `${days}d ${hours}h`;
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

/** Plan fields needed for the simple-row value. */
export type PlanValueSource = {
  usedPercent: number | null;
  headline?: string | null;
};

/**
 * One-line value for a plan: percent, cost headline, or an em dash.
 *
 * @param plan - Plan snapshot
 * @returns Display value
 */
export function formatPlanValue(plan: PlanValueSource): string {
  if (plan.usedPercent !== null) return `${Math.round(plan.usedPercent)}%`;
  if (plan.headline) return plan.headline;
  return '-';
}
