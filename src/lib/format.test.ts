import { describe, it, expect } from 'vitest';
import { formatPlanValue, formatReset } from './format';

describe('formatReset', () => {
  it('formats a day as hours when under 48h', () => {
    const now = Date.parse('2026-08-26T12:00:00Z');
    expect(formatReset('2026-08-27T12:00:00Z', now)).toBe('24h');
  });

  it('returns now when the timestamp is past', () => {
    const now = Date.parse('2026-08-26T12:00:00Z');
    expect(formatReset('2026-08-26T11:00:00Z', now)).toBe('now');
  });
});

describe('formatPlanValue', () => {
  it('prefers percent', () => {
    expect(formatPlanValue({ usedPercent: 86, headline: '$0.63' })).toBe('86%');
  });

  it('falls back to headline then dash', () => {
    expect(formatPlanValue({ usedPercent: null, headline: '$0.63' })).toBe('$0.63');
    expect(formatPlanValue({ usedPercent: null })).toBe('-');
  });
});
