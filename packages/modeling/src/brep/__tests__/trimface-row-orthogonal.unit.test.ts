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

function circle(cx: number, cy: number, r: number, n: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/**
 * Share of row quads whose two radial sides both lie within 10 degrees of perpendicular to the loop
 * tangent at their boundary vertex. The tangent is the bisector of the two adjacent loop edges (the
 * vertex normal), so a polygonal sample is not penalised by its own chord angle.
 */
function rowOrthogonality(outer: P2[], inner: P2[]): number {
  const n = outer.length;
  const TOL = Math.sin((10 * Math.PI) / 180);
  const unit = (v: P2): P2 => {
    const l = Math.hypot(v[0], v[1]);
    return [v[0] / l, v[1] / l];
  };
  const dir = (a: P2, b: P2): P2 => [b[0] - a[0], b[1] - a[1]];
  let good = 0;
  let count = 0;
  for (let k = 0; k < n; k++) {
    const a = outer[k] as P2;
    const b = outer[(k + 1) % n] as P2;
    const c = inner[(k + 1) % n] as P2;
    const d = inner[k] as P2;
    const pa = outer[(k + n - 1) % n] as P2;
    const pb = outer[(k + 2) % n] as P2;
    // Quad sides at a and b, each measured against its own vertex tangent.
    const tanA = unit([dir(pa, a)[0] / 1 + dir(a, b)[0], dir(pa, a)[1] + dir(a, b)[1]] as P2);
    const tanB = unit([dir(a, b)[0] + dir(b, pb)[0], dir(a, b)[1] + dir(b, pb)[1]] as P2);
    const sideA = dir(a, d);
    const sideB = dir(b, c);
    const cosA = Math.abs(tanA[0] * sideA[0] + tanA[1] * sideA[1]) / Math.hypot(sideA[0], sideA[1]);
    const cosB = Math.abs(tanB[0] * sideB[0] + tanB[1] * sideB[1]) / Math.hypot(sideB[0], sideB[1]);
    count++;
    if (cosA <= TOL && cosB <= TOL) good++;
  }
  return good / count;
}

describe('boundary-row orthogonality (planar trims)', () => {
  it('square with a centred circular hole: row quads are orthogonal within 10 degrees', () => {
    const outer = square(0, 0, 5, 4);
    const hole = circle(2.5, 2.5, 0.8, 12);
    const result = rowFrontInner([ring(outer), ring(hole)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(rowOrthogonality(hole, result.inner[1] as P2[])).toBeGreaterThanOrEqual(0.9);
  });

  it('square plate with a 3x4 grid of holes: row quads are orthogonal within 10 degrees', () => {
    const outer = square(0, 0, 5, 4);
    const rings = [ring(outer)];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 4; j++) rings.push(ring(circle(1 + i, 1 + j, 0.3, 16)));
    const result = rowFrontInner(rings);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const share = rings
      .slice(1)
      .map((_, h) => rowOrthogonality(rings[h + 1]?.uv as P2[], result.inner[h + 1] as P2[]));
    expect(Math.min(...share)).toBeGreaterThanOrEqual(0.9);
  });
});
