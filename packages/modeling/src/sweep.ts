import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, pushAll } from './arrays';
import { mergeFlags } from './crease';
import {
  type Frame,
  type FrameMode,
  type PathInput,
  pathFrames,
  pathLength,
  samplePath,
} from './curve';
import { atan2, cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { add, cross, dot, length, newell, normalize, scale, sub, type Tuple3 } from './geom';
import { triangleContact } from './intersect';
import { EDGE_SEAM, EDGE_SHARP, type EditMesh, NONE } from './mesh';
import {
  type Attribution,
  addFaces,
  type OpDiagnostic,
  type RoleCounts,
  requireFinite,
  requirePositive,
  requireSegments,
} from './ops';
import { type Point2, readOutline, requireOutwardShell, segmentsCross } from './primitives';

/** Fraction distance under which matched profile vertices count as the same position. */
const MATCH_EPSILON = 1e-6;

// ---- closed loops shared by sweep and loft ---------------------------------------

type Loop = readonly (readonly number[])[];

function edgeLengths(loop: Loop): number[] {
  return loop.map((p, i) => {
    const q = loop[(i + 1) % loop.length] as readonly number[];
    let sum = 0;
    for (let k = 0; k < p.length; k++) {
      const d = (q[k] as number) - (p[k] as number);
      sum += d * d;
    }
    return Math.sqrt(sum);
  });
}

function fractions(loop: Loop): { at: number[]; perimeter: number } {
  const lengths = edgeLengths(loop);
  const perimeter = lengths.reduce((a, b) => a + b, 0);
  const at: number[] = [];
  let run = 0;
  for (const l of lengths) {
    at.push(run / perimeter);
    run += l;
  }
  return { at, perimeter };
}

function pointAt(loop: Loop, at: readonly number[], u: number): number[] {
  let nearest = -1;
  for (let k = 0; k < at.length; k++) {
    if (Math.abs((at[k] as number) - u) <= MATCH_EPSILON) nearest = k;
  }
  if (nearest >= 0) return [...(loop[nearest] as readonly number[])];
  let k = 0;
  while (k + 1 < at.length && (at[k + 1] as number) <= u) k++;
  const f0 = at[k] as number;
  const f1 = k + 1 < at.length ? (at[k + 1] as number) : 1;
  const w = (u - f0) / (f1 - f0);
  const a = loop[k] as readonly number[];
  const b = loop[(k + 1) % loop.length] as readonly number[];
  return a.map((c, i) => c + ((b[i] as number) - c) * w);
}

/**
 * Resample closed loops onto one shared vertex count: every loop is evaluated at
 * the union of all loops' arc-length fractions, so each keeps its own corners.
 */
function matchLoops(loops: readonly Loop[]): number[][][] {
  const all = loops.map(fractions);
  const union = all.flatMap((f) => f.at).sort((a, b) => a - b);
  const merged: number[] = [];
  for (const u of union) {
    if (merged.length === 0 || u - (merged.at(-1) as number) > MATCH_EPSILON) merged.push(u);
  }
  return loops.map((loop, i) =>
    merged.map((u) => pointAt(loop, (all[i] as { at: number[] }).at, u)),
  );
}

/** Turning angle (radians) at each vertex of a closed loop. */
function turnAngles(loop: Loop): number[] {
  const n = loop.length;
  const v3 = (p: readonly number[]): Tuple3 => [
    p[0] as number,
    p[1] as number,
    (p[2] as number | undefined) ?? 0,
  ];
  return loop.map((p, i) => {
    const a = v3(loop[(i + n - 1) % n] as readonly number[]);
    const b = v3(p);
    const c = v3(loop[(i + 1) % n] as readonly number[]);
    const d1 = sub(b, a);
    const d2 = sub(c, b);
    return atan2(length(cross(d1, d2)), dot(d1, d2));
  });
}

function shoelace(points: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Point2;
    const b = points[(i + 1) % points.length] as Point2;
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

function crossingEdges(points: readonly Point2[]): [number, number] | undefined {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (
        segmentsCross(
          points[i] as Point2,
          points[i + 1] as Point2,
          points[j] as Point2,
          points[(j + 1) % n] as Point2,
        )
      ) {
        return [i, j];
      }
    }
  }
  return undefined;
}

/** Keep the first vertex and reverse the winding. */
function reversed<T>(loop: readonly T[]): T[] {
  return [loop[0] as T, ...loop.slice(1).reverse()];
}

function requireSimple(
  name: string,
  points: readonly Point2[],
  tolerance: number,
): Result<Point2[], ModelingError> {
  const area = shoelace(points);
  if (Math.abs(area) <= tolerance * tolerance) {
    return err(
      modelingError(
        'model-degenerate',
        `the ${name} encloses a non-zero area (its points are not colinear)`,
        { area },
      ),
    );
  }
  const crossing = crossingEdges(points);
  if (crossing !== undefined) {
    return err(
      modelingError('model-invalid-argument', `the ${name} does not cross itself`, {
        edges: crossing,
      }),
    );
  }
  return ok(area < 0 ? reversed(points) : [...points]);
}

