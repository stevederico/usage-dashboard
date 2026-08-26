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
  const hours = Math.round(delta / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.round(delta / 60_000))}m`;
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
