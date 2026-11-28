import { describe, expect, it } from 'vitest';
import { extrude } from '../../../src/brep/build';
import { quadrangulate } from '../../../src/brep/quad';
import { quadrangulateTrimmed } from '../../../src/brep/quad-trimmed';
import type { P2 } from '../../../src/brep/vec';

function ring(cx: number, cy: number, r: number, n: number): P2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as P2;
  });
}

function holedPlate(holeSides: number) {
  const r = extrude({ profile: ring(0, 0, 40, 48), holes: [ring(0, 0, 14, holeSides)], depth: 4 });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

describe('trimmed-face Blossom-Quad', () => {
  it('never emits a folded quad: a holed plate either fails closed or has positive scaled Jacobian', () => {
    for (const n of [24, 32, 48]) {
      const r = quadrangulate(holedPlate(n), { size: 4 });
      if (r.ok) {
        expect(r.value.report.openEdges).toBe(0);
        expect(r.value.report.nonManifoldEdges).toBe(0);
        expect(r.value.report.scaledJacobian.min).toBeGreaterThan(0);
      } else {
        expect(JSON.stringify(r.error)).toContain('no-perfect-matching');
      }
    }
  });

  it('rejects the same holed plate with trimmed-loop when the blossom path is disabled', () => {
    const r = quadrangulate(holedPlate(24), { size: 4, trimmed: 'reject' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain('trimmed-loop');
  });

  it('fails closed on an odd total ring-vertex count', () => {
    const ring3 = {
      uv: [
        [0, 0],
        [1, 0],
        [0, 1],
      ] as P2[],
      ids: [0, 1, 2],
    };
    const r = quadrangulateTrimmed(
      { kind: 'plane' } as never,
      [ring3],
      () => [0, 0, 0],
      () => 0,
      { angle: Math.PI / 6, maxPoints: 4096, maxTriangles: 1500 },
    );
    expect(r).toEqual({ ok: false, error: { reason: 'odd-ring-count', count: 3 } });
  });
});
