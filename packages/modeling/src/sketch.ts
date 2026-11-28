import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf, pushAll } from './arrays';
import { atan2, cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import type { Point2 } from './primitives';
import { type Region2, region2d } from './region2d';
import { analyze, jacobian, leastSquares } from './rig-loops';

/**
 * A profile edge between named points. A `line` runs a to b. An `arc` runs counter-clockwise
 * about `center` from `from` to `to` (both end points stay on one circle); `from` equal to
 * `to` is a full circle.
 */
export type SketchCurve =
  | { readonly kind: 'line'; readonly a: string; readonly b: string }
  | { readonly kind: 'arc'; readonly center: string; readonly from: string; readonly to: string };

/**
 * One geometric relation. `coincident` and `distance` name points; `fix` pins one point
 * (default where it starts); every other kind names curves: `horizontal` and `vertical` one
 * line, `parallel`, `perpendicular` and `angle` two lines (`angle`: degrees counter-clockwise
 * from line a's direction to line b's), `equal` two lines (length) or two arcs (radius),
 * `radius` one arc, `tangent` a line and an arc.
 */
export type SketchConstraint =
  | { readonly kind: 'coincident'; readonly a: string; readonly b: string }
  | { readonly kind: 'fix'; readonly point: string; readonly at?: Point2 }
  | { readonly kind: 'horizontal' | 'vertical'; readonly line: string }
  | {
      readonly kind: 'parallel' | 'perpendicular' | 'equal';
      readonly a: string;
      readonly b: string;
    }
  | { readonly kind: 'distance'; readonly a: string; readonly b: string; readonly value: number }
  | { readonly kind: 'radius'; readonly arc: string; readonly value: number }
  | { readonly kind: 'angle'; readonly a: string; readonly b: string; readonly degrees: number }
  | { readonly kind: 'tangent'; readonly line: string; readonly arc: string };

export interface SketchSpec {
  /** Starting coordinates: the solver moves them the least it can to satisfy the constraints. */
  readonly points: Readonly<Record<string, Point2>>;
  readonly curves: Readonly<Record<string, SketchCurve>>;
  readonly constraints: readonly SketchConstraint[];
}

export interface SketchOptions {
  /** Largest constraint residual accepted, as a fraction of the sketch size (default 1e-8). */
  readonly tolerance?: number;
  /** Largest arc sagitta of the sampled outline (default 1e-4). */
  readonly arcTolerance?: number;
}

export interface SketchSolution {
  /** The closed curve loops as outlines (counter-clockwise) and holes (clockwise). */
  readonly region: Region2;
  readonly points: Readonly<Record<string, Point2>>;
  /** Largest remaining constraint violation, as a fraction of the sketch size. */
  readonly residual: number;
  /** Coordinates the constraints leave free (the rank-based count; 0 when fully constrained). */
  readonly dof: number;
  /** Points that can still move without breaking a constraint. */
  readonly free: readonly string[];
}

type Row = (x: readonly number[]) => number[];
type Resolved =
  | { readonly kind: 'line'; readonly a: number; readonly b: number }
  | { readonly kind: 'arc'; readonly c: number; readonly from: number; readonly to: number };
type Line = Extract<Resolved, { kind: 'line' }>;
type Arc = Extract<Resolved, { kind: 'arc' }>;

const DEFAULT_TOLERANCE = 1e-8;
const DEFAULT_ARC_TOLERANCE = 1e-4;
const FREE_FLOOR = 1e-6;
const ROUNDS = 40;
const PULL = 1e-3;
const TAU = 2 * Math.PI;

const invalid = (option: string, value: unknown, expected: string) =>
  err(modelingError('model-invalid-argument', expected, { option, value }));

const coordinate = (x: readonly number[], i: number) => x[i] as number;
const dir = (x: readonly number[], l: Line): [number, number] => [
  coordinate(x, 2 * l.b) - coordinate(x, 2 * l.a),
  coordinate(x, 2 * l.b + 1) - coordinate(x, 2 * l.a + 1),
];
const span = (x: readonly number[], from: number, to: number): number => {
  const dx = coordinate(x, 2 * to) - coordinate(x, 2 * from);
  const dy = coordinate(x, 2 * to + 1) - coordinate(x, 2 * from + 1);
  return Math.sqrt(dx * dx + dy * dy);
};
const lengthOf = (x: readonly number[], l: Line) => span(x, l.a, l.b);
const radiusOf = (x: readonly number[], a: Arc) => span(x, a.c, a.from);
const sizeOf = (flat: readonly number[]): number => {
  const xs = flat.filter((_, i) => i % 2 === 0);
  const ys = flat.filter((_, i) => i % 2 === 1);
  const extent = Math.max(maxOf(xs) - minOf(xs), maxOf(ys) - minOf(ys));
  return extent > 0 ? extent : 1;
};
const unit = (v: number) => (v === 0 ? 1e-300 : v);

function compile(
  spec: SketchSpec,
  point: ReadonlyMap<string, number>,
  curve: ReadonlyMap<string, Resolved>,
): Result<Row[], ModelingError> {
  const rows: Row[] = [];
  for (const c of curve.values()) {
    if (c.kind === 'arc' && c.from !== c.to) {
      rows.push((x) => [span(x, c.c, c.from) - span(x, c.c, c.to)]);
    }
  }
  for (const [i, k] of spec.constraints.entries()) {
    const path = `constraints[${i}]`;
    const pointOf = (key: string) =>
      point.get((k as unknown as Record<string, string>)[key] as string);
    const curveOf = (key: string) =>
      curve.get((k as unknown as Record<string, string>)[key] as string);
    const lineOf = (key: string): Line | undefined => {
      const c = curveOf(key);
      return c?.kind === 'line' ? c : undefined;
    };
    const arcOf = (key: string): Arc | undefined => {
      const c = curveOf(key);
      return c?.kind === 'arc' ? c : undefined;
    };
    switch (k.kind) {
      case 'coincident': {
        const a = pointOf('a');
        const b = pointOf('b');
        if (a === undefined) return invalid(`${path}.a`, k.a, 'a point name of the sketch');
        if (b === undefined) return invalid(`${path}.b`, k.b, 'a point name of the sketch');
        rows.push((x) => [
          coordinate(x, 2 * b) - coordinate(x, 2 * a),
          coordinate(x, 2 * b + 1) - coordinate(x, 2 * a + 1),
        ]);
        break;
      }
      case 'fix': {
        const p = pointOf('point');
        if (p === undefined) return invalid(`${path}.point`, k.point, 'a point name of the sketch');
        const at = k.at ?? (spec.points[k.point] as Point2);
        if (!at.every(Number.isFinite)) return invalid(`${path}.at`, k.at, 'a finite [x, y]');
        rows.push((x) => [coordinate(x, 2 * p) - at[0], coordinate(x, 2 * p + 1) - at[1]]);
        break;
      }
      case 'distance': {
        const a = pointOf('a');
        const b = pointOf('b');
        if (a === undefined) return invalid(`${path}.a`, k.a, 'a point name of the sketch');
        if (b === undefined) return invalid(`${path}.b`, k.b, 'a point name of the sketch');
        if (!Number.isFinite(k.value) || k.value < 0) {
          return invalid(`${path}.value`, k.value, 'a finite distance >= 0');
        }
        rows.push((x) => [span(x, a, b) - k.value]);
        break;
      }
      case 'horizontal':
      case 'vertical': {
        const l = lineOf('line');
        if (l === undefined) return invalid(`${path}.line`, k.line, 'the name of a line curve');
        const axis = k.kind === 'horizontal' ? 1 : 0;
        rows.push((x) => [coordinate(x, 2 * l.b + axis) - coordinate(x, 2 * l.a + axis)]);
        break;
      }
      case 'parallel':
      case 'perpendicular':
      case 'angle': {
        const a = lineOf('a');
        const b = lineOf('b');
        if (a === undefined) return invalid(`${path}.a`, k.a, 'the name of a line curve');
        if (b === undefined) return invalid(`${path}.b`, k.b, 'the name of a line curve');
        const degrees = k.kind === 'angle' ? k.degrees : k.kind === 'parallel' ? 0 : 90;
        if (!Number.isFinite(degrees)) return invalid(`${path}.degrees`, degrees, 'finite degrees');
        const t = (degrees * Math.PI) / 180;
        const [ct, st] = [cos(t), sin(t)];
        rows.push((x) => {
          const [ux, uy] = dir(x, a);
          const [vx, vy] = dir(x, b);
          const cross = ux * vy - uy * vx;
          const dot = ux * vx + uy * vy;
          return [(cross * ct - dot * st) / unit(lengthOf(x, a) * lengthOf(x, b))];
        });
        break;
      }
      case 'equal': {
        const a = curveOf('a');
        const b = curveOf('b');
        if (a === undefined) return invalid(`${path}.a`, k.a, 'a curve name of the sketch');
        if (b === undefined) return invalid(`${path}.b`, k.b, 'a curve name of the sketch');
        if (a.kind === 'line' && b.kind === 'line') {
          rows.push((x) => [lengthOf(x, a) - lengthOf(x, b)]);
        } else if (a.kind === 'arc' && b.kind === 'arc') {
          rows.push((x) => [radiusOf(x, a) - radiusOf(x, b)]);
        } else return invalid(path, k, 'two lines or two arcs');
        break;
      }
      case 'radius': {
        const a = arcOf('arc');
        if (a === undefined) return invalid(`${path}.arc`, k.arc, 'the name of an arc curve');
        if (!Number.isFinite(k.value) || k.value <= 0) {
          return invalid(`${path}.value`, k.value, 'a finite radius > 0');
        }
        rows.push((x) => [radiusOf(x, a) - k.value]);
        break;
      }
      case 'tangent': {
        const l = lineOf('line');
        const a = arcOf('arc');
        if (l === undefined) return invalid(`${path}.line`, k.line, 'the name of a line curve');
        if (a === undefined) return invalid(`${path}.arc`, k.arc, 'the name of an arc curve');
        rows.push((x) => {
          const [ux, uy] = dir(x, l);
          const cx = coordinate(x, 2 * a.c) - coordinate(x, 2 * l.a);
          const cy = coordinate(x, 2 * a.c + 1) - coordinate(x, 2 * l.a + 1);
          return [Math.abs(ux * cy - uy * cx) / unit(lengthOf(x, l)) - radiusOf(x, a)];
        });
        break;
      }
      default:
        return invalid(
          path,
          k,
          'a constraint of kind coincident, fix, horizontal, vertical, parallel, perpendicular, equal, distance, radius, angle or tangent',
        );
    }
  }
  return ok(rows);
}

function sweepOf(x: readonly number[], a: Arc): number {
  if (a.from === a.to) return TAU;
  const a0 = atan2(
    coordinate(x, 2 * a.from + 1) - coordinate(x, 2 * a.c + 1),
    coordinate(x, 2 * a.from) - coordinate(x, 2 * a.c),
  );
  const a1 = atan2(
    coordinate(x, 2 * a.to + 1) - coordinate(x, 2 * a.c + 1),
    coordinate(x, 2 * a.to) - coordinate(x, 2 * a.c),
  );
  const s = a1 - a0;
  return s <= 0 ? s + TAU : s;
}

/** Interior points of an arc walked from `start` (an end of the arc) along its sweep. */
function arcInterior(x: readonly number[], a: Arc, forward: boolean, chord: number): Point2[] {
  const cx = coordinate(x, 2 * a.c);
  const cy = coordinate(x, 2 * a.c + 1);
  const r = radiusOf(x, a);
  const sweep = sweepOf(x, a);
  const origin = forward ? a.from : a.to;
  const a0 = atan2(coordinate(x, 2 * origin + 1) - cy, coordinate(x, 2 * origin) - cx);
  const signed = forward ? sweep : -sweep;
  const ratio = Math.min(1, chord / r);
  const step = 2 * atan2(Math.sqrt(ratio * (2 - ratio)), 1 - ratio);
  const n = Math.max(1, Math.ceil(sweep / step), Math.ceil(sweep / (Math.PI / 2)));
  const out: Point2[] = [];
  for (let k = 1; k < n; k++) {
    const t = a0 + (signed * k) / n;
    out.push([cx + r * cos(t), cy + r * sin(t)]);
  }
  return out;
}

function signedArea(ring: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i] as Point2;
    const q = ring[(i + 1) % ring.length] as Point2;
    area += p[0] * q[1] - q[0] * p[1];
  }
  return area / 2;
}