function readProfile(
  name: string,
  points: readonly Point2[],
  tolerance: number,
): Result<Point2[], ModelingError> {
  const outline = readOutline(name, points, 3);
  if (!outline.ok) return outline;
  return requireSimple(name, outline.value.points, tolerance);
}

function requireAngleDegrees(name: string, value: number): Result<number, ModelingError> {
  const finite = requireFinite(name, value);
  if (!finite.ok) return finite;
  if (value < 0 || value > 180) {
    return err(
      modelingError('model-invalid-argument', `${name} is in degrees, within [0, 180]`, {
        [name]: value,
      }),
    );
  }
  return ok(value);
}

function ramp(
  name: string,
  value: number | readonly [number, number] | undefined,
  fallback: number,
): Result<[number, number], ModelingError> {
  const pair: [number, number] =
    value === undefined
      ? [fallback, fallback]
      : typeof value === 'number'
        ? name === 'twist'
          ? [0, value]
          : [value, value]
        : [value[0], value[1]];
  for (const v of pair) {
    const checked = name === 'scale' ? requirePositive(name, v) : requireFinite(name, v);
    if (!checked.ok) return checked;
  }
  return ok(pair);
}

// ---- tube assembly -----------------------------------------------------------------

interface Tube {
  /** Rows of vertex positions, all of one length; consecutive rows are joined. */
  readonly rows: readonly (readonly Tuple3[])[];
  /** The last row joins the first. */
  readonly closed: boolean;
  readonly caps: boolean;
  /** u per column, with one extra entry for the wrap back to column 0. */
  readonly u: readonly number[];
  /** v per row, with one extra entry for the wrap when closed. */
  readonly v: readonly number[];
  /** Whether the edge of `column` across row span `span` is sharp. */
  readonly sharpColumn: (span: number, column: number) => boolean;
  readonly sharpRows: readonly boolean[];
  /** Cap corner UVs of row `row` (first or last). */
  readonly capUv: (row: number, column: number) => readonly [number, number];
}

function flagEdge(mesh: EditMesh, a: number, b: number, flag: number): void {
  const h = mesh.findHalf(a, b);
  if (h !== NONE) mesh.eFlags[h >> 1] = mergeFlags(mesh.eFlags[h >> 1] as number, flag);
}

/** Build a quad tube with optional n-gon caps; roles `side`, `start` and `end`. */
/**
 * The triangles a non-planar side quad is split into (along its shorter diagonal), or
 * undefined for a planar quad, which stays one face.
 */
function sideSplit(points: readonly Tuple3[], tolerance: number): number[][] | undefined {
  const normal = normalize(newell(points));
  const origin = points[0] as Tuple3;
  const deviation = maxOf(points.map((p) => Math.abs(dot(sub(p, origin), normal))));
  if (deviation <= tolerance * 10) return undefined;
  const ac = length(sub(points[2] as Tuple3, points[0] as Tuple3));
  const bd = length(sub(points[3] as Tuple3, points[1] as Tuple3));
  return bd < ac
    ? [
        [0, 1, 3],
        [1, 2, 3],
      ]
    : [
        [0, 1, 2],
        [0, 2, 3],
      ];
}

function buildTube(
  mesh: EditMesh,
  tube: Tube,
  attribution: Attribution,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<{ counts: RoleCounts; faces: number[] }, ModelingError> {
  const rows = tube.rows.length;
  const n = (tube.rows[0] as readonly Tuple3[]).length;
  const ids = tube.rows.map((row) => row.map((p) => mesh.addVertex(p[0], p[1], p[2])));
  const id = (i: number, j: number) => (ids[i % rows] as number[])[j % n] as number;
  const spans = tube.closed ? rows : rows - 1;
  const counts: RoleCounts = {};
  const faces: number[] = [];
  const loops: number[][] = [];
  const corners: [number, number][][] = [];
  let split = 0;
  for (let i = 0; i < spans; i++) {
    for (let j = 0; j < n; j++) {
      const quad = [id(i, j), id(i, j + 1), id(i + 1, j + 1), id(i + 1, j)];
      const [u0, u1] = [tube.u[j] as number, tube.u[j + 1] as number];
      const [v0, v1] = [tube.v[i] as number, tube.v[i + 1] as number];
      const uv: [number, number][] = [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ];
      const pick = sideSplit(
        quad.map((q) => mesh.position(q)),
        tolerance,
      );
      if (pick === undefined) {
        loops.push(quad);
        corners.push(uv);
        continue;
      }
      split++;
      for (const tri of pick) {
        loops.push(tri.map((k) => quad[k] as number));
        corners.push(tri.map((k) => uv[k] as [number, number]));
      }
    }
  }
  if (split > 0) {
    diagnostics.push({
      severity: 'info',
      message: `${split} non-planar side quad(s) were split into triangles along their shorter diagonal`,
      detail: { quads: split },
    });
  }
  const side = addFaces(mesh, loops, attribution, 'side', counts);
  if (!side.ok) return side;
  pushAll(faces, side.value);
  const capLoops: { role: string; loop: number[]; row: number; columns: number[] }[] = [];
  if (tube.caps && !tube.closed) {
    const startColumns = reversed(Array.from({ length: n }, (_, j) => j));
    capLoops.push({
      role: 'start',
      loop: startColumns.map((j) => id(0, j)),
      row: 0,
      columns: startColumns,
    });
    const endColumns = Array.from({ length: n }, (_, j) => j);
    capLoops.push({
      role: 'end',
      loop: endColumns.map((j) => id(rows - 1, j)),
      row: rows - 1,
      columns: endColumns,
    });
  }
  for (const cap of capLoops) {
    const added = addFaces(mesh, [cap.loop], attribution, cap.role, counts);
    if (!added.ok) return added;
    pushAll(faces, added.value);
    corners.push(cap.columns.map((j) => [...tube.capUv(cap.row, j)] as [number, number]));
    for (let j = 0; j < n; j++) flagEdge(mesh, id(cap.row, j), id(cap.row, j + 1), EDGE_SHARP);
  }
  for (const [k, f] of faces.entries()) {
    const uv = corners[k] as [number, number][];
    for (const [c, h] of mesh.faceHalves(f).entries())
      mesh.setCorner('uv0', h, uv[c] as [number, number]);
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < n; j++) {
      if (i < spans) {
        if (tube.sharpColumn(i, j)) flagEdge(mesh, id(i, j), id(i + 1, j), EDGE_SHARP);
        if (j === 0) flagEdge(mesh, id(i, j), id(i + 1, j), EDGE_SEAM);
      }
      if (tube.sharpRows[i] === true) flagEdge(mesh, id(i, j), id(i, j + 1), EDGE_SHARP);
      if (tube.closed && i === 0) flagEdge(mesh, id(i, j), id(i, j + 1), EDGE_SEAM);
    }
  }
  if (tube.closed || tube.caps) {
    const outward = requireOutwardShell(
      mesh,
      faces,
      'list profiles counter-clockwise or keep them free of self-crossings',
    );
    if (!outward.ok) return outward;
  }
  return ok({ counts, faces });
}

