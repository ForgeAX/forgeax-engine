import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BACKEND_STARTUP_TIMEOUT_MS,
  resolveBackendStartupTimeoutMs,
  waitForBackendStartup,
} from '../backend-process.js';

afterEach(() => vi.useRealTimers());

describe('DevKit backend startup deadline', () => {
  it('uses a configurable default and accepts explicit finite or unbounded policies', () => {
    expect(DEFAULT_BACKEND_STARTUP_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(resolveBackendStartupTimeoutMs(undefined)).toBe(DEFAULT_BACKEND_STARTUP_TIMEOUT_MS);
    expect(resolveBackendStartupTimeoutMs(90_000)).toBe(90_000);
    expect(resolveBackendStartupTimeoutMs(null)).toBeNull();
    expect(() => resolveBackendStartupTimeoutMs(0)).toThrow(/positive timer-safe integer or null/);
  });

  it('continues past the former 60-second cutoff for finite and disabled deadlines', async () => {
    vi.useFakeTimers();

    for (const timeoutMs of [
      resolveBackendStartupTimeoutMs(undefined),
      resolveBackendStartupTimeoutMs(90_000),
      resolveBackendStartupTimeoutMs(null),
    ]) {
      let ready = false;
      const waiting = waitForBackendStartup(
        timeoutMs,
        () => ready,
        () => {},
        () => new Error('startup timed out'),
      );

      await vi.advanceTimersByTimeAsync(60_050);
      ready = true;
      await vi.advanceTimersByTimeAsync(50);
      await expect(waiting).resolves.toBeUndefined();
    }
  });

  it('still ends a finite wait when its configured deadline expires', async () => {
    vi.useFakeTimers();
    const waiting = waitForBackendStartup(
      25,
      () => false,
      () => {},
      () => new Error('startup timed out'),
    );
    const rejection = expect(waiting).rejects.toThrow('startup timed out');

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });
});