function representatives(
  count: number,
  spec: SketchSpec,
  point: ReadonlyMap<string, number>,
): number[] {
  const rep = Array.from({ length: count }, (_, i) => i);
  const find = (i: number): number => ((rep[i] as number) === i ? i : find(rep[i] as number));
  for (const k of spec.constraints) {
    if (k.kind !== 'coincident') continue;
    const a = find(point.get(k.a) as number);
    const b = find(point.get(k.b) as number);
    rep[Math.max(a, b)] = Math.min(a, b);
  }
  return rep.map((_, i) => find(i));
}

function loops(
  x: readonly number[],
  names: readonly string[],
  curve: ReadonlyMap<string, Resolved>,
  rep: readonly number[],
  chord: number,
): Result<Point2[][], ModelingError> {
  const raw = (c: Resolved): [number, number] => (c.kind === 'line' ? [c.a, c.b] : [c.from, c.to]);
  const ends = (c: Resolved): [number, number] => {
    const [p, q] = raw(c);
    return [rep[p] as number, rep[q] as number];
  };
  const incident = new Map<number, string[]>();
  for (const [name, c] of curve) {
    for (const p of ends(c)) incident.set(p, [...(incident.get(p) ?? []), name]);
  }
  for (const [p, list] of incident) {
    if (list.length !== 2) {
      return err(
        modelingError(
          'model-precondition',
          'every curve end point joins exactly two curve ends (closed loops)',
          { reason: 'profile-not-closed', point: names[p], ends: list.length },
        ),
      );
    }
  }
  const used = new Set<string>();
  const rings: Point2[][] = [];
  for (const [first, firstCurve] of curve) {
    if (used.has(first)) continue;
    const ring: Point2[] = [];
    let name = first;
    let at = ends(firstCurve)[0];
    for (;;) {
      used.add(name);
      const c = curve.get(name) as Resolved;
      const [e0, e1] = ends(c);
      const forward = at === e0;
      const here = raw(c)[forward ? 0 : 1];
      ring.push([coordinate(x, 2 * here), coordinate(x, 2 * here + 1)]);
      if (c.kind === 'arc') pushAll(ring, arcInterior(x, c, forward, chord));
      at = forward ? e1 : e0;
      const next = (incident.get(at) as string[]).find((n) => n !== name && !used.has(n));
      if (next === undefined) break;
      name = next;
    }
    rings.push(ring);
  }
  return ok(rings);
}