// ---- sweep ---------------------------------------------------------------------------

export interface SweepOptions {
  /**
   * Closed `[x, y]` section in the frame plane (x along the frame's x axis, y along
   * its up axis), either winding; or several sections, morphed along the path by
   * arc length (resampled onto shared vertices).
   */
  readonly profile: readonly Point2[] | readonly (readonly Point2[])[];
  readonly path: PathInput;
  /** 'rmf' (default) rotation-minimizing frames; 'up' keeps the section's y toward `up`. */
  readonly frame?: FrameMode;
  /** Initial (rmf) or constant (up) section up direction (default +Y). */
  readonly up?: Tuple3;
  /** Section rotation in degrees: the end value from 0, or [start, end], linear in arc length. */
  readonly twist?: number | readonly [number, number];
  /** Uniform section scale, or [start, end] linear in arc length (default 1). */
  readonly scale?: number | readonly [number, number];
  /** The path closes: the last station joins the first (a ring, no caps). */
  readonly closed?: boolean;
  /** n-gon caps at both ends of an open sweep (default true). */
  readonly caps?: boolean;
  /** Subdivisions of every sampled path span (default 1), for smooth twist and scale ramps. */
  readonly segments?: number;
  /** Section corners and path joints turning more than this many degrees get sharp edges (default 40). */
  readonly sharpAngle?: number;
}

function isProfileList(
  profile: SweepOptions['profile'],
): profile is readonly (readonly Point2[])[] {
  const first = profile[0] as unknown;
  return Array.isArray(first) && Array.isArray(first[0]);
}

function subdivide(points: readonly Tuple3[], closed: boolean, segments: number): Tuple3[] {
  if (segments === 1) return [...points];
  const out: Tuple3[] = [];
  const spans = closed ? points.length : points.length - 1;
  for (let i = 0; i < spans; i++) {
    const a = points[i] as Tuple3;
    const b = points[(i + 1) % points.length] as Tuple3;
    for (let k = 0; k < segments; k++) out.push(add(a, scale(sub(b, a), k / segments)));
  }
  if (!closed) out.push([...(points.at(-1) as Tuple3)]);
  return out;
}

/** Squared closest distance between segments ab and cd. */
export function segmentDistance(a: Tuple3, b: Tuple3, c: Tuple3, d: Tuple3): number {
  const d1 = sub(b, a);
  const d2 = sub(d, c);
  const r = sub(a, c);
  const aa = dot(d1, d1);
  const ee = dot(d2, d2);
  const f = dot(d2, r);
  const cc = dot(d1, r);
  const bb = dot(d1, d2);
  const denominator = aa * ee - bb * bb;
  let s = denominator > 1e-18 ? Math.min(1, Math.max(0, (bb * f - cc * ee) / denominator)) : 0;
  let t = (bb * s + f) / ee;
  if (t < 0) {
    t = 0;
    s = Math.min(1, Math.max(0, -cc / aa));
  } else if (t > 1) {
    t = 1;
    s = Math.min(1, Math.max(0, (bb - cc) / aa));
  }
  const p = add(a, scale(d1, s));
  const q = add(c, scale(d2, t));
  const gap = sub(p, q);
  return dot(gap, gap);
}

/** Crossing span pairs (and midpoints) a sweep overlap failure lists; the scan stops there. */
const OVERLAP_POINTS = 16;

