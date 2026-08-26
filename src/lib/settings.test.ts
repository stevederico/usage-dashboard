import { afterEach, describe, expect, it } from 'vitest';
import { readRefreshMs, writeRefreshMs, REFRESH_KEY } from './settings';

describe('refresh settings', () => {
  afterEach(() => {
    localStorage.removeItem(REFRESH_KEY);
  });

  it('defaults to 5 minutes', () => {
    expect(readRefreshMs()).toBe(300_000);
  });

  it('round-trips a valid interval', () => {
    writeRefreshMs(60_000);
    expect(readRefreshMs()).toBe(60_000);
  });
});