function assemble(rings: readonly Point2[][]): Result<Region2, ModelingError> {
  const depth = rings.map(
    (ring, i) =>
      rings.filter(
        (other, j) => j !== i && region2d.contains([{ outer: other }], ring[0] as Point2),
      ).length,
  );
  const areas = rings.map((ring) => Math.abs(signedArea(ring)));
  const flat = areas.findIndex((a) => !(a > 0));
  if (flat >= 0) {
    return err(
      modelingError('model-degenerate', 'every closed profile loop encloses area', { loop: flat }),
    );
  }
  const shapes: { outer: readonly Point2[]; holes: (readonly Point2[])[] }[] = [];
  const owner = new Map<number, number>();
  for (const [i, ring] of rings.entries()) {
    if ((depth[i] as number) % 2 === 0) {
      owner.set(i, shapes.length);
      shapes.push({ outer: signedArea(ring) > 0 ? ring : [...ring].reverse(), holes: [] });
    }
  }
  for (const [i, ring] of rings.entries()) {
    if ((depth[i] as number) % 2 === 0) continue;
    let best = -1;
    for (const j of owner.keys()) {
      const contains = region2d.contains([{ outer: rings[j] as Point2[] }], ring[0] as Point2);
      if (contains && (best < 0 || (areas[j] as number) < (areas[best] as number))) best = j;
    }
    shapes[owner.get(best) as number]?.holes.push(
      signedArea(ring) < 0 ? ring : [...ring].reverse(),
    );
  }
  return ok(shapes.map((s) => (s.holes.length === 0 ? { outer: s.outer } : s)));
}