/**
 * The first side-wall crossing between spans of the tube farther apart along the path
 * than a half turn of the section radius (nearer spans are the local fold check's), or
 * undefined. Span boxes come from the stations themselves (miters included) and pair up
 * by sweep and prune along the longest axis; candidate quads are compared triangle by triangle, exactly.
 */
function overlapError(
  rows: readonly (readonly Tuple3[])[],
  frames: readonly Frame[],
  closed: boolean,
  total: number,
  radius: number,
  tolerance: number,
): ModelingError | undefined {
  const n = frames.length;
  const sides = (rows[0] as readonly Tuple3[]).length;
  const spans = closed ? n : n - 1;
  const point = (i: number, j: number) => (rows[i % n] as readonly Tuple3[])[j % sides] as Tuple3;
  const box = (points: readonly Tuple3[]) => {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const p of points) {
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a] as number, p[a] as number);
        hi[a] = Math.max(hi[a] as number, p[a] as number);
      }
    }
    return { lo, hi };
  };
  const apart = (a: { lo: number[]; hi: number[] }, b: { lo: number[]; hi: number[] }) =>
    [0, 1, 2].some(
      (k) =>
        (a.lo[k] as number) > (b.hi[k] as number) + tolerance ||
        (b.lo[k] as number) > (a.hi[k] as number) + tolerance,
    );
  const quad = (i: number, j: number): Tuple3[] => [
    point(i, j),
    point(i, j + 1),
    point(i + 1, j + 1),
    point(i + 1, j),
  ];
  const triangles = (q: readonly Tuple3[]): Tuple3[][] =>
    (
      sideSplit(q, tolerance) ?? [
        [0, 1, 2],
        [0, 2, 3],
      ]
    ).map((t) => t.map((k) => q[k] as Tuple3));
  const boxes = Array.from({ length: spans }, (_, i) =>
    box([...(rows[i] as Tuple3[]), ...(rows[(i + 1) % n] as Tuple3[])]),
  );
  const extent = box(rows.flat());
  const axis = [0, 1, 2].reduce((best, k) =>
    (extent.hi[k] as number) - (extent.lo[k] as number) >
    (extent.hi[best] as number) - (extent.lo[best] as number)
      ? k
      : best,
  );
  const lowOf = (i: number) => (boxes[i] as { lo: number[] }).lo[axis] as number;
  const order = boxes.map((_, i) => i).sort((a, b) => lowOf(a) - lowOf(b) || a - b);
  const reach = Math.PI * radius;
  const start = (i: number) => (frames[i] as Frame).s;
  const end = (i: number) => (i + 1 < n ? (frames[i + 1] as Frame).s : total);
  const crossings: [number, number][] = [];
  const at: Tuple3[] = [];
  for (let x = 0; x < order.length && crossings.length < OVERLAP_POINTS; x++) {
    const i = order[x] as number;
    const bi = boxes[i] as { lo: number[]; hi: number[] };
    for (let y = x + 1; y < order.length && crossings.length < OVERLAP_POINTS; y++) {
      const k = order[y] as number;
      const bk = boxes[k] as { lo: number[]; hi: number[] };
      if ((bk.lo[axis] as number) > (bi.hi[axis] as number) + tolerance) break;
      if (apart(bi, bk)) continue;
      const [a, b] = i < k ? [i, k] : [k, i];
      let gap = start(b) - end(a);
      if (closed) gap = Math.min(gap, total - end(b) + start(a));
      if (gap <= reach) continue;
      let hit: Tuple3 | undefined;
      for (let j = 0; j < sides && hit === undefined; j++) {
        const qa = quad(a, j);
        const ba = box(qa);
        if (apart(ba, bk)) continue;
        for (let m = 0; m < sides && hit === undefined; m++) {
          const qb = quad(b, m);
          if (apart(ba, box(qb))) continue;
          for (const ta of triangles(qa)) {
            if (triangles(qb).some((tb) => triangleContact(ta, tb, tolerance) === 'cross')) {
              hit = scale(
                add(add(qa[0] as Tuple3, qa[2] as Tuple3), add(qb[0] as Tuple3, qb[2] as Tuple3)),
                0.25,
              );
              break;
            }
          }
        }
      }
      if (hit === undefined) continue;
      crossings.push([a, b]);
      at.push(hit);
    }
  }
  if (crossings.length === 0) return undefined;
  return modelingError(
    'model-precondition',
    'distant parts of the tube do not cross each other',
    { spans: crossings, at },
    'the path comes back within the section near detail.at (detail.spans pairs the path spans, the first 16 found); space the path out (a helix pitch above the section diameter) or shrink the section',
  );
}

/**
 * Sweep a closed section along a path. Each station places the section in its
 * frame, rotated by the twist ramp, scaled by the scale ramp, and stretched across
 * polyline joints (miter) so walls keep their width. Roles `side`, `start` and
 * `end`; uv0 holds the section perimeter (u) against path arc length (v) in meters.
 * A section that would fold over itself between two stations (a bend tighter than
 * the section) is `model-precondition`, and so is a tube whose distant parts cross.
 */
