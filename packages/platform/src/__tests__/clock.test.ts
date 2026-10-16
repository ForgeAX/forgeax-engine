import { describe, expect, it } from 'vitest';
import { createPlatformClock } from '../clock.js';

describe('host clock units and failure boundaries', () => {
  it('converts native microseconds to the same milliseconds consumed by App', () => {
    let native = 1_234_500;
    const clock = createPlatformClock(() => native, 'microseconds');
    expect(clock.now().unwrap()).toBe(1234.5);
    native += 16_000;
    expect(clock.now().unwrap()).toBe(1250.5);
  });

  it('allows equal samples, rejects backward time and retains the last valid baseline', () => {
    let time = 100;
    const clock = createPlatformClock(() => time, 'milliseconds');
    expect(clock.now().unwrap()).toBe(100);
    expect(clock.now().unwrap()).toBe(100);
    time = 99;
    expect(clock.now()).toMatchObject({
      ok: false,
      error: {
        code: 'platform-clock-invalid',
        detail: { previous: 100, current: 99 },
      },
    });
    time = 101;
    expect(clock.now().unwrap()).toBe(101);
  });

  it.each([NaN, Infinity, -Infinity, -1])('rejects invalid native time %s', (value) => {
    const result = createPlatformClock(() => value, 'milliseconds').now();
    expect(result).toMatchObject({ ok: false, error: { code: 'platform-clock-invalid' } });
  });

  it('preserves the native failure and allows a subsequent successful sample', () => {
    const cause = new Error('native clock temporarily unavailable');
    let failed = true;
    const clock = createPlatformClock(() => {
      if (failed) throw cause;
      return 7;
    }, 'milliseconds');
    expect(clock.now()).toMatchObject({
      ok: false,
      error: {
        code: 'platform-operation-failed',
        detail: { operation: 'clock.now', cause },
      },
    });
    failed = false;
    expect(clock.now().unwrap()).toBe(7);
  });
});
