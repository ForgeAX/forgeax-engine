import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf, pushAll } from './arrays';
import { TriangleBvh } from './compute/bvh';
import { compareLines } from './contour';
import { type BaseView, drawingBaseView, drawingViewFrame, type ResolvedDrawing } from './drawing';
import { LINE_COVERAGE } from './edge-flow';
import { type ModelingError, modelingError } from './errors';
import {
  dot,
  faceNormal,
  length as norm,
  add as plus,
  scale,
  sub,
  type Tuple3,
  normalize as unit,
} from './geom';
import { nearest, type PartGeometry, partDistance, partGeometry } from './interference';
import { type EditMesh, FACE_EDGE_ROUND } from './mesh';
import { SHELL_WALL_ROLES } from './shell';

/**
 * Shut-line gauge: every seam of a dimensional technical
 * specification row is measured between two panels (face tags) along their outer edges.
 * The gap is taken on the theoretical line: each panel's skin line is the tangent of its skin
 * (its faces other than edge treatment, `FACE_EDGE_ROUND`) at the skin's last point before the
 * edge, extended to that panel's own edge wall, so edge rounds and chamfers do not change it
 * and a skin rolling tightly right past its edge is followed. The visual gap is measured where
 * each section leaves its skin line (edge rounds widen it). Flush is the larger of the step
 * between the two skin lines in their bisector frame and a lip standing proud of its skin line;
 * parallelism is the spread of the gap along the line; symmetry compares a row with its
 * mirrored row; coverage is the share of the line's stations that could be measured.
 */
export type ShutLineZone = 'A' | 'B' | 'C';

/**
 * Limits of a seam (meters): gap band, largest flush step, parallelism and symmetry deltas,
 * and the largest visual gap.
 */
export interface ShutLineLimits {
  readonly gap: readonly [number, number];
  readonly flush: number;
  readonly parallelism: number;
  readonly symmetry: number;
  readonly visualGap: number;
}

/**
 * Zones (nominal gap 3.5 mm): A visible upper and side panels, B bumpers,
 * intakes, lamps and arch lips, C the underside. The visual gap limit is the gap band's top
 * plus two of the zone's largest edge radii (R2 edge R: A 1.2, B 1.5, C 0.5 mm).
 */
export const DTS_ZONES: Readonly<Record<ShutLineZone, ShutLineLimits>> = {
  A: {
    gap: [0.00325, 0.00375],
    flush: 0.0003,
    parallelism: 0.0003,
    symmetry: 0.0003,
    visualGap: 0.00615,
  },
  B: {
    gap: [0.0031, 0.0039],
    flush: 0.0005,
    parallelism: 0.0005,
    symmetry: 0.0005,
    visualGap: 0.0069,
  },
  C: {
    gap: [0.003, 0.004],
    flush: 0.001,
    parallelism: 0.001,
    symmetry: Number.POSITIVE_INFINITY,
    visualGap: 0.005,
  },
};

/** One DTS row: a seam between two panels, named by their face tags. */
export interface DtsRow {
  readonly id: string;
  readonly parts: readonly [string, string];
  /** Default 'A'. */
  readonly zone?: ShutLineZone;
  /** Tighter limits than the zone's (each value inside the zone default). */
  readonly limits?: Partial<ShutLineLimits>;
  /**
   * The row of the mirrored seam (left/right pair), which names this row back: symmetry
   * compares their mean gaps.
   */
  readonly mirror?: string;
  /**
   * The drawn panel break this seam realises: a `break` curve of an attached drawing. The
   * seam's centre line, seen in that view, must lie on it within its tolerance over the span
   * both share, covering at least LINE_COVERAGE of it (inside its `inset`).
   */
  readonly break?: { readonly drawing: string; readonly item: string };
  /**
   * An accepted deviation: a check that fails the row's limits but stays inside these
   * explicitly looser bounds is excepted rather than failed (coverage, unmeasured and break
   * cannot be excepted).
   */
  readonly exception?: ShutLineException;
  /**
   * A clearance item instead of a gap band: a designed separation (a tyre in its arch) whose
   * smallest distance between the two parts' faces must be at least `min` (meters). Its checks
   * are `clearance` and `unmeasured` (no face of a part, or none within max(reach, 2 x min));
   * it takes no `limits`, `exception` or `mirror`.
   */
  readonly clearance?: { readonly min: number };
}

/** Looser bounds accepted for a row, with the reason and the ISO date (yyyy-mm-dd) of the decision. */
export interface ShutLineException {
  readonly limits: Partial<ShutLineLimits>;
  readonly reason: string;
  readonly date: string;
}

export interface ShutLineOptions {
  readonly table: readonly DtsRow[];
  /** Station spacing along the edges, m (default 0.01). */
  readonly step?: number;
  /** Largest distance between the two panels' edges at a station, m (default 0.012). */
  readonly reach?: number;
  /**
   * Length at each end of a seam left out of the parallelism and the coverage (three-panel
   * corners), m (default 0.01).
   */
  readonly ends?: number;
}

export type ShutLineCheck =
  | 'unmeasured'
  | 'clearance'
  | 'gap'
  | 'flush'
  | 'parallelism'
  | 'symmetry'
  | 'break'
  | 'coverage'
  | 'visual-gap';

export interface ShutLineStats {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p10: number;
  readonly median: number;
  readonly p90: number;
}