export function sweep(
  mesh: EditMesh,
  options: SweepOptions,
  attribution: Attribution,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const list = isProfileList(options.profile)
    ? options.profile
    : [options.profile as readonly Point2[]];
  if (list.length === 0) {
    return err(modelingError('model-invalid-argument', 'profile has at least one section', {}));
  }
  const sections: Point2[][] = [];
  for (const [i, raw] of list.entries()) {
    const read = readProfile(list.length === 1 ? 'profile' : `profile[${i}]`, raw, tolerance);
    if (!read.ok) return read;
    sections.push(read.value);
  }
  const matched = (sections.length === 1
    ? sections
    : matchLoops(sections)) as unknown as Point2[][];
  const closed = options.closed ?? false;
  if (closed && options.caps === true) {
    return err(
      modelingError(
        'model-invalid-argument',
        'a closed sweep has no caps (caps: false or omitted)',
        {},
      ),
    );
  }
  const caps = !closed && (options.caps ?? true);
  const twist = ramp('twist', options.twist, 0);
  if (!twist.ok) return twist;
  const sizes = ramp('scale', options.scale, 1);
  if (!sizes.ok) return sizes;
  const segments = options.segments ?? 1;
  const checkedSegments = requireSegments('segments', segments, 1);
  if (!checkedSegments.ok) return checkedSegments;
  const sharpAngle = requireAngleDegrees('sharpAngle', options.sharpAngle ?? 40);
  if (!sharpAngle.ok) return sharpAngle;
  const up = options.up ?? [0, 1, 0];
  for (const c of up) {
    const checked = requireFinite('up', c);
    if (!checked.ok) return checked;
  }
  if (length(up) === 0)
    return err(modelingError('model-invalid-argument', 'up is a non-zero vector', { up }));
  if (closed) {
    const [t0, t1] = twist.value;
    const [s0, s1] = sizes.value;
    if ((t1 - t0) % 360 !== 0 || s0 !== s1 || matched.length > 1) {
      return err(
        modelingError(
          'model-invalid-argument',
          'a closed sweep ends where it starts: twist changes by a multiple of 360, scale is constant and one section is used',
          { twist: twist.value, scale: sizes.value, sections: matched.length },
        ),
      );
    }
  }
  const sampled = samplePath(options.path, closed, tolerance);
  if (!sampled.ok) return sampled;
  const points = subdivide(sampled.value, closed, segments);
  const framed = pathFrames(points, closed, options.frame ?? 'rmf', up);
  if (!framed.ok) return framed;
  const frames = framed.value;
  const total = pathLength(points, closed);
  const n = (matched[0] as Point2[]).length;
  const sectionAt = (f: number): Point2[] => {
    if (matched.length === 1) return matched[0] as Point2[];
    const x = f * (matched.length - 1);
    const k = Math.min(Math.floor(x), matched.length - 2);
    const w = x - k;
    const a = matched[k] as Point2[];
    const b = matched[k + 1] as Point2[];
    return a.map((p, j) => [
      p[0] + ((b[j] as Point2)[0] - p[0]) * w,
      p[1] + ((b[j] as Point2)[1] - p[1]) * w,
    ]);
  };
  const [t0, t1] = twist.value;
  const [s0, s1] = sizes.value;
  const stationSections: Point2[][] = [];
  const rows: Tuple3[][] = frames.map((frame) => {
    const f = frame.s / total;
    const section = sectionAt(f).map(
      (p) => [p[0] * (s0 + (s1 - s0) * f), p[1] * (s0 + (s1 - s0) * f)] as Point2,
    );
    stationSections.push(section);
    const angle = (((t0 + (t1 - t0) * f) % 360) * Math.PI) / 180;
    const c = cos(angle);
    const s = sin(angle);
    const x = add(scale(frame.x, c), scale(frame.y, s));
    const y = sub(scale(frame.y, c), scale(frame.x, s));
    return section.map((p) => {
      const o = add(scale(x, p[0]), scale(y, p[1]));
      const stretched = add(o, scale(frame.miterAxis, (frame.miter - 1) * dot(o, frame.miterAxis)));
      return add(frame.point, stretched);
    });
  });
  const stations = rows.length;
  const spans = closed ? stations : stations - 1;
  for (let i = 0; i < spans; i++) {
    const a = frames[i] as Frame;
    const b = frames[(i + 1) % stations] as Frame;
    const direction = normalize(sub(b.point, a.point));
    for (let j = 0; j < n; j++) {
      const advance = dot(
        sub(
          (rows[(i + 1) % stations] as Tuple3[])[j] as Tuple3,
          (rows[i] as Tuple3[])[j] as Tuple3,
        ),
        direction,
      );
      if (advance <= tolerance) {
        return err(
          modelingError(
            'model-precondition',
            'every section point advances along each path span (the tube does not fold over itself)',
            { span: i, profileVertex: j, advance, at: a.point },
            'widen the path bends (bend radius larger than the section) or shrink the section',
          ),
        );
      }
    }
  }
  let radius = 0;
  for (const section of stationSections)
    for (const p of section) radius = Math.max(radius, Math.sqrt(p[0] * p[0] + p[1] * p[1]));
  const overlap = overlapError(rows, frames, closed, total, radius, tolerance);
  if (overlap !== undefined) return err(overlap);
  const turns = matched.map((section) => turnAngles(section));
  const threshold = (sharpAngle.value * Math.PI) / 180;
  const sharp = (matched[0] as Point2[]).map((_, j) =>
    turns.some((t) => (t[j] as number) > threshold),
  );
  const base = matched[0] as Point2[];
  const lengths = edgeLengths(base);
  const u = [0];
  for (const l of lengths) u.push((u.at(-1) as number) + l);
  const v = frames.map((frame) => frame.s);
  if (closed) v.push(total);
  const built = buildTube(
    mesh,
    {
      rows,
      closed,
      caps,
      u,
      v,
      sharpColumn: (_, j) => sharp[j] === true,
      sharpRows: frames.map((frame) => frame.turn > threshold),
      capUv: (row, column) => {
        const p = (stationSections[row] as Point2[])[column] as Point2;
        return row === 0 ? [-p[0], p[1]] : [p[0], p[1]];
      },
    },
    attribution,
    tolerance,
    diagnostics,
  );
  if (!built.ok) return built;
  return ok(built.value.counts);
}

