import type { Tuple3 } from '../../../geom';
import { type NurbsSurface, nurbs, surfaceDerivatives, surfaceDomain } from '../../../nurbs';
import { makeFrame } from '../../surfaces';
import type { Frame } from '../../types';
import { cross3, dot3, type P3, unit3 } from '../../vec';
import fixture from './fixtures/g16-skin-lines.json';
import { heightField, ribbon, tube } from './freeform';
import { type Prng, prng } from './prng';
import { diagonal, type Truth } from './truth';
import { type Implicit, implicit, type Patch, posed, wrap } from './wrap';

export interface SsiPair {
  readonly id: string;
  readonly kind: 'analytic' | 'freeform';
  readonly seed: number;
  readonly note: string;
  readonly a: NurbsSurface;
  readonly b: NurbsSurface;
  /** Dense-sampling reference: samples `a` and evaluates the signed function of `b`. */
  readonly truth: Truth;
  /** Branch count and closed-branch count fixed by construction (analytic pairs only; freeform counts come from sampling). */
  readonly designed?: { readonly branches: number; readonly closed: number };
  /** Branch lengths from a closed form, sorted ascending (circles only). */
  readonly exactLengths?: readonly number[];
  /** Analytic pairs: the exact implicit function of each surface (0 on it). */
  readonly implicits?: { readonly a: Implicit; readonly b: Implicit };
  /** The analytic patches the NURBS sides wrap (`a` absent when face a is free-form). */
  readonly patches?: { readonly a?: Patch; readonly b: Patch };
  readonly diagonal: number;
}

const PI = Math.PI;
const frame = (o: P3, z: P3, x: P3 = [1, 0, 0]): Frame => makeFrame(o, z, x);

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** A seeded rigid pose: uniform axis, free spin, translation within `reach`. */
function pose(rng: Prng, reach: number): Frame {
  const z = rng.direction();
  const spin = rng.direction();
  return frame(
    [rng.range(-reach, reach), rng.range(-reach, reach), rng.range(-reach, reach)],
    z,
    spin,
  );
}

const jitter = (rng: Prng, v: number, rel: number): number => v * (1 + rng.range(-rel, rel));

interface AnalyticSpec {
  readonly id: string;
  readonly note: string;
  readonly designed: { branches: number; closed: number };
  readonly build: (rng: Prng) => {
    readonly a: Patch;
    readonly b: Patch;
    readonly exact?: readonly number[];
  };
}

const plane = (o: P3, z: P3, half: number, x?: P3): Patch => ({
  surface: { kind: 'plane', frame: frame(o, z, x) },
  v: [0, 0],
  half,
});
const cylinder = (o: P3, z: P3, radius: number, v: readonly [number, number], x?: P3): Patch => ({
  surface: { kind: 'cylinder', frame: frame(o, z, x), radius },
  v,
  half: 0,
});
const sphere = (o: P3, radius: number): Patch => ({
  surface: { kind: 'sphere', frame: frame(o, [0, 0, 1]), radius },
  v: [0, 0],
  half: 0,
});
const cone = (o: P3, radius: number, halfAngle: number, v: readonly [number, number]): Patch => ({
  surface: { kind: 'cone', frame: frame(o, [0, 0, 1]), radius, halfAngle },
  v,
  half: 0,
});
const torus = (o: P3, major: number, minor: number): Patch => ({
  surface: { kind: 'torus', frame: frame(o, [0, 0, 1]), major, minor },
  v: [0, 0],
  half: 0,
});

