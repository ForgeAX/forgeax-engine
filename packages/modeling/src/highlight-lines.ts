import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf, pushAll } from './arrays';
import { atan2, cos, hypot3 } from './dmath';
import { type ModelingError, modelingError } from './errors';
import type { Tuple3 } from './geom';
import {
  approximate,
  checkSurface,
  type NurbsCurve,
  type NurbsSurface,
  parametersOf,
  surfaceDerivatives,
  surfaceDomain,
} from './nurbs';
import { reflectionPhase, type ZebraOptions } from './surface-analysis';

/**
 * Which highlight lines to extract. `reflection`: the zebra's stripe borders, the lines
 * where the reflected view ray's angle around the stripe axis is a multiple of `width`
 * (`refine` is unused). `isophote`: the view-independent lines where the angle between the
 * patch normal (dS/du x dS/dv) and `direction` is a multiple of `step` degrees, so
 * n · direction = cos(k · step). `weld`: largest distance between line ends chained across
 * patch boundaries, meters (default 1e-6 x the diagonal of the patches' bounding box).
 */
export type HighlightOptions = (
  | ({ readonly field: 'reflection' } & ZebraOptions)
  | {
      readonly field: 'isophote';
      readonly direction: Tuple3;
      /** Angle between neighbouring isophotes, degrees, in (0, 90]. */
      readonly step: number;
    }
) & {
  readonly weld?: number;
};

export interface HighlightLine {
  /** Cubic least-squares fit of the traced points. */
  readonly curve: NurbsCurve;
  /** The line's angle in degrees: k x `width` (reflection) or k x `step` (isophote). */
  readonly level: number;
  /** Indices of the patches the line crosses, in the order it crosses them. */
  readonly patches: readonly number[];
}

/** A traced point: exactly on the level, with its patch, parameters and normal. @internal */
export interface HighlightPoint {
  readonly p: Tuple3;
  readonly n: Tuple3;
  readonly patch: number;
  readonly u: number;
  readonly v: number;
  /** Whether the point lies on a side of its patch. */
  readonly side: boolean;
}

/** A traced highlight line, chained across patches. @internal */
export interface HighlightTrace {
  readonly level: number;
  readonly points: readonly HighlightPoint[];
}

/** Grid cells per patch direction for the marching squares. */
const CELLS = 64;
const BISECTIONS = 30;
/** Fitted control points per traced point, and their cap. */
const POINTS_PER_CONTROL = 3;
const MAX_CONTROL = 48;
/** Chains shorter than this fraction of the scene diagonal, or with fewer points, are skipped. */
const MIN_LENGTH = 0.01;
const MIN_POINTS = 8;
/** Traced points closer than this share of the median spacing to the last kept one are dropped. */
const SPACING = 0.5;

const sub = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Tuple3, b: Tuple3): Tuple3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Tuple3) => hypot3(a[0], a[1], a[2]);
const distance = (a: Tuple3, b: Tuple3) => norm(sub(a, b));

function invalid(expected: string, detail: Record<string, unknown>): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

/**
 * Reflected rays within this angle of the stripe axis (degrees) are not sampled: every
 * reflection line meets there, so the field has no direction and the lines bunch up.
 */
const POLE = 5;
const POLE_COS = cos((POLE * Math.PI) / 180);

/** @internal */
export interface Field {
  /** Scalar per point and normal (NaN where the field is undefined). */
  readonly value: (p: Tuple3, n: Tuple3) => number;
  /** The field in line spacings: level k lies at k (NaN where the field is undefined). */
  readonly coordinate: (p: Tuple3, n: Tuple3) => number;
  /** The level values crossing (lo, hi]: [level index, value][]. */
  readonly levels: (lo: number, hi: number) => [number, number][];
  /** Degrees per level index. */
  readonly degrees: number;
  /** Value range of a branch cut (cells spanning more than half of it are skipped). */
  readonly period: number;
}

