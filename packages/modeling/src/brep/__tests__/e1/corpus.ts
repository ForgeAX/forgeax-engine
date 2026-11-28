import { makeFrame } from '../../surfaces';
import { defaultTolerance } from '../../tolerance';
import type { Frame, Surface } from '../../types';
import { add3, cross3, madd3, type P3, scale3, TWO_PI, unit3 } from '../../vec';
import { type Prng, prng } from './prng';

/**
 * The E1 analytic-intersection corpus: 40 surface pairs, each with a closed-form reference for the
 * intersection set. Every reference is derived by hand from the two surface definitions in a canonical
 * pose, then moved by a seeded rigid motion together with both surfaces; nothing here calls the
 * intersection code under test.
 */
/** Surfaces the corpus builds: every E1 pair is analytic, so each member carries a `frame`. */
export type AnalyticSurface = Exclude<Surface, { readonly kind: 'nurbs' }>;

export type PairClass = 'full' | 'tangent-partial';

export const E1_DIAG = 16;
export const E1_TOL = defaultTolerance(E1_DIAG).tol;
/** Gap of a near-tangent pair, in tolerances: clearly outside the tangent window `|gap| <= tol`. */
export const E1_NEAR = 20 * E1_TOL;
/** Radius of the ball around the canonical origin in which references and truth are compared. */
export const E1_WINDOW = 4;

export interface RefBranch {
  readonly kind: string;
  readonly closed: boolean;
  readonly t0: number;
  readonly t1: number;
  readonly at: (t: number) => P3;
}

/** An authored pole or apex passage: `branch` at parameter `t` sits on that feature of surface `on`. */
export interface PoleClaim {
  readonly on: 'a' | 'b';
  readonly branch: number;
  readonly t: number;
  readonly feature: 'pole' | 'apex';
}

export interface E1Pair {
  readonly id: string;
  readonly seed: number;
  readonly a: AnalyticSurface;
  readonly b: AnalyticSurface;
  readonly expected: PairClass;
  /** Length-unit distance, measured in the window, to the nearest tangent configuration of the pair family; null when no family applies. */
  readonly gap: number | null;
  readonly branches: readonly RefBranch[];
  readonly poles: readonly PoleClaim[];
  readonly window: { readonly c: P3; readonly r: number };
}

export function classify(gap: number | null, tol: number): PairClass {
  return gap !== null && Math.abs(gap) <= tol ? 'tangent-partial' : 'full';
}

interface Draft {
  readonly a: AnalyticSurface;
  readonly b: AnalyticSurface;
  readonly expected?: PairClass;
  readonly gap: number | null;
  readonly branches: RefBranch[];
  readonly poles?: PoleClaim[];
}

const ORIGIN: P3 = [0, 0, 0];
const AXIS_Z: P3 = [0, 0, 1];
const W = E1_WINDOW;

function frameOf(o: P3, z: P3, phi: number): Frame {
  const f = makeFrame(o, z);
  const x = add3(scale3(f.x, Math.cos(phi)), scale3(f.y, Math.sin(phi)));
  return { o, x, y: cross3(f.z, x), z: f.z };
}
const plane = (o: P3, n: P3, phi: number): AnalyticSurface => ({
  kind: 'plane',
  frame: frameOf(o, n, phi),
});
const cylinder = (o: P3, z: P3, radius: number, phi: number): AnalyticSurface => ({
  kind: 'cylinder',
  frame: frameOf(o, z, phi),
  radius,
});
const sphere = (o: P3, z: P3, radius: number, phi: number): AnalyticSurface => ({
  kind: 'sphere',
  frame: frameOf(o, z, phi),
  radius,
});
const torus = (o: P3, z: P3, major: number, minor: number, phi: number): AnalyticSurface => ({
  kind: 'torus',
  frame: frameOf(o, z, phi),
  major,
  minor,
});
const R0 = 0.5;
/** Cone with its apex at `apex`; the frame sits where the radius is `R0`, so the apex is at `-R0 cot(alpha)` along the axis. */
const cone = (apex: P3, z: P3, halfAngle: number, phi: number): AnalyticSurface => ({
  kind: 'cone',
  frame: frameOf(madd3(apex, unit3(z), R0 / Math.tan(halfAngle)), z, phi),
  radius: R0,
  halfAngle,
});

