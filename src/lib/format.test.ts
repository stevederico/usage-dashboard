import { describe, it, expect } from 'vitest';
import { formatReset } from './format';

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
