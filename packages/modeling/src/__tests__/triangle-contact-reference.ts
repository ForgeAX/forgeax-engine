// Reference oracle for the triangleContact falsifier. Verbatim copy of the closure in
// src/intersect.ts at origin/main 76581473, before the allocation-free rewrite. Keep it
// unchanged: it is the old behaviour, not production code. The only edit from the source is
// the exported name (referenceTriangleContact); the helpers keep their original text.
import { hypot2 } from '../dmath';
import type { Tuple3 } from '../geom';
import { orient2d, orient3d } from '../predicates';

type Contact = 'none' | 'touch' | 'cross';

type P = readonly [number, number, number];

function strongest(a: Contact, b: Contact): Contact {
  return a === 'cross' || b === 'cross'
    ? 'cross'
    : a === 'touch' || b === 'touch'
      ? 'touch'
      : 'none';
}

function dropAxis(t: readonly P[]): [number, number] {
  const [a, b, c] = t as [P, P, P];
  const u: Tuple3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Tuple3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Tuple3 = [
    Math.abs(u[1] * v[2] - u[2] * v[1]),
    Math.abs(u[2] * v[0] - u[0] * v[2]),
    Math.abs(u[0] * v[1] - u[1] * v[0]),
  ];
  const drop = n[0] >= n[1] && n[0] >= n[2] ? 0 : n[1] >= n[2] ? 1 : 2;
  return [(drop + 1) % 3, (drop + 2) % 3];
}

function segmentsContact2d(a: number[], b: number[], c: number[], d: number[]): Contact {
  const o = (p: number[], q: number[], r: number[]) =>
    Math.sign(
      orient2d(
        p[0] as number,
        p[1] as number,
        q[0] as number,
        q[1] as number,
        r[0] as number,
        r[1] as number,
      ),
    );
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 'cross';
  const within = (p: number[], q: number[], r: number[]) =>
    Math.min(p[0] as number, q[0] as number) <= (r[0] as number) &&
    (r[0] as number) <= Math.max(p[0] as number, q[0] as number) &&
    Math.min(p[1] as number, q[1] as number) <= (r[1] as number) &&
    (r[1] as number) <= Math.max(p[1] as number, q[1] as number);
  if (
    (d1 === 0 && within(a, b, c)) ||
    (d2 === 0 && within(a, b, d)) ||
    (d3 === 0 && within(c, d, a)) ||
    (d4 === 0 && within(c, d, b))
  ) {
    return 'touch';
  }
  return 'none';
}

function pointInTriangle2d(p: number[], t: number[][]): Contact {
  const signs = [0, 1, 2].map((i) => {
    const a = t[i] as number[];
    const b = t[(i + 1) % 3] as number[];
    return Math.sign(
      orient2d(
        a[0] as number,
        a[1] as number,
        b[0] as number,
        b[1] as number,
        p[0] as number,
        p[1] as number,
      ),
    );
  });
  const orientation = Math.sign(
    orient2d(
      (t[0] as number[])[0] as number,
      (t[0] as number[])[1] as number,
      (t[1] as number[])[0] as number,
      (t[1] as number[])[1] as number,
      (t[2] as number[])[0] as number,
      (t[2] as number[])[1] as number,
    ),
  );
  if (signs.every((s) => s === orientation)) return 'cross';
  if (signs.every((s) => s === orientation || s === 0)) return 'touch';
  return 'none';
}

function facing(t1: readonly P[], t2: readonly P[]): number {
  const n = (t: readonly P[]) => {
    const [a, b, c] = t as [P, P, P];
    const u: Tuple3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: Tuple3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  };
  const a = n(t1);
  const b = n(t2);
  return Math.sign(
    (a[0] as number) * (b[0] as number) +
      (a[1] as number) * (b[1] as number) +
      (a[2] as number) * (b[2] as number),
  );
}

