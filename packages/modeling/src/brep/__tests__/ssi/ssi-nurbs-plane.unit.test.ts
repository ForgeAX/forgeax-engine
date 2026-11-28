// biome-ignore-all lint/style/noNonNullAssertion: fixed-size fixtures indexed under noUncheckedIndexedAccess
import { describe, expect, it } from 'vitest';
import { intersectFaces } from '../../ssi';
import type { SsiFace, SsiResult } from '../../ssi/types';
import { makeFrame } from '../../surfaces';
import { tube } from './freeform';
import { prng } from './prng';

// Transversal NURBS x plane: a lofted tube cut by a mid-plane. The section is one open branch whose
// ends exit the tube's own parameter boundary, each within the fit tolerance.
function tubeFace(): SsiFace {
  return {
    surface: {
      kind: 'nurbs',
      surface: tube(prng(1), { length: 6, sections: 8, radius: 1, wobble: 0.3 }),
    },
  };
}

function planeFace(
  origin: readonly [number, number, number],
  normal: readonly [number, number, number],
): SsiFace {
  return {
    surface: { kind: 'plane', frame: makeFrame([...origin], [...normal]) },
    bounds: [
      [-4, 4],
      [-4, 4],
    ],
  };
}

function solve(
  origin: readonly [number, number, number],
  normal: readonly [number, number, number],
): SsiResult {
  const r = intersectFaces(tubeFace(), planeFace(origin, normal));
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

describe('intersectFaces: NURBS x plane transversal section', () => {
  // Measured 26.6 s alone and 45 s under full-suite load on the shared host, so the 30 s default is load-sensitive.
  it('a mid-length plane gives two open boundary chains and two closed loops, all within tolerance', {
    timeout: 120000,
  }, () => {
    const r = solve([0, 0, 0], [0, 0, 1]);
    expect(r.status).toBe('ok');
    expect(r.issues).toEqual([]);
    expect(r.branches.map((b) => b.closed).sort()).toEqual([false, false, true, true]);
    for (const b of r.branches) {
      expect(b.bound).toBeLessThanOrEqual(1e-7);
      for (const p of b.points) expect(Math.abs(p[2]!)).toBeLessThanOrEqual((1e-7 / 100) * 10);
    }
  });

  it('returns one ok branch for a transverse plane, with both ends on the face boundary', () => {
    const r = solve([-3, 0, 0], [1, 0, 0]);
    expect(r.status).toBe('ok');
    expect(r.branches).toHaveLength(1);
    const b = r.branches[0]!;
    expect(b.closed).toBe(false);
    expect(b.ends).toEqual(['boundary', 'boundary']);
    expect(b.bound).toBeLessThanOrEqual(1e-7);
    for (const p of b.points) expect(Math.abs(p[0]! + 3)).toBeLessThanOrEqual((1e-7 / 100) * 10);
  });

  it('a plane missing the tube returns an empty ok result, never a partial one', () => {
    const r = solve([0, 0, 50], [0, 0, 1]);
    expect(r.status).toBe('ok');
    expect(r.branches).toEqual([]);
    expect(r.issues).toEqual([]);
  });
});
