import { hypot3 } from '../dmath';
import type { Tuple3 } from '../geom';
import type { WorkMeter } from './job';

/**
 * BSP-tree polygon classification for the TypeScript boolean baseline (the csg.js
 * idea: split convex polygons by the planes of the other solid's polygons). Unlike
 * csg.js the tree only classifies; output polygons are the classified fragments of
 * the original triangles, so neither operand is shredded by its own planes.
 */
export interface Plane {
  readonly n: Tuple3;
  readonly w: number;
}

/** A convex planar polygon; `source` indexes the job's source-triangle table. */
export interface Poly {
  readonly points: readonly Tuple3[];
  readonly plane: Plane;
  readonly source: number;
}

export interface BspNode {
  readonly plane: Plane;
  front: BspNode | null;
  back: BspNode | null;
}

/** Fragment class relative to a closed solid. */
export const IN = 0;
export const OUT = 1;
/** On the solid's surface with the same outward normal. */
export const ON_SAME = 2;
/** On the solid's surface with the opposite outward normal. */
export const ON_OPPOSITE = 3;
export type PolyClass = typeof IN | typeof OUT | typeof ON_SAME | typeof ON_OPPOSITE;

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

export function planeOf(a: Tuple3, b: Tuple3, c: Tuple3): Plane | undefined {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const l = hypot3(nx, ny, nz);
  if (l === 0) return undefined;
  const n: Tuple3 = [nx / l, ny / l, nz / l];
  return { n, w: n[0] * a[0] + n[1] * a[1] + n[2] * a[2] };
}

export function flipPoly(poly: Poly): Poly {
  return {
    points: [...poly.points].reverse(),
    plane: { n: [-poly.plane.n[0], -poly.plane.n[1], -poly.plane.n[2]], w: -poly.plane.w },
    source: poly.source,
  };
}

interface Split {
  front?: Poly;
  back?: Poly;
  coplanar?: Poly;
  aligned: boolean;
}

/** Split a convex polygon by a plane; vertices within `eps` of the plane are on it. */
export function splitPoly(plane: Plane, poly: Poly, eps: number): Split {
  const { n, w } = plane;
  const points = poly.points;
  const types: number[] = [];
  const distances: number[] = [];
  let kind = 0;
  for (const p of points) {
    const t = n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - w;
    const type = t < -eps ? BACK : t > eps ? FRONT : COPLANAR;
    kind |= type;
    types.push(type);
    distances.push(t);
  }
  switch (kind) {
    case COPLANAR: {
      const m = poly.plane.n;
      return { coplanar: poly, aligned: n[0] * m[0] + n[1] * m[1] + n[2] * m[2] > 0 };
    }
    case FRONT:
      return { front: poly, aligned: false };
    case BACK:
      return { back: poly, aligned: false };
  }
  const f: Tuple3[] = [];
  const b: Tuple3[] = [];
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const ti = types[i] as number;
    const tj = types[j] as number;
    const vi = points[i] as Tuple3;
    const vj = points[j] as Tuple3;
    if (ti !== BACK) f.push(vi);
    if (ti !== FRONT) b.push(vi);
    if ((ti | tj) === SPANNING) {
      const di = distances[i] as number;
      const dj = distances[j] as number;
      const t = di / (di - dj);
      const v: Tuple3 = [
        vi[0] + (vj[0] - vi[0]) * t,
        vi[1] + (vj[1] - vi[1]) * t,
        vi[2] + (vj[2] - vi[2]) * t,
      ];
      f.push(v);
      b.push(v);
    }
  }
  const out: Split = { aligned: false };
  if (f.length >= 3) out.front = { points: f, plane: poly.plane, source: poly.source };
  if (b.length >= 3) out.back = { points: b, plane: poly.plane, source: poly.source };
  return out;
}

/**
 * Autopartition of a closed solid's polygons (iterative, so deep trees cannot exhaust
 * the stack). Returns undefined when the work budget runs out.
 */
export function buildTree(
  polys: readonly Poly[],
  eps: number,
  work: WorkMeter,
): { root: BspNode | null; nodes: number } | undefined {
  let root: BspNode | null = null;
  let nodes = 0;
  const stack: { polys: readonly Poly[]; attach: (node: BspNode) => void }[] = [];
  if (polys.length > 0) stack.push({ polys, attach: (node) => (root = node) });
  while (stack.length > 0) {
    const { polys: list, attach } = stack.pop() as (typeof stack)[number];
    const node: BspNode = { plane: (list[0] as Poly).plane, front: null, back: null };
    nodes++;
    attach(node);
    const front: Poly[] = [];
    const back: Poly[] = [];
    for (let i = 1; i < list.length; i++) {
      if (!work.spend(1)) return undefined;
      const split = splitPoly(node.plane, list[i] as Poly, eps);
      if (split.front !== undefined) front.push(split.front);
      if (split.back !== undefined) back.push(split.back);
    }
    if (front.length > 0) stack.push({ polys: front, attach: (child) => (node.front = child) });
    if (back.length > 0) stack.push({ polys: back, attach: (child) => (node.back = child) });
  }
  return { root, nodes };
}

