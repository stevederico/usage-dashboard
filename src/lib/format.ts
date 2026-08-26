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

/**
 * Compact token count (1.2K, 4.4M).
 *
 * @param value - Token count
 * @returns Short label
 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

/**
 * Weekday label for a YYYY-MM-DD date. Today is Today.
 *
 * @param date - Calendar date
 * @param now - Reference time
 * @returns Short label
 */
export function weekdayLabel(date: string, now = Date.now()): string {
  const today = new Date(now);
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  const todayKey = `${today.getFullYear()}-${m}-${d}`;
  if (date === todayKey) return 'Today';
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][parsed.getDay()] ?? date;
}
