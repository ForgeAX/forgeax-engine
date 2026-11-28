import { type Model, type OpReport, type Point2, sel, type Tuple3 } from '@forgeax/engine-modeling';

/** Throws the first failure of an operation with its structured detail. */
export function check(r: OpReport, what = ''): OpReport {
  if (r.status === 'failed') {
    const e = r.error;
    throw new Error(`${what || r.op} failed: ${e?.code} ${e?.expected ?? ''} ${JSON.stringify(e?.detail ?? {}).slice(0, 400)} ${e?.hint ?? ''}`);
  }
  return r;
}

export function closedModel(m: Model, what: string): Model {
  const v = m.validate();
  if (!v.pass) throw new Error(`${what} does not validate: ${JSON.stringify(v.issues.slice(0, 3)).slice(0, 400)}`);
  return m;
}

/**
 * Lines of a counter-clockwise polygon pushed `d[i]` along their left (inner) normal, with
 * every corner the intersection of its two neighbours: planar sections of one faceted
 * solid, so lofted facets stay planar.
 */
export function offsetEdges(poly: readonly Point2[], d: readonly number[]): Point2[] {
  const n = poly.length;
  const lines = poly.map((a, i) => {
    const b = poly[(i + 1) % n] as Point2;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    return { p: [a[0] - (dy / l) * (d[i] as number), a[1] + (dx / l) * (d[i] as number)] as Point2, dir: [dx / l, dy / l] as Point2 };
  });
  return poly.map((_, i) => {
    const a = lines[(i + n - 1) % n] as (typeof lines)[number];
    const b = lines[i] as (typeof lines)[number];
    const det = a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0];
    const t = ((b.p[0] - a.p[0]) * b.dir[1] - (b.p[1] - a.p[1]) * b.dir[0]) / det;
    return [a.p[0] + a.dir[0] * t, a.p[1] + a.dir[1] * t] as Point2;
  });
}

/** Normal distance from each edge of `from` to the parallel edge of `to` (both counter-clockwise). */
export function edgeDistances(from: readonly Point2[], to: readonly Point2[]): number[] {
  const n = from.length;
  return from.map((a, i) => {
    const b = from[(i + 1) % n] as Point2;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const r = to[i] as Point2;
    return (-(b[1] - a[1]) * (r[0] - a[0]) + (b[0] - a[0]) * (r[1] - a[1])) / l;
  });
}

/** A planar section of `base` at height `y`, `t` of the way to the roof outline. */
export function section(base: readonly Point2[], total: readonly number[], t: number, y: number): Tuple3[] {
  return offsetEdges(base, total.map((d) => d * t)).map(([x, z]) => [x, y, z] as Tuple3);
}

/** Points of an arc about `c` from `a0` to `a1` degrees (0 = +x, counter-clockwise), ends included. */
export function arc(c: Point2, radius: number, a0: number, a1: number, n: number): Point2[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    return [c[0] + radius * Math.cos(t), c[1] + radius * Math.sin(t)] as Point2;
  });
}

/** Outline of an annular sector (counter-clockwise), `r0 = 0` makes a pie wedge. */
export function sector(c: Point2, r0: number, r1: number, a0: number, a1: number, n: number): Point2[] {
  const outer = arc(c, r1, a0, a1, n);
  if (r0 <= 0) return [c, ...outer];
  return [...outer, ...arc(c, r0, a1, a0, n)];
}

export function circle(c: Point2, radius: number, n: number, phase = 0): Point2[] {
  return Array.from({ length: n }, (_, i) => {
    const t = phase + (2 * Math.PI * i) / n;
    return [c[0] + radius * Math.cos(t), c[1] + radius * Math.sin(t)] as Point2;
  });
}

/** Radius of a piecewise-linear [u, r] profile at u. */
export function radiusAt(profile: readonly Point2[], u: number): number {
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1] as Point2;
    const b = profile[i] as Point2;
    if (u <= b[0]) return b[0] === a[0] ? b[1] : a[1] + ((b[1] - a[1]) * (u - a[0])) / (b[0] - a[0]);
  }
  return (profile.at(-1) as Point2)[1];
}

/** Outline of two discs of `radius` joined by their tangents (counter-clockwise), centres at x = +-half. */
export function stadium(half: number, radius: number, n: number): Point2[] {
  return [...arc([half, 0], radius, -90, 90, n), ...arc([-half, 0], radius, 90, 270, n)];
}

/** `stadium` as a planar section at `z`, centred on (0, y). */
export function stadiumSection(half: number, radius: number, y: number, z: number, n: number): Tuple3[] {
  return stadium(half, radius, n).map(([x, v]) => [x, y + v, z] as Tuple3);
}

/** Prism of a (z, y) side profile spanning x0..x1 (an extrudePolygon turned about Y, as the house window wedge). */
export function extrudeZY(m: Model, points: readonly Point2[], x0: number, x1: number, label: string): OpReport {
  const r = check(m.extrudePolygon({ points: [...points], depth: x1 - x0, label }), label);
  check(m.rotate(sel.all(), 'y', -90));
  check(m.translate(sel.all(), [x1, 0, 0]));
  return r;
}

/** Prism of an (x, y) front profile spanning z0..z1. */
export function extrudeXY(m: Model, points: readonly Point2[], z0: number, z1: number, label: string): OpReport {
  const r = check(m.extrudePolygon({ points: [...points], depth: z1 - z0, label }), label);
  check(m.translate(sel.all(), [0, 0, z0]));
  return r;
}

/** Prism of an (x, z) plan polygon spanning y0..y1. */
export function extrudeXZ(m: Model, points: readonly Point2[], y0: number, y1: number, label: string): OpReport {
  const r = check(m.extrudePolygon({ points: [...points], depth: y1 - y0, label }), label);
  check(m.rotate(sel.all(), 'x', 90));
  check(m.translate(sel.all(), [0, y1, 0]));
  return r;
}

/** Cylinder along an axis (`'x' | 'y' | 'z'`) centred at `center`. */
export function bar(m: Model, axis: 'x' | 'y' | 'z', center: Tuple3, length: number, radius: number, segments = 12, label?: string): OpReport {
  const r = check(m.cylinder({ radiusTop: radius, radiusBottom: radius, height: length, radialSegments: segments, center, ...(label === undefined ? {} : { label }) }), label ?? 'bar');
  if (axis === 'x') check(m.rotate(sel.all(), 'z', 90, center));
  if (axis === 'z') check(m.rotate(sel.all(), 'x', 90, center));
  return r;
}
