import { describe, expect, it } from 'vitest';
import { acos } from '../dmath-acos';

const view = new DataView(new ArrayBuffer(8));
function ordered(x: number): bigint {
  view.setFloat64(0, x);
  const b = view.getBigInt64(0);
  return b < 0n ? -(b & 0x7fffffffffffffffn) : b;
}
function ulps(a: number, b: number): number {
  const d = ordered(a) - ordered(b);
  return Number(d < 0n ? -d : d);
}

describe('dmath acos', () => {
  it('stays within 4 ulps of the host over [-1, 1], including both ends of the steep region', () => {
    let worst = 0;
    const xs: number[] = [-1, 1, 0, 0.5, -0.5, 1 - 2 ** -52, -1 + 2 ** -52, 1e-300];
    for (let k = 0; k <= 20000; k++) xs.push(-1 + (2 * k) / 20000);
    for (let k = 1; k <= 200; k++) xs.push(1 - k * 1e-9, -1 + k * 1e-9);
    for (const x of xs) worst = Math.max(worst, ulps(acos(x), Math.acos(x)));
    expect(worst).toBeLessThanOrEqual(4);
  });

  it('maps out-of-range and NaN to NaN, and pins exact ends', () => {
    expect(acos(1)).toBe(0);
    expect(acos(-1)).toBe(Math.PI);
    expect(acos(1.0000001)).toBeNaN();
    expect(acos(-2)).toBeNaN();
    expect(acos(Number.NaN)).toBeNaN();
  });

  it('pins bits so the port cannot drift', () => {
    expect(acos(0.3)).toBe(1.266103672779499);
    expect(acos(-0.75)).toBe(2.4188584057763776);
  });
});