function coplanarContact(
  t1: readonly P[],
  t2: readonly P[],
  boundary = true,
  tolerance = 0,
): Contact {
  const [i, j] = dropAxis(t1);
  const a = t1.map((p) => [p[i], p[j]] as number[]);
  const b = t2.map((p) => [p[i], p[j]] as number[]);
  const centroid = (t: number[][]) =>
    [0, 1].map((k) => t.reduce((sum, p) => sum + (p[k] as number), 0) / 3);
  let edge: Contact = 'none';
  let overlap =
    pointInTriangle2d(centroid(a), b) === 'cross' || pointInTriangle2d(centroid(b), a) === 'cross';
  for (let k = 0; k < 3 && !overlap; k++) {
    for (let l = 0; l < 3; l++) {
      const edges = segmentsContact2d(
        a[k] as number[],
        a[(k + 1) % 3] as number[],
        b[l] as number[],
        b[(l + 1) % 3] as number[],
      );
      if (edges === 'cross') overlap = true;
      edge = strongest(edge, edges);
    }
    const inA = pointInTriangle2d(b[k] as number[], a);
    const inB = pointInTriangle2d(a[k] as number[], b);
    if (inA === 'cross' || inB === 'cross') overlap = true;
    edge = strongest(edge, strongest(inA, inB));
  }
  if (overlap) {
    if (facing(t1, t2) <= 0) return 'touch';
    // Separate parts cut from one another (splitBy pieces, a lifted cover) meet with
    // vertices an ulp apart: a same-facing overlap no wider than the tolerance is contact.
    return tolerance > 0 && overlapWidth(t1, a, b) <= tolerance ? 'touch' : 'cross';
  }
  return boundary && edge !== 'none' ? 'touch' : 'none';
}

function overlapWidth(t: readonly P[], a: readonly number[][], b: readonly number[][]): number {
  const signedArea = (poly: readonly number[][]) =>
    poly.reduce((sum, p, k) => {
      const q = poly[(k + 1) % poly.length] as number[];
      return sum + (p[0] as number) * (q[1] as number) - (q[0] as number) * (p[1] as number);
    }, 0) / 2;
  const ccw = (poly: readonly number[][]) =>
    signedArea(poly) < 0 ? [...poly].reverse() : [...poly];
  let clipped = ccw(a);
  const clip = ccw(b);
  for (let k = 0; k < 3 && clipped.length > 0; k++) {
    const e0 = clip[k] as number[];
    const e1 = clip[(k + 1) % 3] as number[];
    const inside = (p: number[]) =>
      ((e1[0] as number) - (e0[0] as number)) * ((p[1] as number) - (e0[1] as number)) -
        ((e1[1] as number) - (e0[1] as number)) * ((p[0] as number) - (e0[0] as number)) >=
      0;
    const next: number[][] = [];
    for (let m = 0; m < clipped.length; m++) {
      const p = clipped[m] as number[];
      const q = clipped[(m + 1) % clipped.length] as number[];
      const pi = inside(p);
      const qi = inside(q);
      if (pi) next.push(p);
      if (pi !== qi) {
        const dx = (e1[0] as number) - (e0[0] as number);
        const dy = (e1[1] as number) - (e0[1] as number);
        const num =
          dx * ((p[1] as number) - (e0[1] as number)) - dy * ((p[0] as number) - (e0[0] as number));
        const den =
          dx * ((p[1] as number) - (q[1] as number)) - dy * ((p[0] as number) - (q[0] as number));
        const s = den === 0 ? 0 : num / den;
        next.push([
          (p[0] as number) + ((q[0] as number) - (p[0] as number)) * s,
          (p[1] as number) + ((q[1] as number) - (p[1] as number)) * s,
        ]);
      }
    }
    clipped = next;
  }
  if (clipped.length < 3) return 0;
  const area = Math.abs(signedArea(clipped));
  const perimeter = clipped.reduce((sum, p, k) => {
    const q = clipped[(k + 1) % clipped.length] as number[];
    return sum + hypot2((q[0] as number) - (p[0] as number), (q[1] as number) - (p[1] as number));
  }, 0);
  if (perimeter === 0) return 0;
  const n = normalOf(t);
  const length = Math.sqrt(dot3(n, n));
  const kept = Math.max(Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])) / length;
  return (2 * area) / perimeter / kept;
}