// ---- loft ------------------------------------------------------------------------------

export type LoftMatch = 'index' | 'arclength';

export interface LoftOptions {
  /** Closed planar 3D sections in order (first == last point is accepted). */
  readonly profiles: readonly (readonly Tuple3[])[];
  /** The last section joins the first (a ring; at least three sections, no caps). */
  readonly closed?: boolean;
  /** n-gon caps on the first and last section of an open loft (default true). */
  readonly caps?: boolean;
  /**
   * 'arclength' (default): sections are rotated to the start that best follows the
   * previous one and resampled onto shared arc-length positions, keeping every
   * corner; 'index': vertex i joins vertex i (equal counts required).
   */
  readonly match?: LoftMatch;
  /** Rows per section span (default 1); more rows follow a Catmull-Rom curve through the sections. */
  readonly segments?: number;
  /** Section corners turning more than this many degrees get sharp edges (default 40). */
  readonly sharpAngle?: number;
}

interface PlanarSection {
  readonly points: Tuple3[];
  readonly normal: Tuple3;
  readonly centroid: Tuple3;
}

function readSection(
  index: number,
  raw: readonly Tuple3[],
  tolerance: number,
): Result<PlanarSection, ModelingError> {
  const name = `profiles[${index}]`;
  for (const p of raw) {
    for (const c of p) {
      const checked = requireFinite(name, c);
      if (!checked.ok) return checked;
    }
  }
  let points = raw.map((p) => [...p] as Tuple3);
  const first = points[0];
  const last = points.at(-1);
  if (
    points.length > 3 &&
    first !== undefined &&
    last !== undefined &&
    first[0] === last[0] &&
    first[1] === last[1] &&
    first[2] === last[2]
  ) {
    points = points.slice(0, -1);
  }
  if (points.length < 3) {
    return err(
      modelingError('model-invalid-argument', `${name} has at least 3 distinct points`, {
        count: points.length,
      }),
    );
  }
  for (let i = 0; i < points.length; i++) {
    const d = length(sub(points[(i + 1) % points.length] as Tuple3, points[i] as Tuple3));
    if (d <= tolerance) {
      return err(
        modelingError('model-degenerate', `consecutive ${name} points differ`, {
          index: i,
          distance: d,
        }),
      );
    }
  }
  const area = newell(points);
  if (length(area) / 2 <= tolerance * tolerance) {
    return err(
      modelingError(
        'model-degenerate',
        `${name} encloses a non-zero area (its points are not colinear)`,
        { area: length(area) / 2 },
      ),
    );
  }
  const normal = normalize(area);
  const centroid = scale(
    points.reduce((a, p) => add(a, p), [0, 0, 0] as Tuple3),
    1 / points.length,
  );
  const deviation = maxOf(points.map((p) => Math.abs(dot(sub(p, centroid), normal))));
  if (deviation > tolerance * 10) {
    return err(
      modelingError(
        'model-precondition',
        `${name} is planar`,
        { deviation, tolerance: tolerance * 10 },
        'flatten the section or split it into planar sections',
      ),
    );
  }
  const e1 = normalize(sub(points[0] as Tuple3, centroid));
  const e2 = cross(normal, e1);
  const flat = points.map((p) => [dot(sub(p, centroid), e1), dot(sub(p, centroid), e2)] as Point2);
  const crossing = crossingEdges(flat);
  if (crossing !== undefined) {
    return err(
      modelingError('model-invalid-argument', `${name} does not cross itself`, { edges: crossing }),
    );
  }
  return ok({ points, normal, centroid });
}

/**
 * `next` restarted at the arc-length offset that best follows `previous` (relative to
 * their centroids): one of its vertices, or a new point on an edge when no vertex
 * lies within a quarter sample of the best offset.
 */
