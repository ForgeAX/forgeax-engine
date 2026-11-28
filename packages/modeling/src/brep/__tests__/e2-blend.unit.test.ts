// biome-ignore-all lint/style/noNonNullAssertion: fixed fixtures indexed under noUncheckedIndexedAccess
import { describe, expect, it } from 'vitest';
import { box, cylinder, revolve } from '../build';
import { chamferEdgeGeometry } from '../chamfer';
import { curvePoint } from '../curves';
import { filletEdgeGeometry } from '../fillet';
import { offsetSurface } from '../offset';
import { surfaceInverse, surfaceNormal, surfacePoint } from '../surfaces';
import type { Curve, Shape, Surface } from '../types';
import { dist3, dot3, madd3, type P3 } from '../vec';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const world = { o: [0, 0, 0] as P3, x: [1, 0, 0] as P3, y: [0, 1, 0] as P3, z: [0, 0, 1] as P3 };

/** Edge indices whose two end vertices satisfy `pick`. */
function edgeWhere(shape: Shape, pick: (a: P3, b: P3, c: Curve) => boolean): number {
  const i = shape.edges.findIndex(
    (e) =>
      e.curve >= 0 &&
      pick(shape.vertices[e.v0]!.p, shape.vertices[e.v1]!.p, shape.curves[e.curve]!),
  );
  if (i < 0) throw new Error('no edge');
  return i;
}

function distanceToSurface(s: Surface, p: P3): number {
  return surfaceInverse(s, p).dist;
}

describe('E2 offsetSurface: point (u, v) moves exactly d along the oriented normal', () => {
  const cases: Surface[] = [
    { kind: 'plane', frame: world },
    { kind: 'cylinder', frame: world, radius: 2 },
    { kind: 'sphere', frame: world, radius: 2 },
    { kind: 'cone', frame: world, radius: 1.5, halfAngle: 0.4 },
    { kind: 'torus', frame: world, major: 3, minor: 1 },
  ];
  for (const s of cases) {
    for (const reversed of [false, true]) {
      it(`${s.kind}${reversed ? ' reversed' : ''}`, () => {
        const d = 0.3;
        const o = must(offsetSurface(s, d, reversed));
        expect(o.kind).toBe(s.kind);
        const sign = reversed ? -1 : 1;
        for (const [u, v] of [
          [0.2, 0.3],
          [1.7, -0.6],
          [4, 0.9],
        ] as const) {
          const expected = madd3(surfacePoint(s, u, v), surfaceNormal(s, u, v), sign * d);
          expect(dist3(surfacePoint(o, u, v), expected)).toBeLessThan(1e-12);
        }
      });
    }
  }

  it('a collapsing radius and a spindle torus are model-partial with a reason', () => {
    const cyl = offsetSurface({ kind: 'cylinder', frame: world, radius: 1 }, -1);
    expect(cyl.ok).toBe(false);
    if (!cyl.ok) {
      expect(cyl.error.code).toBe('model-partial');
      expect(cyl.error.detail).toMatchObject({ reason: 'offset-collapse' });
    }
    const spindle = offsetSurface({ kind: 'torus', frame: world, major: 2, minor: 1 }, 1.5);
    expect(!spindle.ok && (spindle.error.detail as { reason: string }).reason).toBe(
      'offset-spindle',
    );
    const inward = offsetSurface({ kind: 'sphere', frame: world, radius: 1 }, 1, true);
    expect(!inward.ok && inward.error.code).toBe('model-partial');
  });
});

describe('E2 fillet between two planes is a cylinder of exact radius', () => {
  const b = must(box({ size: [2, 3, 4] }));
  // The edge along z at x = +1, y = +1.5 (convex, 90 degrees).
  const e = edgeWhere(b, (p, q) => p[0] === 1 && q[0] === 1 && p[1] === 1.5 && q[1] === 1.5);
  const r = 0.25;
  const blend = must(filletEdgeGeometry(b, e, r));

  it('surface is a cylinder whose radius parameter equals r and whose axis is the edge direction', () => {
    expect(blend.surface.kind).toBe('cylinder');
    const s = blend.surface as Surface & { kind: 'cylinder' };
    expect(s.radius).toBe(r);
    expect(Math.abs(Math.abs(s.frame.z[2]) - 1)).toBeLessThan(1e-15);
    expect(blend.convex).toBe(true);
  });

  it('the spine is offset r from both planes and the contacts lie on the faces, tangent', () => {
    const spine = blend.spine as Curve & { kind: 'line' };
    expect(spine.o[0]).toBeCloseTo(1 - r, 15);
    expect(spine.o[1]).toBeCloseTo(1.5 - r, 15);
    const ca = curvePoint(blend.contactA, 0.7);
    const cb = curvePoint(blend.contactB, 0.7);
    for (const c of [ca, cb]) {
      expect(distanceToSurface(blend.surface, c)).toBeLessThan(1e-15);
    }
    expect([ca[0], cb[0]].sort()).toEqual([0.75, 1]);
    expect([ca[1], cb[1]].sort()).toEqual([1.25, 1.5]);
  });

  it('the blend face normal points out of the solid (away from the ball center)', () => {
    const s = blend.surface;
    const p = curvePoint(blend.contactA, 0);
    const inv = surfaceInverse(s, p);
    const n = surfaceNormal(s, inv.u, inv.v);
    const out = blend.reversed ? -1 : 1;
    const outward: P3 = Math.abs(p[0] - 1) < 1e-12 ? [1, 0, 0] : [0, 1, 0];
    expect(out * dot3(n, outward)).toBeGreaterThan(0.999);
  });

  it('a plane pair accepts any radius in closed form; a non-finite or tiny radius is a bad argument', () => {
    // Bounding the radius by the face extent belongs to the solid rebuild, not the face-pair geometry.
    expect(must(filletEdgeGeometry(b, e, 5)).surface.kind).toBe('cylinder');
    for (const bad of [Number.NaN, 0, -0.1]) {
      const r = filletEdgeGeometry(b, e, bad);
      expect(!r.ok && r.error.code).toBe('model-invalid-argument');
    }
  });
});