type Continuation =
  | null
  | {
      readonly kind: 'back';
      readonly node: BspNode;
      readonly aligned: boolean;
      readonly next: Continuation;
    }
  | {
      readonly kind: 'combine';
      readonly front: PolyClass;
      readonly aligned: boolean;
      readonly next: Continuation;
    };

function combine(front: PolyClass, back: PolyClass, aligned: boolean): PolyClass {
  if (front === ON_SAME || front === ON_OPPOSITE) return front;
  if (back === ON_SAME || back === ON_OPPOSITE) return back;
  if (front === back) return front;
  // Outside in front of the plane and inside behind it: the solid's outward normal is
  // the plane normal there; the reverse case faces the other way.
  const solidAlongPlane = front === OUT;
  return solidAlongPlane === aligned ? ON_SAME : ON_OPPOSITE;
}

export interface Bounds {
  readonly min: Tuple3;
  readonly max: Tuple3;
}

export function boundsOf(polys: readonly Poly[]): Bounds {
  const min: Tuple3 = [Infinity, Infinity, Infinity];
  const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const poly of polys) {
    for (const p of poly.points) {
      for (let k = 0; k < 3; k++) {
        if ((p[k] as number) < (min[k] as number)) min[k] = p[k] as number;
        if ((p[k] as number) > (max[k] as number)) max[k] = p[k] as number;
      }
    }
  }
  return { min, max };
}

function disjoint(poly: Poly, bounds: Bounds, eps: number): boolean {
  for (let k = 0; k < 3; k++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of poly.points) {
      lo = Math.min(lo, p[k] as number);
      hi = Math.max(hi, p[k] as number);
    }
    if (lo > (bounds.max[k] as number) + eps || hi < (bounds.min[k] as number) - eps) return true;
  }
  return false;
}

/**
 * Split polygons into fragments that each lie entirely inside, outside or on the
 * surface of the closed solid whose tree is `root`. A fragment on a node plane is
 * classified once just in front of the plane and once just behind it; the pair of
 * answers says whether it is on the surface and with which orientation, which keeps
 * coplanar overlaps exact. Polygons outside the solid's bounds are outside.
 */
export function classify(
  polys: readonly Poly[],
  root: BspNode | null,
  bounds: Bounds,
  eps: number,
  work: WorkMeter,
): { poly: Poly; type: PolyClass }[] | undefined {
  const out: { poly: Poly; type: PolyClass }[] = [];
  const stack: { poly: Poly; node: BspNode; next: Continuation }[] = [];
  const emit = (poly: Poly, type: PolyClass, continuation: Continuation) => {
    let label = type;
    let next = continuation;
    for (;;) {
      if (next === null) {
        out.push({ poly, type: label });
        return;
      }
      if (next.kind === 'back') {
        const after: Continuation = {
          kind: 'combine',
          front: label,
          aligned: next.aligned,
          next: next.next,
        };
        if (next.node.back !== null) {
          stack.push({ poly, node: next.node.back, next: after });
          return;
        }
        label = IN;
        next = after;
        continue;
      }
      label = combine(next.front, label, next.aligned);
      next = next.next;
    }
  };
  for (const poly of polys) {
    if (root === null || disjoint(poly, bounds, eps)) {
      out.push({ poly, type: OUT });
      continue;
    }
    stack.push({ poly, node: root, next: null });
    while (stack.length > 0) {
      const { poly: piece, node, next } = stack.pop() as (typeof stack)[number];
      if (!work.spend(1)) return undefined;
      const split = splitPoly(node.plane, piece, eps);
      if (split.front !== undefined) {
        if (node.front !== null) stack.push({ poly: split.front, node: node.front, next });
        else emit(split.front, OUT, next);
      }
      if (split.back !== undefined) {
        if (node.back !== null) stack.push({ poly: split.back, node: node.back, next });
        else emit(split.back, IN, next);
      }
      if (split.coplanar !== undefined) {
        const after: Continuation = { kind: 'back', node, aligned: split.aligned, next };
        if (node.front !== null)
          stack.push({ poly: split.coplanar, node: node.front, next: after });
        else emit(split.coplanar, OUT, after);
      }
    }
  }
  return out;
}