function alignedTo(previous: PlanarSection, next: PlanarSection): Tuple3[] {
  const samples = 64;
  const ref = fractions(previous.points);
  const own = fractions(next.points);
  const at = Array.from({ length: samples }, (_, k) => k / samples);
  const reference = at.map((u) =>
    sub(pointAt(previous.points, ref.at, u) as Tuple3, previous.centroid),
  );
  const cost = (offset: number) => {
    let sum = 0;
    for (const [m, u] of at.entries()) {
      const p = pointAt(next.points, own.at, (offset + u) % 1) as Tuple3;
      const d = sub(sub(p, next.centroid), reference[m] as Tuple3);
      sum += dot(d, d);
    }
    return sum;
  };
  let best = 0;
  let bestCost = Infinity;
  for (const offset of [...own.at, ...at]) {
    const c = cost(offset);
    if (c < bestCost - 1e-12) {
      bestCost = c;
      best = offset;
    }
  }
  const n = next.points.length;
  const vertex = own.at.findIndex((f) => Math.abs(f - best) <= 0.25 / samples);
  if (vertex >= 0) return [...next.points.slice(vertex), ...next.points.slice(0, vertex)];
  let k = own.at.findIndex((f) => f > best);
  if (k < 0) k = n;
  const start = pointAt(next.points, own.at, best) as Tuple3;
  return [start, ...next.points.slice(k), ...next.points.slice(0, k)];
}

function catmullRomRow(p0: Tuple3, p1: Tuple3, p2: Tuple3, p3: Tuple3, t: number): Tuple3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const m1 = scale(sub(p2, p0), 0.5);
  const m2 = scale(sub(p3, p1), 0.5);
  return add(
    add(scale(p1, 2 * t3 - 3 * t2 + 1), scale(m1, t3 - 2 * t2 + t)),
    add(scale(p2, -2 * t3 + 3 * t2), scale(m2, t3 - t2)),
  );
}

/**
 * Loft through two or more closed planar sections, which may have different vertex
 * counts. Sections are wound consistently about the loft direction. Roles `side`,
 * `start` and `end`; uv0 holds the section perimeter fraction times the first
 * section's perimeter (u) against the distance between section centroids (v).
 */