const circle = (c: P3, e1: P3, e2: P3, r: number): RefBranch => ({
  kind: 'circle',
  closed: true,
  t0: 0,
  t1: TWO_PI,
  at: (t) => add3(c, add3(scale3(e1, r * Math.cos(t)), scale3(e2, r * Math.sin(t)))),
});
/** `c + cos t A + sin t B` with conjugate semi-diameters `A`, `B`. */
const ellipse = (c: P3, A: P3, B: P3): RefBranch => ({
  kind: 'ellipse',
  closed: true,
  t0: 0,
  t1: TWO_PI,
  at: (t) => add3(c, add3(scale3(A, Math.cos(t)), scale3(B, Math.sin(t)))),
});
const line = (o: P3, d: P3): RefBranch => ({
  kind: 'line',
  closed: false,
  t0: -3 * W,
  t1: 3 * W,
  at: (t) => madd3(o, unit3(d), t),
});
const open = (kind: string, at: (t: number) => P3): RefBranch => ({
  kind,
  closed: false,
  t0: -2 * W,
  t1: 2 * W,
  at,
});
const loop = (kind: string, at: (t: number) => P3): RefBranch => ({
  kind,
  closed: true,
  t0: 0,
  t1: TWO_PI,
  at,
});
const point = (p: P3): RefBranch => ({ kind: 'point', closed: false, t0: 0, t1: 0, at: () => p });

/** Right-hand perpendicular pair of a direction. */
function basis(n: P3): [P3, P3] {
  const f = makeFrame(ORIGIN, n);
  return [f.x, f.y];
}

type Build = (g: Prng) => Draft;

const phi = (g: Prng): number => g.range(0, TWO_PI);

const psCircle: Build = (g) => {
  const R = g.range(1.5, 2.5);
  const d = R * g.range(0.2, 0.7);
  const n = g.direction();
  const [e1, e2] = basis(n);
  return {
    a: plane(scale3(n, d), n, phi(g)),
    b: sphere(ORIGIN, AXIS_Z, R, phi(g)),
    gap: R - d,
    branches: [circle(scale3(n, d), e1, e2, Math.sqrt(R * R - d * d))],
  };
};

const psGreatPole: Build = (g) => {
  const R = g.range(1.5, 2.5);
  const side = unit3(cross3(AXIS_Z, g.direction()));
  const e2 = cross3(side, AXIS_Z);
  return {
    a: plane(ORIGIN, side, phi(g)),
    b: sphere(ORIGIN, AXIS_Z, R, phi(g)),
    gap: R,
    branches: [circle(ORIGIN, AXIS_Z, e2, R)],
    poles: [
      { on: 'b', branch: 0, t: 0, feature: 'pole' },
      { on: 'b', branch: 0, t: Math.PI, feature: 'pole' },
    ],
  };
};

function psAt(gapOf: (R: number) => number, expected: PairClass): Build {
  return (g) => {
    const R = g.range(1.5, 2.5);
    const d = R - gapOf(R);
    const n = g.direction();
    const [e1, e2] = basis(n);
    const rr = Math.sqrt(Math.max(0, R * R - d * d));
    return {
      a: plane(scale3(n, d), n, phi(g)),
      b: sphere(ORIGIN, AXIS_Z, R, phi(g)),
      expected,
      gap: gapOf(R),
      branches: [
        expected === 'tangent-partial' ? point(scale3(n, d)) : circle(scale3(n, d), e1, e2, rr),
      ],
    };
  };
}

const pcCircle: Build = (g) => {
  const r = g.range(0.6, 1.2);
  const h = g.range(-1, 1);
  const [e1, e2] = basis(AXIS_Z);
  return {
    a: plane([0, 0, h], AXIS_Z, phi(g)),
    b: cylinder(ORIGIN, AXIS_Z, r, phi(g)),
    gap: null,
    branches: [circle([0, 0, h], e1, e2, r)],
  };
};

