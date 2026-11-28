import { type Tuple3, triangulateLoop } from '../geom';
import type { EditMesh } from '../mesh';

export type Point = readonly [number, number, number];
export type Triangle = readonly [Point, Point, Point];

export interface PairCase {
  readonly kind: string;
  readonly t1: Triangle;
  readonly t2: Triangle;
  readonly tolerance: number;
}

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

const span = (r: Rng, a: number, b: number): number => a + (b - a) * r();
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const point = (r: Rng, s = 1): Point => [span(r, -s, s), span(r, -s, s), span(r, -s, s)];
const tri = (r: Rng, s = 1): Triangle => [point(r, s), point(r, s), point(r, s)];
const gridPoint = (r: Rng, n = 3): Point => [
  Math.floor(span(r, -n, n + 1)),
  Math.floor(span(r, -n, n + 1)),
  Math.floor(span(r, -n, n + 1)),
];
const gridTri = (r: Rng): Triangle => [gridPoint(r), gridPoint(r), gridPoint(r)];
const lerp = (a: Point, b: Point, s: number): Point => [
  a[0] + (b[0] - a[0]) * s,
  a[1] + (b[1] - a[1]) * s,
  a[2] + (b[2] - a[2]) * s,
];
const barycentric = (t: Triangle, u: number, v: number): Point => {
  const [a, b, c] = t;
  return [
    a[0] + u * (b[0] - a[0]) + v * (c[0] - a[0]),
    a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]),
    a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]),
  ];
};
const offset = (p: Point, d: Point): Point => [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
const normalOf = (t: Triangle): Tuple3 => {
  const [a, b, c] = t;
  const [u0, u1, u2] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const [v0, v1, v2] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [u1 * v2 - u2 * v1, u2 * v0 - u0 * v2, u0 * v1 - u1 * v0];
};
const unit = (r: Rng): Point => {
  const p = point(r);
  const n = Math.hypot(p[0], p[1], p[2]) || 1;
  return [p[0] / n, p[1] / n, p[2] / n];
};
/** A plane through `o` spanned by two orthonormal directions `u`, `v`. */
function planeBasis(r: Rng): { o: Point; u: Point; v: Point } {
  const n = unit(r);
  const seed: Point = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const cross = (a: Point, b: Point): Point => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const uRaw = cross(n, seed);
  const un = Math.hypot(uRaw[0], uRaw[1], uRaw[2]);
  const u: Point = [uRaw[0] / un, uRaw[1] / un, uRaw[2] / un];
  const vRaw = cross(n, u);
  return { o: point(r, 0.5), u, v: vRaw };
}
const inPlane = (b: { o: Point; u: Point; v: Point }, x: number, y: number): Point => [
  b.o[0] + x * b.u[0] + y * b.v[0],
  b.o[1] + x * b.u[1] + y * b.v[1],
  b.o[2] + x * b.u[2] + y * b.v[2],
];
const planeTri = (r: Rng, b: { o: Point; u: Point; v: Point }, s = 1): Triangle => [
  inPlane(b, span(r, -s, s), span(r, -s, s)),
  inPlane(b, span(r, -s, s), span(r, -s, s)),
  inPlane(b, span(r, -s, s), span(r, -s, s)),
];
const ulp = (x: number): number => {
  const a = Math.abs(x);
  return 2 ** (Math.floor(Math.log2(a)) - 52);
};

const TOLERANCES: readonly number[] = [0, 0, 0, 1e-9, 1e-6, 1e-3];

interface Draw {
  readonly t1: Triangle;
  readonly t2: Triangle;
  readonly tolerance?: number;
}

type Generator = (r: Rng) => Draw;

const GENERATORS: readonly (readonly [string, Generator])[] = [
  ['random', (r) => ({ t1: tri(r), t2: tri(r) })],
  ['grid', (r) => ({ t1: gridTri(r), t2: gridTri(r) })],
  [
    'separated',
    (r) => {
      const t1 = tri(r);
      const axis = Math.floor(r() * 3);
      const sign = r() < 0.5 ? -1 : 1;
      const shift: [number, number, number] = [0, 0, 0];
      shift[axis] = sign * span(r, 1.5, 3);
      return { t1, t2: tri(r).map((p) => offset(p, shift)) as unknown as Triangle };
    },
  ],
  [
    'touch-vertex',
    (r) => {
      const t1 = gridTri(r);
      const u = pick(r, [0, 0.25, 0.5, 0.75, 1]);
      const v = pick(r, [0, 0.25, 0.5]);
      const contact = u + v <= 1 ? barycentric(t1, u, v) : barycentric(t1, 0, 0);
      return { t1, t2: [contact, gridPoint(r), gridPoint(r)] };
    },
  ],
  [
    'touch-edge',
    (r) => {
      const t1 = gridTri(r);
      const s1 = pick(r, [0, 0.25, 0.5, 1]);
      const s2 = pick(r, [0, 0.5, 0.75, 1]);
      const third = r() < 0.5 ? gridPoint(r) : point(r, 2);
      return { t1, t2: [lerp(t1[0], t1[1], s1), lerp(t1[0], t1[1], s2), third] };
    },
  ],
  [
    'edge-through',
    (r) => {
      const t1 = tri(r);
      const x = barycentric(t1, span(r, 0.05, 0.6), span(r, 0.05, 0.3));
      const n = normalOf(t1);
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      const k = span(r, 0.05, 0.6);
      const side = (r() < 0.5 ? -1 : 1) * k;
      const q0 = offset(x, [(n[0] / len) * side, (n[1] / len) * side, (n[2] / len) * side]);
      const q1 = offset(x, [
        (-n[0] / len) * side * 0.7,
        (-n[1] / len) * side * 0.7,
        (-n[2] / len) * side * 0.7,
      ]);
      return { t1, t2: [q0, q1, point(r, 1.5)] };
    },
  ],
  [
    'coplanar-overlap',
    (r) => {
      const b = planeBasis(r);
      const exact = r() < 0.5;
      if (exact) {
        const flat: Triangle = [gridPoint(r, 2), gridPoint(r, 2), gridPoint(r, 2)];
        const flat2: Triangle = [gridPoint(r, 2), gridPoint(r, 2), gridPoint(r, 2)];
        const z = (p: Point): Point => [p[0], p[1], 0.5];
        return { t1: flat.map(z) as unknown as Triangle, t2: flat2.map(z) as unknown as Triangle };
      }
      return { t1: planeTri(r, b), t2: planeTri(r, { ...b, o: offset(b.o, [0.1, 0.1, 0.1]) }) };
    },
  ],
  [
    'coplanar-disjoint',
    (r) => {
      const b = planeBasis(r);
      const far = offset(b.o, [b.u[0] * 2.5, b.u[1] * 2.5, b.u[2] * 2.5]);
      return { t1: planeTri(r, b, 1), t2: planeTri(r, { ...b, o: far }, 1) };
    },
  ],
  [
    'cross',
    (r) => {
      const t1 = tri(r);
      const x = barycentric(t1, span(r, 0.1, 0.5), span(r, 0.1, 0.4));
      const n = normalOf(t1);
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      const h = span(r, 0.02, 0.5);
      const above = offset(x, [(n[0] / len) * h, (n[1] / len) * h, (n[2] / len) * h]);
      const below = offset(x, [(-n[0] / len) * h, (-n[1] / len) * h, (-n[2] / len) * h]);
      const far = offset(x, [span(r, -1, 1), span(r, -1, 1), span(r, -1, 1)]);
      return { t1, t2: r() < 0.5 ? [above, below, far] : [above, far, below] };
    },
  ],
  [
    'degenerate',
    (r) => {
      const p = point(r);
      const d = point(r);
      const q = offset(p, [d[0] * 0.5, d[1] * 0.5, d[2] * 0.5]);
      const s = offset(p, d);
      switch (Math.floor(r() * 5)) {
        case 0:
          return { t1: [p, p, s], t2: tri(r) };
        case 1:
          return { t1: [p, q, s], t2: tri(r) };
        case 2:
          return { t1: tri(r), t2: [p, p, p] };
        case 3:
          return { t1: tri(r), t2: [p, q, s] };
        default: {
          const t1 = tri(r);
          return { t1, t2: [t1[0], t1[0], gridPoint(r)] };
        }
      }
    },
  ],
  [
    'near-tolerance',
    (r) => {
      const t1 = tri(r);
      const n = normalOf(t1);
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      const tol = pick(r, [1e-12, 1e-9, 1e-6, 1e-3, 1e-2]);
      const factor = pick(r, [0, 1e-12, 1e-9, 0.5, 1 - 1e-15, 1, 1 + 1e-15, 2, -1, -0.5]);
      const base = barycentric(t1, span(r, 0, 1), span(r, 0, 1));
      const shifted = (k: number): Point =>
        offset(base, [
          (n[0] / len) * k * tol * factor,
          (n[1] / len) * k * tol * factor,
          (n[2] / len) * k * tol * factor,
        ]);
      return { t1, t2: [shifted(1), shifted(0.5), shifted(-1)], tolerance: tol };
    },
  ],
  [
    'ulp-coplanar',
    (r) => {
      const c = span(r, 0.1, 10);
      const k = (): number => pick(r, [-3, -2, -1, 0, 1, 2, 3]);
      const plane = (): Triangle =>
        [0, 1, 2].map(
          () => [span(r, -2, 2), span(r, -2, 2), c + k() * ulp(c)] as Point,
        ) as unknown as Triangle;
      return { t1: plane(), t2: plane(), tolerance: r() < 0.5 ? 0 : 1e-9 };
    },
  ],
  [
    'tolerance-boundary',
    (r) => {
      const tol = pick(r, [0.25, 0.5, 2]);
      const onPlane = (z: number): Triangle =>
        [0, 1, 2].map(() => {
          const g = gridPoint(r, 2);
          return [g[0], g[1], z] as Point;
        }) as unknown as Triangle;
      return { t1: onPlane(0), t2: onPlane(tol), tolerance: tol };
    },
  ],
  [
    'rotated',
    (r) => {
      const axis = unit(r);
      const angle = span(r, 0, Math.PI);
      const s = Math.sin(angle / 2);
      const x = axis[0] * s;
      const y = axis[1] * s;
      const z = axis[2] * s;
      const w = Math.cos(angle / 2);
      const [m00, m01, m02] = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)];
      const [m10, m11, m12] = [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)];
      const [m20, m21, m22] = [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
      const map = (p: Point): Point => [
        m00 * p[0] + m01 * p[1] + m02 * p[2],
        m10 * p[0] + m11 * p[1] + m12 * p[2],
        m20 * p[0] + m21 * p[1] + m22 * p[2],
      ];
      const flat = (): Triangle =>
        [0, 1, 2].map(() => map([span(r, -1, 1), span(r, -1, 1), 0])) as unknown as Triangle;
      return {
        t1: flat(),
        t2: flat().map((p) => offset(p, [0, 0, span(r, -1e-16, 1e-16)])) as unknown as Triangle,
      };
    },
  ],
  [
    'decimal',
    (r) => {
      const dec = (): Point => [
        Math.round(span(r, -20, 20)) / 10,
        Math.round(span(r, -20, 20)) / 10,
        pick(r, [0.3, 0.1, -0.7, 0]),
      ];
      const decTri = (): Triangle => [dec(), dec(), dec()];
      if (r() < 0.5) return { t1: decTri(), t2: decTri() };
      const t1 = decTri();
      const t2 = decTri().map((p) => [p[0], p[2], p[1]] as Point) as unknown as Triangle;
      return { t1, t2 };
    },
  ],
];

