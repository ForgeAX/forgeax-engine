// biome-ignore-all lint/style/noNonNullAssertion: fixed-size fixtures indexed under noUncheckedIndexedAccess
import { describe, expect, it } from 'vitest';
import { curvePoint } from '../curves';
import {
  BOUND_SAFETY,
  branchPCurvePoint,
  type IntersectOptions,
  intersectSurfaces,
  type SurfaceIntersection,
} from '../intersect';
import { makeFrame, surfaceInverse, surfacePoint } from '../surfaces';
import type { Curve, Surface } from '../types';
import { cross3, dist3, type P3, scale3, TWO_PI } from '../vec';
import { implicit } from './e1/check';
import { buildE1Corpus, E1_TOL } from './e1/corpus';
import { nearest, polyline, receiptHolds, refPoints, residual, run } from './e1/match';

const pairs = buildE1Corpus();
const planeIds = new Set(
  pairs.filter((p) => p.a.kind === 'plane' || p.b.kind === 'plane').map((p) => p.id),
);

describe('B-E1a1: plane against quadric and torus', () => {
  const planeCases = pairs.filter((p) => planeIds.has(p.id));

  it('the corpus holds 21 plane pairs: 18 full and 3 tangent partial', () => {
    expect(planeCases).toHaveLength(21);
    expect(planeCases.filter((p) => p.expected === 'full')).toHaveLength(18);
  });

  for (const p of planeCases) {
    it(`${p.id}: classified ${p.expected}, branches match the reference both ways`, () => {
      const out = run(p);
      if (p.expected === 'tangent-partial') {
        expect(out.branches).toEqual([]);
        expect(out.partials).toHaveLength(1);
        expect(out.partials[0]?.code).toBe('brep-ssi-tangent');
        expect(out.partials[0]?.surfaces).toEqual([3, 7]);
        expect(out.partials[0]?.contact).toBeDefined();
        return;
      }
      expect(out.partials).toEqual([]);
      expect(out.branches).toHaveLength(p.branches.length);
      const mine = out.branches.map((b) => polyline(b, 3000));
      const ref = p.branches.map((b) => refPoints(b, 3000));
      // The spiric reference is sampled uniformly in v where u has a square-root tip, so its own
      // chords are the looser side of the reverse check.
      const mineCoarse = out.branches.map((b) => polyline(b, 400));
      const refCoarse = p.branches.map((b) => refPoints(b, 400));
      const within = (q: P3) => dist3(q, p.window.c) <= p.window.r * 0.95;
      for (const line of refCoarse) {
        for (const q of line) if (within(q)) expect(nearest(q, mine)).toBeLessThan(2e-5);
      }
      const chord = p.id === 'plane-torus/spiric-loop' ? 4e-4 : 2e-5;
      for (const line of mineCoarse) {
        for (const q of line) if (within(q)) expect(nearest(q, ref)).toBeLessThan(chord);
      }
      for (const b of out.branches) {
        expect(residual(b, p.a, p.b, 1500)).toBeLessThanOrEqual(E1_TOL);
      }
    });

    it(`${p.id}: every receipt covers an independently measured residual`, () => {
      for (const b of run(p).branches) {
        expect(receiptHolds(b, p.a, p.b)).toBe(true);
        if (b.receipt !== 'closed-form') expect(b.receipt.bound).toBeLessThanOrEqual(E1_TOL);
      }
    });

    it(`${p.id}: pcurves reproduce the curve on both surfaces, continuous across seams`, () => {
      for (const b of run(p).branches) {
        for (const [s, pc] of [
          [p.a, b.onA],
          [p.b, b.onB],
        ] as const) {
          let prev: readonly [number, number] | undefined;
          for (let i = 0; i <= 400; i++) {
            const t = b.t0 + ((b.t1 - b.t0) * i) / 400;
            const uv = branchPCurvePoint(pc, t);
            expect(dist3(surfacePoint(s, uv[0], uv[1]), curvePoint(b.curve, t))).toBeLessThan(
              E1_TOL,
            );
            if (prev !== undefined && s.kind !== 'plane') {
              expect(Math.abs(uv[0] - prev[0])).toBeLessThan(Math.PI);
              expect(Math.abs(uv[1] - prev[1])).toBeLessThan(Math.PI);
            }
            prev = uv;
          }
        }
      }
    });

    it(`${p.id}: swapping the operands gives the same curves with the pcurves exchanged`, () => {
      const fwd = run(p);
      const r = intersectSurfaces(p.b, p.a, E1_TOL, {
        window: p.window,
        ids: [3, 7],
      });
      if (!r.ok) throw new Error(p.id);
      expect(r.value.branches).toHaveLength(fwd.branches.length);
      expect(r.value.partials.map((x) => x.code)).toEqual(fwd.partials.map((x) => x.code));
      for (const [i, b] of r.value.branches.entries()) {
        const f = fwd.branches[i]!;
        expect(b.curve).toEqual(f.curve);
        const t = (b.t0 + b.t1) / 2;
        expect(branchPCurvePoint(b.onA, t)).toEqual(branchPCurvePoint(f.onB, t));
      }
    });
  }

  it('the plane pairs resolve 21 of 21: 18 full passes and 3 tangent partials', () => {
    let full = 0;
    let tangent = 0;
    for (const p of planeCases) {
      const out = run(p);
      if (p.expected === 'full') {
        if (out.branches.length === p.branches.length && out.partials.length === 0) full++;
      } else if (out.branches.length === 0 && out.partials[0]?.code === 'brep-ssi-tangent') {
        tangent++;
      }
    }
    expect([full, tangent]).toEqual([18, 3]);
  });

  it('near-tangent pairs just outside the tolerance window are full passes with branches', () => {
    for (const id of [
      'plane-sphere/near-tangent',
      'plane-cylinder/near-tangent',
      'plane-cone/near-tangent-apex',
      'plane-torus/near-tangent-top',
      'plane-torus/near-node',
    ]) {
      const p = pairs.find((q) => q.id === id)!;
      const out = run(p);
      expect(out.partials, id).toEqual([]);
      expect(out.branches.length, id).toBeGreaterThan(0);
    }
  });

  it('fitted branches carry a numeric receipt, analytic ones carry closed-form', () => {
    const kinds = (id: string) =>
      run(pairs.find((q) => q.id === id)!).branches.map((b) => b.receipt);
    expect(kinds('plane-sphere/circle')).toEqual(['closed-form']);
    expect(kinds('plane-cone/parabola')[0]).toHaveProperty('bound');
    expect(kinds('plane-torus/spiric-loop')[0]).toHaveProperty('bound');
    expect(kinds('plane-torus/near-node')).toHaveLength(2);
  });

  it('falsifier: an understated receipt is caught by the independent measurement', () => {
    const p = pairs.find((q) => q.id === 'plane-torus/spiric-loop')!;
    const b = run(p).branches[0]!;
    expect(b.receipt).not.toBe('closed-form');
    const low = {
      ...b,
      receipt: { bound: (b.receipt as { bound: number }).bound / 4 },
    };
    expect(receiptHolds(b, p.a, p.b)).toBe(true);
    expect(receiptHolds(low, p.a, p.b)).toBe(false);
    expect(BOUND_SAFETY).toBeGreaterThan(1);
  });

  it('falsifier: a closed-form claim is caught when the curve is off the surface', () => {
    const p = pairs.find((q) => q.id === 'plane-sphere/circle')!;
    const b = run(p).branches[0]!;
    const moved = {
      ...b,
      curve: {
        ...(b.curve as Extract<Curve, { kind: 'circle' }>),
        radius: (b.curve as { radius: number }).radius * 1.001,
      },
    };
    expect(receiptHolds(b, p.a, p.b)).toBe(true);
    expect(receiptHolds(moved, p.a, p.b)).toBe(false);
  });
});

