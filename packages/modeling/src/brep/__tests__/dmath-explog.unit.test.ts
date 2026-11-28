import { describe, expect, it } from 'vitest';
import { exp, log, tan } from '../dmath-explog';

function ulps(a: number, b: number): number {
  const view = new DataView(new ArrayBuffer(16));
  view.setFloat64(0, a);
  view.setFloat64(8, b);
  return Math.abs(Number(view.getBigInt64(0) - view.getBigInt64(8)));
}

describe('dmath-explog: deterministic log, exp and tan', () => {
  it('log and exp agree with Math to two ulps over a wide range (measured worst: 2)', () => {
    let worstLog = 0;
    let worstExp = 0;
    for (let i = 1; i <= 4000; i++) {
      const x = i / 40; // 0.025 .. 100
      worstLog = Math.max(worstLog, ulps(log(x), Math.log(x)));
      const y = (i - 2000) / 50; // -40 .. 40
      worstExp = Math.max(worstExp, ulps(exp(y), Math.exp(y)));
    }
    for (const x of [1e-300, 1e-12, 0.5, 1, 2, Math.E, 1e12, 1e300]) {
      expect(ulps(log(x), Math.log(x))).toBeLessThanOrEqual(2);
    }
    for (const y of [-700, -1e-9, 1e-9, 0.34, 1, 10, 700]) {
      expect(ulps(exp(y), Math.exp(y))).toBeLessThanOrEqual(2);
    }
    expect(worstLog).toBeLessThanOrEqual(2);
    expect(worstExp).toBeLessThanOrEqual(2);
  });

  it('keeps the special values and inverts each other', () => {
    expect(log(1)).toBe(0);
    expect(log(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(log(-1))).toBe(true);
    expect(log(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(exp(0)).toBe(1);
    expect(exp(710)).toBe(Number.POSITIVE_INFINITY);
    expect(exp(-800)).toBe(0);
    expect(Number.isNaN(exp(Number.NaN))).toBe(true);
    for (const x of [0.01, 0.7, 3, 250]) expect(ulps(exp(log(x)), x)).toBeLessThanOrEqual(4);
  });

  it('tan is sin over cos and agrees with Math.tan away from the poles', () => {
    for (const x of [-1.2, -0.3, 0, 0.4, 0.785398163397448, 1.3]) {
      expect(ulps(tan(x), Math.tan(x))).toBeLessThanOrEqual(8);
    }
  });

  it('pins exact bits so a realm that differs is caught', () => {
    expect(log(10)).toBe(2.302585092994046);
    expect(exp(1)).toBe(2.7182818284590455);
    expect(log(0.3)).toBe(-1.2039728043259361);
    expect(exp(-2.5)).toBe(0.0820849986238988);
  });
});