/** Deterministic synthetic corpus: `perGenerator` seeded pairs for each generator family. */
export function syntheticCorpus(perGenerator: number, seed = 0x5eed): PairCase[] {
  const r = mulberry32(seed);
  const out: PairCase[] = [];
  for (const [kind, gen] of GENERATORS) {
    for (let i = 0; i < perGenerator; i++) {
      const d = gen(r);
      const tolerance = d.tolerance ?? pick(r, TOLERANCES);
      out.push({ kind, t1: d.t1, t2: d.t2, tolerance });
    }
  }
  return out;
}

/**
 * The three mesh reads `candidatePairs` makes. Structural, so a mesh typed by any build of the
 * kernel (source or `dist`) fits; `EditMesh` itself is nominal through its private fields.
 */
type CandidateMesh = Pick<EditMesh, 'faces' | 'faceVertices' | 'position'>;

type Box = readonly [number, number, number];

const at = <T>(xs: readonly T[], i: number): T => {
  const x = xs[i];
  if (x === undefined) throw new Error(`index ${i} is outside its array`);
  return x;
};

const bounds = (tp: Triangle, axisFold: (...xs: number[]) => number): Box => [
  axisFold(tp[0][0], tp[1][0], tp[2][0]),
  axisFold(tp[0][1], tp[1][1], tp[2][1]),
  axisFold(tp[0][2], tp[1][2], tp[2][2]),
];