const SPECS: readonly AnalyticSpec[] = [
  {
    id: 'plane-plane',
    note: 'two crossing finite planes: one line',
    designed: { branches: 1, closed: 0 },
    build: (r) => {
      const t = r.range(0.4, 1.0);
      return {
        a: plane([0, 0, 0], [0, 0, 1], 3),
        b: plane([r.range(-0.3, 0.3), 0, 0], [Math.sin(t), 0, Math.cos(t)], 3),
      };
    },
  },
  {
    id: 'plane-cylinder-oblique',
    note: 'plane across a tilted cylinder: one ellipse',
    designed: { branches: 1, closed: 1 },
    build: (r) => {
      const t = r.range(0.3, 0.6);
      return {
        a: cylinder([0, 0, 0], [Math.sin(t), 0, Math.cos(t)], jitter(r, 1, 0.1), [-3, 3]),
        b: plane([0, 0, r.range(-0.3, 0.3)], [0, 0, 1], 4),
      };
    },
  },
  {
    id: 'plane-cylinder-parallel',
    note: 'plane parallel to the cylinder axis: two lines',
    designed: { branches: 2, closed: 0 },
    build: (r) => ({
      a: cylinder([0, 0, 0], [0, 0, 1], jitter(r, 1, 0.1), [-2, 2]),
      b: plane([r.range(-0.4, 0.4), 0, 0], [1, 0, 0], 4),
    }),
  },
  {
    id: 'plane-sphere',
    note: 'plane through a sphere: one circle',
    designed: { branches: 1, closed: 1 },
    build: (r) => {
      const R = jitter(r, 2, 0.1);
      const d = r.range(-0.9, 0.9);
      return {
        a: sphere([0, 0, 0], R),
        b: plane([0, 0, d], [0, 0, 1], 5),
        exact: [2 * PI * Math.sqrt(R * R - d * d)],
      };
    },
  },
  {
    id: 'plane-cone-across',
    note: 'plane across a cone: one ellipse',
    designed: { branches: 1, closed: 1 },
    build: (r) => {
      const t = r.range(0.05, 0.12);
      return {
        a: cone([0, 0, 0], 0.4, 0.35, [0, 4]),
        b: plane([0, 0, r.range(1.5, 2.5)], [Math.sin(t), 0, Math.cos(t)], 6),
      };
    },
  },
  {
    id: 'plane-cone-parallel',
    note: 'plane parallel to the cone axis: one hyperbola branch',
    designed: { branches: 1, closed: 0 },
    build: (r) => ({
      a: cone([0, 0, 0], 0.4, 0.35, [0, 4]),
      b: plane([r.range(0.7, 0.9), 0, 2], [1, 0, 0], 6),
    }),
  },
  {
    id: 'plane-torus-equator',
    note: 'equatorial plane of a torus: two coaxial circles',
    designed: { branches: 2, closed: 2 },
    build: (r) => {
      const R = jitter(r, 3, 0.05);
      const m = jitter(r, 1, 0.1);
      return {
        a: torus([0, 0, 0], R, m),
        b: plane([0, 0, 0], [0, 0, 1], 6),
        exact: [2 * PI * (R - m), 2 * PI * (R + m)],
      };
    },
  },
  {
    id: 'plane-torus-axial',
    note: 'plane through the torus axis: two tube sections',
    designed: { branches: 2, closed: 2 },
    build: (r) => {
      const m = jitter(r, 1, 0.1);
      return {
        a: torus([0, 0, 0], 3, m),
        b: plane([0, 0, 0], [0, 1, 0], 6),
        exact: [2 * PI * m, 2 * PI * m],
      };
    },
  },
  {
    id: 'plane-torus-parallel',
    note: 'plane parallel to the torus axis through the tube centres: one closed curve',
    designed: { branches: 1, closed: 1 },
    build: (r) => ({
      a: torus([0, 0, 0], 3, jitter(r, 1, 0.1)),
      b: plane([3 + r.range(-0.1, 0.1), 0, 0], [1, 0, 0], 6),
    }),
  },
  {
    id: 'sphere-sphere',
    note: 'two spheres: one circle',
    designed: { branches: 1, closed: 1 },
    build: (r) => {
      const R1 = jitter(r, 2, 0.1);
      const R2 = jitter(r, 1.5, 0.1);
      const d = r.range(1.8, 2.2);
      const a = (d * d + R1 * R1 - R2 * R2) / (2 * d);
      return {
        a: sphere([0, 0, 0], R1),
        b: sphere([0, 0, d], R2),
        exact: [2 * PI * Math.sqrt(R1 * R1 - a * a)],
      };
    },
  },
  {
    id: 'sphere-cylinder-through',
    note: 'narrow off-axis cylinder through a sphere: two loops',
    designed: { branches: 2, closed: 2 },
    build: (r) => ({
      a: sphere([0, 0, 0], 2),
      b: cylinder([r.range(0.3, 0.6), 0, 0], [0, 0, 1], jitter(r, 0.7, 0.1), [-3, 3]),
    }),
  },
  {
    id: 'cylinder-cylinder-through',
    note: 'thin cylinder through a thick one, axes crossing: two loops',
    designed: { branches: 2, closed: 2 },
    build: (r) => ({
      a: cylinder([0, 0, 0], [0, 0, 1], 1.5, [-3, 3]),
      b: cylinder([0, r.range(-0.2, 0.2), 0], [1, 0, 0], jitter(r, 0.6, 0.1), [-3, 3], [0, 1, 0]),
    }),
  },
  {
    id: 'cylinder-cylinder-skew',
    note: 'thin cylinder through a thick one, axes skew: two loops',
    designed: { branches: 2, closed: 2 },
    build: (r) => ({
      a: cylinder([0, 0, 0], [0, 0, 1], 1.5, [-3, 3]),
      b: cylinder([0, r.range(0.4, 0.6), r.range(0.2, 0.5)], [1, 0, 0], 0.6, [-3, 3], [0, 1, 0]),
    }),
  },
  {
    id: 'cylinder-cylinder-graze',
    note: 'cylinder cutting the wall of a thick one: one saddle loop',
    designed: { branches: 1, closed: 1 },
    build: (r) => ({
      a: cylinder([0, 0, 0], [0, 0, 1], 1.5, [-3, 3]),
      b: cylinder([0, r.range(1.1, 1.3), r.range(-0.3, 0.3)], [1, 0, 0], 0.8, [-3, 3], [0, 1, 0]),
    }),
  },
  {
    id: 'sphere-cone-coaxial',
    note: 'sphere centred on the cone apex: one circle',
    designed: { branches: 1, closed: 1 },
    build: (r) => {
      const R = jitter(r, 2, 0.1);
      const a = r.range(0.4, 0.6);
      return {
        a: cone([0, 0, 0], 0, a, [0.3, 5]),
        b: sphere([0, 0, 0], R),
        exact: [2 * PI * R * Math.sin(a)],
      };
    },
  },
  {
    id: 'torus-sphere-concentric',
    note: 'sphere of the major radius around a torus: two circles',
    designed: { branches: 2, closed: 2 },
    build: () => {
      const rho = 3 - 1 / 6;
      return {
        a: torus([0, 0, 0], 3, 1),
        b: sphere([0, 0, 0], 3),
        exact: [2 * PI * rho, 2 * PI * rho],
      };
    },
  },
  {
    id: 'torus-cylinder-coaxial',
    note: 'cylinder of the major radius around a torus axis: two circles',
    designed: { branches: 2, closed: 2 },
    build: () => ({
      a: torus([0, 0, 0], 3, 1),
      b: cylinder([0, 0, 0], [0, 0, 1], 3, [-2, 2]),
      exact: [6 * PI, 6 * PI],
    }),
  },
];