function validate(spec: SketchSpec): ModelingError | undefined {
  const names = Object.keys(spec.points);
  for (const name of names) {
    const p = spec.points[name] as Point2;
    if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) {
      return modelingError('model-invalid-argument', 'a finite [x, y] point', {
        option: `points.${name}`,
        value: p,
      });
    }
  }
  if (Object.keys(spec.curves).length === 0) {
    return modelingError('model-invalid-argument', 'at least one curve', {
      option: 'curves',
      value: spec.curves,
    });
  }
  return undefined;
}

function resolveCurves(
  spec: SketchSpec,
  point: ReadonlyMap<string, number>,
): Result<Map<string, Resolved>, ModelingError> {
  const out = new Map<string, Resolved>();
  for (const [name, c] of Object.entries(spec.curves)) {
    const keys = c.kind === 'line' ? (['a', 'b'] as const) : (['center', 'from', 'to'] as const);
    if (c.kind !== 'line' && c.kind !== 'arc') {
      return invalid(`curves.${name}.kind`, (c as { kind: unknown }).kind, "'line' or 'arc'");
    }
    const found: number[] = [];
    for (const key of keys) {
      const ref = (c as unknown as Record<string, string>)[key] as string;
      const i = point.get(ref);
      if (i === undefined)
        return invalid(`curves.${name}.${key}`, ref, 'a point name of the sketch');
      found.push(i);
    }
    out.set(
      name,
      c.kind === 'line'
        ? { kind: 'line', a: found[0] as number, b: found[1] as number }
        : { kind: 'arc', c: found[0] as number, from: found[1] as number, to: found[2] as number },
    );
  }
  return ok(out);
}

