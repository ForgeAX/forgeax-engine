import { describe, expect, it } from 'vitest';
import { rowFrontInner } from '../quad-row';
import type { TrimRing } from '../tessellate-trimmed';
import type { P2 } from '../vec';

function ring(points: P2[]): TrimRing {
  return { uv: points, ids: points.map((_, i) => i) };
}

function square(x0: number, y0: number, size: number, n: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < n; i++) out.push([x0 + (size * i) / n, y0]);
  for (let i = 0; i < n; i++) out.push([x0 + size, y0 + (size * i) / n]);
  for (let i = 0; i < n; i++) out.push([x0 + size - (size * i) / n, y0 + size]);
  for (let i = 0; i < n; i++) out.push([x0, y0 + size - (size * i) / n]);
  return out;
}

describe('boundary-row front (planar trims)', () => {
  it('places a row on every loop of a square with a centred hole', () => {
    const result = rowFrontInner([ring(square(0, 0, 1, 4)), ring(square(0.4, 0.4, 0.2, 4))]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped).toEqual([false, false]);
    expect(result.inner[0]).toHaveLength(16);
    expect(result.inner[1]).toHaveLength(16);
  });

  it('skips a loop whose web to the outer boundary is narrower than two rows', () => {
    const result = rowFrontInner([ring(square(0, 0, 1, 4)), ring(square(0.02, 0.4, 0.2, 4))]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped[1]).toBe(true);
    expect(result.inner[1]).toEqual(square(0.02, 0.4, 0.2, 4));
  });

  it('fails closed when a loop has a zero-length edge', () => {
    const result = rowFrontInner([
      ring([
        [0, 0],
        [0, 0],
        [1, 0],
        [1, 1],
      ]),
    ]);
    expect(result.ok).toBe(false);
  });
});