export interface ShutLineRow {
  readonly id: string;
  readonly parts: readonly [string, string];
  readonly zone: ShutLineZone;
  readonly limits: ShutLineLimits;
  /** Stations measured (both panels' edges). */
  readonly samples: number;
  /**
   * Stations of the line, away from its ends, that could not be measured: the other panel's
   * edge is beyond `reach`, a panel has less than 2 mm of skin within 10 mm of its edge, a
   * panel's edge wall lies within 45 degrees of its own skin line, the theoretical edge
   * would be more than 3 mm from the physical one, the other panel's nearest edge point lies
   * more than 45 degrees off the section square to the edge (past that panel's end), or the
   * station lies on an open side: an open skin edge of an edge chain with walls elsewhere.
   */
  readonly skipped: number;
  /** Measured share of the line's stations away from its ends. */
  readonly coverage: number;
  /**
   * Gap on the theoretical line along the two skin lines' mean direction (their bisector
   * frame), m. A panel's skin line: probing its section every 0.25 mm from 10 mm back toward
   * its edge along its own edge normal, its skin runs from the first skin hit up to edge
   * treatment (`FACE_EDGE_ROUND` faces: bevels and surface blend bands), a miss, or a turn of 45 degrees or more between
   * neighbouring faces; the line is the tangent at the skin's last point, from a least-squares
   * quadratic over the skin's last 2 mm, and it ends where it meets the panel's own wall.
   */
  readonly gap?: ShutLineStats;
  /**
   * Gap between the points where the sections, walking from their skins' last points toward
   * the gap, first fall 0.1 mm below their skin lines (or reach their theoretical edges), m.
   */
  readonly visualGap?: ShutLineStats;
  /**
   * Largest flush step, m: per station the larger of the separation of the two theoretical
   * edges along the bisector of the two skin lines' normals (see `gap`; a parallel step's
   * height, 0 for a crease centred in the gap, the mismatch for an off-centre crossing, and a
   * skin tilted by a lip before its edge lifts its edge) and a section standing proud of its
   * own skin line at its visual edge (a lip in the edge treatment).
   */
  readonly flush?: number;
  /** Gap max - min away from the ends, m. */
  readonly parallelism?: number;
  /** |mean gap - mirrored row's mean gap|, m. */
  readonly symmetryDelta?: number;
  /** Station with the gap farthest from its band. */
  readonly worst?: { readonly at: Tuple3; readonly gap: number; readonly flush: number };
  /** The seam centre line against its drawn break (rows with `break`), m and share. */
  readonly break?: { readonly max: number; readonly back: number; readonly coverage: number };
  /** Checks that fail the limits and are not excepted. */
  readonly failures: readonly ShutLineCheck[];
  /** Checks that fail the limits but pass the row's exception. */
  readonly excepted: readonly ShutLineCheck[];
  readonly exception?: ShutLineException;
  /** A clearance row's smallest distance between the parts and where it is (a vertex of either). */
  readonly clearance?: { readonly min: number; readonly distance: number; readonly at: Tuple3 };
  readonly status: ShutLineStatus;
}

/** 'fail' with any non-excepted failure, 'excepted' when every deviation is excepted. */
export type ShutLineStatus = 'pass' | 'fail' | 'excepted' | 'unmeasured';

export interface ShutLineReport {
  readonly rows: readonly ShutLineRow[];
  /** No row fails or is unmeasured (excepted rows pass; a stricter gate checks counts.excepted). */
  readonly pass: boolean;
  readonly counts: Readonly<Record<ShutLineStatus, number>>;
}

function invalid(expected: string, detail: Record<string, unknown> = {}): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

const add = (a: Tuple3, b: Tuple3, s = 1): Tuple3 => (s === 1 ? plus(a, b) : plus(a, scale(b, s)));

const WALL_ROLES: ReadonlySet<string> = new Set(SHELL_WALL_ROLES);
/** Skin probes: every SKIN_STEP back from the edge, up to SKIN_DEPTH, m. */
const SKIN_STEP = 0.00025;
const SKIN_DEPTH = 0.01;
/** The skin line is fitted over the skin's last SKIN_WINDOW before the edge, m. */
const SKIN_WINDOW = 0.002;
/** A section leaves its skin line where it falls this far below it, m. */
const DEPART = 0.0001;
/** An edge wall whose normal is within 45 degrees of the skin normal is not a wall. */
const WALL_SKIN_COSINE = Math.SQRT1_2;
/** Largest distance between the physical and the theoretical edge, m. */
const EDGE_SHIFT = 0.003;
const SCALAR_LIMITS = ['flush', 'parallelism', 'symmetry', 'visualGap'] as const;
/** The check each limit bounds. */
const LIMIT_CHECK = {
  gap: 'gap',
  flush: 'flush',
  parallelism: 'parallelism',
  symmetry: 'symmetry',
  visualGap: 'visual-gap',
} as const satisfies Record<keyof ShutLineLimits, ShutLineCheck>;
/** The checks a set of limits bounds. */
export function shutLineChecks(limits: Partial<ShutLineLimits>): ShutLineCheck[] {
  return (Object.keys(LIMIT_CHECK) as (keyof ShutLineLimits)[]).flatMap((key) =>
    limits[key] === undefined ? [] : [LIMIT_CHECK[key]],
  );
}
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Edge {
  readonly part: number;
  readonly va: number;
  readonly vb: number;
  readonly a: Tuple3;
  readonly b: Tuple3;
  /** Skin normal (outward) and the edge wall's normal (zero for an open skin edge). */
  readonly n: Tuple3;
  readonly wall: Tuple3;
}

/** A row's limits must be finite and inside its zone's (they may only tighten them). */
function rowLimits(row: DtsRow, zone: ShutLineZone): Result<ShutLineLimits, ModelingError> {
  const zoneLimits = DTS_ZONES[zone];
  const given = row.limits;
  if (given === undefined) return ok(zoneLimits);
  const bad = (expected: string) =>
    err(invalid(expected, { id: row.id, zone, limits: given, zoneLimits }));
  if (typeof given !== 'object' || given === null) return bad('limits is an object');
  for (const key of Object.keys(given))
    if (!Object.hasOwn(zoneLimits, key))
      return bad('limits names only gap, flush, parallelism, symmetry and visualGap');
  if (given.gap !== undefined) {
    const band = given.gap as unknown;
    const [lo, hi] = Array.isArray(band) && band.length === 2 ? band : [Number.NaN, Number.NaN];
    if (
      !(
        Number.isFinite(lo) &&
        Number.isFinite(hi) &&
        zoneLimits.gap[0] <= lo &&
        lo <= hi &&
        hi <= zoneLimits.gap[1]
      )
    )
      return bad("limits.gap is a finite band [lo, hi], lo <= hi, inside the zone's band");
  }
  for (const key of SCALAR_LIMITS) {
    const v = given[key];
    if (v !== undefined && !(Number.isFinite(v) && v >= 0 && v <= zoneLimits[key]))
      return bad(`limits.${key} is a finite number of meters >= 0, at most the zone's`);
  }
  return ok({ ...zoneLimits, ...given });
}