const pcEllipse: Build = (g) => {
  const r = g.range(0.6, 1.2);
  const h = g.range(-1, 1);
  const tan = Math.tan(g.range(0.3, 1.0));
  return {
    a: plane([0, 0, h], unit3([-tan, 0, 1]), phi(g)),
    b: cylinder(ORIGIN, AXIS_Z, r, phi(g)),
    gap: null,
    branches: [ellipse([0, 0, h], [r, 0, r * tan], [0, r, 0])],
  };
};

function pcLines(gapOf: (r: number) => number, expected: PairClass): Build {
  return (g) => {
    const r = g.range(0.7, 1.3);
    const d = r - gapOf(r);
    const s = Math.sqrt(Math.max(0, r * r - d * d));
    return {
      a: plane([0, d, 0], [0, 1, 0], phi(g)),
      b: cylinder(ORIGIN, AXIS_Z, r, phi(g)),
      expected,
      gap: gapOf(r),
      branches:
        expected === 'tangent-partial'
          ? [line([0, r, 0], AXIS_Z)]
          : [line([s, d, 0], AXIS_Z), line([-s, d, 0], AXIS_Z)],
    };
  };
}

const coneAlpha = (g: Prng): number => g.range(0.3, 0.7);

const pkCircle: Build = (g) => {
  const al = coneAlpha(g);
  const h = g.range(0.6, 1.6);
  const [e1, e2] = basis(AXIS_Z);
  return {
    a: plane([0, 0, h], AXIS_Z, phi(g)),
    b: cone(ORIGIN, AXIS_Z, al, phi(g)),
    gap: null,
    branches: [circle([0, 0, h], e1, e2, Math.tan(al) * h)],
  };
};

const pkEllipse: Build = (g) => {
  const al = coneAlpha(g);
  const k = Math.tan(al);
  const m = g.range(0.2, 0.8) / k;
  const h = g.range(0.8, 1.4);
  const A = 1 - k * k * m * m;
  const x0 = (k * k * m * h) / A;
  return {
    a: plane([0, 0, h], unit3([-m, 0, 1]), phi(g)),
    b: cone(ORIGIN, AXIS_Z, al, phi(g)),
    gap: null,
    branches: [
      ellipse(
        [x0, 0, m * x0 + h],
        [(k * h) / A, 0, (m * k * h) / A],
        [0, (k * h) / Math.sqrt(A), 0],
      ),
    ],
  };
};

const pkParabola: Build = (g) => {
  const al = coneAlpha(g);
  const k = Math.tan(al);
  const h = g.range(0.8, 1.4);
  return {
    a: plane([0, 0, h], unit3([-1 / k, 0, 1]), phi(g)),
    b: cone(ORIGIN, AXIS_Z, al, phi(g)),
    gap: null,
    branches: [
      open('parabola', (t) => {
        const x = (t * t - k * k * h * h) / (2 * k * h);
        return [x, t, x / k + h];
      }),
    ],
  };
};

const pkHyperbola: Build = (g) => {
  const al = coneAlpha(g);
  const k = Math.tan(al);
  const d = g.range(0.3, 0.9);
  const sheet = (s: 1 | -1) => open('hyperbola', (t) => [d, t, (s * Math.sqrt(t * t + d * d)) / k]);
  return {
    a: plane([d, 0, 0], [1, 0, 0], phi(g)),
    b: cone(ORIGIN, AXIS_Z, al, phi(g)),
    gap: null,
    branches: [sheet(1), sheet(-1)],
  };
};

const pkApexLines: Build = (g) => {
  const al = coneAlpha(g);
  const k = Math.tan(al);
  return {
    a: plane(ORIGIN, [0, 1, 0], phi(g)),
    b: cone(ORIGIN, AXIS_Z, al, phi(g)),
    gap: null,
    branches: [line(ORIGIN, [k, 0, 1]), line(ORIGIN, [-k, 0, 1])],
    poles: [
      { on: 'b', branch: 0, t: 0, feature: 'apex' },
      { on: 'b', branch: 1, t: 0, feature: 'apex' },
    ],
  };
};

