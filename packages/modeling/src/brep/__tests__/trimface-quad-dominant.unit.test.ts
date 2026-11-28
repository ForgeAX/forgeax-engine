import { describe, expect, it } from 'vitest';
import { quadrangulateTrimmed } from '../quad-trimmed';
import { makeFrame } from '../surfaces';
import type { TrimRing } from '../tessellate-trimmed';
import type { Surface } from '../types';
import type { P2, P3 } from '../vec';

const plane: Surface = { kind: 'plane', frame: makeFrame([0, 0, 0], [0, 0, 1]) };
/** Corner sine floor of a quad admitted in dominant mode; quads must stay above it. */
const QUAD_FLOOR = 1e-6;

function circle(r: number, n: number, ccw: boolean): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((ccw ? i : n - i) / n) * 2 * Math.PI;
    out.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return out;
}

/** Outer circle radius 1 (CCW, ids 0..15) and hole radius 0.3 (CW, ids 100..107). */
function annulus(): { rings: TrimRing[]; positions: Map<number, P3> } {
  const outer = circle(1, 16, true);
  const hole = circle(0.3, 8, false);
  const positions = new Map<number, P3>();
  for (const [i, p] of outer.entries()) positions.set(i, [p[0], p[1], 0]);
  for (const [i, p] of hole.entries()) positions.set(100 + i, [p[0], p[1], 0]);
  return {
    rings: [
      { uv: outer, ids: outer.map((_, i) => i) },
      { uv: hole, ids: hole.map((_, i) => 100 + i) },
    ],
    positions,
  };
}

function sj(p: readonly P3[]): number {
  const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: P3, b: P3): P3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a: P3) => Math.sqrt(dot(a, a));
  const n0 = cross(sub(p[2] as P3, p[0] as P3), sub(p[3] as P3, p[1] as P3));
  const ln = len(n0);
  if (ln === 0) return 0;
  const normal: P3 = [n0[0] / ln, n0[1] / ln, n0[2] / ln];
  let min = Infinity;
  for (let i = 0; i < 4; i++) {
    const here = p[i] as P3;
    const d1 = sub(p[(i + 1) % 4] as P3, here);
    const d2 = sub(p[(i + 3) % 4] as P3, here);
    const l1 = len(d1);
    const l2 = len(d2);
    if (l1 === 0 || l2 === 0) return 0;
    min = Math.min(min, dot(cross(d1, d2), normal) / (l1 * l2));
  }
  return min;
}

describe('quad-dominant trimmed quadrangulation', () => {
  it('keeps every quad above the floor, covers every triangle, and stays conforming at the rings', () => {
    const { rings, positions } = annulus();
    let next = 1000;
    const added = new Map<number, P3>(positions);
    const r = quadrangulateTrimmed(
      plane,
      rings,
      (id) => added.get(id) as P3,
      (p) => {
        const id = next++;
        added.set(id, p);
        return id;
      },
      { angle: Math.PI / 6, maxPoints: 4096, maxTriangles: 1500, dominant: true },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { quads, singles, triangles } = r.value;
    // Coverage: every triangle is either paired into a quad or emitted as a single.
    expect(quads.length * 2 + singles.length).toBe(triangles);
    expect(singles.length).toBeGreaterThan(0);

    // Quads are admitted only above the flatness floor (no folds, no flat corners).
    let minQuad = Infinity;
    for (const q of quads) minQuad = Math.min(minQuad, sj(q.map((v) => added.get(v) as P3)));
    expect(minQuad).toBeGreaterThan(QUAD_FLOOR);

    // Shared boundary: edges used once are exactly the ring segments, so the face stays watertight
    // against its neighbours and no triangle or quad opens a seam.
    const uses = new Map<string, number>();
    const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
    for (const f of [...quads, ...singles]) {
      for (let k = 0; k < f.length; k++) {
        const kk = key(f[k] as number, f[(k + 1) % f.length] as number);
        uses.set(kk, (uses.get(kk) ?? 0) + 1);
      }
    }
    const open = new Set<string>();
    for (const [k, n] of uses) if (n === 1) open.add(k);
    const ring = new Set<string>();
    for (const rg of rings) {
      for (const [i, id] of rg.ids.entries()) {
        ring.add(key(id, rg.ids[(i + 1) % rg.ids.length] as number));
      }
    }
    expect([...open].sort()).toEqual([...ring].sort());
    for (const n of uses.values()) expect(n).toBeLessThanOrEqual(2);
  });

  it('default strict mode is untouched: no singles are emitted', () => {
    const { rings, positions } = annulus();
    const r = quadrangulateTrimmed(
      plane,
      rings,
      (id) => positions.get(id) as P3,
      () => 9999,
      { angle: Math.PI / 6, maxPoints: 4096, maxTriangles: 1500 },
    );
    if (!r.ok) return;
    expect(r.value.singles.length).toBe(0);
  });
});