/**
 * Constraint sketch: named points, line and arc curves and geometric relations
 * solve together by Levenberg-Marquardt (the rig-loop `leastSquares`), starting from the given
 * coordinates, into the closed profile as a region that `extrudePolygon` and `region2d.*`
 * take. A sketch the constraints leave free still solves (the coordinates stay where
 * they were): `dof` and `free` report what can still move. Inconsistent constraints, or a
 * start too far from a solution, fail with `model-solver-diverged`.
 */
export const sketch = {
  solve(spec: SketchSpec, options: SketchOptions = {}): Result<SketchSolution, ModelingError> {
    const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
    const chord = options.arcTolerance ?? DEFAULT_ARC_TOLERANCE;
    if (!Number.isFinite(tolerance) || tolerance <= 0) {
      return invalid('tolerance', tolerance, 'a finite residual > 0');
    }
    if (!Number.isFinite(chord) || chord <= 0) {
      return invalid('arcTolerance', chord, 'a finite length > 0');
    }
    const bad = validate(spec);
    if (bad !== undefined) return err(bad);
    const names = Object.keys(spec.points);
    const point = new Map(names.map((n, i) => [n, i] as const));
    const curve = resolveCurves(spec, point);
    if (!curve.ok) return curve;
    const compiled = compile(spec, point, curve.value);
    if (!compiled.ok) return compiled;
    const start = names.flatMap((n) => spec.points[n] as Point2);
    const size = sizeOf(start);
    const origin = [
      minOf(start.filter((_, i) => i % 2 === 0)),
      minOf(start.filter((_, i) => i % 2 === 1)),
    ];
    const toWorld = (y: readonly number[]) => y.map((v, i) => (origin[i % 2] as number) + v * size);
    const f: (y: readonly number[]) => number[] = (y) => {
      const x = toWorld(y);
      return compiled.value.flatMap((row) => row(x)).map((v) => v / size);
    };
    const worst = (y: readonly number[]) => Math.max(0, maxOf(f(y).map(Math.abs)));
    let x = start.map((v, i) => (v - (origin[i % 2] as number)) / size);
    let iterations = 0;
    for (let round = 0; round < ROUNDS && worst(x) > tolerance; round++) {
      const anchor = x;
      const pull = (y: readonly number[]) => [
        ...f(y),
        ...y.map((v, i) => PULL * (v - (anchor[i] as number))),
      ];
      const step = leastSquares(pull, anchor, tolerance);
      iterations += step.iterations;
      x = step.x;
    }
    const fit = { x, residual: worst(x), iterations };
    if (!(fit.residual <= tolerance)) {
      return err(
        modelingError(
          'model-solver-diverged',
          'the sketch constraints are consistent and reachable from the starting coordinates',
          { residual: fit.residual, iterations: fit.iterations },
        ),
      );
    }
    const solved = toWorld(fit.x);
    const rings = loops(
      solved,
      names,
      curve.value,
      representatives(names.length, spec, point),
      chord,
    );
    if (!rings.ok) return rings;
    const region = assemble(rings.value);
    if (!region.ok) return region;
    const { rank, nullSpace } = analyze(jacobian(f, fit.x), fit.x.length);
    const free = names.filter((_, i) =>
      nullSpace.some(
        (v) =>
          Math.abs(v[2 * i] as number) > FREE_FLOOR ||
          Math.abs(v[2 * i + 1] as number) > FREE_FLOOR,
      ),
    );
    return ok({
      region: region.value,
      points: Object.fromEntries(
        names.map((n, i) => [n, [solved[2 * i] as number, solved[2 * i + 1] as number] as Point2]),
      ),
      residual: fit.residual,
      dof: fit.x.length - rank,
      free,
    });
  },
};
