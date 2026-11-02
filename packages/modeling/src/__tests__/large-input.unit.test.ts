import { describe, expect, it } from 'vitest';
import { maxOf, minOf, pushAll, replaceAll } from '../arrays';
import { model } from '../model';
import { sel } from '../selectors';

describe('large inputs never ride on call arguments', () => {
  it('extreme() selects on a 200k-face mesh', () => {
    const m = model();
    m.plane({ width: 1, height: 1, widthSegments: 450, heightSegments: 450 });
    expect(m.editMesh.faceCount).toBeGreaterThan(200_000);
    const count = m.count(sel.extreme('+x'));
    expect(count).toBe(450);
    expect(m.poisoned).toBeUndefined();
  });

  it('a 200k-face session clones, snapshots and restores without a RangeError', () => {
    const m = model();
    m.plane({ width: 1, height: 1, widthSegments: 450, heightSegments: 450 });
    const bytes = m.snapshot();
    const attempt = m.try((inner) => {
      inner.tag(sel.all(), 'x');
    });
    expect(attempt.ok).toBe(true);
    expect(m.snapshot().byteLength).toBeGreaterThanOrEqual(bytes.byteLength);
  });

  it('array helpers agree with the spread forms', () => {
    const small = [3, -0, 0, 2, Number.NaN, 1];
    expect(Object.is(maxOf([0, -0]), Math.max(0, -0))).toBe(true);
    expect(Object.is(minOf([0, -0]), Math.min(0, -0))).toBe(true);
    expect(maxOf(small)).toBe(Math.max(...small));
    expect(maxOf([])).toBe(Math.max(...[]));
    expect(minOf([])).toBe(Math.min(...[]));
    const big = Array.from({ length: 500_000 }, (_, i) => i);
    expect(maxOf(big)).toBe(499_999);
    expect(minOf(big)).toBe(0);
    const out: number[] = [];
    pushAll(out, big);
    expect(out).toHaveLength(500_000);
    replaceAll(out, [1, 2]);
    expect(out).toEqual([1, 2]);
  });
});
