import { beforeAll, describe, expect, it } from 'vitest';
import { must } from '../../../examples/brep-heal/damage';
import { bore } from '../../../examples/brep-pattern/render';
import { holeBoundaryMetrics } from '../../../examples/qf-curved-baseline/metrics';
import { box } from '../build';
import { applyPattern, linearPattern } from '../pattern';
import { quadrangulate } from '../quad';
import type { Shape } from '../types';

// The 3 x 4 hole plate of the pattern gallery (100 wide, 12 holes of radius 4 at pitch 20) at three heights. Each plate
// takes ~100 s to build, so the three share one file and a long timeout.
function plate(height: number): Shape {
  const tools = [];
  for (let j = 0; j < 4; j++)
    tools.push(
      ...must(
        linearPattern(bore(4, [-20, -30 + j * 20, 0]), {
          direction: [1, 0, 0],
          spacing: 20,
          count: 3,
        }),
      ),
    );
  return must(applyPattern(must(box({ size: [100, height, 8] })), tools));
}

const iso = (size: number) => ({ size, trimmed: 'quad-dominant', isoQuadric: true }) as const;
const reasonOf = (r: ReturnType<typeof quadrangulate>): string | undefined =>
  r.ok ? undefined : (r.error.detail as { reason?: string }).reason;

describe('isoQuadric on the 3 x 4 hole plate: the far edges fall to a finer ratio when a strip fails', () => {
  let thin: Shape; // 100 x 70: the outer rows of holes sit 1.04 from the plate edge
  let wall3: Shape; // 100 x 74: the same holes 3.04 from the edge
  let tall: Shape; // 100 x 90: every hole has room on all sides
  beforeAll(() => {
    thin = plate(70);
    wall3 = plate(74);
    tall = plate(90);
  }, 600_000);

  for (const size of [5, 3]) {
    it(`wall 1.04, size ${size}: all quads, every hole rowed, minSJ >= 0.3`, () => {
      const r = quadrangulate(thin, iso(size));
      expect(reasonOf(r)).toBeUndefined();
      if (!r.ok) return;
      expect(r.value.report.triangles).toBe(0);
      expect(r.value.report.openEdges).toBe(0);
      expect(r.value.report.nonManifoldEdges).toBe(0);
      expect(r.value.report.scaledJacobian.min).toBeGreaterThanOrEqual(0.3);
      const m = holeBoundaryMetrics(thin, r.value);
      expect(m.coverage).toBe(1);
      expect(m.rowOnly).toBe(1);
    }, 120_000);
  }

  it('the wall decides it: wall 3.04 lays out at size 3 on the plain ratio, wall 1.04 needs a finer far field', () => {
    const near = quadrangulate(wall3, iso(3));
    const edge = quadrangulate(thin, iso(3));
    expect(near.ok && edge.ok).toBe(true);
    if (!near.ok || !edge.ok) return;
    // The thin wall is meshed with a finer plate-edge sampling than the thick one (measured 11432 vs 4840 quads).
    expect(edge.value.report.quads).toBeGreaterThan(near.value.report.quads * 2);
  }, 120_000);

  it('the 90-tall control is unchanged at 5, 4, 3.5, 3 and 2.6 (quads and minSJ)', () => {
    const want: readonly [number, number, number][] = [
      [5, 2792, 0.701],
      [4, 4744, 0.576],
      [3.5, 2792, 0.701],
      [3, 5684, 0.563],
      [2.6, 3060, 0.701],
    ];
    for (const [size, quads, minSj] of want) {
      const r = quadrangulate(tall, iso(size));
      expect(reasonOf(r)).toBeUndefined();
      if (!r.ok) continue;
      expect(r.value.report.quads).toBe(quads);
      expect(r.value.report.scaledJacobian.min).toBeCloseTo(minSj, 3);
    }
  }, 120_000);

  it('fails closed, never folded, where no ratio lays out (wall 1.04 at size 5.5)', () => {
    const r = quadrangulate(thin, iso(5.5));
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toMatch(/^iso-/);
  }, 120_000);
});