/** The scalar field of a highlight view (see `HighlightOptions`). @internal */
export function fieldOf(options: HighlightOptions): Result<Field, ModelingError> {
  if (options.field === 'reflection') {
    const reflection = reflectionPhase(options);
    if (!reflection.ok) return reflection;
    const { phase, axial } = reflection.value;
    const value = (p: Tuple3, n: Tuple3) => (axial(p, n) > POLE_COS ? Number.NaN : phase(p, n));
    const levels = (lo: number, hi: number): [number, number][] => {
      const out: [number, number][] = [];
      for (let k = Math.floor(lo) + 1; k <= hi; k++) out.push([k, k]);
      return out;
    };
    return ok({
      value,
      coordinate: value,
      levels,
      degrees: options.width ?? 4,
      period: reflection.value.period,
    });
  }
  if (options.field !== 'isophote')
    return err(
      invalid("field is 'reflection' or 'isophote'", {
        field: (options as { readonly field?: unknown }).field,
      }),
    );
  const step = options.step;
  if (!(Number.isFinite(step) && step > 0 && step <= 90))
    return err(invalid('isophote step is in (0, 90] degrees', { step }));
  const d = options.direction;
  const length = Array.isArray(d) && d.every(Number.isFinite) ? norm(d) : 0;
  if (!(length > 0))
    return err(invalid('isophote direction is a nonzero vector', { direction: d }));
  const direction: Tuple3 = [d[0] / length, d[1] / length, d[2] / length];
  // n · direction = 1 and = -1 are single points, not lines.
  const table: [number, number][] = [];
  for (let k = 1; k * step < 180; k++) table.push([k, cos((k * step * Math.PI) / 180)]);
  return ok({
    value: (_p, n) => dot(n, direction),
    coordinate: (_p, n) =>
      (atan2(norm(cross(n, direction)), dot(n, direction)) * 180) / Math.PI / step,
    levels: (lo, hi) => table.filter(([, c]) => lo < c && c <= hi),
    degrees: step,
    period: Number.POSITIVE_INFINITY,
  });
}

function evaluate(s: NurbsSurface, u: number, v: number): { p: Tuple3; n: Tuple3 } | undefined {
  const d = surfaceDerivatives(s, u, v, 1);
  const c = cross((d[1] as Tuple3[])[0] as Tuple3, (d[0] as Tuple3[])[1] as Tuple3);
  const l = norm(c);
  if (!(l > 1e-14)) return undefined;
  return { p: (d[0] as Tuple3[])[0] as Tuple3, n: [c[0] / l, c[1] / l, c[2] / l] };
}

function bounds(surfaces: readonly NurbsSurface[]): number {
  const lo: Tuple3 = [Infinity, Infinity, Infinity];
  const hi: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const s of surfaces)
    for (const row of s.points)
      for (const p of row)
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k] as number, p[k] as number);
          hi[k] = Math.max(hi[k] as number, p[k] as number);
        }
  return surfaces.length === 0 ? 0 : distance(lo, hi);
}

/** Corners of a cell's edges: e0 c0-c1, e1 c1-c2, e2 c3-c2, e3 c0-c3. */
const EDGE_CORNERS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 2],
  [3, 2],
  [0, 3],
];
/** The two edges around each corner. */
const CORNER_EDGES: readonly (readonly [number, number])[] = [
  [3, 0],
  [0, 1],
  [1, 2],
  [2, 3],
];