function analytic(spec: AnalyticSpec, index: number): SsiPair {
  const seed = 1000 + index;
  const rng = prng(seed);
  const built = spec.build(rng);
  const rigid = pose(rng, 2);
  const a = posed(built.a, rigid);
  const b = posed(built.b, rigid);
  const other = implicit(b);
  const sa = wrap(a);
  const sb = wrap(b);
  return {
    id: spec.id,
    kind: 'analytic',
    seed,
    note: spec.note,
    a: sa,
    b: sb,
    truth: {
      grid: sa,
      periodicU: a.surface.kind !== 'plane',
      periodicV: a.surface.kind === 'torus',
      g: (q) => (other.inside(q) ? other.f(q) : undefined),
    },
    designed: spec.designed,
    implicits: { a: implicit(a), b: other },
    patches: { a, b },
    ...(built.exact === undefined ? {} : { exactLengths: [...built.exact].sort((x, y) => x - y) }),
    diagonal: diagonal(sa, sb),
  };
}

// ---- freeform pairs ---------------------------------------------------------------------

function heightG(field: ReturnType<typeof heightField>): (q: Tuple3) => number | undefined {
  return (q) => {
    const h = field.height(q[0], q[1]);
    return h === undefined ? undefined : q[2] - h;
  };
}

function freeform(
  id: string,
  seed: number,
  note: string,
  a: NurbsSurface,
  b: NurbsSurface,
  g: (q: Tuple3) => number | undefined,
  periodicU = false,
  periodicV = false,
): SsiPair {
  return {
    id,
    kind: 'freeform',
    seed,
    note,
    a,
    b,
    truth: { grid: a, periodicU, periodicV, g },
    diagonal: diagonal(a, b),
  };
}

interface Line {
  readonly name: string;
  readonly degree: number;
  readonly points: readonly Tuple3[];
  readonly knots: readonly number[];
}

/**
 * The half hull skin of the G16 case (C-600 carrier, hull concept B): its 13 feature-line curves
 * through the drawn stations, skinned in one linear loft across the lines. u runs along the ship (z),
 * v across the half section from the keel centreline to the deck centreline.
 */
export function hullSkin(): NurbsSurface {
  const curves = (fixture.lines as unknown as Line[]).map((l) => ({
    degree: l.degree,
    points: l.points,
    knots: l.knots,
  }));
  return must(nurbs.loft(curves, { degree: 1, parametrization: 'uniform' }));
}