const pkNearApex: Build = (g) => {
  const al = coneAlpha(g);
  const k = Math.tan(al);
  const q = E1_NEAR / (2 * W * Math.sin(al));
  const s = q / Math.sqrt(1 - q * q);
  const m = Math.sqrt(1 + s * s) / k;
  const ray = (sign: 1 | -1) => open('line', (t) => [t, sign * s * t, m * t]);
  return {
    a: plane(ORIGIN, unit3([-m, 0, 1]), phi(g)),
    b: cone(ORIGIN, AXIS_Z, al, phi(g)),
    gap: E1_NEAR,
    branches: [ray(1), ray(-1)],
    poles: [
      { on: 'b', branch: 0, t: 0, feature: 'apex' },
      { on: 'b', branch: 1, t: 0, feature: 'apex' },
    ],
  };
};

const torusDims = (g: Prng): [number, number] => [g.range(1.5, 2.2), g.range(0.4, 0.7)];

const ptTwoCircles: Build = (g) => {
  const [R, r] = torusDims(g);
  const h = r * g.range(0.2, 0.7);
  const rho = Math.sqrt(r * r - h * h);
  const [e1, e2] = basis(AXIS_Z);
  return {
    a: plane([0, 0, h], AXIS_Z, phi(g)),
    b: torus(ORIGIN, AXIS_Z, R, r, phi(g)),
    gap: r - h,
    branches: [circle([0, 0, h], e1, e2, R + rho), circle([0, 0, h], e1, e2, R - rho)],
  };
};

const ptMeridian: Build = (g) => {
  const [R, r] = torusDims(g);
  const ex: P3 = [1, 0, 0];
  const torusFrame = makeFrame(ORIGIN, AXIS_Z, ex);
  return {
    a: plane(ORIGIN, [0, 1, 0], phi(g)),
    b: { kind: 'torus', frame: torusFrame, major: R, minor: r },
    gap: null,
    branches: [circle([R, 0, 0], ex, AXIS_Z, r), circle([-R, 0, 0], ex, AXIS_Z, r)],
  };
};

const ptNearTop: Build = (g) => {
  const [R, r] = torusDims(g);
  const h = r - E1_NEAR;
  const rho = Math.sqrt(r * r - h * h);
  const [e1, e2] = basis(AXIS_Z);
  return {
    a: plane([0, 0, h], AXIS_Z, phi(g)),
    b: torus(ORIGIN, AXIS_Z, R, r, phi(g)),
    gap: E1_NEAR,
    branches: [circle([0, 0, h], e1, e2, R + rho), circle([0, 0, h], e1, e2, R - rho)],
  };
};

/** Point of torus parameters `(u, v)` in the canonical frame. */
const torusAt = (R: number, r: number, u: number, v: number): P3 => {
  const rho = R + r * Math.cos(v);
  return [rho * Math.cos(u), rho * Math.sin(u), r * Math.sin(v)];
};
const acosClamped = (x: number): number => Math.acos(Math.max(-1, Math.min(1, x)));

/** Plane `x = d` parallel to the torus axis, `d` inside the tube range: one connected loop. */
const ptSpiric: Build = (g) => {
  const [R, r] = torusDims(g);
  const d = R - r + r * g.range(0.3, 0.8);
  const vm = acosClamped((d - R) / r);
  return {
    a: plane([d, 0, 0], [1, 0, 0], phi(g)),
    b: torus(ORIGIN, AXIS_Z, R, r, phi(g)),
    gap: d - (R - r),
    branches: [
      loop('spiric', (t) => {
        const fwd = t <= Math.PI;
        const v = fwd ? -vm + (2 * vm * t) / Math.PI : vm - (2 * vm * (t - Math.PI)) / Math.PI;
        const u = acosClamped(d / (R + r * Math.cos(v)));
        return torusAt(R, r, fwd ? u : -u, v);
      }),
    ],
  };
};

/** Plane `x = R - r - gap` parallel to the axis: tangent to the inner equator when `gap = 0` (node). */
function ptNode(gapOf: () => number, expected: PairClass): Build {
  return (g) => {
    const [R, r] = torusDims(g);
    const gap = gapOf();
    const d = R - r - gap;
    const lobe = (sign: 1 | -1) =>
      loop('lobe', (t) => {
        const v = -Math.PI + t;
        const u = acosClamped(d / (R + r * Math.cos(v)));
        return torusAt(R, r, sign * u, v);
      });
    return {
      a: plane([d, 0, 0], [1, 0, 0], phi(g)),
      b: torus(ORIGIN, AXIS_Z, R, r, phi(g)),
      expected,
      gap: -gap,
      branches: [lobe(1), lobe(-1)],
    };
  };
}

