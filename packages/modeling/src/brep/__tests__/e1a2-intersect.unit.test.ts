// biome-ignore-all lint/style/noNonNullAssertion: fixed-size fixtures indexed under noUncheckedIndexedAccess
import { describe, expect, it } from 'vitest';
import { curvePoint } from '../curves';
import { BOUND_SAFETY, branchPCurvePoint, intersectSurfaces } from '../intersect';
import { makeFrame, surfacePoint } from '../surfaces';
import type { Frame } from '../types';
import { cross3, dist3, dot3, len3, madd3, type P3, scale3, sub3 } from '../vec';
import { implicit } from './e1/check';
import { type AnalyticSurface, buildE1Corpus, E1_TOL } from './e1/corpus';
import { nearest, polyline, receiptHolds, refPoints, residual, run } from './e1/match';
import { prng } from './e1/prng';

const pairs = buildE1Corpus();
const quad = pairs.filter((p) => p.a.kind !== 'plane' && p.b.kind !== 'plane');
const classOf = (id: string): 'A' | 'B' | 'C' | 'D' =>
  id.includes('steinmetz')
    ? 'D'
    : id.startsWith('cylinder-cylinder/parallel')
      ? 'B'
      : /offset|perpendicular/.test(id)
        ? 'C'
        : 'A';

