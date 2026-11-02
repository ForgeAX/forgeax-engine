import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { type NurbsSurface, nurbs } from '../nurbs';
import { checkSurfaceQuality } from '../surface-quality';

/** Deterministic generator (Park-Miller) so failures reproduce. */
function rng(seed: number): () => number {
  let state = seed;
  const next = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
  // The first draws of a small seed are tiny; skip them.
  for (let k = 0; k < 4; k++) next();
  return next;
}

function knotVector(rand: () => number, p: number, count: number): number[] {
  const interior: number[] = [];
  for (let k = 0; k < count - p - 1; k++) interior.push(0.05 + 0.9 * rand());
  interior.sort((a, b) => a - b);
  // A repeated interior knot now and then (multiplicity up to the degree).
  if (interior.length >= 2 && p >= 2 && rand() < 0.4) interior[1] = interior[0] as number;
  return [...new Array<number>(p + 1).fill(0), ...interior, ...new Array<number>(p + 1).fill(1)];
}

function randomSurface(seed: number, rational = false): NurbsSurface {
  const rand = rng(seed);
  const p = 1 + Math.floor(rand() * 4);
  const q = 1 + Math.floor(rand() * 4);
  const nu = p + 1 + Math.floor(rand() * 4);
  const nv = q + 1 + Math.floor(rand() * 4);
  const points = Array.from({ length: nu }, (_, i) =>
    Array.from({ length: nv }, (_, j): Tuple3 => [i + rand() * 0.5, j + rand() * 0.5, rand()]),
  );
  const base = {
    degreeU: p,
    degreeV: q,
    points,
    knotsU: knotVector(rand, p, nu),
    knotsV: knotVector(rand, q, nv),
  };
  return rational ? { ...base, weights: points.map((row) => row.map(() => 0.5 + rand())) } : base;
}

const dist = (a: Tuple3, b: Tuple3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Largest distance between two surfaces over 2048 random points of `on`'s domain. */
function deviation(a: NurbsSurface, b: NurbsSurface, seed = 1, on: NurbsSurface = a): number {
  const rand = rng(seed);
  const [[u0, u1], [v0, v1]] = nurbs.surfaceDomain(on);
  let worst = 0;
  for (let k = 0; k < 2048; k++) {
    const u = u0 + (u1 - u0) * rand();
    const v = v0 + (v1 - v0) * rand();
    worst = Math.max(worst, dist(nurbs.surfacePoint(a, u, v), nurbs.surfacePoint(b, u, v)));
  }
  return worst;
}

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};

const SEEDS = Array.from({ length: 12 }, (_, k) => 101 + 37 * k);