function ssCircle(gapOf: (R1: number, R2: number) => number, nested: boolean): Build {
  return (g) => {
    const R1 = g.range(1.6, 2.2);
    const R2 = nested ? g.range(0.6, 1.0) : g.range(1.0, 1.6);
    const D = gapOf(R1, R2);
    const x = (D * D + R1 * R1 - R2 * R2) / (2 * D);
    const rr = Math.sqrt(R1 * R1 - x * x);
    const [e1, e2] = basis(AXIS_Z);
    return {
      a: sphere(ORIGIN, AXIS_Z, R1, phi(g)),
      b: sphere([0, 0, D], g.direction(), R2, phi(g)),
      gap: nested ? D - (R1 - R2) : R1 + R2 - D,
      branches: [circle([0, 0, x], e1, e2, rr)],
    };
  };
}

const scCoaxial: Build = (g) => {
  const R = g.range(1.5, 2.2);
  const r = R * g.range(0.3, 0.7);
  const z = Math.sqrt(R * R - r * r);
  const [e1, e2] = basis(AXIS_Z);
  return {
    a: cylinder(ORIGIN, AXIS_Z, r, phi(g)),
    b: sphere(ORIGIN, AXIS_Z, R, phi(g)),
    gap: R - r,
    branches: [circle([0, 0, z], e1, e2, r), circle([0, 0, -z], e1, e2, r)],
  };
};

const scCoaxialNear: Build = (g) => {
  const r = g.range(0.8, 1.2);
  const R = r + E1_NEAR;
  const z = Math.sqrt(R * R - r * r);
  const [e1, e2] = basis(AXIS_Z);
  return {
    a: cylinder(ORIGIN, AXIS_Z, r, phi(g)),
    b: sphere(ORIGIN, AXIS_Z, R, phi(g)),
    gap: R - r,
    branches: [circle([0, 0, z], e1, e2, r), circle([0, 0, -z], e1, e2, r)],
  };
};

/** Cylinder parallel to the sphere axis, offset `e`, `R > e + r`: two disjoint loops `z = +-sqrt(R^2 - e^2 - r^2 - 2 e r cos t)`. */
const scOffsetTwo: Build = (g) => {
  const R = g.range(1.8, 2.4);
  const r = g.range(0.4, 0.7);
  const e = g.range(0.4, 0.8);
  const sheet = (s: 1 | -1) =>
    loop('loop', (t) => {
      const q = R * R - e * e - r * r - 2 * e * r * Math.cos(t);
      return [e + r * Math.cos(t), r * Math.sin(t), s * Math.sqrt(Math.max(0, q))];
    });
  return {
    a: cylinder([e, 0, 0], AXIS_Z, r, phi(g)),
    b: sphere(ORIGIN, AXIS_Z, R, phi(g)),
    gap: R - (e + r),
    branches: [sheet(1), sheet(-1)],
  };
};

/** `|e - r| < R < e + r`: the cylinder leaves the sphere, one loop whose two sheets meet where `cos t = c0`. */
const scOffsetOne: Build = (g) => {
  const r = g.range(0.4, 0.6);
  const e = g.range(0.8, 1.0);
  const R = e * g.range(0.9, 1.1);
  const c0 = (R * R - e * e - r * r) / (2 * e * r);
  const t1 = acosClamped(c0);
  return {
    a: cylinder([e, 0, 0], AXIS_Z, r, phi(g)),
    b: sphere(ORIGIN, AXIS_Z, R, phi(g)),
    gap: Math.min(Math.abs(R - (e + r)), Math.abs(R - Math.abs(e - r))),
    branches: [
      loop('loop', (t) => {
        const fwd = t <= Math.PI;
        const s = fwd ? t / Math.PI : 2 - t / Math.PI;
        const tt = t1 + (TWO_PI - 2 * t1) * s;
        const q = R * R - e * e - r * r - 2 * e * r * Math.cos(tt);
        return [e + r * Math.cos(tt), r * Math.sin(tt), (fwd ? 1 : -1) * Math.sqrt(Math.max(0, q))];
      }),
    ],
  };
};