function isoDate(date: unknown): boolean {
  const m = typeof date === 'string' ? DATE.exec(date) : null;
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return days !== undefined && d >= 1 && d <= days;
}

/**
 * A row's exception names only gap, flush, parallelism, symmetry and visualGap, each finite
 * and strictly looser than the row's limit (a gap band containing it), with a reason and an
 * ISO date.
 */
function rowException(
  row: DtsRow,
  limits: ShutLineLimits,
): Result<ShutLineException | undefined, ModelingError> {
  const exception = row.exception;
  if (exception === undefined) return ok(undefined);
  const bad = (expected: string) => err(invalid(expected, { id: row.id, exception, limits }));
  if (typeof exception !== 'object' || exception === null) return bad('exception is an object');
  const given = exception.limits as unknown;
  if (typeof given !== 'object' || given === null || Object.keys(given).length === 0)
    return bad('exception.limits names at least one limit');
  for (const key of Object.keys(given))
    if (!Object.hasOwn(LIMIT_CHECK, key))
      return bad(
        'exception.limits names only gap, flush, parallelism, symmetry and visualGap (coverage, unmeasured and break cannot be excepted)',
      );
  const loose = given as Partial<ShutLineLimits>;
  if (loose.gap !== undefined) {
    const band = loose.gap as unknown;
    const [lo, hi] = Array.isArray(band) && band.length === 2 ? band : [Number.NaN, Number.NaN];
    if (
      !(
        Number.isFinite(lo) &&
        Number.isFinite(hi) &&
        lo <= limits.gap[0] &&
        hi >= limits.gap[1] &&
        (lo < limits.gap[0] || hi > limits.gap[1])
      )
    )
      return bad('exception.limits.gap is a finite band [lo, hi] strictly containing the row band');
  }
  for (const key of SCALAR_LIMITS) {
    const v = loose[key];
    if (v !== undefined && !(Number.isFinite(v) && v > limits[key]))
      return bad(`exception.limits.${key} is a finite number of meters above the row's limit`);
  }
  if (typeof exception.reason !== 'string' || exception.reason.trim().length === 0)
    return bad('exception.reason is a non-empty string');
  if (!isoDate(exception.date)) return bad('exception.date is an ISO date (yyyy-mm-dd)');
  return ok(exception);
}

/** 2D points ordered along their principal direction (a polyline through an unordered sample of a line). */
function alongLine(points: readonly (readonly [number, number])[]): (readonly [number, number])[] {
  const n = Math.max(1, points.length);
  const cx = points.reduce((a, p) => a + p[0], 0) / n;
  const cy = points.reduce((a, p) => a + p[1], 0) / n;
  let [sxx, sxy, syy] = [0, 0, 0];
  for (const p of points) {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  // Major axis of the 2x2 covariance by power iteration (exact arithmetic only).
  let [ux, uy] = sxx >= syy ? [1, 0] : [0, 1];
  for (let it = 0; it < 32; it++) {
    const nx = sxx * ux + sxy * uy;
    const ny = sxy * ux + syy * uy;
    const l = Math.sqrt(nx * nx + ny * ny);
    if (l === 0) break;
    [ux, uy] = [nx / l, ny / l];
  }
  return [...points].sort((a, b) => (a[0] - b[0]) * ux + (a[1] - b[1]) * uy);
}

interface Chain {
  readonly segments: readonly { readonly edge: Edge; readonly from: Tuple3; readonly to: Tuple3 }[];
  readonly closed: boolean;
}

/** A panel's outer edges as chains walked vertex to vertex (closed loops, or open at branches). */
function chainsOf(edges: readonly Edge[]): Chain[] {
  const at = new Map<number, number[]>();
  for (const [i, e] of edges.entries())
    for (const v of [e.va, e.vb]) {
      const list = at.get(v);
      if (list === undefined) at.set(v, [i]);
      else list.push(i);
    }
  const used = new Set<number>();
  const walk = (first: number, start: number): Chain => {
    const segments: { edge: Edge; from: Tuple3; to: Tuple3 }[] = [];
    let [i, v] = [first, start];
    for (;;) {
      used.add(i);
      const e = edges[i] as Edge;
      const forward = e.va === v;
      segments.push({ edge: e, from: forward ? e.a : e.b, to: forward ? e.b : e.a });
      v = forward ? e.vb : e.va;
      const next = at.get(v) as number[];
      if (next.length !== 2) return { segments, closed: false };
      const j = next.find((k) => !used.has(k));
      if (j === undefined) return { segments, closed: v === start };
      i = j;
    }
  };
  const out: Chain[] = [];
  for (const [v, list] of at)
    if (list.length !== 2) for (const i of list) if (!used.has(i)) out.push(walk(i, v));
  for (const [i, e] of edges.entries()) if (!used.has(i)) out.push(walk(i, e.va));
  return out;
}

/**
 * The edge-to-edge vector across the gap in the bisector frame of the two skin lines:
 * `along` the mean skin (the gap) and `step` along the bisector of their normals (the flush
 * step: a parallel step's height, 0 for a crease centred in the gap, the mismatch for an
 * off-centre crossing, about gap x sin(angle / 2) when it crosses at one edge). `(u, h)` are
 * across-the-gap and height coordinates of each panel's theoretical edge; `s` its skin
 * line's slope.
 */
function bisectorSplit(
  ua: number,
  ha: number,
  sa: number,
  ub: number,
  hb: number,
  sb: number,
): { readonly along: number; readonly step: number } {
  const ra = Math.sqrt(1 + sa * sa);
  const rb = Math.sqrt(1 + sb * sb);
  const mu = -sa / ra - sb / rb;
  const mh = 1 / ra + 1 / rb;
  const m = Math.sqrt(mu * mu + mh * mh);
  const [du, dh] = [ub - ua, hb - ha];
  return { along: (du * mh - dh * mu) / m, step: Math.abs(du * mu + dh * mh) / m };
}

/** A skin line in a station's section: height `at(u)`, its slope, and the skin's last point `start`. */
interface SkinLine {
  readonly at: (u: number) => number;
  readonly slope: number;
  readonly start: number;
}

/**
 * Value and slope at t = 0 of the least-squares quadratic through (t, h) (a line with fewer
 * than three points, or when the quadratic is degenerate); undefined below two distinct t.
 */
function tangentFit(
  ts: readonly number[],
  hs: readonly number[],
): { readonly h: number; readonly slope: number } | undefined {
  let [s0, s1, s2, s3, s4, r0, r1, r2] = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i] as number;
    const h = hs[i] as number;
    const t2 = t * t;
    s0 += 1;
    s1 += t;
    s2 += t2;
    s3 += t2 * t;
    s4 += t2 * t2;
    r0 += h;
    r1 += h * t;
    r2 += h * t2;
  }
  const det2 = s0 * s2 - s1 * s1;
  if (!(det2 > 1e-12 * s0 * s0)) return undefined;
  const linear = { h: (r0 * s2 - r1 * s1) / det2, slope: (s0 * r1 - s1 * r0) / det2 };
  if (ts.length < 3) return linear;
  // Cramer's rule on the normal equations [s0 s1 s2; s1 s2 s3; s2 s3 s4] c = [r0 r1 r2].
  const det3 = (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    hh: number,
    k: number,
  ) => a * (e * k - f * hh) - b * (d * k - f * g) + c * (d * hh - e * g);
  const det = det3(s0, s1, s2, s1, s2, s3, s2, s3, s4);
  if (!(Math.abs(det) > 1e-9 * s0 * s0 * s0)) return linear;
  return {
    h: det3(r0, s1, s2, r1, s2, s3, r2, s3, s4) / det,
    slope: det3(s0, r0, s2, s1, r1, s3, s2, r2, s4) / det,
  };
}