/** Marching squares on one patch: polylines of exact level crossings. */
function tracePatch(
  surfaces: readonly NurbsSurface[],
  index: number,
  field: Field,
  skip: ((patch: number, s: number, t: number) => boolean) | undefined,
): { level: number; points: HighlightPoint[] }[] {
  const surface = surfaces[index] as NurbsSurface;
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const n = CELLS + 1;
  const us = Array.from({ length: n }, (_, i) => u0 + ((u1 - u0) * i) / CELLS);
  const vs = Array.from({ length: n }, (_, j) => v0 + ((v1 - v0) * j) / CELLS);
  const values = new Float64Array(n * n).fill(Number.NaN);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (skip?.(index, i / CELLS, j / CELLS) === true) continue;
      const e = evaluate(surface, us[i] as number, vs[j] as number);
      if (e !== undefined) values[i * n + j] = field.value(e.p, e.n);
    }
  const crossings: HighlightPoint[] = [];
  const keys = new Map<string, number>();
  const segments: [number, number, number][] = [];
  const crossing = (
    key: string,
    a: readonly [number, number],
    b: readonly [number, number],
    level: number,
  ): number => {
    const known = keys.get(key);
    if (known !== undefined) return known;
    const [ua, va, ub, vb] = [us[a[0]], vs[a[1]], us[b[0]], vs[b[1]]] as number[] as [
      number,
      number,
      number,
      number,
    ];
    const at = (t: number): [number, number] => [ua + (ub - ua) * t, va + (vb - va) * t];
    const above = (values[a[0] * n + a[1]] as number) >= level;
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < BISECTIONS; it++) {
      const mid = (lo + hi) / 2;
      const [u, v] = at(mid);
      const e = evaluate(surface, u, v);
      const x = e === undefined ? Number.NaN : field.value(e.p, e.n);
      if (Number.isNaN(x)) break;
      if (x >= level === above) lo = mid;
      else hi = mid;
    }
    const [u, v] = at((lo + hi) / 2);
    const e = evaluate(surface, u, v) ?? {
      p: (surfaceDerivatives(surface, u, v, 0)[0] as Tuple3[])[0] as Tuple3,
      n: [0, 0, 0] as Tuple3,
    };
    const rim = (k: 0 | 1) => a[k] === b[k] && (a[k] === 0 || a[k] === CELLS);
    crossings.push({ p: e.p, n: e.n, patch: index, u, v, side: rim(0) || rim(1) });
    keys.set(key, crossings.length - 1);
    return crossings.length - 1;
  };
  for (let i = 0; i < CELLS; i++)
    for (let j = 0; j < CELLS; j++) {
      const corners: readonly [number, number][] = [
        [i, j],
        [i + 1, j],
        [i + 1, j + 1],
        [i, j + 1],
      ];
      const f = corners.map(([a, b]) => values[a * n + b] as number);
      if (f.some((x) => Number.isNaN(x))) continue;
      const lo = minOf(f);
      const hi = maxOf(f);
      if (hi - lo > field.period / 2) continue;
      const edgeKey = (e: number, level: number) => {
        const [ca, cb] = EDGE_CORNERS[e] as [number, number];
        const a = corners[ca] as [number, number];
        const b = corners[cb] as [number, number];
        return `${level}:${a[0]},${a[1]}:${b[0]},${b[1]}`;
      };
      for (const [k, level] of field.levels(lo, hi)) {
        const above = f.map((x) => x >= level);
        const crossed = [0, 1, 2, 3].filter((e) => {
          const [ca, cb] = EDGE_CORNERS[e] as [number, number];
          return above[ca] !== above[cb];
        });
        const point = (e: number) => {
          const [ca, cb] = EDGE_CORNERS[e] as [number, number];
          return crossing(
            edgeKey(e, k),
            corners[ca] as [number, number],
            corners[cb] as [number, number],
            level,
          );
        };
        if (crossed.length === 2) {
          segments.push([k, point(crossed[0] as number), point(crossed[1] as number)]);
          continue;
        }
        if (crossed.length !== 4) continue;
        // Saddle: the corners on the other side than the cell center are cut off.
        const center = f.reduce((sum, x) => sum + x, 0) / 4 >= level;
        for (let c = 0; c < 4; c++) {
          if (above[c] === center) continue;
          const [ea, eb] = CORNER_EDGES[c] as [number, number];
          segments.push([k, point(ea), point(eb)]);
        }
      }
    }
  return polylines(crossings, segments);
}

/** Walk segments into polylines: open ones from their ends first, then closed loops. */
function polylines(
  crossings: readonly HighlightPoint[],
  segments: readonly [number, number, number][],
): { level: number; points: HighlightPoint[] }[] {
  const links: number[][] = crossings.map(() => []);
  const level = new Map<number, number>();
  for (const [k, a, b] of segments) {
    if (a === b) continue;
    (links[a] as number[]).push(b);
    (links[b] as number[]).push(a);
    level.set(a, k);
    level.set(b, k);
  }
  const used = new Uint8Array(crossings.length);
  const out: { level: number; points: HighlightPoint[] }[] = [];
  const walk = (start: number) => {
    const path = [start];
    used[start] = 1;
    let at = start;
    for (;;) {
      const next = (links[at] as number[]).find((x) => used[x] === 0);
      if (next === undefined) break;
      used[next] = 1;
      path.push(next);
      at = next;
    }
    out.push({
      level: level.get(start) as number,
      points: path.map((i) => crossings[i] as HighlightPoint),
    });
  };
  for (let i = 0; i < crossings.length; i++)
    if (used[i] === 0 && (links[i] as number[]).length === 1) walk(i);
  for (let i = 0; i < crossings.length; i++)
    if (used[i] === 0 && (links[i] as number[]).length > 0) walk(i);
  return out;
}