function segmentTriangleSides(p: P, q: P, t: readonly P[], sp: number, sq: number): Contact {
  const [a, b, c] = t as [P, P, P];
  if (sp * sq > 0) return 'none';
  if (sp === 0 && sq === 0) {
    const [i, j] = dropAxis(t);
    const s = [p, q].map((x) => [x[i], x[j]] as number[]);
    const tri = t.map((x) => [x[i], x[j]] as number[]);
    let out: Contact = 'none';
    for (let k = 0; k < 3; k++) {
      out = strongest(
        out,
        segmentsContact2d(
          s[0] as number[],
          s[1] as number[],
          tri[k] as number[],
          tri[(k + 1) % 3] as number[],
        ),
      );
    }
    const inside = strongest(
      pointInTriangle2d(s[0] as number[], tri),
      pointInTriangle2d(s[1] as number[], tri),
    );
    return out === 'none' && inside === 'none' ? 'none' : 'touch';
  }
  const e = [
    Math.sign(orient3d(p, q, a, b)),
    Math.sign(orient3d(p, q, b, c)),
    Math.sign(orient3d(p, q, c, a)),
  ];
  const pierces = e.every((s) => s > 0) || e.every((s) => s < 0);
  const grazes = !pierces && (e.every((s) => s >= 0) || e.every((s) => s <= 0));
  if (!pierces && !grazes) return 'none';
  return pierces && sp !== 0 && sq !== 0 ? 'cross' : 'touch';
}

function nearCoplanar(t1: readonly P[], t2: readonly P[], tolerance: number): boolean {
  const within = (t: readonly P[], plane: readonly P[]) => {
    const n = normalOf(plane);
    const length = Math.sqrt(dot3(n, n));
    if (length === 0) return false;
    const o = plane[0] as P;
    return t.every((p) => Math.abs(dot3(minus(p, o), n)) / length <= tolerance);
  };
  return within(t1, t2) && within(t2, t1);
}

function minus(a: P, b: P): Tuple3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot3(a: readonly number[], b: readonly number[]): number {
  return (
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number)
  );
}

function normalOf(t: readonly P[]): Tuple3 {
  const u = minus(t[1] as P, t[0] as P);
  const v = minus(t[2] as P, t[0] as P);
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

export function referenceTriangleContact(
  t1: readonly P[],
  t2: readonly P[],
  tolerance = 0,
): Contact {
  if (tolerance > 0 && nearCoplanar(t1, t2, tolerance)) {
    return coplanarContact(t1, t2, true, tolerance);
  }
  const side = (t: readonly P[], others: readonly P[]) =>
    others.map((p) => Math.sign(orient3d(t[0] as P, t[1] as P, t[2] as P, p)));
  const s2 = side(t1, t2);
  if (s2.every((s) => s > 0) || s2.every((s) => s < 0)) return 'none';
  const s1 = side(t2, t1);
  if (s1.every((s) => s > 0) || s1.every((s) => s < 0)) return 'none';
  if (s2.every((s) => s === 0)) return coplanarContact(t1, t2, true, tolerance);
  let out: Contact = 'none';
  for (let k = 0; k < 3; k++) {
    const next = (k + 1) % 3;
    out = strongest(
      out,
      segmentTriangleSides(t1[k] as P, t1[next] as P, t2, s1[k] as number, s1[next] as number),
    );
    out = strongest(
      out,
      segmentTriangleSides(t2[k] as P, t2[next] as P, t1, s2[k] as number, s2[next] as number),
    );
  }
  return out;
}