export function measureShutLines(
  mesh: EditMesh,
  options: ShutLineOptions,
  drawings: readonly ResolvedDrawing[] = [],
): Result<ShutLineReport, ModelingError> {
  const table: readonly DtsRow[] = Array.isArray(options?.table) ? options.table : [];
  if (table.length === 0) return err(invalid('a seam table has at least one row'));
  const breaks = new Map<
    string,
    {
      readonly view: BaseView;
      readonly line: readonly (readonly [number, number])[];
      readonly tolerance: number;
      readonly inset: number;
    }
  >();
  for (const row of table) {
    if (row.break === undefined) continue;
    const d = drawings.find((x) => x.name === row.break?.drawing);
    const item = d?.items.find((i) => i.id === row.break?.item);
    const view = d?.views.find((v) => v.id === item?.view);
    const line = d?.curves.find((c) => c.id === row.break?.item)?.points;
    if (
      item?.kind !== 'curve' ||
      item.role !== 'break' ||
      view === undefined ||
      line === undefined
    ) {
      return err(
        invalid('a row break names a break curve of an attached drawing', {
          row: row.id,
          break: row.break,
        }),
      );
    }
    breaks.set(row.id, {
      view: drawingBaseView(view, d?.views ?? []),
      line,
      tolerance: item.tolerance ?? 0.002,
      inset: item.inset ?? 0,
    });
  }
  const step = options.step ?? 0.01;
  const reach = options.reach ?? 0.012;
  const ends = options.ends ?? 0.01;
  for (const [name, value] of [
    ['step', step],
    ['reach', reach],
  ] as const)
    if (!(Number.isFinite(value) && value > 0))
      return err(invalid(`${name} is a positive number of meters`, { [name]: value }));
  if (!(Number.isFinite(ends) && ends >= 0))
    return err(invalid('ends is a number of meters >= 0', { ends }));
  const ids = new Set<string>();
  const tagIds = new Map<string, number>();
  const limitsOf = new Map<string, ShutLineLimits>();
  const exceptionOf = new Map<string, ShutLineException>();
  for (const row of table) {
    if (typeof row?.id !== 'string' || row.id.length === 0 || ids.has(row.id))
      return err(invalid('every seam row has a unique non-empty id', { id: row?.id }));
    ids.add(row.id);
    if (!Array.isArray(row.parts) || row.parts.length !== 2 || row.parts[0] === row.parts[1])
      return err(invalid('a seam row names two different parts (face tags)', { id: row.id }));
    if (row.zone !== undefined && !(row.zone in DTS_ZONES))
      return err(invalid("zone is 'A', 'B' or 'C'", { id: row.id, zone: row.zone }));
    if (row.clearance !== undefined) {
      const min = (row.clearance as { min?: unknown } | null)?.min;
      if (!(typeof min === 'number' && Number.isFinite(min) && min > 0))
        return err(invalid('clearance.min is a positive number of meters', { id: row.id }));
      if (row.limits !== undefined || row.exception !== undefined || row.mirror !== undefined)
        return err(
          invalid('a clearance row takes no limits, exception or mirror (no gap band)', {
            id: row.id,
          }),
        );
    }
    const limits = rowLimits(row, row.zone ?? 'A');
    if (!limits.ok) return limits;
    limitsOf.set(row.id, limits.value);
    const exception = rowException(row, limits.value);
    if (!exception.ok) return exception;
    if (exception.value !== undefined) exceptionOf.set(row.id, exception.value);
    for (const tag of row.parts) if (!tagIds.has(tag)) tagIds.set(tag, mesh.tagIndex(tag, false));
  }
  for (const row of table) {
    if (row.mirror === undefined) continue;
    const twin = table.find((r) => r.id === row.mirror);
    if (row.mirror === row.id || twin === undefined || twin.mirror !== row.id)
      return err(
        invalid('mirror names another row of the table, which names this row back', {
          id: row.id,
          mirror: row.mirror,
          ...(twin === undefined ? {} : { twinMirror: twin.mirror ?? null }),
        }),
      );
  }

  // Panels: every face carrying a part's tag belongs to it, whichever other parts also claim
  // it; their skin excludes the shell wall.
  const parts = [...tagIds.keys()];
  const wallRole = new Set(mesh.roleNames.flatMap((name, i) => (WALL_ROLES.has(name) ? [i] : [])));
  const partsOf = new Map<number, number[]>();
  for (const f of mesh.faces()) {
    const ks = parts.flatMap((tag, k) => {
      const t = tagIds.get(tag) as number;
      return t >= 0 && mesh.hasTag(f, t) ? [k] : [];
    });
    if (ks.length > 0) partsOf.set(f, ks);
  }
  for (const row of table) {
    const [A, B] = [parts.indexOf(row.parts[0]), parts.indexOf(row.parts[1])];
    for (const [f, ks] of partsOf)
      if (ks.includes(A) && ks.includes(B))
        return err(
          invalid("a seam row's two parts share no face", {
            id: row.id,
            parts: row.parts,
            face: f,
          }),
        );
  }
  const isWall = (f: number) => wallRole.has(mesh.fRole[f] as number);
  const isTreatment = (f: number) => ((mesh.fFlags[f] as number) & FACE_EDGE_ROUND) !== 0;
  const inPart = (f: number, k: number) => f >= 0 && (partsOf.get(f)?.includes(k) ?? false);
  // Skin triangles (rounds included) of each part for the section probes.
  const skins = parts.map((_, k) => {
    const positions: number[] = [];
    const indices: number[] = [];
    const faces: number[] = [];
    for (const [f, ks] of partsOf) {
      if (isWall(f) || !ks.includes(k)) continue;
      const vs = mesh.faceVertices(f);
      const base = positions.length / 3;
      for (const v of vs) pushAll(positions, mesh.position(v) as Tuple3);
      for (let i = 1; i + 1 < vs.length; i++) {
        indices.push(base, base + i, base + i + 1);
        faces.push(f);
      }
    }
    return { bvh: new TriangleBvh(positions, indices), faces };
  });
  // Outer edges of each part: skin against its own wall, or an open skin edge.
  const edges: Edge[] = [];
  for (const e of mesh.edges()) {
    const fa = mesh.hFace[e * 2] as number;
    const fb = mesh.hFace[e * 2 + 1] as number;
    const claimed = new Set([...(partsOf.get(fa) ?? []), ...(partsOf.get(fb) ?? [])]);
    if (claimed.size === 0) continue;
    const [va, vb] = mesh.edgeVertices(e);
    const a = mesh.position(va) as Tuple3;
    const b = mesh.position(vb) as Tuple3;
    if (!(norm(sub(b, a)) > 1e-9)) continue;
    for (const part of claimed) {
      let outer = -1;
      let wall = -1;
      if (inPart(fa, part) && !isWall(fa) && (fb < 0 || (inPart(fb, part) && isWall(fb))))
        [outer, wall] = [fa, fb];
      else if (inPart(fb, part) && !isWall(fb) && (fa < 0 || (inPart(fa, part) && isWall(fa))))
        [outer, wall] = [fb, fa];
      if (outer < 0) continue;
      const wn = wall >= 0 ? faceNormal(mesh, wall) : ([0, 0, 0] as Tuple3);
      const c = faceNormal(mesh, outer);
      // The skin normal without its component along the wall (a chamfer leans between them).
      const k = dot(c, wn);
      edges.push({ part, va, vb, a, b, n: unit(add(c, wn, -k)), wall: wn });
    }
  }
  const chainsOfPart = new Map<number, Chain[]>();
  const chains = (part: number): Chain[] => {
    let c = chainsOfPart.get(part);
    if (c === undefined) {
      c = chainsOf(edges.filter((e) => e.part === part));
      chainsOfPart.set(part, c);
    }
    return c;
  };
  // Where a panel's edge chain has walls, its seams are walled: an open skin edge of the chain
  // is a side, neither measured (its corners read oblique sections) nor a partner edge.
  const sides = new Set<Edge>();
  for (const k of parts.keys())
    for (const { segments } of chains(k))
      if (segments.some((g) => norm(g.edge.wall) > 0))
        for (const { edge } of segments) if (norm(edge.wall) === 0) sides.add(edge);
  const closest = (p: Tuple3, e: Edge): { q: Tuple3; d: number } => {
    const ab = sub(e.b, e.a);
    const u = Math.max(0, Math.min(1, dot(sub(p, e.a), ab) / dot(ab, ab)));
    const q = add(e.a, ab, u);
    return { q, d: norm(sub(q, p)) };
  };
  /** Skin point of `part` under `x` along -n (a ray from 5 mm above) and its face. */
  const probe = (
    x: Tuple3,
    n: Tuple3,
    part: number,
  ): { readonly x: Tuple3; readonly face: number } | undefined => {
    const o = add(x, n, 0.005);
    const skin = skins[part] as (typeof skins)[number];
    const hit = skin.bvh.raycast(o, [-n[0], -n[1], -n[2]], 0.015, false);
    return hit === undefined
      ? undefined
      : { x: add(o, n, -hit.t), face: skin.faces[hit.triangle] as number };
  };

  interface Station {
    readonly p: Tuple3;
    /** The middle of the gap: the seam's centre line. */
    readonly mid: Tuple3;
    readonly gap: number;
    readonly visual: number;
    readonly flush: number;
    /** Within `ends` of the line's ends. */
    readonly end: boolean;
  }
  /**
   * The station at `p` on edge `e` (tangent `t`): far (no partner edge within reach), skipped,
   * or measured. Its section is square to the edge, or at a vertex (`vertex`) points at the
   * nearest point of the other panel's edges.
   */
  const measureAt = (
    p: Tuple3,
    t: Tuple3,
    vertex: boolean,
    e: Edge,
    own: number,
    other: number,
    theirs: readonly Edge[],
  ): Omit<Station, 'end'> | 'far' | 'skipped' => {
    let best: { q: Tuple3; d: number; e: Edge } | undefined;
    for (const f of theirs) {
      const c = closest(p, f);
      if (c.d <= reach && (best === undefined || c.d < best.d)) best = { ...c, e: f };
    }
    if (best === undefined) return 'far';
    // The section frame at the station: across (from this panel to the other), normal.
    const n = e.n;
    const d = sub(best.q, p);
    const g = add(add(d, n, -dot(d, n)), t, vertex ? 0 : -dot(d, t));
    // With no gap to read a direction from, across is the skin tangent square to the edge.
    const square: Tuple3 = unit([
      t[1] * n[2] - t[2] * n[1],
      t[2] * n[0] - t[0] * n[2],
      t[0] * n[1] - t[1] * n[0],
    ]);
    // A section square to its edge facing the other panel's nearest point more along the edge
    // than across it (past the other panel's end) cuts no seam.
    if (!vertex && Math.abs(dot(d, t)) > Math.abs(dot(d, square))) return 'skipped';
    const across =
      norm(g) > 1e-9
        ? unit(g)
        : dot(square, d) >= 0
          ? square
          : ([-square[0], -square[1], -square[2]] as Tuple3);
    const side: Tuple3 = [
      n[1] * across[2] - n[2] * across[1],
      n[2] * across[0] - n[0] * across[2],
      n[0] * across[1] - n[1] * across[0],
    ];
    // Each skin is probed along its own edge normal, so a panel meeting this one at a crease
    // is found too; its points are then read in this station's frame. Walking from SKIN_DEPTH
    // toward the edge, the skin ends at edge treatment, a miss, or a turn of 45 degrees or more
    // between neighbouring faces (a turned edge). The skin line is the tangent at the skin's
    // last point, from a quadratic over its last SKIN_WINDOW, so a tight roll is followed.
    const line = (part: number, from: Tuple3, sign: number, pn: Tuple3): SkinLine | undefined => {
      const along = unit(add(across, pn, -dot(across, pn)));
      const us: number[] = [];
      const hs: number[] = [];
      const backs: number[] = [];
      let normal: Tuple3 | undefined;
      for (let i = Math.round(SKIN_DEPTH / SKIN_STEP); i >= 1; i--) {
        const back = i * SKIN_STEP;
        const hit = probe(add(from, along, sign * back), pn, part);
        const fn =
          hit === undefined || isTreatment(hit.face) ? undefined : faceNormal(mesh, hit.face);
        if (
          hit === undefined ||
          fn === undefined ||
          (normal !== undefined && dot(normal, fn) < WALL_SKIN_COSINE)
        ) {
          if (normal === undefined) continue;
          break;
        }
        normal = fn;
        us.push(dot(sub(hit.x, p), across));
        hs.push(dot(sub(hit.x, p), n));
        backs.push(back);
      }
      const k = us.length - 1;
      if (k < 1 || (backs[0] as number) - (backs[k] as number) < SKIN_WINDOW - SKIN_STEP / 2)
        return undefined;
      const u0 = us[k] as number;
      const near = backs.flatMap((b, i) =>
        b <= (backs[k] as number) + SKIN_WINDOW + 1e-12 ? [i] : [],
      );
      const fit = tangentFit(
        near.map((i) => ((us[i] as number) - u0) / SKIN_WINDOW),
        near.map((i) => hs[i] as number),
      );
      if (fit === undefined) return undefined;
      const slope = fit.slope / SKIN_WINDOW;
      return { at: (u: number) => fit.h + slope * (u - u0), slope, start: u0 };
    };
    const la = line(own, p, -1, n);
    const lb = line(other, best.q, 1, best.e.n);
    if (la === undefined || lb === undefined) return 'skipped';
    // Theoretical edge: the skin line meeting the panel's own wall face (or its open edge), at
    // `u` across and `w` along the edge (nonzero where the section misses the wall face).
    const theoretical = (l: SkinLine, edge: Tuple3, face: Edge) => {
      const u0 = dot(sub(edge, p), across);
      const wall = face.wall;
      if (norm(wall) === 0) return { u: u0, w: 0 };
      // A wall within 45 degrees of its own skin line (a turned edge, a three-panel corner) has
      // no theoretical line to extend to.
      const wn = dot(n, wall);
      const skinNormal = (wn - l.slope * dot(across, wall)) / Math.sqrt(1 + l.slope * l.slope);
      if (Math.abs(skinNormal) > WALL_SKIN_COSINE) return undefined;
      // On the wall plane: u (across . wall) + h (n . wall) = (edge - p) . wall, h = l.at(u).
      const den = dot(across, wall) + l.slope * wn;
      if (Math.abs(den) < 1e-9) return undefined;
      const u = (dot(sub(edge, p), wall) - l.at(0) * wn) / den;
      if (!(Math.abs(u - u0) <= EDGE_SHIFT)) return undefined;
      // The wall face ends with its edge: slide a hit beyond it back along the edge.
      const ab = sub(face.b, face.a);
      const x = add(add(p, across, u), n, l.at(u));
      const s = dot(sub(x, face.a), ab) / dot(ab, ab);
      const clamped = Math.max(0, Math.min(1, s));
      if (clamped === s) return { u, w: 0 };
      const y = sub(add(x, ab, clamped - s), p);
      return { u: dot(y, across), w: dot(y, side) };
    };
    const ta = theoretical(la, p, e);
    const tb = theoretical(lb, best.q, best.e);
    if (ta === undefined || tb === undefined) return 'skipped';
    const [ua, ub] = [ta.u, tb.u];
    const edges = bisectorSplit(ua, la.at(ua), la.slope, ub, lb.at(ub), lb.slope);
    const [du, dw] = [edges.along, tb.w - ta.w];
    // Visual edge: walking toward the gap, where the section first leaves its skin line;
    // `h` is the section's own height there.
    // A section that reaches the theoretical edge keeps its last offset from the skin line.
    const visualEdge = (l: SkinLine, part: number, to: number) => {
      const stepU = 0.0001;
      const from = l.start;
      const dir = Math.sign(to - from);
      let last = { u: from, h: l.at(from) };
      for (let u = from; dir * (to - u) > 0; u += dir * stepU) {
        const x = probe(add(add(p, across, u), n, l.at(u)), n, part);
        const h = x === undefined ? undefined : dot(sub(x.x, p), n);
        if (h === undefined || l.at(u) - h > DEPART) return last;
        last = { u, h };
      }
      return { u: to, h: l.at(to) + last.h - l.at(last.u) };
    };
    const va = visualEdge(la, own, ua);
    const vb = visualEdge(lb, other, ub);
    const center = (ua + ub) / 2;
    return {
      p,
      mid: add(p, across, center),
      gap: dw === 0 ? du : Math.sign(du) * Math.sqrt(du * du + dw * dw),
      visual: vb.u - va.u,
      flush: Math.max(
        edges.step,
        // A lip in the edge treatment stands proud of its own skin line at the visual edge; a
        // section below it is the departure itself (less than DEPART), not a step.
        Math.max(0, va.h - la.at(va.u)),
        Math.max(0, vb.h - lb.at(vb.u)),
      ),
    };
  };

  /**
   * Stations every `step` along each chain of a panel's outer edges, at the edges' ends too.
   * A chain belongs to the line between its first and last station with the other panel in
   * reach (on a loop: all but its longest stretch out of reach); stations within `ends` of
   * those ends are excluded from the coverage, the rest are measured or skipped.
   */
  const measureRow = (row: DtsRow): { stations: Station[]; counted: number; skipped: number } => {
    const [A, B] = [parts.indexOf(row.parts[0]), parts.indexOf(row.parts[1])];
    const out: Station[] = [];
    let counted = 0;
    let skipped = 0;
    for (const [own, other] of [
      [A, B],
      [B, A],
    ] as const) {
      const theirs = edges.filter((e) => e.part === other && !sides.has(e));
      if (theirs.length === 0) continue;
      for (const chain of chains(own)) {
        const { segments } = chain;
        const sampled: { s: number; r: Omit<Station, 'end'> | 'far' | 'skipped' }[] = [];
        let s = 0;
        const stepsOf = (seg: Chain['segments'][number]) =>
          Math.max(1, Math.round(norm(sub(seg.to, seg.from)) / step));
        const point = (seg: Chain['segments'][number], k: number) =>
          add(seg.from, sub(seg.to, seg.from), k);
        const distance = (x: Tuple3) => minOf(theirs.map((f) => closest(x, f).d));
        // A vertex is a station where its distance to the other panel peaks or dips against the
        // neighboring stations (a pinch or flare narrower than the spacing); its neighbors cover
        // the rest, such as a panel corner, whose section would cut the line obliquely.
        const extreme = (x: Tuple3, neighbors: readonly Tuple3[]) => {
          const d0 = distance(x);
          const ds = neighbors.map(distance);
          return ds.every((d) => d0 <= d + 1e-9) || ds.every((d) => d0 >= d - 1e-9);
        };
        for (const [i, seg] of segments.entries()) {
          const len = norm(sub(seg.to, seg.from));
          const t = unit(sub(seg.to, seg.from));
          const steps = stepsOf(seg);
          const side = sides.has(seg.edge);
          const at = (k: number, vertex = false) => {
            const r = measureAt(point(seg, k), t, vertex, seg.edge, own, other, theirs);
            sampled.push({ s: s + len * k, r: side && r !== 'far' ? 'skipped' : r });
          };
          const prev = segments[i > 0 ? i - 1 : chain.closed ? segments.length - 1 : -1];
          const neighbors = [point(seg, 0.5 / steps)];
          if (prev !== undefined) neighbors.push(point(prev, 1 - 0.5 / stepsOf(prev)));
          if (extreme(seg.from, neighbors)) at(0, true);
          for (let k = 0; k < steps; k++) at((k + 0.5) / steps);
          s += len;
          if (
            !chain.closed &&
            i === segments.length - 1 &&
            extreme(seg.to, [point(seg, 1 - 0.5 / steps)])
          )
            at(1, true);
        }
        const total = s;
        const near = sampled.flatMap((x, i) => (x.r === 'far' ? [] : [i]));
        if (near.length === 0) continue;
        let [first, last] = [near[0] as number, near[near.length - 1] as number];
        let full = false;
        if (chain.closed) {
          // The line is the loop without its longest stretch out of reach.
          let widest = -1;
          for (let k = 0; k < near.length; k++) {
            const i = near[k] as number;
            const j = near[(k + 1) % near.length] as number;
            if ((i + 1) % sampled.length === j) continue;
            const span = ((sampled[j]?.s as number) - (sampled[i]?.s as number) + total) % total;
            if (span > widest) [widest, last, first] = [span, i, j];
          }
          full = widest < 0;
        }
        const s0 = sampled[first]?.s as number;
        const from = (x: number) => (chain.closed ? (x - s0 + total) % total : x - s0);
        const length = full ? total : from(sampled[last]?.s as number);
        for (let k = 0; k < sampled.length; k++) {
          const i = (first + k) % sampled.length;
          const x = sampled[i] as (typeof sampled)[number];
          const pos = full ? 0 : from(x.s);
          if (!full && pos > length) break;
          const end = !full && (pos < ends || length - pos < ends);
          if (!end) counted++;
          if (typeof x.r === 'string') {
            if (!end) skipped++;
          } else out.push({ ...x.r, end });
          if (!chain.closed && i === sampled.length - 1) break;
        }
      }
    }
    return { stations: out, counted, skipped };
  };

  const measured = new Map<string, ReturnType<typeof measureRow>>();
  for (const row of table) if (row.clearance === undefined) measured.set(row.id, measureRow(row));
  const stats = (v: readonly number[]): ShutLineStats => {
    const sorted = [...v].sort((a, b) => a - b);
    const at = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
    return {
      min: sorted[0] as number,
      max: sorted[sorted.length - 1] as number,
      mean: v.reduce((a, b) => a + b, 0) / v.length,
      p10: at(0.1),
      median: at(0.5),
      p90: at(0.9),
    };
  };
  const rows: ShutLineRow[] = table.map((row) => {
    if (row.clearance !== undefined)
      return clearanceRow(
        mesh,
        row,
        row.clearance.min,
        reach,
        limitsOf.get(row.id) as ShutLineLimits,
      );
    const zone = row.zone ?? 'A';
    const limits = limitsOf.get(row.id) as ShutLineLimits;
    const exception = exceptionOf.get(row.id);
    const { stations: s, counted, skipped } = measured.get(row.id) as ReturnType<typeof measureRow>;
    const coverage = counted === 0 ? (s.length > 0 ? 1 : 0) : (counted - skipped) / counted;
    const base = {
      id: row.id,
      parts: row.parts,
      zone,
      limits,
      samples: s.length,
      skipped,
      coverage,
      ...(exception === undefined ? {} : { exception }),
    };
    if (s.length < 3)
      return { ...base, failures: ['unmeasured'], excepted: [], status: 'unmeasured' };
    const gaps = s.map((x) => x.gap);
    const gap = stats(gaps);
    const inner = s.filter((x) => !x.end).map((x) => x.gap);
    const parallelism = inner.length > 0 ? maxOf(inner) - minOf(inner) : gap.max - gap.min;
    const flush = maxOf(s.map((x) => x.flush));
    const visualGap = stats(s.map((x) => x.visual));
    let worst = s[0] as Station;
    const off = (x: Station) => Math.max(limits.gap[0] - x.gap, x.gap - limits.gap[1], 0);
    for (const x of s) if (off(x) > off(worst)) worst = x;
    const mirror = row.mirror === undefined ? undefined : measured.get(row.mirror)?.stations;
    const symmetryDelta =
      mirror === undefined || mirror.length < 3
        ? undefined
        : Math.abs(gap.mean - mirror.reduce((a, b) => a + b.gap, 0) / mirror.length);
    const failures: ShutLineCheck[] = [];
    const excepted: ShutLineCheck[] = [];
    // Each limited check: failing the row's limits, it is excepted when the exception names
    // it and the measurement stays inside the exception's bound.
    const limited = (key: keyof ShutLineLimits, fails: (l: ShutLineLimits) => boolean) => {
      if (!fails(limits)) return;
      const bound = exception?.limits[key];
      const loose = bound === undefined ? undefined : { ...limits, [key]: bound };
      (loose !== undefined && !fails(loose) ? excepted : failures).push(LIMIT_CHECK[key]);
    };
    limited('gap', (l) => gap.min < l.gap[0] || gap.max > l.gap[1]);
    limited('flush', (l) => flush > l.flush);
    limited('parallelism', (l) => parallelism > l.parallelism);
    limited('symmetry', (l) => symmetryDelta !== undefined && symmetryDelta > l.symmetry);
    if (coverage < LINE_COVERAGE) failures.push('coverage');
    limited('visualGap', (l) => visualGap.max > l.visualGap);
    const drawn = breaks.get(row.id);
    let brk: { readonly max: number; readonly back: number; readonly coverage: number } | undefined;
    if (drawn !== undefined) {
      const { frame } = drawingViewFrame(drawn.view);
      // Stations come from both panels' edges: order the centre points along the line.
      const seam = alongLine(
        s.map((x): readonly [number, number] => [dot(x.mid, frame.right), dot(x.mid, frame.up)]),
      );
      brk = compareLines(drawn.line, seam, { reach: 0.05, inset: drawn.inset });
      if (brk.max > drawn.tolerance || brk.back > drawn.tolerance || brk.coverage < LINE_COVERAGE)
        failures.push('break');
    }
    return {
      ...base,
      gap,
      visualGap,
      flush,
      parallelism,
      ...(symmetryDelta === undefined ? {} : { symmetryDelta }),
      worst: { at: worst.p, gap: worst.gap, flush: worst.flush },
      ...(brk === undefined ? {} : { break: brk }),
      failures,
      excepted,
      status: failures.length > 0 ? 'fail' : excepted.length > 0 ? 'excepted' : 'pass',
    };
  });
  const counts = { pass: 0, fail: 0, excepted: 0, unmeasured: 0 };
  for (const r of rows) counts[r.status]++;
  return ok({ rows, pass: counts.fail === 0 && counts.unmeasured === 0, counts });
}

