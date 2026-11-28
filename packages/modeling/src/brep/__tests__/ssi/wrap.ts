import type { Tuple3 } from '../../../geom';
import type { NurbsSurface } from '../../../nurbs';
import { makeFrame } from '../../surfaces';
import type { Frame, Surface } from '../../types';

type AnalyticSurface = Exclude<Surface, { kind: 'nurbs' }>;

import { dot3, type P3, sub3 } from '../../vec';

/** An analytic surface bounded to the part the NURBS wrapper represents: `v` for cylinder and cone, `half` for a plane. */
export interface Patch {
  readonly surface: AnalyticSurface;
  readonly v: readonly [number, number];
  readonly half: number;
}

const W = Math.SQRT1_2;
const CIRCLE: readonly (readonly [number, number, number])[] = [
  [1, 0, 1],
  [1, 1, W],
  [0, 1, 1],
  [-1, 1, W],
  [-1, 0, 1],
  [-1, -1, W],
  [0, -1, 1],
  [1, -1, W],
  [1, 0, 1],
];
const CIRCLE_KNOTS = [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1];

/** Profile `(radius, height, weight)` of a surface of revolution about the frame axis, with its degree and knots. */
interface Profile {
  readonly rows: readonly (readonly [number, number, number])[];
  readonly degree: number;
  readonly knots: readonly number[];
}

function profile(s: AnalyticSurface, v: readonly [number, number]): Profile {
  switch (s.kind) {
    case 'cylinder':
      return {
        rows: [
          [s.radius, v[0], 1],
          [s.radius, v[1], 1],
        ],
        degree: 1,
        knots: [0, 0, 1, 1],
      };
    case 'cone': {
      const sa = Math.sin(s.halfAngle);
      const ca = Math.cos(s.halfAngle);
      return {
        rows: [
          [s.radius + v[0] * sa, v[0] * ca, 1],
          [s.radius + v[1] * sa, v[1] * ca, 1],
        ],
        degree: 1,
        knots: [0, 0, 1, 1],
      };
    }
    case 'sphere': {
      const r = s.radius;
      return {
        rows: [
          [0, -r, 1],
          [r, -r, W],
          [r, 0, 1],
          [r, r, W],
          [0, r, 1],
        ],
        degree: 2,
        knots: [0, 0, 0, 0.5, 0.5, 1, 1, 1],
      };
    }
    case 'torus':
      return {
        rows: CIRCLE.map(([c, d, w]) => [s.major + s.minor * c, s.minor * d, w] as const),
        degree: 2,
        knots: CIRCLE_KNOTS,
      };
    case 'plane':
      throw new Error('a plane is not a surface of revolution');
  }
}

function at(f: Frame, a: number, b: number, c: number): Tuple3 {
  return [
    f.o[0] + f.x[0] * a + f.y[0] * b + f.z[0] * c,
    f.o[1] + f.x[1] * a + f.y[1] * b + f.z[1] * c,
    f.o[2] + f.x[2] * a + f.y[2] * b + f.z[2] * c,
  ];
}

/**
 * The patch as a rational NURBS surface that reproduces the analytic one exactly: a bilinear
 * patch for a plane, otherwise a quadratic full circle in `u` times the profile in `v`
 * (the homogeneous net is a tensor product, so the weights multiply).
 */
export function wrap(p: Patch): NurbsSurface {
  const f = p.surface.frame;
  if (p.surface.kind === 'plane') {
    const h = p.half;
    return {
      degreeU: 1,
      degreeV: 1,
      points: [
        [at(f, -h, -h, 0), at(f, -h, h, 0)],
        [at(f, h, -h, 0), at(f, h, h, 0)],
      ],
      knotsU: [0, 0, 1, 1],
      knotsV: [0, 0, 1, 1],
    };
  }
  const prof = profile(p.surface, p.v);
  const points: Tuple3[][] = [];
  const weights: number[][] = [];
  for (const [c, d, wu] of CIRCLE) {
    points.push(prof.rows.map(([rho, z]) => at(f, rho * c, rho * d, z)));
    weights.push(prof.rows.map(([, , wv]) => wu * wv));
  }
  return {
    degreeU: 2,
    degreeV: prof.degree,
    points,
    weights,
    knotsU: CIRCLE_KNOTS,
    knotsV: prof.knots,
  };
}

/** Signed distance-like implicit function of the whole analytic surface (zero on it) and the test for the bounded patch. */
export interface Implicit {
  f(q: P3): number;
  inside(q: P3): boolean;
}

export function implicit(p: Patch): Implicit {
  const s = p.surface;
  const f = s.frame;
  const local = (q: P3): P3 => {
    const d = sub3(q, f.o);
    return [dot3(d, f.x), dot3(d, f.y), dot3(d, f.z)];
  };
  switch (s.kind) {
    case 'plane':
      return {
        f: (q) => local(q)[2],
        inside: (q) => {
          const l = local(q);
          return Math.abs(l[0]) <= p.half && Math.abs(l[1]) <= p.half;
        },
      };
    case 'cylinder':
      return {
        f: (q) => {
          const l = local(q);
          return Math.hypot(l[0], l[1]) - s.radius;
        },
        inside: (q) => {
          const z = local(q)[2];
          return z >= p.v[0] && z <= p.v[1];
        },
      };
    case 'sphere':
      return {
        f: (q) => {
          const l = local(q);
          return Math.hypot(l[0], l[1], l[2]) - s.radius;
        },
        inside: () => true,
      };
    case 'cone': {
      const sa = Math.sin(s.halfAngle);
      const ca = Math.cos(s.halfAngle);
      return {
        f: (q) => {
          const l = local(q);
          return (Math.hypot(l[0], l[1]) - s.radius) * ca - l[2] * sa;
        },
        inside: (q) => {
          const l = local(q);
          const v = (Math.hypot(l[0], l[1]) - s.radius) * sa + l[2] * ca;
          return v >= p.v[0] && v <= p.v[1];
        },
      };
    }
    case 'torus':
      return {
        f: (q) => {
          const l = local(q);
          return Math.hypot(Math.hypot(l[0], l[1]) - s.major, l[2]) - s.minor;
        },
        inside: () => true,
      };
  }
}

/** The patch moved by the rigid pose `pose` (a right-handed frame): its frame is expressed in the world of the pose. */
export function posed(p: Patch, pose: Frame): Patch {
  const f = p.surface.frame;
  const map = (a: P3): P3 => [
    pose.x[0] * a[0] + pose.y[0] * a[1] + pose.z[0] * a[2],
    pose.x[1] * a[0] + pose.y[1] * a[1] + pose.z[1] * a[2],
    pose.x[2] * a[0] + pose.y[2] * a[1] + pose.z[2] * a[2],
  ];
  const o = map(f.o);
  const frame: Frame = {
    o: [o[0] + pose.o[0], o[1] + pose.o[1], o[2] + pose.o[2]],
    x: map(f.x),
    y: map(f.y),
    z: map(f.z),
  };
  return { ...p, surface: { ...p.surface, frame } as AnalyticSurface };
}

export const frameAt = makeFrame;
