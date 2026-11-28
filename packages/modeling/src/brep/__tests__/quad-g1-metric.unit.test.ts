import { describe, expect, it } from 'vitest';
import { box } from '../build';
import { filletBox } from '../fillet-box';
import { quadrangulate } from '../quad';
import { g1RowContinuity } from '../quad-g1-metric';
import type { Shape } from '../types';

function mustShape(r: { ok: boolean; value?: Shape }): Shape {
  if (!r.ok || r.value === undefined) throw new Error('build failed');
  return r.value;
}

const rounded = mustShape(filletBox({ size: [4, 3, 2], radius: 0.5 }));
const opts = { size: 0.25, trimmed: 'quad-dominant' } as const;

function mesh(shape: Shape) {
  const r = quadrangulate(shape, opts);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function metric(shape: Shape, result: ReturnType<typeof mesh>) {
  const g = g1RowContinuity(shape, result);
  if (!g.ok) throw new Error(JSON.stringify(g.error));
  return g.value;
}

describe('g1RowContinuity', () => {
  it('judges every plane-cylinder and cylinder-sphere seam of a filleted box', () => {
    const g = metric(rounded, mesh(rounded));
    expect(g.pairs).toBe(48);
    expect(g.mixedPairs).toBe(0);
    expect(g.regular).toBeGreaterThan(100);
    expect(g.regular + g.ends + g.irregular).toBe(g.seamVertices);
    expect(g.fraction).toBeGreaterThanOrEqual(0.9);
    // A coarse arc chord leaves its tangent by half the step angle (30 deg steps here): collinearity is no test.
    expect(g.maxBendDeg).toBeGreaterThan(10);
  });

  it('reports no seam on a sharp box', () => {
    const sharp = mustShape(box({ size: [4, 3, 2] }));
    const g = metric(sharp, mesh(sharp));
    expect(g.pairs).toBe(0);
    expect(g.seamVertices).toBe(0);
    expect(g.fraction).toBe(1);
  });

  it('falsifier: skewing the plane rows next to a seam lowers the fraction', () => {
    const result = mesh(rounded);
    const healthy = metric(rounded, result);
    const owner = new Map<number, Set<number>>();
    result.faceRanges.forEach((range, f) => {
      for (let m = range[0]; m < range[1]; m++) {
        if (!result.mesh.isFaceAlive(m)) continue;
        for (const v of result.mesh.faceVertices(m)) {
          const set = owner.get(v) ?? new Set<number>();
          set.add(f);
          owner.set(v, set);
        }
      }
    });
    const planes = new Set(
      rounded.faces.flatMap((face, f) =>
        (rounded.surfaces[face.surface] as { kind: string }).kind === 'plane' ? [f] : [],
      ),
    );
    for (const [v, faces] of owner) {
      const [only] = [...faces];
      if (faces.size !== 1 || only === undefined || !planes.has(only)) continue;
      const p = result.mesh.position(v);
      result.mesh.setPosition(v, p[0] + 0.1, p[1], p[2]);
    }
    const damaged = metric(rounded, result);
    expect(damaged.continued).toBeLessThan(healthy.continued);
    expect(damaged.maxPerpDeg).toBeGreaterThan(20);
  });
});