/**
 * A clearance row: the smallest distance between the faces of its two parts (searched up to
 * max(reach, 2 x min)), located at the vertex of either part nearest the other.
 */
function clearanceRow(
  mesh: EditMesh,
  row: DtsRow,
  min: number,
  reach: number,
  limits: ShutLineLimits,
): ShutLineRow {
  const geometry = row.parts.map((tag) => {
    const t = mesh.tagIndex(tag, false);
    const faces = t < 0 ? [] : mesh.faces().filter((f) => mesh.hasTag(f, t));
    return partGeometry(mesh, tag, faces, false);
  });
  const base = {
    id: row.id,
    parts: row.parts,
    zone: row.zone ?? 'A',
    limits,
    samples: 0,
    skipped: 0,
    excepted: [],
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] as const;
  const distance = geometry.some((g) => g.faces.length === 0)
    ? Infinity
    : partDistance(
        geometry,
        0,
        1,
        { deltas: [identity, identity], relative: () => identity },
        Math.max(reach, 2 * min),
      );
  if (!Number.isFinite(distance))
    return { ...base, coverage: 0, failures: ['unmeasured'], status: 'unmeasured' };
  let at: Tuple3 = [0, 0, 0];
  let best = Infinity;
  for (const [k, g] of geometry.entries()) {
    const other = geometry[1 - k] as PartGeometry;
    for (let i = 0; i < g.points.length; i += 3) {
      const p: Tuple3 = [
        g.points[i] as number,
        g.points[i + 1] as number,
        g.points[i + 2] as number,
      ];
      const d = nearest(other, p);
      if (d < best) [best, at] = [d, p];
    }
  }
  const failures: ShutLineCheck[] = distance < min ? ['clearance'] : [];
  return {
    ...base,
    samples: geometry.reduce((n, g) => n + g.points.length / 3, 0),
    coverage: 1,
    clearance: { min, distance, at },
    failures,
    status: failures.length > 0 ? 'fail' : 'pass',
  };
}