/** Chain per-patch polylines whose ends meet within `weld` (same level), greedily by distance. */
function chain(
  pieces: readonly { level: number; points: HighlightPoint[] }[],
  weld: number,
): HighlightTrace[] {
  const end = (i: number, tail: boolean) => {
    const points = (pieces[i] as (typeof pieces)[number]).points;
    const q = (tail ? points.at(-1) : points[0]) as HighlightPoint;
    const next = (tail ? points.at(-2) : points[1]) as HighlightPoint;
    return { piece: i, tail, p: q.p, patch: q.patch, side: q.side, spacing: distance(q.p, next.p) };
  };
  const ends = pieces.flatMap((piece, i) =>
    piece.points.length < 2
      ? []
      : [
          { ...end(i, false), level: piece.level },
          { ...end(i, true), level: piece.level },
        ],
  );
  const candidates: [number, number, number][] = [];
  for (let a = 0; a < ends.length; a++)
    for (let b = a + 1; b < ends.length; b++) {
      const ea = ends[a] as (typeof ends)[number];
      const eb = ends[b] as (typeof ends)[number];
      if (ea.piece === eb.piece || ea.level !== eb.level) continue;
      const d = distance(ea.p, eb.p);
      // Ends on the sides of two patches meet across their joint: closer than half a
      // point spacing, they are one line whatever the joint's kink does to it.
      const joint =
        ea.side && eb.side && ea.patch !== eb.patch && d <= Math.min(ea.spacing, eb.spacing) / 2;
      if (d <= weld || joint) candidates.push([d, a, b]);
    }
  candidates.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  const partner = new Int32Array(ends.length).fill(-1);
  for (const [, a, b] of candidates) {
    if (partner[a] !== -1 || partner[b] !== -1) continue;
    partner[a] = b;
    partner[b] = a;
  }
  const endIndex = (piece: number, tail: boolean) => 2 * piece + (tail ? 1 : 0);
  const endOf = new Map<number, number>();
  for (const [k, e] of ends.entries()) endOf.set(endIndex(e.piece, e.tail), k);
  const used = new Uint8Array(pieces.length);
  const out: HighlightTrace[] = [];
  const follow = (start: number, fromTail: boolean) => {
    const points: HighlightPoint[] = [];
    let piece = start;
    let reversed = fromTail;
    for (;;) {
      used[piece] = 1;
      const own = (pieces[piece] as (typeof pieces)[number]).points;
      pushAll(points, reversed ? [...own].reverse() : own);
      const exit = endOf.get(endIndex(piece, !reversed));
      const other = exit === undefined ? -1 : (partner[exit] as number);
      if (other < 0) break;
      const next = ends[other] as (typeof ends)[number];
      if (used[next.piece] === 1) break;
      piece = next.piece;
      reversed = next.tail;
    }
    out.push({ level: (pieces[start] as (typeof pieces)[number]).level, points });
  };
  const free = (piece: number, tail: boolean) => {
    const k = endOf.get(endIndex(piece, tail));
    return k === undefined || partner[k] === -1;
  };
  for (let i = 0; i < pieces.length; i++) {
    if (used[i] === 1) continue;
    if (free(i, false)) follow(i, false);
    else if (free(i, true)) follow(i, true);
  }
  for (let i = 0; i < pieces.length; i++) if (used[i] === 0) follow(i, false);
  return out;
}

/**
 * Trace the highlight lines of `surfaces`: the field sampled on a 64 x 64 parameter grid
 * per patch, marching squares per level, each crossing bisected onto the exact level on
 * the patch, polylines chained across patch boundaries where their ends meet within the
 * weld distance (ends on two patches' sides: within half their point spacing). Reflection
 * rays within 5 degrees of the stripe axis are not sampled: all lines meet there. `skip` drops grid samples (normalized patch coordinates), e.g. trimmed
 * regions. Points closer than 1e-4 x the scene diagonal to their predecessor are dropped.
 * @internal
 */
