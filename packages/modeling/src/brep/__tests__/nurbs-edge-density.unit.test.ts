import { describe, expect, it } from 'vitest';
import { curvePoint, type NurbsCurve } from '../../nurbs';
import { nurbsSegment, revolveProfile } from '../revolve-profile';
import { tessellate, tessellateSampled } from '../tessellate';
import type { Shape } from '../types';
import { validate } from '../validate';

const VASE_BODY: [number, number][] = [
  [0.4, 0],
  [0.7, 0.6],
  [0.7, 1.2],
  [0.7, 1.8],
  [0.5, 2.4],
];

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** Quarter circle of radius 1 in the (r, z) plane, as a rational degree-2 NURBS (exact). */
const QUARTER: NurbsCurve = {
  degree: 2,
  points: [
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ],
  weights: [1, Math.SQRT1_2, 1],
  knots: [0, 0, 0, 1, 1, 1],
};

/**
 * Quarter-circle NURBS profile edge (axis-to-cylinder cap shape): the profile starts at the axis at
 * (0, 0), rises to the quarter arc, and ends on the axis at (0, 1). The quarter itself is rational.
 */
function quarterRevolve(): { shape: Shape; edge: number } {
  const shape = must(
    revolveProfile({
      start: [0, 0],
      segments: [
        { kind: 'line', to: [1, 0] },
        { kind: 'nurbs', to: [0, 1], curve: QUARTER },
      ],
    }),
  );
  const edge = shape.edges.findIndex((e) => shape.curves[e.curve]?.kind === 'nurbs');
  return { shape, edge };
}

describe('NURBS edge density follows the turn of the whole edge', () => {
  it('a quarter-circle NURBS edge gets the segment count of the analytic quarter arc', () => {
    for (const angle of [Math.PI / 16, Math.PI / 8, Math.PI / 32]) {
      const analytic = Math.ceil(Math.PI / 2 / angle - 1e-9);
      const { shape, edge } = quarterRevolve();
      const sampled = must(tessellateSampled(shape, { angle }));
      const segments = (sampled.samples.get(edge)?.length ?? 0) - 1;
      expect(Math.abs(segments - analytic)).toBeLessThanOrEqual(1);
    }
  });

  it('a straight degree-3 NURBS edge still gets the minimum of 3 segments', () => {
    const line = must(
      nurbsSegment(
        [
          [0.5, 0],
          [0.5, 0.5],
          [0.5, 1],
        ],
        { degree: 3 },
      ),
    );
    const shape = must(
      revolveProfile({
        start: [0, 0],
        segments: [{ kind: 'line', to: [0.5, 0] }, line, { kind: 'line', to: [0, 1] }],
      }),
    );
    expect(validate(shape).ok).toBe(true);
    const sampled = must(tessellateSampled(shape, { angle: Math.PI / 16 }));
    const nurbsEdge = shape.edges.findIndex((e) => shape.curves[e.curve]?.kind === 'nurbs');
    expect((sampled.samples.get(nurbsEdge)?.length ?? 0) - 1).toBe(3);
  });
});

describe('vase NURBS wall stays close to the true surface', () => {
  it('max distance from a wall mid-chord to the surface of revolution is below the pinned bound', () => {
    const body = must(nurbsSegment(VASE_BODY, { degree: 3 }));
    const curve = (body as { curve: NurbsCurve }).curve;
    const shape = must(
      revolveProfile({
        start: [0, 0],
        segments: [{ kind: 'line', to: [0.4, 0] }, body, { kind: 'line', to: [0, 2.4] }],
      }),
    );
    const mesh = must(tessellate(shape, { angle: Math.PI / 16 }));
    const profile: [number, number][] = [];
    for (let i = 0; i <= 4000; i++) {
      const p = curvePoint(curve, i / 4000);
      profile.push([p[0], p[1]]);
    }
    let worst = 0;
    for (const f of mesh.faces()) {
      const vs = mesh.faceVertices(f);
      for (let i = 0; i < vs.length; i++) {
        const a = mesh.position(vs[i] as number);
        const b = mesh.position(vs[(i + 1) % vs.length] as number);
        const x = (a[0] + b[0]) / 2;
        const y = (a[1] + b[1]) / 2;
        const z = (a[2] + b[2]) / 2;
        const rho = Math.hypot(x, y);
        let best = Number.POSITIVE_INFINITY;
        for (const [pr, pz] of profile) best = Math.min(best, Math.hypot(rho - pr, z - pz));
        worst = Math.max(worst, best);
      }
    }
    // Measured 1.62e-2 at the density fixed here (committed tessellator: 9.35e-2); bound with margin.
    expect(worst).toBeLessThan(0.03);
  }, 200000);
});