describe('B-E1a1: fail closed and validation', () => {
  const plane: Surface = {
    kind: 'plane',
    frame: makeFrame([0, 0, 0], [0, 0, 1]),
  };
  const sphere: Surface = {
    kind: 'sphere',
    frame: makeFrame([0, 0, 0], [0, 0, 1]),
    radius: 1,
  };
  const torus: Surface = {
    kind: 'torus',
    frame: makeFrame([0, 0, 0], [0, 0, 1]),
    major: 2,
    minor: 0.5,
  };
  const win = { c: [0, 0, 0] as P3, r: 4 };
  const must = (r: ReturnType<typeof intersectSurfaces>): SurfaceIntersection => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  };
  const code = (r: ReturnType<typeof intersectSurfaces>): unknown =>
    r.ok ? 'ok' : (r.error.detail as { brep?: string } | undefined)?.brep;

  it('an oblique plane against a torus is unsupported, never a guess', () => {
    const oblique: Surface = {
      kind: 'plane',
      frame: makeFrame([0.2, 0, 0], [1, 0, 1]),
    };
    const out = must(intersectSurfaces(oblique, torus, E1_TOL, { window: win, ids: [4, 5] }));
    expect(out.branches).toEqual([]);
    expect(out.partials).toEqual([{ code: 'brep-ssi-unsupported', surfaces: [4, 5], gap: null }]);
  });

  it('a NURBS surface in either slot is unsupported with the ids, never a frame access', () => {
    const patch: Surface = {
      kind: 'nurbs',
      surface: {
        degreeU: 1,
        degreeV: 1,
        points: [
          [
            [0, 0, 0],
            [0, 1, 0],
          ],
          [
            [1, 0, 0],
            [1, 1, 0],
          ],
        ],
        knotsU: [0, 0, 1, 1],
        knotsV: [0, 0, 1, 1],
      },
    };
    for (const [a, b] of [
      [patch, sphere],
      [sphere, patch],
    ] as const) {
      // The unit patch (z = 0, x and y in [0, 1]) meets the unit sphere in the quarter circle
      // x^2 + y^2 = 1: one open fitted NURBS branch with a bounded receipt (marched NURBS x quadric, #592).
      const out = must(intersectSurfaces(a, b, E1_TOL, { ids: [7, 8] }));
      expect(out.partials).toEqual([]);
      expect(out.branches).toHaveLength(1);
      const branch = out.branches[0] as (typeof out.branches)[number];
      expect(branch.curve.kind).toBe('nurbs');
      expect(branch.closed).toBe(false);
      expect([branch.t0, branch.t1]).toEqual([0, 1]);
      expect(typeof branch.receipt === 'object' && branch.receipt.bound).toBeLessThan(1e-6);
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const p = curvePoint(branch.curve, t);
        expect(Math.abs(Math.hypot(p[0], p[1], p[2]) - 1)).toBeLessThan(1e-6);
        expect(Math.abs(p[2])).toBeLessThan(1e-6);
      }
    }
    // The z = 0 patch lies in the plane: a coincident contact, never an empty success.
    const coplanar = must(intersectSurfaces(plane, patch, E1_TOL, { ids: [7, 8] }));
    expect(coplanar.branches).toEqual([]);
    expect(coplanar.partials).toEqual([{ code: 'brep-ssi-coincident', surfaces: [7, 8], gap: 0 }]);
    const offset: Surface = {
      kind: 'plane',
      frame: makeFrame([0, 0, 1], [0, 0, 1]),
    };
    expect(must(intersectSurfaces(offset, patch, E1_TOL, { ids: [7, 8] }))).toEqual({
      branches: [],
      partials: [],
    });
  });

  it('two coincident planes are a coincident partial; parallel offset planes are empty', () => {
    const same = must(intersectSurfaces(plane, plane, E1_TOL, { ids: [1, 2] }));
    expect(same.partials[0]?.code).toBe('brep-ssi-coincident');
    expect(same.partials[0]?.surfaces).toEqual([1, 2]);
    const far: Surface = {
      kind: 'plane',
      frame: makeFrame([0, 0, 1], [0, 0, 1]),
    };
    expect(must(intersectSurfaces(plane, far, E1_TOL))).toEqual({
      branches: [],
      partials: [],
    });
  });

  it('two crossing planes give one line covering the window', () => {
    const tilted: Surface = {
      kind: 'plane',
      frame: makeFrame([0, 0, 0], [1, 0, 0]),
    };
    const out = must(intersectSurfaces(plane, tilted, E1_TOL, { window: win }));
    expect(out.branches).toHaveLength(1);
    const b = out.branches[0]!;
    expect(b.t1 - b.t0).toBeCloseTo(2 * win.r, 9);
    expect(dist3(curvePoint(b.curve, (b.t0 + b.t1) / 2), [0, 0, 0])).toBeLessThan(1e-12);
  });

  it('a plane through a cone apex that misses the cone is tangent at the apex', () => {
    const cone: Surface = {
      kind: 'cone',
      frame: makeFrame([0, 0, 1], [0, 0, 1]),
      radius: 0.5,
      halfAngle: 0.4,
    };
    const apexZ = 1 - 0.5 / Math.tan(0.4);
    const through: Surface = {
      kind: 'plane',
      frame: makeFrame([0, 0, apexZ], [0, 0, 1]),
    };
    const out = must(intersectSurfaces(through, cone, E1_TOL, { window: win }));
    expect(out.branches).toEqual([]);
    expect(out.partials[0]?.code).toBe('brep-ssi-tangent');
    expect(dist3(out.partials[0]!.contact!, [0, 0, apexZ])).toBeLessThan(1e-9);
  });

  it('disjoint pairs are an empty result', () => {
    const up: Surface = {
      kind: 'plane',
      frame: makeFrame([0, 0, 3], [0, 0, 1]),
    };
    expect(must(intersectSurfaces(up, sphere, E1_TOL))).toEqual({
      branches: [],
      partials: [],
    });
    expect(must(intersectSurfaces(up, torus, E1_TOL))).toEqual({
      branches: [],
      partials: [],
    });
  });

  it('an open branch without a window is brep-bad-argument', () => {
    const side: Surface = {
      kind: 'plane',
      frame: makeFrame([0.2, 0, 0], [1, 0, 0]),
    };
    const cyl: Surface = {
      kind: 'cylinder',
      frame: makeFrame([0, 0, 0], [0, 0, 1]),
      radius: 1,
    };
    expect(code(intersectSurfaces(side, cyl, E1_TOL))).toBe('brep-bad-argument');
    expect(must(intersectSurfaces(side, cyl, E1_TOL, { window: win })).branches).toHaveLength(2);
  });

  it('rejects bad tolerance, window, ids, surfaces and unreadable options', () => {
    expect(code(intersectSurfaces(plane, sphere, Number.NaN))).toBe('brep-bad-argument');
    expect(code(intersectSurfaces(plane, sphere, 1e-12))).toBe('brep-bad-argument');
    expect(
      code(
        intersectSurfaces(plane, sphere, E1_TOL, {
          window: { c: [0, 0, 0], r: -1 },
        }),
      ),
    ).toBe('brep-bad-argument');
    expect(
      code(
        intersectSurfaces(plane, sphere, E1_TOL, {
          ids: [1] as unknown as [number, number],
        }),
      ),
    ).toBe('brep-bad-argument');
    expect(code(intersectSurfaces(plane, { ...sphere, radius: -1 }, E1_TOL))).toBe(
      'brep-bad-argument',
    );
    const skewed = { ...plane, frame: { ...plane.frame, x: [2, 0, 0] as P3 } };
    expect(code(intersectSurfaces(skewed, sphere, E1_TOL))).toBe('brep-bad-argument');
    const hostile = {
      get window(): never {
        throw new Error('boom');
      },
    };
    expect(code(intersectSurfaces(plane, sphere, E1_TOL, hostile))).toBe('brep-bad-argument');
  });

  it('reads the options exactly once', () => {
    let reads = 0;
    const counted = {
      get window() {
        reads++;
        return win;
      },
      get ids() {
        reads++;
        return [0, 1] as const;
      },
    };
    must(intersectSurfaces(plane, sphere, E1_TOL, counted as unknown as IntersectOptions));
    expect(reads).toBe(2);
  });

  it('a fit that cannot meet the tolerance is brep-tol-exceeded, not an unbounded receipt', () => {
    const huge: Surface = {
      kind: 'torus',
      frame: makeFrame([0, 0, 0], [0, 0, 1]),
      major: 2e7,
      minor: 5e6,
    };
    const px: Surface = {
      kind: 'plane',
      frame: makeFrame([1.7e7, 0, 0], [1, 0, 0]),
    };
    const r = intersectSurfaces(px, huge, 1e-9, {
      window: { c: [1.7e7, 0, 0], r: 4 },
    });
    expect(code(r)).toBe('brep-tol-exceeded');
  });

  it('the tangent window is |gap| <= tol on both sides for sphere and cylinder, exactly at the edge', () => {
    const tol = 2 ** -17;
    const cyl: Surface = {
      kind: 'cylinder',
      frame: makeFrame([0, 0, 0], [0, 0, 1]),
      radius: 1,
    };
    const at = (s: Surface, normal: P3, d: number) =>
      must(
        intersectSurfaces({ kind: 'plane', frame: makeFrame(scale3(normal, d), normal) }, s, tol, {
          window: win,
        }),
      );
    for (const [s, normal] of [
      [sphere, [0, 0, 1] as P3],
      [cyl, [1, 0, 0] as P3],
    ] as const) {
      const d = (gap: number) => 1 - gap;
      expect(at(s, normal, d(tol)).partials[0]?.code).toBe('brep-ssi-tangent');
      expect(at(s, normal, d(tol)).branches).toEqual([]);
      expect(at(s, normal, d(1.5 * tol)).branches.length).toBeGreaterThan(0);
      expect(at(s, normal, d(1.5 * tol)).partials).toEqual([]);
      expect(at(s, normal, d(-tol)).partials[0]?.code).toBe('brep-ssi-tangent');
      expect(at(s, normal, d(-1.5 * tol))).toEqual({
        branches: [],
        partials: [],
      });
    }
  });

  it('a plane tilted 73 degrees from a cylinder axis gives the ellipse, not lines', () => {
    const cyl: Surface = {
      kind: 'cylinder',
      frame: makeFrame([0, 0, 0], [0, 0, 1]),
      radius: 1,
    };
    const c = 0.3;
    const n = [Math.sqrt(1 - c * c), 0, c] as P3;
    const out = must(
      intersectSurfaces({ kind: 'plane', frame: makeFrame([0, 0, 0], n) }, cyl, E1_TOL, {
        window: win,
      }),
    );
    expect(out.branches.map((b) => b.curve.kind)).toEqual(['ellipse']);
    expect((out.branches[0]!.curve as { a: number }).a).toBeCloseTo(1 / c, 12);
  });

  it('a plane through the apex tilted past the generatrix is tangent at the apex, not two lines', () => {
    const cone: Surface = {
      kind: 'cone',
      frame: makeFrame([0, 0, 1], [0, 0, 1]),
      radius: 0.5,
      halfAngle: 0.4,
    };
    const apexZ = 1 - 0.5 / Math.tan(0.4);
    const tilt = 0.4 + 0.3;
    const n = [Math.cos(tilt), 0, Math.sin(tilt)] as P3;
    const pl: Surface = { kind: 'plane', frame: makeFrame([0, 0, apexZ], n) };
    const out = must(intersectSurfaces(pl, cone, E1_TOL, { window: win }));
    expect(out.branches).toEqual([]);
    expect(out.partials[0]?.code).toBe('brep-ssi-tangent');
  });

  it('planes off the origin meet in the right line, and the window picks the covered stretch', () => {
    const a: Surface = {
      kind: 'plane',
      frame: makeFrame([0, 0, 1], [0, 0, 1]),
    };
    const b: Surface = {
      kind: 'plane',
      frame: makeFrame([2, 0, 0], [1, 0, 0]),
    };
    const w = { c: [2, 5, 1] as P3, r: 3 };
    const out = must(intersectSurfaces(a, b, E1_TOL, { window: w }));
    const l = out.branches[0]!;
    const mid = curvePoint(l.curve, (l.t0 + l.t1) / 2);
    expect(dist3(mid, [2, 5, 1])).toBeLessThan(1e-12);
    expect(l.t1 - l.t0).toBeCloseTo(6, 12);
    expect(Math.abs(implicit(a, mid))).toBeLessThan(1e-12);
    expect(Math.abs(implicit(b, mid))).toBeLessThan(1e-12);
  });

  it('a pair that has a closed-form trim only in part still reproduces the curve on the lower nappe', () => {
    const k: Surface = {
      kind: 'cone',
      frame: makeFrame([0, 0, 0.5], [0, 0, 1]),
      radius: 0.5,
      halfAngle: 0.4,
    };
    const apexZ = 0.5 - 0.5 / Math.tan(0.4);
    const through: Surface = {
      kind: 'plane',
      frame: makeFrame([0, 0, apexZ], [0, 1, 0]),
    };
    const far = { c: [0, 0, apexZ - 6] as P3, r: 2 };
    const out = must(intersectSurfaces(through, k, E1_TOL, { window: far }));
    expect(out.branches).toHaveLength(2);
    for (const b of out.branches) {
      for (let i = 0; i <= 50; i++) {
        const t = b.t0 + ((b.t1 - b.t0) * i) / 50;
        const uv = branchPCurvePoint(b.onB, t);
        expect(dist3(surfacePoint(k, uv[0], uv[1]), curvePoint(b.curve, t))).toBeLessThan(E1_TOL);
      }
    }
  });

  it('a zero-radius window is rejected', () => {
    expect(
      code(
        intersectSurfaces(plane, sphere, E1_TOL, {
          window: { c: [0, 0, 0], r: 0 },
        }),
      ),
    ).toBe('brep-bad-argument');
  });

  it('an absent ids option is read once', () => {
    let reads = 0;
    const counted = {
      get ids(): undefined {
        reads++;
        return undefined;
      },
    };
    must(intersectSurfaces(plane, sphere, E1_TOL, counted as unknown as IntersectOptions));
    expect(reads).toBe(1);
  });

  it('results are deeply frozen', () => {
    const out = must(intersectSurfaces(plane, sphere, E1_TOL));
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.branches[0])).toBe(true);
  });

  it('a seeded sweep of planes through a sphere: radius and centre follow the closed form', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 60; i++) {
      const n = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5] as P3;
      const len = Math.hypot(...n) || 1;
      const nn = scale3(n, 1 / len);
      const d = (rnd() - 0.5) * 1.8;
      const s: Surface = {
        kind: 'sphere',
        frame: makeFrame([0, 0, 0], [0, 0, 1]),
        radius: 1,
      };
      const pl: Surface = {
        kind: 'plane',
        frame: makeFrame(scale3(nn, d), nn),
      };
      const b = must(intersectSurfaces(pl, s, E1_TOL)).branches[0]!;
      expect(b.curve.kind).toBe('circle');
      expect((b.curve as { radius: number }).radius).toBeCloseTo(Math.sqrt(1 - d * d), 12);
      expect(b.closed).toBe(true);
      expect(b.t1 - b.t0).toBeCloseTo(TWO_PI, 12);
    }
    void cross3;
  });
});

describe('B-E1a1: cone inverse below the apex', () => {
  const cone: Surface = {
    kind: 'cone',
    frame: makeFrame([0.3, -0.2, 0.5], [1, 2, -0.5], [0.2, 0.1, 1]),
    radius: 0.3,
    halfAngle: 0.5,
  };
  const negative: Surface = { ...cone, halfAngle: -0.4 } as Surface;
  for (const [name, s] of [
    ['positive half angle', cone],
    ['negative half angle', negative],
  ] as const) {
    it(`${name}: both nappes round-trip through surfaceInverse`, () => {
      const sa = Math.sin((s as { halfAngle: number }).halfAngle);
      const apexV = -0.3 / sa;
      for (let i = 0; i < 80; i++) {
        const v = apexV + (i - 40) * 0.05 + 0.013;
        for (let j = 0; j < 12; j++) {
          const u = (j * TWO_PI) / 12 + 0.1;
          const pt = surfacePoint(s, u, v);
          const inv = surfaceInverse(s, pt);
          expect(inv.dist).toBeLessThan(1e-11);
          expect(dist3(surfacePoint(s, inv.u, inv.v), pt)).toBeLessThan(1e-10);
        }
      }
    });
  }
});