const skCoaxial: Build = (g) => {
  const al = g.range(0.4, 0.6);
  const k = Math.tan(al);
  const c = g.range(0.5, 1.0);
  const R = g.range(1.2, 1.8);
  const disc = (k * k + 1) * R * R - k * k * c * c;
  const sq = Math.sqrt(disc);
  const [e1, e2] = basis(AXIS_Z);
  const ring = (w: number) => circle([0, 0, w], e1, e2, k * Math.abs(w));
  return {
    a: cone(ORIGIN, AXIS_Z, al, phi(g)),
    b: sphere([0, 0, c], g.direction(), R, phi(g)),
    gap: sq / (k * k + 1),
    branches: [ring((c + sq) / (k * k + 1)), ring((c - sq) / (k * k + 1))],
  };
};

function ccParallel(near: boolean): Build {
  return (g) => {
    const r1 = g.range(0.9, 1.3);
    const r2 = g.range(0.6, 1.0);
    const D = near ? r1 + r2 - E1_NEAR : (r1 + r2) * g.range(0.7, 0.95);
    const x = (D * D + r1 * r1 - r2 * r2) / (2 * D);
    const y = Math.sqrt(r1 * r1 - x * x);
    return {
      a: cylinder(ORIGIN, AXIS_Z, r1, phi(g)),
      b: cylinder([D, 0, 0], AXIS_Z, r2, phi(g)),
      gap: Math.min(r1 + r2 - D, D - Math.abs(r1 - r2)),
      branches: [line([x, y, 0], AXIS_Z), line([x, -y, 0], AXIS_Z)],
    };
  };
}

/** Axis of the second cylinder along y through `(e, ., 0)`; `r1` is the z-axis cylinder. */
function ccPerp(kind: 'two' | 'single' | 'steinmetz'): Build {
  return (g) => {
    const r1 = kind === 'single' ? 1 : g.range(0.9, 1.3);
    const r2 =
      kind === 'steinmetz' ? r1 : kind === 'two' ? r1 * g.range(0.4, 0.7) : g.range(0.4, 0.6);
    const e = kind === 'single' ? g.range(0.7, 0.9) : 0;
    const a = cylinder(ORIGIN, AXIS_Z, r1, phi(g));
    const b = cylinder([e, 0, 0], [0, 1, 0], r2, phi(g));
    if (kind === 'steinmetz') {
      const half = (s: 1 | -1) =>
        loop('ellipse', (t) => [r1 * Math.cos(t), r1 * Math.sin(t), s * r1 * Math.sin(t)]);
      return { a, b, expected: 'tangent-partial', gap: r1 - r2, branches: [half(1), half(-1)] };
    }
    if (kind === 'two') {
      const sheet = (s: 1 | -1) =>
        loop('loop', (t) => [
          r2 * Math.cos(t),
          s * Math.sqrt(r1 * r1 - r2 * r2 * Math.cos(t) ** 2),
          r2 * Math.sin(t),
        ]);
      return { a, b, gap: r1 - r2, branches: [sheet(1), sheet(-1)] };
    }
    const c0 = (r1 - e) / r2;
    const t1 = acosClamped(c0);
    return {
      a,
      b,
      gap: Math.min(Math.abs(r1 - (e + r2)), Math.abs(r1 - Math.abs(e - r2))),
      branches: [
        loop('loop', (t) => {
          const fwd = t <= Math.PI;
          const s = fwd ? t / Math.PI : 2 - t / Math.PI;
          const tt = t1 + (TWO_PI - 2 * t1) * s;
          const x = e + r2 * Math.cos(tt);
          return [x, (fwd ? 1 : -1) * Math.sqrt(Math.max(0, r1 * r1 - x * x)), r2 * Math.sin(tt)];
        }),
      ],
    };
  };
}

const ckCoaxial: Build = (g) => {
  const al = coneAlpha(g);
  const k = Math.tan(al);
  const r = g.range(0.6, 1.2);
  const [e1, e2] = basis(AXIS_Z);
  return {
    a: cylinder(ORIGIN, AXIS_Z, r, phi(g)),
    b: cone(ORIGIN, AXIS_Z, al, phi(g)),
    gap: null,
    branches: [circle([0, 0, r / k], e1, e2, r), circle([0, 0, -r / k], e1, e2, r)],
  };
};

