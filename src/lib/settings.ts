export const REFRESH_KEY = 'quota-refresh-ms';
export const SETTINGS_EVENT = 'quota-settings';

/** Refresh interval choices. */
export const REFRESH_OPTIONS = [
  { value: 0, label: 'Manual' },
  { value: 300_000, label: '5 Minutes' },
  { value: 900_000, label: '15 Minutes' },
  { value: 3_600_000, label: '1 Hour' },
] as const;

const DEFAULT_MS = 3_600_000;

/**
 * Read the usage refresh interval from localStorage.
 *
 * @returns Interval in milliseconds, or 0 for manual
 */
export function readRefreshMs(): number {
  try {
    const raw = localStorage.getItem(REFRESH_KEY);
    if (raw === null) return DEFAULT_MS;
    const n = Number(raw);
    if (REFRESH_OPTIONS.some((o) => o.value === n)) return n;
    return DEFAULT_MS;
  } catch {
    return DEFAULT_MS;
  }
}

/**
 * Persist the usage refresh interval.
 *
 * @param ms - Interval in milliseconds, or 0 for manual
 */
export function writeRefreshMs(ms: number): void {
  try {
    localStorage.setItem(REFRESH_KEY, String(ms));
    window.dispatchEvent(new Event(SETTINGS_EVENT));
  } catch {
    // Ignore quota / private-mode failures.
  }
}