/**
 * The pairs `faceContacts` hands to `triangleContact` for a mesh: triangles of different
 * faces, sharing no vertex, whose boxes meet once grown by the tolerance (the same
 * sweep as `faceContacts`, without its `only` filter).
 */
export function candidatePairs(mesh: CandidateMesh, tolerance: number): PairCase[] {
  type Tri = {
    face: number;
    verts: number[];
    points: Triangle;
    lo: Box;
    hi: Box;
    set: string;
  };
  const tris: Tri[] = [];
  for (const f of mesh.faces()) {
    const verts = mesh.faceVertices(f);
    const points = verts.map((v) => mesh.position(v)) as unknown as Tuple3[];
    const set = verts
      .slice()
      .sort((x, y) => x - y)
      .join(',');
    const indices = triangulateLoop(points);
    if (indices === undefined) continue;
    for (let i = 0; i < indices.length; i += 3) {
      const corners: Tuple3 = [at(indices, i), at(indices, i + 1), at(indices, i + 2)];
      const tp = corners.map((k) => at(points, k)) as unknown as Triangle;
      const lo = bounds(tp, Math.min);
      const hi = bounds(tp, Math.max);
      tris.push({
        face: f,
        verts: corners.map((k) => at(verts, k)),
        points: tp,
        lo,
        hi,
        set,
      });
    }
  }
  tris.sort((a, b) => a.lo[0] - b.lo[0]);
  const out: PairCase[] = [];
  for (let i = 0; i < tris.length; i++) {
    const a = at(tris, i);
    const reach0 = a.hi[0] + tolerance;
    const reach1 = a.hi[1] + tolerance;
    const reach2 = a.hi[2] + tolerance;
    for (let j = i + 1; j < tris.length; j++) {
      const b = at(tris, j);
      if (b.lo[0] > reach0) break;
      if (b.face === a.face) continue;
      if (
        b.lo[1] > reach1 ||
        a.lo[1] > b.hi[1] + tolerance ||
        b.lo[2] > reach2 ||
        a.lo[2] > b.hi[2] + tolerance
      ) {
        continue;
      }
      if (a.verts.some((v) => b.verts.includes(v))) continue;
      if (a.set === b.set) continue;
      out.push({ kind: 'candidate', t1: a.points, t2: b.points, tolerance });
    }
  }
  return out;
}
