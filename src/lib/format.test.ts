import { describe, it, expect } from 'vitest';
import { formatPlanValue, formatReset, weekdayLabel } from './format';

describe('formatReset', () => {
  it('formats a full day as 1d', () => {
    const now = Date.parse('2026-08-26T12:00:00Z');
    expect(formatReset('2026-08-27T12:00:00Z', now)).toBe('1d');
  });

  it('formats days and leftover hours', () => {
    const now = Date.parse('2026-08-26T12:00:00Z');
    expect(formatReset('2026-08-28T17:00:00Z', now)).toBe('2d 5h');
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

describe('weekdayLabel', () => {
  it('labels today as Today', () => {
    const now = new Date(2026, 7, 26, 15).getTime();
    expect(weekdayLabel('2026-08-26', now)).toBe('Today');
  });
});