/** The skin with every control point moved by `distance` along the surface normal toward the hull interior: the inner face of the 0.15 m shell, to about 0.1 mm. */
export function innerSkin(skin: NurbsSurface, distance: number): NurbsSurface {
  const [[u0, u1], [v0, v1]] = surfaceDomain(skin);
  const greville = (
    knots: readonly number[],
    degree: number,
    i: number,
    a: number,
    b: number,
  ): number => {
    let s = 0;
    for (let k = 1; k <= degree; k++) s += knots[i + k] as number;
    return degree === 0 ? a : Math.min(b, Math.max(a, s / degree));
  };
  const points = skin.points.map((row, i) =>
    row.map((p, j): Tuple3 => {
      const u = greville(skin.knotsU, skin.degreeU, i, u0, u1);
      const v = greville(skin.knotsV, skin.degreeV, j, v0, v1);
      const d = surfaceDerivatives(skin, u, v, 1);
      const su = (d[1] as Tuple3[])[0] as Tuple3;
      const sv = (d[0] as Tuple3[])[1] as Tuple3;
      let n = unit3(cross3(su, sv));
      const inward = unit3([-p[0], 16 - p[1], 0]);
      if (dot3(n, inward) < 0) n = [-n[0], -n[1], -n[2]];
      return [p[0] + n[0] * distance, p[1] + n[1] * distance, p[2] + n[2] * distance];
    }),
  );
  return { ...skin, points };
}

/** Plate end face of the G16 case at station `s`: the plane z = 150 - s + 0.08 against the inner skin. */
function g16(station: number): SsiPair {
  const skin = innerSkin(hullSkin(), 0.15);
  const z = 150 - station + 0.08;
  const patch = plane([0, 0, z], [0, 0, 1], 200);
  const planeSurface = wrap(patch);
  const other = implicit(patch);
  const pair = freeform(
    `g16-plate-s${station}`,
    station,
    `thin plate end face at station ${station} against the 0.15 m shell inner skin of the carrier hull`,
    skin,
    planeSurface,
    (q) => (other.inside(q) ? other.f(q) : undefined),
  );
  return { ...pair, patches: { b: patch } };
}

function freeformPairs(): SsiPair[] {
  const out: SsiPair[] = [g16(35), g16(60), g16(100)];
  {
    const r = prng(5);
    const a = heightField(r, { size: 3, count: 5, amplitude: 0.5 });
    const b = heightField(r, { size: 3, count: 5, amplitude: 0.5, base: 0.1 });
    out.push(
      freeform(
        'sheet-sheet-bumpy',
        5,
        'two seeded bumpy height sheets crossing in several branches',
        a.surface,
        b.surface,
        heightG(b),
      ),
    );
  }
  {
    const r = prng(4);
    const a = heightField(r, { size: 3, count: 7, amplitude: 0.6 });
    const b = heightField(r, { size: 3, count: 7, amplitude: 0.6, base: 0.1 });
    out.push(
      freeform(
        'sheet-sheet-rough',
        4,
        'two rougher height sheets: six branches of very different length',
        a.surface,
        b.surface,
        heightG(b),
      ),
    );
  }
  {
    const r = prng(2003);
    const t = tube(r, { length: 4, sections: 6, radius: 0.8, wobble: 0.3 });
    const h = heightField(r, { size: 4, count: 6, amplitude: 0.25 });
    out.push(
      freeform(
        'tube-sheet',
        2003,
        'bent varying-radius tube across a gently bumpy sheet',
        t,
        h.surface,
        heightG(h),
        true,
        false,
      ),
    );
  }
  {
    const r = prng(2004);
    const t = tube(r, { length: 4, sections: 6, radius: 0.8, wobble: 0.2 });
    const h = heightField(r, { size: 4, count: 6, amplitude: 0.3, slope: 4 });
    out.push(
      freeform(
        'tube-ramp',
        2004,
        'bent tube across a steep bumpy ramp: closed loop',
        t,
        h.surface,
        heightG(h),
        true,
        false,
      ),
    );
  }
  {
    const r = prng(2005);
    const rb = ribbon(r, { length: 4, sections: 7, width: 1.5, twist: 0.7 });
    const h = heightField(r, { size: 4, count: 6, amplitude: 0.3 });
    out.push(
      freeform(
        'ribbon-sheet',
        2005,
        'twisted ribbon across a bumpy sheet',
        rb,
        h.surface,
        heightG(h),
      ),
    );
  }
  return out;
}

/** The 25 pairs of the SSI corpus: 17 analytic pairs wrapped as NURBS (seeded poses) and 8 non-analytic ones. */
export function ssiCorpus(): SsiPair[] {
  return [...SPECS.map(analytic), ...freeformPairs()];
}