describe('surface algebra', () => {
  it('keeps the shape through knot insertion and refinement in both directions', () => {
    for (const [k, seed] of SEEDS.entries()) {
      const s = randomSurface(seed, k % 3 === 0);
      for (const dir of ['u', 'v'] as const) {
        const inserted = unwrap(nurbs.surface.insertKnot(s, dir, 0.37, 2));
        const refined = unwrap(nurbs.surface.refine(s, dir, [0.2, 0.5, 0.5, 0.81]));
        for (const out of [inserted, refined]) {
          expect(nurbs.checkSurface(out).ok).toBe(true);
          expect(deviation(s, out, seed)).toBeLessThanOrEqual(1e-12);
        }
        const count = (x: NurbsSurface) =>
          dir === 'u' ? x.points.length : (x.points[0] as Tuple3[]).length;
        expect(count(inserted)).toBeGreaterThan(count(s));
      }
    }
  });

  it('elevates exactly, keeping each interior knot at its multiplicity + by', () => {
    for (const [k, seed] of SEEDS.entries()) {
      const s = randomSurface(seed, k % 4 === 1);
      for (const dir of ['u', 'v'] as const) {
        for (const by of [1, 2]) {
          const e = unwrap(nurbs.surface.elevate(s, dir, by));
          expect(nurbs.checkSurface(e).ok).toBe(true);
          expect(deviation(s, e, seed + by)).toBeLessThanOrEqual(1e-12);
          const knots = dir === 'u' ? s.knotsU : s.knotsV;
          const p = dir === 'u' ? s.degreeU : s.degreeV;
          const spans = new Set(knots.slice(p + 1, knots.length - p - 1)).size + 1;
          const before = dir === 'u' ? s.points.length : (s.points[0] as Tuple3[]).length;
          const after = dir === 'u' ? e.points.length : (e.points[0] as Tuple3[]).length;
          expect(after).toBe(before + by * spans);
          expect(dir === 'u' ? e.degreeU : e.degreeV).toBe(p + by);
        }
      }
    }
  });

  it('falsifier: an elevation missing one control row fails the shape test', () => {
    // A cubic or higher in u: a dropped row of an elevated linear piece can be redundant.
    const base = Array.from({ length: 64 }, (_, k) => randomSurface(k + 1)).find(
      (x) => x.degreeU >= 3,
    ) as NurbsSurface;
    const s = unwrap(nurbs.surface.refine(base, 'u', [0.5]));
    const e = unwrap(nurbs.surface.elevate(s, 'u', 1));
    const mid = e.points.length >> 1;
    // Drop a row and one copy of the interior knot so the net stays structurally valid.
    const knots = [...e.knotsU];
    knots.splice(knots.indexOf(0.5), 1);
    const broken: NurbsSurface = {
      ...e,
      points: e.points.filter((_, i) => i !== mid),
      knotsU: knots,
    };
    expect(nurbs.checkSurface(broken).ok).toBe(true);
    expect(deviation(s, broken)).toBeGreaterThan(1e-6);
  });

  it('splits at an isoparm into two halves that are exactly G2 across the cut', () => {
    for (const [k, seed] of SEEDS.entries()) {
      const s = randomSurface(seed, k % 3 === 2);
      for (const dir of ['u', 'v'] as const) {
        const [a, b] = unwrap(nurbs.surface.split(s, dir, 0.43));
        expect(deviation(s, a, seed, a)).toBeLessThanOrEqual(1e-12);
        expect(deviation(s, b, seed, b)).toBeLessThanOrEqual(1e-12);
        const [[, au1], [, av1]] = nurbs.surfaceDomain(a);
        const [[bu0], [bv0]] = nurbs.surfaceDomain(b);
        expect(dir === 'u' ? [au1, bu0] : [av1, bv0]).toEqual([0.43, 0.43]);
        // The cut is the same polynomial on both sides: derivatives up to order 2 agree.
        for (const f of [0.1, 0.5, 0.9]) {
          const [[u0, u1], [v0, v1]] = nurbs.surfaceDomain(s);
          const [u, v] = dir === 'u' ? [0.43, v0 + (v1 - v0) * f] : [u0 + (u1 - u0) * f, 0.43];
          const da = nurbs.surfaceDerivatives(a, u, v, 2);
          const db = nurbs.surfaceDerivatives(b, u, v, 2);
          const ds = nurbs.surfaceDerivatives(s, u, v, 2);
          const scale = (x: Tuple3) => 1 + Math.hypot(...x);
          for (const [i, j] of [
            [0, 0],
            [1, 0],
            [0, 1],
            [2, 0],
            [1, 1],
            [0, 2],
          ] as const) {
            const ref = (ds[i] as Tuple3[])[j] as Tuple3;
            const x = (da[i] as Tuple3[])[j] as Tuple3;
            const y = (db[i] as Tuple3[])[j] as Tuple3;
            expect(dist(x, y) / scale(ref)).toBeLessThan(1e-9);
          }
        }
      }
    }
  });

  it('reports split halves as G3 (beyond G2) at the surface-quality tolerances', () => {
    const grid = Array.from({ length: 6 }, (_, i) =>
      Array.from({ length: 5 }, (_, j): Tuple3 => [i * 0.2, j * 0.15, 0.05 * Math.sin(i + j)]),
    );
    const s = unwrap(nurbs.grid(grid));
    const [a, b] = unwrap(nurbs.surface.split(s, 'u', 0.5));
    const report = unwrap(
      checkSurfaceQuality(
        {
          surfaces: [
            { name: 'a', surface: a },
            { name: 'b', surface: b },
          ],
        },
        { position: 1e-5, angle: 0.1, continuity: 'G2', maxNet: [32, 32], isoparms: 0 },
      ),
    );
    const edge = report.edges.find((e) => e.a === 'a' && e.b === 'b');
    expect(edge?.achieved).toBe('G3');
    expect(edge?.gap.value).toBeLessThanOrEqual(1e-12);
  });

  it('rejects an out-of-domain or end split and an unknown direction', () => {
    const s = randomSurface(SEEDS[0] as number);
    for (const t of [-0.1, 0, 1, 1.5, Number.NaN]) {
      const r = nurbs.surface.split(s, 'u', t);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
    }
    const bad = nurbs.surface.insertKnot(s, 'w' as never, 0.5);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('model-invalid-argument');
  });

  it('extends a patch by a length, keeping the original part and the side continuity', () => {
    for (const [k, seed] of SEEDS.slice(0, 8).entries()) {
      const s = randomSurface(seed, k % 4 === 3);
      for (const side of ['u0', 'u1', 'v0', 'v1'] as const) {
        for (const continuity of ['G1', 'G2'] as const) {
          const e = unwrap(nurbs.surface.extend(s, side, 0.3, { continuity }));
          expect(nurbs.checkSurface(e).ok).toBe(true);
          // The original domain is unchanged in shape (extension excluded).
          expect(deviation(e, s, seed, s)).toBeLessThan(1e-9);
          const dir = side[0] as 'u' | 'v';
          const [[su0, su1], [sv0, sv1]] = nurbs.surfaceDomain(s);
          const [[eu0, eu1], [ev0, ev1]] = nurbs.surfaceDomain(e);
          const old = side === 'u0' ? su0 : side === 'u1' ? su1 : side === 'v0' ? sv0 : sv1;
          const now = side === 'u0' ? eu0 : side === 'u1' ? eu1 : side === 'v0' ? ev0 : ev1;
          expect(side.endsWith('0') ? now < old : now > old).toBe(true);
          // Reach: mean distance between old and new side.
          let sum = 0;
          for (let i = 0; i <= 16; i++) {
            const f = i / 16;
            const along = dir === 'u' ? sv0 + (sv1 - sv0) * f : su0 + (su1 - su0) * f;
            const p =
              dir === 'u' ? nurbs.surfacePoint(s, old, along) : nurbs.surfacePoint(s, along, old);
            const q =
              dir === 'u' ? nurbs.surfacePoint(e, now, along) : nurbs.surfacePoint(e, along, now);
            sum += dist(p, q);
          }
          expect(Math.abs(sum / 17 - 0.3)).toBeLessThan(1e-6);
          // Continuity across the old side: first (G1) or second (G2) derivatives agree.
          const order = continuity === 'G1' ? 1 : 2;
          const h = 1e-7;
          const along = dir === 'u' ? (sv0 + sv1) / 2 : (su0 + su1) / 2;
          const inside = side.endsWith('0') ? old + h : old - h;
          const outside = side.endsWith('0') ? old - h : old + h;
          const at = (x: number) =>
            nurbs.surfaceDerivatives(e, dir === 'u' ? x : along, dir === 'u' ? along : x, order);
          const di = at(inside);
          const doo = at(outside);
          const pick = (d: Tuple3[][]) =>
            (dir === 'u' ? (d[order] as Tuple3[])[0] : (d[0] as Tuple3[])[order]) as Tuple3;
          const ref = pick(
            nurbs.surfaceDerivatives(
              s,
              dir === 'u' ? old : along,
              dir === 'u' ? along : old,
              order,
            ),
          );
          expect(dist(pick(di), pick(doo)) / (1 + Math.hypot(...ref))).toBeLessThan(1e-4);
        }
      }
    }
  });

  it('keeps the net of a natural (G2) extension; a G1 extension adds one span', () => {
    const s = randomSurface(SEEDS[5] as number);
    const g2 = unwrap(nurbs.surface.extend(s, 'u1', 0.2));
    expect(g2.points.length).toBe(s.points.length);
    const g1 = unwrap(nurbs.surface.extend(s, 'u1', 0.2, { continuity: 'G1' }));
    expect(g1.points.length).toBe(s.points.length + s.degreeU - 1);
    const bad = nurbs.surface.extend(s, 'u1', -1);
    expect(bad.ok).toBe(false);
  });

  it('makes surfaces compatible along a direction without changing their shapes', () => {
    const surfaces = SEEDS.slice(0, 4).map((seed, k) => randomSurface(seed, k === 1));
    for (const dir of ['u', 'v'] as const) {
      const out = unwrap(nurbs.surface.compatible(surfaces, dir));
      const first = out[0] as NurbsSurface;
      for (const [k, s] of out.entries()) {
        expect(dir === 'u' ? s.degreeU : s.degreeV).toBe(
          dir === 'u' ? first.degreeU : first.degreeV,
        );
        expect(dir === 'u' ? s.knotsU : s.knotsV).toEqual(
          dir === 'u' ? first.knotsU : first.knotsV,
        );
        const original = surfaces[k] as NurbsSurface;
        // The compatible surface is on [0, 1] along dir; the originals already are.
        expect(deviation(original, s, k + 3)).toBeLessThanOrEqual(1e-12);
      }
    }
  });
});

it('covers degrees 1 to 4 in both directions', () => {
  const degrees = new Set(
    SEEDS.map((seed) => randomSurface(seed)).flatMap((s) => [`u${s.degreeU}`, `v${s.degreeV}`]),
  );
  expect(degrees.size).toBeGreaterThanOrEqual(6);
});