export function loft(
  mesh: EditMesh,
  options: LoftOptions,
  attribution: Attribution,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const closed = options.closed ?? false;
  const count = options.profiles.length;
  if (count < (closed ? 3 : 2)) {
    return err(
      modelingError(
        'model-invalid-argument',
        `a ${closed ? 'closed' : 'open'} loft has at least ${closed ? 3 : 2} profiles`,
        { count },
      ),
    );
  }
  if (closed && options.caps === true) {
    return err(
      modelingError(
        'model-invalid-argument',
        'a closed loft has no caps (caps: false or omitted)',
        {},
      ),
    );
  }
  const caps = !closed && (options.caps ?? true);
  const segments = options.segments ?? 1;
  const checkedSegments = requireSegments('segments', segments, 1);
  if (!checkedSegments.ok) return checkedSegments;
  const sharpAngle = requireAngleDegrees('sharpAngle', options.sharpAngle ?? 40);
  if (!sharpAngle.ok) return sharpAngle;
  const match = options.match ?? 'arclength';
  let sections: PlanarSection[] = [];
  for (const [i, raw] of options.profiles.entries()) {
    const read = readSection(i, raw, tolerance);
    if (!read.ok) return read;
    sections.push(read.value);
  }
  for (let i = 0; i < (closed ? count : count - 1); i++) {
    const d = length(
      sub(
        (sections[(i + 1) % count] as PlanarSection).centroid,
        (sections[i] as PlanarSection).centroid,
      ),
    );
    if (d <= tolerance) {
      return err(
        modelingError('model-degenerate', 'consecutive profiles have distinct centroids', {
          profiles: [i, (i + 1) % count],
          distance: d,
        }),
      );
    }
  }
  // Index matching keeps the author's correspondence: sections are never reversed one by
  // one (a closed band whose inner rings run back along the path would join mirrored
  // indices); the whole loft is turned outward once it is matched.
  sections = sections.map((section, i) => {
    if (match === 'index') return section;
    const prev = sections[closed ? (i + count - 1) % count : Math.max(0, i - 1)] as PlanarSection;
    const next = sections[closed ? (i + 1) % count : Math.min(count - 1, i + 1)] as PlanarSection;
    const direction = normalize(sub(next.centroid, prev.centroid));
    return dot(section.normal, direction) < 0
      ? { ...section, points: reversed(section.points), normal: scale(section.normal, -1) }
      : section;
  });
  for (const [i, section] of sections.entries()) {
    const prev = sections[closed ? (i + count - 1) % count : Math.max(0, i - 1)] as PlanarSection;
    const next = sections[closed ? (i + 1) % count : Math.min(count - 1, i + 1)] as PlanarSection;
    if (Math.abs(dot(section.normal, normalize(sub(next.centroid, prev.centroid)))) <= 1e-6) {
      return err(
        modelingError(
          'model-degenerate',
          'each profile plane crosses the loft direction',
          { profile: i },
          'turn the profile to face along the path between its neighbours',
        ),
      );
    }
  }
  let loops: Tuple3[][];
  if (match === 'index') {
    const counts = sections.map((s) => s.points.length);
    if (counts.some((c) => c !== counts[0])) {
      return err(
        modelingError(
          'model-invalid-argument',
          "match 'index' joins profiles with equal vertex counts",
          { counts },
          "use match: 'arclength' to resample profiles with different counts",
        ),
      );
    }
    loops = sections.map((s) => s.points);
    if (loftVolume(loops, closed) < 0) loops = loops.map((loop) => reversed(loop));
  } else {
    for (let i = 1; i < count; i++) {
      const section = sections[i] as PlanarSection;
      sections[i] = { ...section, points: alignedTo(sections[i - 1] as PlanarSection, section) };
    }
    loops = matchLoops(sections.map((s) => s.points)) as unknown as Tuple3[][];
  }
  const rows: Tuple3[][] = [];
  const rowOf: number[] = [];
  const spans = closed ? count : count - 1;
  const loopAt = (i: number): Tuple3[] => {
    if (closed) return loops[(i + count) % count] as Tuple3[];
    if (i < 0)
      return (loops[0] as Tuple3[]).map((p, j) =>
        sub(scale(p, 2), (loops[1] as Tuple3[])[j] as Tuple3),
      );
    if (i >= count)
      return (loops[count - 1] as Tuple3[]).map((p, j) =>
        sub(scale(p, 2), (loops[count - 2] as Tuple3[])[j] as Tuple3),
      );
    return loops[i] as Tuple3[];
  };
  for (let i = 0; i < spans; i++) {
    for (let k = 0; k < segments; k++) {
      if (k === 0) {
        rows.push(loops[i] as Tuple3[]);
        rowOf.push(i);
        continue;
      }
      const [a, b, c, d] = [loopAt(i - 1), loopAt(i), loopAt(i + 1), loopAt(i + 2)];
      rows.push(
        b.map((p, j) =>
          catmullRomRow(a[j] as Tuple3, p, c[j] as Tuple3, d[j] as Tuple3, k / segments),
        ),
      );
      rowOf.push(-1);
    }
  }
  if (!closed) {
    rows.push(loops[count - 1] as Tuple3[]);
    rowOf.push(count - 1);
  }
  const centroid = (row: readonly Tuple3[]) =>
    scale(
      row.reduce((a, p) => add(a, p), [0, 0, 0] as Tuple3),
      1 / row.length,
    );
  const v = [0];
  for (let i = 1; i <= (closed ? rows.length : rows.length - 1); i++) {
    v.push(
      (v.at(-1) as number) +
        length(sub(centroid(rows[i % rows.length] as Tuple3[]), centroid(rows[i - 1] as Tuple3[]))),
    );
  }
  const base = fractions(loops[0] as Tuple3[]);
  const u = [...base.at.map((f) => f * base.perimeter), base.perimeter];
  const threshold = (sharpAngle.value * Math.PI) / 180;
  const turns = loops.map((loop) => turnAngles(loop));
  const capFrame = (row: number) => {
    const section = sections[rowOf[row] as number] as PlanarSection;
    const e1 = normalize(sub((rows[row] as Tuple3[])[0] as Tuple3, section.centroid));
    return { section, e1, e2: cross(section.normal, e1) };
  };
  const built = buildTube(
    mesh,
    {
      rows,
      closed,
      caps,
      u,
      v,
      sharpColumn: (span, j) => {
        const section = Math.floor(span / segments);
        const corner = (k: number) => ((turns[k % count] as number[])[j] as number) > threshold;
        return corner(section) || corner(section + 1);
      },
      sharpRows: rows.map(() => false),
      capUv: (row, column) => {
        const { section, e1, e2 } = capFrame(row);
        const d = sub((rows[row] as Tuple3[])[column] as Tuple3, section.centroid);
        return row === 0 ? [-dot(d, e1), dot(d, e2)] : [dot(d, e1), dot(d, e2)];
      },
    },
    attribution,
    tolerance,
    diagnostics,
  );
  if (!built.ok) return built;
  return ok(built.value.counts);
}

/** Signed volume of the surface joining loops index by index (with fan caps when open). */
function loftVolume(loops: readonly (readonly Tuple3[])[], closed: boolean): number {
  let six = 0;
  const tri = (a: Tuple3, b: Tuple3, c: Tuple3) => {
    six += dot(a, cross(b, c));
  };
  const spans = closed ? loops.length : loops.length - 1;
  for (let i = 0; i < spans; i++) {
    const a = loops[i] as readonly Tuple3[];
    const b = loops[(i + 1) % loops.length] as readonly Tuple3[];
    for (let j = 0; j < a.length; j++) {
      const k = (j + 1) % a.length;
      tri(a[j] as Tuple3, a[k] as Tuple3, b[k] as Tuple3);
      tri(a[j] as Tuple3, b[k] as Tuple3, b[j] as Tuple3);
    }
  }
  if (!closed) {
    for (const [loop, sign] of [
      [loops[0] as readonly Tuple3[], -1],
      [loops[loops.length - 1] as readonly Tuple3[], 1],
    ] as const) {
      const c = scale(
        loop.reduce<Tuple3>((sum, p) => add(sum, p), [0, 0, 0]),
        1 / loop.length,
      );
      for (let j = 0; j < loop.length; j++) {
        const p = loop[j] as Tuple3;
        const q = loop[(j + 1) % loop.length] as Tuple3;
        if (sign > 0) tri(c, p, q);
        else tri(c, q, p);
      }
    }
  }
  return six / 6;
}
