import { describe, expect, it } from 'vitest';
import { PATTERN_CASES } from '../../../examples/brep-pattern/render';
import { kindsOf } from '../../../examples/quad-feature-baseline/kind-render';
import { quadrangulate } from '../quad';
import { cross3, dot3, len3, type P3, scale3, sub3 } from '../vec';

function sj(p: readonly P3[]): number {
  const n = cross3(sub3(p[2] as P3, p[0] as P3), sub3(p[3] as P3, p[1] as P3));
  const l = len3(n);
  if (l === 0) return 0;
  const normal = scale3(n, 1 / l);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 4; i++) {
    const here = p[i] as P3;
    const d1 = sub3(p[(i + 1) % 4] as P3, here);
    const d2 = sub3(p[(i + 3) % 4] as P3, here);
    min = Math.min(min, dot3(cross3(scale3(d1, 1 / len3(d1)), scale3(d2, 1 / len3(d2))), normal));
  }
  return min;
}

/** Min scaled Jacobian over interior (non-row, non-fallback) quads of a blossom-row result. */
function interiorMinSj(id: string): number {
  const make = PATTERN_CASES[id];
  if (make === undefined) throw new Error(`${id} missing`);
  const shape = make().shape;
  const r = quadrangulate(shape, { size: 5, trimmed: 'blossom-row', source: 'boolean' });
  if (!r.ok) throw new Error(`${id} failed: ${r.error.code}`);
  const mesh = r.value.mesh;
  const kinds = kindsOf(r.value);
  let min = Number.POSITIVE_INFINITY;
  for (const f of mesh.faces()) {
    if (kinds[f] !== 'interior') continue;
    const vs = mesh.faceVertices(f);
    if (vs.length !== 4) continue;
    min = Math.min(min, sj(vs.map((v) => mesh.position(v) as P3)));
  }
  return min;
}

// TARGET quality bar, tracked as expected-failing (narrowed, not met). Current best interior minSJ is
// 0.1205. Sweep of a hard SJ >= 0.3 floor with perfect matching over trim-interior spacings 4..8: every
// spacing fails with no-perfect-matching, so no all-quad interior exists at these spacings. A quad-dominant
// hard floor reaches 0.32 (bolt6) and 0.40 (bolt12) but leaves 32-58 triangles, which breaks the all-quad
// leftover-pairing contract (trimface-leftover-pairing.unit.test.ts).
// `it.fails` keeps this green while the bar is unmet; when the bar is met the assertion passes,
// `it.fails` turns red, and the `.fails` marker must be removed in the same change.
// Measured floor: the current interior minSJ is 0.12054 on both bolt6 and bolt12 (266 and 348 interior quads, none
// non-quad). A fold or a throw in the join band falls below this floor or leaves no interior quad to measure.
describe('blossom-row interior join band (measured floor)', () => {
  for (const id of ['bolt6', 'bolt12']) {
    it(`${id}: interior quads keep minSj >= 0.12 and stay positive`, () => {
      const min = interiorMinSj(id);
      expect(Number.isFinite(min)).toBe(true);
      expect(min).toBeGreaterThan(0);
      expect(min).toBeGreaterThanOrEqual(0.12);
    });
  }
});

describe('blossom-row interior join band (target quality bar, expected to fail)', () => {
  for (const id of ['bolt6', 'bolt12']) {
    it.fails(`${id}: interior quads keep minSj >= 0.3`, () => {
      expect(interiorMinSj(id)).toBeGreaterThanOrEqual(0.3);
    });
  }
});