export function traceHighlights(
  surfaces: readonly NurbsSurface[],
  options: HighlightOptions,
  skip?: (patch: number, s: number, t: number) => boolean,
): Result<
  {
    readonly traces: readonly HighlightTrace[];
    readonly degrees: number;
    readonly diagonal: number;
  },
  ModelingError
> {
  const field = fieldOf(options);
  if (!field.ok) return field;
  for (const [index, surface] of surfaces.entries()) {
    const checked = checkSurface(surface);
    if (!checked.ok)
      return err({ ...checked.error, detail: { ...checked.error.detail, surface: index } });
  }
  const diagonal = bounds(surfaces);
  const weld = options.weld ?? 1e-6 * diagonal;
  if (!(Number.isFinite(weld) && weld >= 0))
    return err(invalid('weld is a non-negative distance', { weld }));
  const pieces = surfaces.flatMap((_, index) => tracePatch(surfaces, index, field.value, skip));
  const drop = Math.max(weld, 1e-4 * diagonal);
  const traces = chain(pieces, weld).map((trace) => {
    const gaps = trace.points
      .slice(1)
      .map((q, k) => distance(q.p, (trace.points[k] as HighlightPoint).p))
      .sort((x, y) => x - y);
    const spacing = SPACING * (gaps[gaps.length >> 1] ?? 0);
    const points: HighlightPoint[] = [];
    for (const [k, q] of trace.points.entries()) {
      const last = k === trace.points.length - 1;
      const d = points.length === 0 ? Infinity : distance(q.p, (points.at(-1) as HighlightPoint).p);
      if (d > drop && (d > spacing || last)) points.push(q);
      else if (last && points.length > 1) points[points.length - 1] = q;
    }
    return { level: trace.level, points };
  });
  return ok({
    traces: traces.filter((t) => longEnough(t.points, diagonal)),
    degrees: field.value.degrees,
    diagonal,
  });
}

/** Whether traced points make a line worth judging (enough points, not tiny). @internal */
export function longEnough(points: readonly HighlightPoint[], diagonal: number): boolean {
  if (points.length < MIN_POINTS) return false;
  let length = 0;
  for (let k = 1; k < points.length; k++)
    length += distance((points[k] as HighlightPoint).p, (points[k - 1] as HighlightPoint).p);
  return length >= MIN_LENGTH * diagonal;
}

/**
 * Fit traced points (cubic least squares, control points from the point count, capped)
 * with chord-length parameters (returned: the normalized curve parameter of each point).
 */
function fitTrace(
  points: readonly Tuple3[],
): Result<{ readonly curve: NurbsCurve; readonly parameters: readonly number[] }, ModelingError> {
  const parameters = parametersOf(points, 'chord');
  if (!parameters.ok) return parameters;
  const controlPoints = Math.min(
    points.length,
    MAX_CONTROL,
    Math.max(4, Math.floor(points.length / POINTS_PER_CONTROL)),
  );
  const curve = approximate(points, { controlPoints, degree: 3, parameters: parameters.value });
  if (!curve.ok) return curve;
  return ok({ curve: curve.value, parameters: parameters.value });
}

/** Extract the highlight lines of `surfaces` as fitted curves (see `HighlightOptions`). */
export function highlightLines(
  surfaces: readonly NurbsSurface[],
  options: HighlightOptions,
): Result<{ readonly lines: readonly HighlightLine[] }, ModelingError> {
  const traced = traceHighlights(surfaces, options);
  if (!traced.ok) return traced;
  const lines: HighlightLine[] = [];
  for (const trace of traced.value.traces) {
    const fit = fitTrace(trace.points.map((q) => q.p));
    if (!fit.ok) return fit;
    const patches: number[] = [];
    for (const q of trace.points) if (!patches.includes(q.patch)) patches.push(q.patch);
    lines.push({ curve: fit.value.curve, level: trace.level * traced.value.degrees, patches });
  }
  return ok({ lines });
}
