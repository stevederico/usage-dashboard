import { afterEach, describe, expect, it } from 'vitest';
import { readRefreshMs, writeRefreshMs, REFRESH_KEY } from './settings';

describe('refresh settings', () => {
  afterEach(() => {
    localStorage.removeItem(REFRESH_KEY);
  });

  it('defaults to 1 hour', () => {
    expect(readRefreshMs()).toBe(3_600_000);
  });

  it('round-trips a valid interval', () => {
    writeRefreshMs(900_000);
    expect(readRefreshMs()).toBe(900_000);
  });

  it('rejects 30 second and 1 minute leftovers', () => {
    localStorage.setItem(REFRESH_KEY, '30000');
    expect(readRefreshMs()).toBe(3_600_000);
    localStorage.setItem(REFRESH_KEY, '60000');
    expect(readRefreshMs()).toBe(3_600_000);
  });
});
