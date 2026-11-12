import { describe, expect, it } from 'vitest';
import { atan, atan2, cos, hypot3, sin } from '../dmath';

function ulps(a: number, b: number): number {
  if (a === b) return 0;
  const view = new DataView(new ArrayBuffer(16));
  view.setFloat64(0, a);
  view.setFloat64(8, b);
  return Number(BigInt.asIntN(64, view.getBigInt64(0) - view.getBigInt64(8)));
}

describe('dmath (realm-independent trigonometry)', () => {
  it('stays within one ulp of the host Math on a dense sweep', () => {
    let worst = 0;
    for (let i = -20000; i <= 20000; i++) {
      const x = i * 0.000731 * Math.PI;
      worst = Math.max(worst, Math.abs(ulps(sin(x), Math.sin(x))));
      worst = Math.max(worst, Math.abs(ulps(cos(x), Math.cos(x))));
      worst = Math.max(worst, Math.abs(ulps(atan(x), Math.atan(x))));
      worst = Math.max(
        worst,
        Math.abs(ulps(atan2(x, 1.3 - i * 1e-4), Math.atan2(x, 1.3 - i * 1e-4))),
      );
    }
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('keeps exact values and special cases', () => {
    expect(sin(0)).toBe(0);
    expect(Object.is(sin(-0), -0)).toBe(true);
    expect(cos(0)).toBe(1);
    expect(sin(Math.PI / 2)).toBe(1);
    expect(Number.isNaN(sin(Number.POSITIVE_INFINITY))).toBe(true);
    expect(atan2(0, 1)).toBe(0);
    expect(atan2(0, -1)).toBe(Math.PI);
    expect(atan2(-0, -1)).toBe(-Math.PI);
    expect(atan2(1, 0)).toBe(Math.PI / 2);
    expect(atan2(-1, 0)).toBe(-Math.PI / 2);
    expect(atan2(1, 1)).toBe(Math.PI / 4);
    expect(atan2(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)).toBe((3 * Math.PI) / 4);
    expect(atan(Number.POSITIVE_INFINITY)).toBe(Math.PI / 2);
    expect(hypot3(3, 4, 12)).toBe(13);
  });

  it('reduces large arguments deterministically', () => {
    expect(Math.abs(sin(1e7) - Math.sin(1e7))).toBeLessThan(1e-9);
    expect(Math.abs(cos(123456.789) - Math.cos(123456.789))).toBeLessThan(1e-15);
  });
});