const must = (r: ReturnType<typeof intersectSurfaces>) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe('B-E1a2: quadric against quadric', () => {
  it('the corpus holds 19 quadric pairs: A 12, B 2, C 4, D 1 tangent', () => {
    const count = (c: string) => quad.filter((p) => classOf(p.id) === c).length;
    expect([count('A'), count('B'), count('C'), count('D')]).toEqual([12, 2, 4, 1]);
    expect(quad.filter((p) => p.expected === 'full')).toHaveLength(18);
  });

  for (const p of quad.filter((q) => q.expected === 'full')) {
    it(`${p.id} (class ${classOf(p.id)}): branches match the reference both ways, no partial`, () => {
      const out = run(p);
      expect(out.partials).toEqual([]);
      expect(out.branches).toHaveLength(p.branches.length);
      const mine = out.branches.map((b) => polyline(b, 3000));
      const ref = p.branches.map((b) => refPoints(b, 3000));
      const mineCoarse = out.branches.map((b) => polyline(b, 400));
      const refCoarse = p.branches.map((b) => refPoints(b, 400));
      // The one-loop references are sampled uniformly where the height has a square-root tip.
      const chord = p.id.endsWith('one-loop') ? 4e-4 : 2e-5;
      const within = (q: P3) => dist3(q, p.window.c) <= p.window.r * 0.95;
      for (const line of refCoarse) {
        for (const q of line) if (within(q)) expect(nearest(q, mine)).toBeLessThan(2e-5);
      }
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
        expect(b.receipt === 'closed-form').toBe(classOf(p.id) !== 'C');
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
            if (prev !== undefined) {
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
      const r = intersectSurfaces(p.b, p.a, E1_TOL, { window: p.window, ids: [3, 7] });
      const swapped = must(r);
      expect(swapped.branches).toHaveLength(fwd.branches.length);
      for (const b of swapped.branches) {
        const same = fwd.branches.map((f) => polyline(f, 3000));
        for (const q of polyline(b, 300)) expect(nearest(q, same)).toBeLessThan(1e-5);
        for (const [s, pc] of [
          [p.a, b.onB],
          [p.b, b.onA],
        ] as const) {
          for (let i = 0; i <= 40; i++) {
            const t = b.t0 + ((b.t1 - b.t0) * i) / 40;
            const uv = branchPCurvePoint(pc, t);
            expect(dist3(surfacePoint(s, uv[0], uv[1]), curvePoint(b.curve, t))).toBeLessThan(
              E1_TOL,
            );
          }
        }
      }
    });
  }

  it('equal-radius perpendicular cylinders are a tangent partial with the ids, never a guessed topology', () => {
    const p = pairs.find((q) => q.id === 'cylinder-cylinder/perpendicular-equal-steinmetz')!;
    const out = run(p);
    expect(out.branches).toEqual([]);
    expect(out.partials).toHaveLength(1);
    expect(out.partials[0]?.code).toBe('brep-ssi-tangent');
    expect(out.partials[0]?.surfaces).toEqual([3, 7]);
    expect(out.partials[0]?.contact).toBeDefined();
  });

  it('counts: 36 full passes of 36 and 40 of 40 resolved over the whole corpus', () => {
    let full = 0;
    let resolved = 0;
    for (const p of pairs) {
      const out = run(p);
      const unsupported = out.partials.some((x) => x.code === 'brep-ssi-unsupported');
      const good =
        !unsupported &&
        (p.expected === 'full'
          ? out.branches.length === p.branches.length && out.partials.length === 0
          : out.branches.length === 0 && out.partials[0]?.code === 'brep-ssi-tangent');
      if (good) resolved++;
      if (good && p.expected === 'full') full++;
    }
    expect([full, resolved]).toEqual([36, 40]);
  });
});

type Spec =
  | { kind: 'sphere'; o: P3; z: P3; radius: number }
  | { kind: 'cylinder'; o: P3; z: P3; radius: number }
  | { kind: 'cone'; o: P3; z: P3; radius: number; halfAngle: number }
  | { kind: 'torus'; o: P3; z: P3; major: number; minor: number };

/** A pair in canonical position moved by one seeded rotation and translation. */
function moved(seed: number, ...specs: Spec[]): AnalyticSurface[] {
  const g = prng(seed);
  const axis = g.direction();
  const ang = g.range(0, 6.28);
  const shift: P3 = [g.range(-3, 3), g.range(-3, 3), g.range(-3, 3)];
  const rot = (v: P3): P3 => {
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    const k = cross3(axis, v);
    return madd3(madd3(scale3(v, c), k, sn), axis, dot3(axis, v) * (1 - c));
  };
  return specs.map((sp) => {
    const frame: Frame = makeFrame(
      madd3(rot(sp.o), [1, 0, 0], 0).map((x, i) => x + shift[i]!) as unknown as P3,
      rot(sp.z),
    );
    return { ...sp, frame } as unknown as AnalyticSurface;
  });
}

function flatten(sp: AnalyticSurface[]): [AnalyticSurface, AnalyticSurface] {
  return [sp[0]!, sp[1]!];
}

describe('B-E1a2: classes under a seeded rigid motion, tolerance windows and falsifiers', () => {
  const Z: P3 = [0, 0, 1];
  const near = 0.5 * E1_TOL;
  const far = 20 * E1_TOL;
  const win = { c: [0, 0, 0] as P3, r: 4 };
  const err = (a: AnalyticSurface, b: AnalyticSurface, t = E1_TOL) =>
    intersectSurfaces(a, b, t, { window: win, ids: [5, 6] });

  it('a generic skew pair (cone against sphere off axis, tilted cylinders) fails closed with ids', () => {
    const [k, sp] = flatten(
      moved(
        1,
        { kind: 'cone', o: [0, 0, 0], z: Z, radius: 0, halfAngle: 0.5 },
        {
          kind: 'sphere',
          o: [0.4, 0.2, 1],
          z: Z,
          radius: 1,
        },
      ),
    );
    const out = must(err(k, sp));
    expect(out.branches).toEqual([]);
    expect(out.partials).toEqual([{ code: 'brep-ssi-unsupported', surfaces: [5, 6], gap: null }]);
    const tilted = flatten(
      moved(
        2,
        { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 1 },
        {
          kind: 'cylinder',
          o: [0, 0, 0],
          z: [0, Math.sin(0.4), Math.cos(0.4)],
          radius: 0.7,
        },
      ),
    );
    expect(must(err(...tilted)).partials[0]?.code).toBe('brep-ssi-unsupported');
  });

  it('coaxial class: tangent and coincident windows are partials, 20 tol outside is a full pass', () => {
    for (const seed of [3, 4, 5]) {
      const touchR = (gap: number) =>
        flatten(
          moved(
            seed,
            { kind: 'sphere', o: [0, 0, 0], z: Z, radius: 1 },
            {
              kind: 'cylinder',
              o: [0, 0, 0],
              z: Z,
              radius: 1 - gap,
            },
          ),
        );
      for (const gap of [0, near, -near]) {
        const out = must(err(...touchR(gap)));
        expect(out.branches, `gap ${gap}`).toEqual([]);
        expect(out.partials[0]?.code).toBe('brep-ssi-tangent');
      }
      expect(must(err(...touchR(far))).branches).toHaveLength(2);
      expect(must(err(...touchR(-far))).partials).toEqual([]);
      expect(must(err(...touchR(-far))).branches).toHaveLength(0);
    }
    const same = flatten(
      moved(
        6,
        { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 1 },
        { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 1 },
      ),
    );
    expect(must(err(...same)).partials[0]?.code).toBe('brep-ssi-coincident');
  });

  it('parallel cylinders: tangent at +-tol, a full pass 20 tol outside, disjoint and nested are empty', () => {
    const pair = (d: number, r2 = 0.7) =>
      flatten(
        moved(
          7,
          { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 1 },
          { kind: 'cylinder', o: [d, 0, 0], z: Z, radius: r2 },
        ),
      );
    for (const d of [1.7, 1.7 + near, 1.7 - near, 0.3, 0.3 + near, 0.3 - near]) {
      expect(must(err(...pair(d))).partials[0]?.code, `d ${d}`).toBe('brep-ssi-tangent');
    }
    for (const d of [1.7 - 5 * E1_TOL, 0.3 + 5 * E1_TOL]) {
      expect(must(err(...pair(d))).branches, `d ${d}`).toHaveLength(2);
    }
    for (const d of [1.7, 0.3, 1.7 + near, 0.3 - near]) {
      const [a, b] = pair(d);
      const c = must(err(a, b)).partials[0]!.contact!;
      const off = (s: AnalyticSurface) => len3(cross3(sub3(c, s.frame.o), s.frame.z));
      expect(Math.abs(off(a) - 1), `d ${d}`).toBeLessThan(E1_TOL);
      expect(Math.abs(off(b) - 0.7), `d ${d}`).toBeLessThan(E1_TOL);
    }
    expect(must(err(...pair(1.7 - far))).branches).toHaveLength(2);
    expect(must(err(...pair(0.3 + far))).branches).toHaveLength(2);
    expect(must(err(...pair(1.7 + far)))).toEqual({ branches: [], partials: [] });
    expect(must(err(...pair(0.3 - far)))).toEqual({ branches: [], partials: [] });
  });

  it('class C fails closed when g touches zero: near-tangent offset sphere-cylinder and cylinder pairs', () => {
    const sc = (e: number) =>
      flatten(
        moved(
          8,
          { kind: 'sphere', o: [e, 0, 0], z: Z, radius: 2 },
          { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 0.5 },
        ),
      );
    for (const d of [near, -near, 0]) {
      for (const e of [2.5 + d, 1.5 + d]) {
        const out = must(err(...sc(e)));
        expect(out.branches, `e ${e}`).toEqual([]);
        expect(out.partials[0]?.code).toBe('brep-ssi-unsupported');
        expect(out.partials[0]?.surfaces).toEqual([5, 6]);
      }
    }
    const cc = (px: number, r2: number) =>
      flatten(
        moved(
          9,
          { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 1 },
          { kind: 'cylinder', o: [px, 0, 0], z: [0, 1, 0], radius: r2 },
        ),
      );
    for (const d of [near, -near]) {
      for (const [px, r2] of [
        [0.3 + d, 0.7],
        [1.8 + d, 0.8],
      ] as const) {
        const out = must(err(...cc(px, r2)));
        expect(out.branches).toEqual([]);
        expect(out.partials[0]?.code).toBe('brep-ssi-unsupported');
      }
    }
    expect(must(err(...sc(2.5 - far))).branches.length).toBeGreaterThan(0);
    expect(must(err(...sc(1.5 + far))).branches.length).toBeGreaterThan(0);
    expect(must(err(...cc(0.3 + far, 0.7))).branches.length).toBeGreaterThan(0);
  });

  it('equal-radius perpendicular cylinders: a tangent partial within tol, loops 20 tol away', () => {
    const cc = (r2: number, px = 0) =>
      flatten(
        moved(
          10,
          { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 1 },
          { kind: 'cylinder', o: [px, 0, 0], z: [0, 1, 0], radius: r2 },
        ),
      );
    for (const r2 of [1, 1 + near, 1 - near]) {
      expect(must(err(...cc(r2))).partials[0]?.code).toBe('brep-ssi-tangent');
    }
    const lopsided = must(err(...cc(1 - far)));
    expect(lopsided.partials).toEqual([]);
    expect(lopsided.branches).toHaveLength(2);
  });

  it('equal-radius perpendicular cylinders: the offset and radius gap each leave the tangent window, and the contact lies on both', () => {
    const cc = (r2: number, px = 0) =>
      flatten(
        moved(
          10,
          { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 1 },
          { kind: 'cylinder', o: [px, 0, 0], z: [0, 1, 0], radius: r2 },
        ),
      );
    for (const [r2, px] of [
      [1, 5 * E1_TOL],
      [1, 0.5],
      [1 + 5 * E1_TOL, 0],
      [1 - 5 * E1_TOL, 0],
    ] as const) {
      const out = must(err(...cc(r2, px)));
      expect(out.partials, `${r2} ${px}`).toEqual([]);
      expect(out.branches.length, `${r2} ${px}`).toBeGreaterThan(0);
    }
    for (const r2 of [1, 1 + near, 1 - near]) {
      const [a, b] = cc(r2);
      const t = must(err(a, b)).partials[0]!;
      expect(t.gap).toBeCloseTo(1 - r2, 12);
      const c = t.contact!;
      const off = (s: AnalyticSurface) => len3(cross3(sub3(c, s.frame.o), s.frame.z));
      expect(Math.abs(off(a) - 1)).toBeLessThan(E1_TOL);
      expect(Math.abs(off(b) - r2)).toBeLessThan(E1_TOL);
    }
  });

  it('class C topology: loop count equals the number of positive intervals of an independent sign scan', () => {
    const g = prng(2024);
    const SCAN = 20000;
    let counted = 0;
    for (let k = 0; k < 40; k++) {
      const R = g.range(1.2, 2.6);
      const r = g.range(0.3, 1.2);
      const e = g.range(0.2, 2.8);
      const sphereCyl = k % 2 === 0;
      const r2 = g.range(0.3, 1.2);
      const px = g.range(0, 1.8);
      const specs: Spec[] = sphereCyl
        ? [
            { kind: 'sphere', o: [e, 0, 0], z: Z, radius: R },
            { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: r },
          ]
        : [
            { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: r },
            { kind: 'cylinder', o: [px, 0, 0], z: [0, 1, 0], radius: r2 },
          ];
      const [a, b] = flatten(moved(100 + k, ...specs));
      const [other, base] = sphereCyl ? [a, b] : [b, a];
      const params = sphereCyl
        ? [Math.abs(e - r) - R, e + r - R]
        : [Math.abs(r - r2) - px, px + r2 - r, px - (r + r2), px - Math.abs(r - r2)];
      if (params.some((x) => Math.abs(x) < 1e-3) || (!sphereCyl && Math.abs(px) < 1e-3)) continue;
      const frame = base.frame;
      const h = sphereCyl
        ? dot3(subv(other.frame.o, frame.o), frame.z)
        : dot3(subv(other.frame.o, frame.o), frame.z);
      const pos: boolean[] = [];
      for (let i = 0; i < SCAN; i++) {
        const th = (2 * Math.PI * i) / SCAN;
        const pt = madd3(
          madd3(
            madd3(frame.o, frame.x, (base as { radius: number }).radius * Math.cos(th)),
            frame.y,
            (base as { radius: number }).radius * Math.sin(th),
          ),
          frame.z,
          h,
        );
        pos.push(implicit(other, pt) < 0);
      }
      const ups = pos.filter((v, i) => v && !pos[(i + SCAN - 1) % SCAN]).length;
      const expected = pos.every((v) => v) ? 2 : ups;
      const out = err(a, b);
      if (!out.ok) {
        expect((out.error.detail as { brep?: string }).brep).toBe('brep-tol-exceeded');
        continue;
      }
      if (out.value.partials.length > 0) continue;
      counted++;
      expect(out.value.branches.length, `case ${k}`).toBe(expected);
      for (const br of out.value.branches) expect(receiptHolds(br, a, b), `case ${k}`).toBe(true);
    }
    expect(counted).toBeGreaterThan(20);
  });

  it('falsifier: an understated or displaced class C receipt is caught by the independent measurement', () => {
    const p = pairs.find((q) => q.id === 'sphere-cylinder/offset-two-loops')!;
    const b = run(p).branches[0]!;
    expect(b.receipt).not.toBe('closed-form');
    const low = { ...b, receipt: { bound: (b.receipt as { bound: number }).bound / 4 } };
    expect(receiptHolds(b, p.a, p.b)).toBe(true);
    expect(receiptHolds(low, p.a, p.b)).toBe(false);
    expect(BOUND_SAFETY).toBeGreaterThan(1);
    const q = pairs.find((x) => x.id === 'sphere-sphere/circle')!;
    const c = run(q).branches[0]!;
    const off = {
      ...c,
      curve: {
        ...(c.curve as { radius: number }),
        radius: (c.curve as { radius: number }).radius * 1.001,
      },
    };
    expect(receiptHolds(off as typeof c, q.a, q.b)).toBe(false);
  });

  it('class C disjoint pairs return no branches and no partial', () => {
    const sc = [
      { kind: 'sphere', frame: makeFrame([3, 0, 0], Z), radius: 2 },
      { kind: 'cylinder', frame: makeFrame([0, 0, 0], Z), radius: 0.5 },
    ] as unknown as [AnalyticSurface, AnalyticSurface];
    const pc = [
      { kind: 'cylinder', frame: makeFrame([0, 0, 0], Z), radius: 1 },
      { kind: 'cylinder', frame: makeFrame([2.5, 0, 0], [0, 1, 0]), radius: 0.5 },
    ] as unknown as [AnalyticSurface, AnalyticSurface];
    expect(must(err(...sc))).toEqual({ branches: [], partials: [] });
    expect(must(err(...pc))).toEqual({ branches: [], partials: [] });
  });

  it('class C keeps axial centre offsets: sphere and perpendicular cylinder receipts hold', () => {
    const sc = [
      { kind: 'sphere', frame: makeFrame([2, 0, 0.7], Z), radius: 2 },
      { kind: 'cylinder', frame: makeFrame([0, 0, 0], Z), radius: 0.5 },
    ] as unknown as [AnalyticSurface, AnalyticSurface];
    const scOut = must(err(...sc));
    expect(scOut.branches.length).toBe(1);
    expect(scOut.branches.every((br) => receiptHolds(br, sc[0], sc[1]))).toBe(true);
    const pc = [
      { kind: 'cylinder', frame: makeFrame([0, 0, 0], Z), radius: 1 },
      { kind: 'cylinder', frame: makeFrame([0.4, 0, 0.6], [0, 1, 0]), radius: 0.5 },
    ] as unknown as [AnalyticSurface, AnalyticSurface];
    const pcOut = must(err(...pc));
    expect(pcOut.branches.length).toBe(2);
    expect(pcOut.branches.every((br) => receiptHolds(br, pc[0], pc[1]))).toBe(true);
  });

  it('class C fails closed on a sub-tolerance thin perpendicular cylinder and on a skewed near-perpendicular pair', () => {
    const thin = [
      { kind: 'cylinder', frame: makeFrame([0, 0, 0], Z), radius: 2 },
      { kind: 'cylinder', frame: makeFrame([Math.sqrt(3), 0, 0], [0, 1, 0]), radius: E1_TOL / 2 },
    ] as unknown as [AnalyticSurface, AnalyticSurface];
    const thinOut = must(err(...thin));
    expect(thinOut.branches).toEqual([]);
    expect(thinOut.partials).toEqual([
      { code: 'brep-ssi-unsupported', surfaces: [5, 6], gap: null },
    ]);
    const u = Math.sqrt(1 + 5e-4 * 5e-4);
    const skew = [
      { kind: 'cylinder', frame: makeFrame([0, 0, 0], Z), radius: 1 },
      { kind: 'cylinder', frame: makeFrame([0.4, 0, 0], [0, 1 / u, 5e-4 / u]), radius: 0.5 },
    ] as unknown as [AnalyticSurface, AnalyticSurface];
    const skewOut = must(err(...skew));
    expect(skewOut.branches).toEqual([]);
    expect(skewOut.partials).toEqual([
      { code: 'brep-ssi-unsupported', surfaces: [5, 6], gap: null },
    ]);
  });

  it('class C resolves a large-radius arc whose angular span is below tolerance (length, not angle, is guarded)', () => {
    const big = { c: [0, 0, 0] as P3, r: 1000 };
    const pair = [
      { kind: 'cylinder', frame: makeFrame([0, 0, 0], Z), radius: 48.33275723455087 },
      {
        kind: 'cylinder',
        frame: makeFrame([0.00333002534277906, 0, 0], [0, 1, 0]),
        radius: 0.00031829241316517695,
      },
    ] as unknown as [AnalyticSurface, AnalyticSurface];
    const out = must(intersectSurfaces(pair[0], pair[1], E1_TOL, { window: big, ids: [5, 6] }));
    expect(out.partials).toEqual([]);
    expect(out.branches.length).toBe(2);
    expect(out.branches.every((br) => receiptHolds(br, pair[0], pair[1]))).toBe(true);
  });

  it('results are frozen and carry closed-form receipts for class A and B', () => {
    const p = pairs.find((q) => q.id === 'cone-cone/coaxial')!;
    const out = run(p);
    expect(Object.isFrozen(out)).toBe(true);
    expect(out.branches.every((b) => b.receipt === 'closed-form')).toBe(true);
  });
});

describe('B-E1a2 class A: coaxial windows and falsifiers', () => {
  const Z: P3 = [0, 0, 1];
  const near = 0.5 * E1_TOL;
  const mid = 5 * E1_TOL;
  const far = 20 * E1_TOL;
  const win = { c: [0, 0, 0] as P3, r: 4 };
  const err = (a: AnalyticSurface, b: AnalyticSurface) =>
    must(intersectSurfaces(a, b, E1_TOL, { window: win, ids: [5, 6] }));
  const radiusOf = (b: { curve: unknown }) => (b.curve as { radius: number }).radius;
  const sphereCyl = (seed: number, rc: number, rs = 1) =>
    flatten(
      moved(
        seed,
        { kind: 'sphere', o: [0, 0, 0], z: Z, radius: rs },
        { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: rc },
      ),
    );
  const spheres = (seed: number, gap: number, ra: number, rb: number) =>
    flatten(
      moved(
        seed,
        { kind: 'sphere', o: [0, 0, 0], z: Z, radius: ra },
        { kind: 'sphere', o: [0, 0, ra + rb + gap], z: Z, radius: rb },
      ),
    );

  it('a gap between 5 tol and 20 tol is a miss, not a tangent, and just inside crosses', () => {
    for (const seed of [3, 4]) {
      for (const g of [mid, -mid]) {
        const sc = err(...sphereCyl(seed, 1 + g));
        expect(sc.partials, `sphere-cylinder ${g}`).toEqual(g > 0 ? [] : expect.anything());
        if (g > 0) expect(sc.branches).toEqual([]);
        else expect(sc.branches).toHaveLength(2);
        const ss = err(...spheres(seed, g, 1, 0.6));
        if (g > 0) expect(ss).toEqual({ branches: [], partials: [] });
        else {
          expect(ss.partials).toEqual([]);
          expect(ss.branches).toHaveLength(1);
        }
      }
      for (const g of [near, -near, 0]) {
        const ss = err(...spheres(seed, g, 1, 0.6));
        expect(ss.branches, `gap ${g}`).toEqual([]);
        expect(ss.partials[0]?.code).toBe('brep-ssi-tangent');
        expect(ss.partials[0]?.gap).toBeCloseTo(g, 12);
      }
    }
  });

  it('nested and concentric spheres: internal tangency, nesting, containment and coincidence', () => {
    const inner = (seed: number, shift: number, rb = 0.5) =>
      flatten(
        moved(
          seed,
          { kind: 'sphere', o: [0, 0, 0], z: Z, radius: 1 },
          { kind: 'sphere', o: [0, 0, shift], z: Z, radius: rb },
        ),
      );
    for (const seed of [3, 4]) {
      for (const s of [0.5, 0.5 + near, 0.5 - near]) {
        const out = err(...inner(seed, s));
        expect(out.branches, `shift ${s}`).toEqual([]);
        expect(out.partials[0]?.code, `shift ${s}`).toBe('brep-ssi-tangent');
      }
      expect(err(...inner(seed, 0.5 - mid))).toEqual({ branches: [], partials: [] });
      expect(err(...inner(seed, 0.5 + mid)).branches).toHaveLength(1);
      expect(err(...inner(seed, 0.2))).toEqual({ branches: [], partials: [] });
      expect(err(...inner(seed, 0))).toEqual({ branches: [], partials: [] });
      const same = err(...inner(seed, 0, 1));
      expect(same.branches).toEqual([]);
      expect(same.partials[0]?.code).toBe('brep-ssi-coincident');
    }
  });

  it('a radius offset inside tol is coincident, outside is empty, for cylinders, spheres and cones', () => {
    for (const seed of [3, 4]) {
      for (const dr of [near, -near]) {
        const cy = flatten(
          moved(
            seed,
            { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 1 },
            { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 1 + dr },
          ),
        );
        const out = err(...cy);
        expect(out.partials[0]?.code).toBe('brep-ssi-coincident');
        expect(out.partials[0]?.gap).toBeCloseTo(Math.abs(dr), 12);
        const sp = flatten(
          moved(
            seed,
            { kind: 'sphere', o: [0, 0, 0], z: Z, radius: 1 },
            { kind: 'sphere', o: [0, 0, 0], z: Z, radius: 1 + dr },
          ),
        );
        expect(err(...sp).partials[0]?.code).toBe('brep-ssi-coincident');
        const ko = flatten(
          moved(
            seed,
            { kind: 'cone', o: [0, 0, 0], z: Z, radius: 1, halfAngle: 0.4 },
            { kind: 'cone', o: [0, 0, 0], z: Z, radius: 1 + dr, halfAngle: 0.4 },
          ),
        );
        expect(err(...ko).partials[0]?.code).toBe('brep-ssi-coincident');
      }
      const apart = flatten(
        moved(
          seed,
          { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 1 },
          { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 1 + mid },
        ),
      );
      expect(err(...apart)).toEqual({ branches: [], partials: [] });
      const cones = flatten(
        moved(
          seed,
          { kind: 'cone', o: [0, 0, 0], z: Z, radius: 1, halfAngle: 0.4 },
          { kind: 'cone', o: [0, 0, 0], z: Z, radius: 1 + mid, halfAngle: 0.4 },
        ),
      );
      // Two cones of one axis and half-angle, offset in radius, are translates along the axis:
      // their nappes meet in one ring at radius mid / 2 (a double-nappe cone surface).
      const coneOut = err(...cones);
      expect(coneOut.partials).toEqual([]);
      expect(coneOut.branches).toHaveLength(1);
      for (const br of coneOut.branches) expect(receiptHolds(br, cones[0], cones[1])).toBe(true);
      const ax = cones[0].frame;
      const q = curvePoint(coneOut.branches[0]!.curve, coneOut.branches[0]!.t0);
      const d = [0, 1, 2].map((i) => q[i]! - ax.o[i]!);
      const along = d[0]! * ax.z[0]! + d[1]! * ax.z[1]! + d[2]! * ax.z[2]!;
      const radial = Math.hypot(
        ...([0, 1, 2].map((i) => d[i]! - along * ax.z[i]!) as [number, number, number]),
      );
      expect(radial).toBeCloseTo(mid / 2, 9);
    }
  });

  it('a near-coaxial ring carries a bound at least its axis offset, so the receipt is never closed-form', () => {
    for (const seed of [3, 4]) {
      for (const off of [0.2 * E1_TOL, -0.2 * E1_TOL]) {
        const pair = flatten(
          moved(
            seed,
            { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 1 },
            { kind: 'cone', o: [off, 0, 0], z: Z, radius: 0.5, halfAngle: 0.4 },
          ),
        );
        const out = err(...pair);
        expect(out.branches.length).toBeGreaterThan(0);
        for (const br of out.branches) {
          expect(br.receipt).not.toBe('closed-form');
          expect((br.receipt as { bound: number }).bound).toBeGreaterThanOrEqual(
            0.2 * E1_TOL * 0.999,
          );
        }
      }
    }
  });

  it('coincident gaps of one pair report the smallest gap, not the largest', () => {
    const pair = flatten(
      moved(
        3,
        { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 1 },
        { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 1 + 0.9 * E1_TOL },
      ),
    );
    const out = err(...pair);
    expect(out.partials).toHaveLength(1);
    expect(out.partials[0]?.gap).toBeCloseTo(0.9 * E1_TOL, 10);
  });

  it('an axis offset beyond half a tolerance is not coaxial, and a horn torus is unsupported', () => {
    for (const seed of [3, 4]) {
      for (const off of [0.2 * E1_TOL, -0.2 * E1_TOL]) {
        const ok1 = flatten(
          moved(
            seed,
            { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 1 },
            { kind: 'cone', o: [off, 0, 0], z: Z, radius: 0.5, halfAngle: 0.4 },
          ),
        );
        // A cylinder meets both nappes of the offset double cone: two rings, each on both surfaces.
        const out1 = err(...ok1);
        expect(out1.branches).toHaveLength(2);
        expect(out1.partials).toEqual([]);
        for (const br of out1.branches) expect(receiptHolds(br, ok1[0], ok1[1])).toBe(true);
      }
      for (const off of [2 * E1_TOL, 0.01]) {
        const skew = flatten(
          moved(
            seed,
            { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 1 },
            { kind: 'cone', o: [off, 0, 0], z: Z, radius: 0.5, halfAngle: 0.4 },
          ),
        );
        const out = err(...skew);
        expect(out.branches).toEqual([]);
        expect(out.partials[0]?.code).toBe('brep-ssi-unsupported');
      }
      const torus = (minor: number) =>
        flatten(
          moved(
            seed,
            { kind: 'sphere', o: [0, 0, 0], z: Z, radius: 1.2 },
            { kind: 'torus', o: [0, 0, 0], z: Z, major: 0.8, minor },
          ),
        );
      for (const minor of [0.8, 0.8 - near, 0.8 + near]) {
        expect(err(...torus(minor)).partials[0]?.code, `minor ${minor}`).toBe(
          'brep-ssi-unsupported',
        );
      }
      expect(err(...torus(0.8 - far)).branches.length).toBeGreaterThan(0);
      // A horn torus (major = minor) against a coaxial cylinder is unsupported, not a coaxial ring.
      const horn = flatten(
        moved(
          seed,
          { kind: 'cylinder', o: [0, 0, 0], z: Z, radius: 0.8 },
          { kind: 'torus', o: [0, 0, 0], z: Z, major: 0.8, minor: 0.8 },
        ),
      );
      expect(err(...horn).partials[0]?.code).toBe('brep-ssi-unsupported');
      expect(err(...horn).branches).toEqual([]);
    }
  });

  it('a cone apex on a sphere is one tangent touch plus the ring, never a degenerate ring', () => {
    for (const seed of [3, 4, 5]) {
      for (const lift of [0, 0.3 * E1_TOL, -0.3 * E1_TOL]) {
        const pair = flatten(
          moved(
            seed,
            { kind: 'cone', o: [0, 0, 0], z: Z, radius: 0, halfAngle: 0.5 },
            { kind: 'sphere', o: [0, 0, 1 + lift], z: Z, radius: 1 },
          ),
        );
        const out = err(...pair);
        expect(
          out.partials.map((x) => x.code),
          `lift ${lift}`,
        ).toEqual(['brep-ssi-tangent']);
        expect(out.branches, `lift ${lift}`).toHaveLength(1);
        expect(radiusOf(out.branches[0]!)).toBeGreaterThan(0.1);
        const c = out.partials[0]!.contact!;
        expect(dist3(c, pair[0]!.frame.o)).toBeLessThan(2 * E1_TOL);
      }
    }
  });

  it('two tori of equal major radius cross in two rings ordered by axis position then radius', () => {
    for (const seed of [3, 4]) {
      const pair = flatten(
        moved(
          seed,
          { kind: 'torus', o: [0, 0, 0], z: Z, major: 1, minor: 0.4 },
          { kind: 'torus', o: [0, 0, 0.5], z: Z, major: 1, minor: 0.4 },
        ),
      );
      const out = err(...pair);
      expect(out.branches).toHaveLength(2);
      const rs = out.branches.map(radiusOf);
      expect(rs[0]!).toBeLessThan(rs[1]!);
      const sphereCone = pairs.find((q) => q.id === 'sphere-cone/coaxial')!;
      const rings = run(sphereCone).branches;
      const axis = sphereCone.a.frame.z;
      const along = rings.map((b) => dot3(curvePoint(b.curve, b.t0), axis));
      expect(along[0]!).toBeLessThan(along[1]!);
    }
  });

  it('a tangent contact lies on both surfaces', () => {
    for (const seed of [3, 4, 5]) {
      for (const g of [0, near, -near]) {
        const [a, b] = sphereCyl(seed, 1 - g);
        const c = err(a, b).partials[0]!.contact!;
        expect(Math.abs(implicit(a, c))).toBeLessThan(2 * E1_TOL);
        expect(Math.abs(implicit(b, c))).toBeLessThan(2 * E1_TOL);
      }
    }
  });
});

function subv(a: P3, b: P3): P3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