describe('E2 fillet in the revolution family', () => {
  const c = must(cylinder({ radius: 1.5, height: 3 }));
  const rim = edgeWhere(c, (p, _q, k) => k.kind === 'circle' && p[2] > 0);

  it('cylinder top rim: torus with major R - r, minor r, spine at height h/2 - r', () => {
    const blend = must(filletEdgeGeometry(c, rim, 0.4));
    expect(blend.surface.kind).toBe('torus');
    const t = blend.surface as Surface & { kind: 'torus' };
    expect(t.minor).toBe(0.4);
    expect(t.major).toBeCloseTo(1.1, 15);
    expect(t.frame.o[2]).toBeCloseTo(1.1, 15);
    expect(blend.convex).toBe(true);
    const spine = blend.spine as Curve & { kind: 'circle' };
    expect(spine.radius).toBeCloseTo(1.1, 15);
  });

  it('a ball whose center reaches the axis is a sphere; past it is model-partial blend-spindle', () => {
    const sphere = must(filletEdgeGeometry(c, rim, 1.5));
    expect(sphere.surface.kind).toBe('sphere');
    const spindle = filletEdgeGeometry(c, rim, 1.2);
    expect(spindle.ok).toBe(false);
  });

  it('a concave step (shoulder) gives a reversed torus with major rho + r', () => {
    const step = must(
      revolve({
        profile: [
          [0, 0],
          [2, 0],
          [2, 1],
          [1, 1],
          [1, 2],
          [0, 2],
        ],
      }),
    );
    // The concave edge is the circle radius 1 at z = 1.
    const e = edgeWhere(
      step,
      (p, _q, k) =>
        k.kind === 'circle' && Math.abs(p[2] - 1) < 1e-12 && (k as { radius: number }).radius === 1,
    );
    const blend = must(filletEdgeGeometry(step, e, 0.25));
    expect(blend.convex).toBe(false);
    const t = blend.surface as Surface & { kind: 'torus' };
    expect(t.kind).toBe('torus');
    expect(t.major).toBeCloseTo(1.25, 15);
    expect(t.frame.o[2]).toBeCloseTo(1.25, 15);
    // Concave: the ball center is outside the material, so the face normal faces the center.
    expect(blend.reversed).toBe(true);
  });

  it('a pair with no closed-form section is model-partial blend-nonanalytic', () => {
    const r = filletEdgeGeometry(
      c,
      edgeWhere(c, (_p, _q, k) => k.kind === 'line'),
      0.1,
    );
    // The seam line joins the cylinder to itself: tangent, not a blend edge.
    expect(r.ok).toBe(false);
  });
});

describe('E2 chamfer geometry', () => {
  it('a 90-degree box edge chamfer is a plane at 45 degrees with setbacks d on each face', () => {
    const b = must(box({ size: [2, 2, 2] }));
    const e = edgeWhere(b, (p, q) => p[0] === 1 && q[0] === 1 && p[1] === 1 && q[1] === 1);
    const ch = must(chamferEdgeGeometry(b, e, 0.3));
    expect(ch.surface.kind).toBe('plane');
    const n = (ch.surface as Surface & { kind: 'plane' }).frame.z;
    const s = ch.reversed ? -1 : 1;
    expect(s * n[0]).toBeCloseTo(Math.SQRT1_2, 15);
    expect(s * n[1]).toBeCloseTo(Math.SQRT1_2, 15);
    const a = curvePoint(ch.contactA, 0);
    const c = curvePoint(ch.contactB, 0);
    expect(dist3(a, c)).toBeCloseTo(0.3 * Math.SQRT2, 14);
  });

  it('a cylinder rim chamfer is a cone of half-angle 45 degrees through both setback circles', () => {
    const c = must(cylinder({ radius: 1, height: 2 }));
    const rim = edgeWhere(c, (p, _q, k) => k.kind === 'circle' && p[2] > 0);
    const ch = must(chamferEdgeGeometry(c, rim, 0.2));
    expect(ch.surface.kind).toBe('cone');
    const k = ch.surface as Surface & { kind: 'cone' };
    expect(Math.abs(k.halfAngle)).toBeCloseTo(Math.PI / 4, 14);
    for (const curve of [ch.contactA, ch.contactB]) {
      expect(distanceToSurface(ch.surface, curvePoint(curve, 1.1))).toBeLessThan(1e-14);
    }
  });
});