const kkCoaxial: Build = (g) => {
  const a1 = g.range(0.3, 0.5);
  const a2 = g.range(0.7, 0.9);
  const k1 = Math.tan(a1);
  const k2 = Math.tan(a2);
  const s = g.range(1, 2);
  const [e1, e2] = basis(AXIS_Z);
  const za = (k2 * s) / (k1 + k2);
  const zb = (-k2 * s) / (k1 - k2);
  return {
    a: cone(ORIGIN, AXIS_Z, a1, phi(g)),
    b: cone([0, 0, s], [0, 0, -1], a2, phi(g)),
    gap: null,
    branches: [
      circle([0, 0, za], e1, e2, k1 * Math.abs(za)),
      circle([0, 0, zb], e1, e2, k1 * Math.abs(zb)),
    ],
  };
};

const stCoaxial: Build = (g) => {
  const R = 1.8;
  const r = 0.5;
  const Rs = g.range(1.45, 2.15);
  const rho = (Rs * Rs - r * r + R * R) / (2 * R);
  const z = Math.sqrt(Rs * Rs - rho * rho);
  const [e1, e2] = basis(AXIS_Z);
  return {
    a: sphere(ORIGIN, g.direction(), Rs, phi(g)),
    b: torus(ORIGIN, AXIS_Z, R, r, phi(g)),
    gap: Math.min(Rs - (R - r), R + r - Rs),
    branches: [circle([0, 0, z], e1, e2, rho), circle([0, 0, -z], e1, e2, rho)],
  };
};

function ctCoaxial(near: boolean): Build {
  return (g) => {
    const [R, r] = torusDims(g);
    const off = near ? r - E1_NEAR : r * g.range(-0.6, 0.6);
    const z = Math.sqrt(r * r - off * off);
    const [e1, e2] = basis(AXIS_Z);
    return {
      a: cylinder(ORIGIN, AXIS_Z, R + off, phi(g)),
      b: torus(ORIGIN, AXIS_Z, R, r, phi(g)),
      gap: r - Math.abs(off),
      branches: [circle([0, 0, z], e1, e2, R + off), circle([0, 0, -z], e1, e2, R + off)],
    };
  };
}

const ktCoaxial: Build = (g) => {
  const R = 1.6;
  const r = 0.5;
  const al = g.range(1.0, 1.2);
  const k = Math.tan(al);
  const za = R / k + g.range(-0.25, 0.25);
  const A = -k;
  const b = A * za + R;
  const disc = A * A * b * b - (A * A + 1) * (b * b - r * r);
  const sq = Math.sqrt(disc);
  const [e1, e2] = basis(AXIS_Z);
  const ring = (z: number) => circle([0, 0, z], e1, e2, k * Math.abs(z - za));
  return {
    a: cone([0, 0, za], AXIS_Z, al, phi(g)),
    b: torus(ORIGIN, AXIS_Z, R, r, phi(g)),
    gap: r - Math.abs(R - k * za) / Math.sqrt(1 + k * k),
    branches: [ring((A * b + sq) / (A * A + 1)), ring((A * b - sq) / (A * A + 1))],
  };
};

export const E1_BUILDERS: ReadonlyArray<readonly [string, Build]> = [
  ['plane-sphere/circle', psCircle],
  ['plane-sphere/great-circle-poles', psGreatPole],
  ['plane-sphere/near-tangent', psAt(() => E1_NEAR, 'full')],
  ['plane-sphere/tangent', psAt(() => 0, 'tangent-partial')],
  ['plane-cylinder/circle', pcCircle],
  ['plane-cylinder/ellipse', pcEllipse],
  ['plane-cylinder/two-lines', pcLines((r) => r * 0.5, 'full')],
  ['plane-cylinder/near-tangent', pcLines(() => E1_NEAR, 'full')],
  ['plane-cylinder/tangent', pcLines(() => 0, 'tangent-partial')],
  ['plane-cone/circle', pkCircle],
  ['plane-cone/ellipse', pkEllipse],
  ['plane-cone/parabola', pkParabola],
  ['plane-cone/hyperbola-two-nappes', pkHyperbola],
  ['plane-cone/apex-lines', pkApexLines],
  ['plane-cone/near-tangent-apex', pkNearApex],
  ['plane-torus/two-circles', ptTwoCircles],
  ['plane-torus/meridian-on-seam', ptMeridian],
  ['plane-torus/near-tangent-top', ptNearTop],
  ['plane-torus/spiric-loop', ptSpiric],
  ['plane-torus/node-tangent', ptNode(() => 0, 'tangent-partial')],
  ['plane-torus/near-node', ptNode(() => E1_NEAR, 'full')],
  ['sphere-sphere/circle', ssCircle((R1, R2) => (R1 + R2) * 0.7, false)],
  ['sphere-sphere/near-tangent-external', ssCircle((R1, R2) => R1 + R2 - E1_NEAR, false)],
  ['sphere-sphere/near-tangent-internal', ssCircle((R1, R2) => R1 - R2 + E1_NEAR, true)],
  ['sphere-cylinder/coaxial', scCoaxial],
  ['sphere-cylinder/coaxial-near-tangent', scCoaxialNear],
  ['sphere-cylinder/offset-two-loops', scOffsetTwo],
  ['sphere-cylinder/offset-one-loop', scOffsetOne],
  ['sphere-cone/coaxial', skCoaxial],
  ['cylinder-cylinder/parallel-lines', ccParallel(false)],
  ['cylinder-cylinder/parallel-near-tangent', ccParallel(true)],
  ['cylinder-cylinder/perpendicular-two-loops', ccPerp('two')],
  ['cylinder-cylinder/perpendicular-skew-one-loop', ccPerp('single')],
  ['cylinder-cylinder/perpendicular-equal-steinmetz', ccPerp('steinmetz')],
  ['cylinder-cone/coaxial', ckCoaxial],
  ['cone-cone/coaxial', kkCoaxial],
  ['sphere-torus/coaxial', stCoaxial],
  ['cylinder-torus/coaxial', ctCoaxial(false)],
  ['cylinder-torus/coaxial-near-tangent', ctCoaxial(true)],
  ['cone-torus/coaxial', ktCoaxial],
];

interface Motion {
  readonly m: readonly number[];
  readonly t: P3;
}

function motion(g: Prng): Motion {
  const k = g.direction();
  const th = g.range(0, TWO_PI);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const v = 1 - c;
  const m = [
    c + k[0] * k[0] * v,
    k[0] * k[1] * v - k[2] * s,
    k[0] * k[2] * v + k[1] * s,
    k[1] * k[0] * v + k[2] * s,
    c + k[1] * k[1] * v,
    k[1] * k[2] * v - k[0] * s,
    k[2] * k[0] * v - k[1] * s,
    k[2] * k[1] * v + k[0] * s,
    c + k[2] * k[2] * v,
  ];
  return { m, t: [g.range(-1, 1), g.range(-1, 1), g.range(-1, 1)] };
}

const rot = (mo: Motion, p: P3): P3 => {
  const m = mo.m as [number, number, number, number, number, number, number, number, number];
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
    m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
    m[6] * p[0] + m[7] * p[1] + m[8] * p[2],
  ];
};
const place = (mo: Motion, p: P3): P3 => add3(rot(mo, p), mo.t);

function moveSurface(mo: Motion, s: AnalyticSurface): AnalyticSurface {
  const f = s.frame;
  const frame: Frame = { o: place(mo, f.o), x: rot(mo, f.x), y: rot(mo, f.y), z: rot(mo, f.z) };
  return { ...s, frame };
}

export function buildE1Corpus(): E1Pair[] {
  return E1_BUILDERS.map(([id, build], i) => {
    const seed = 0xe1000 + i;
    const g = prng(seed);
    const d = build(g);
    const mo = motion(g);
    return {
      id,
      seed,
      a: moveSurface(mo, d.a),
      b: moveSurface(mo, d.b),
      expected: d.expected ?? 'full',
      gap: d.gap,
      branches: d.branches.map((b) => ({ ...b, at: (t: number) => place(mo, b.at(t)) })),
      poles: d.poles ?? [],
      window: { c: mo.t, r: W },
    };
  });
}
