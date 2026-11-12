import type { Tuple3 } from './geom';
import type { Point2 } from './primitives';
import type { Coverage, Issue } from './report';
import type { Clamp, LimitMode } from './rig';

/**
 * What a pose report's issues name: `no-contrapposto` (hip and shoulder lines do
 * not counter-tilt 5-15 degrees), `unbalanced` (the centre of mass projects outside the
 * support polygon), `not-grounded` (a foot part stands off or sinks into the ground by more
 * than the contact tolerance), `thin-silhouette` (front silhouette fill below 0.41),
 * `no-negative-space` (the silhouette above the hip line encloses under 4 % background: arms
 * merge into the torso, a box on legs), `straight-line-of-action` (the body's midline stays
 * within 1 % of the height of the straight line from the feet to the top: no C or S),
 * `massless` (open parts carry no mass, so the balance check cannot see them).
 */
export type PoseCode =
  | 'no-contrapposto'
  | 'unbalanced'
  | 'not-grounded'
  | 'thin-silhouette'
  | 'no-negative-space'
  | 'straight-line-of-action'
  | 'massless';

/** Negative space below which the upper silhouette reads as one block. */
export const NEGATIVE_SPACE = 0.04;
/** Midline deviation (share of the height) below which the line of action is straight. */
export const LINE_OF_ACTION = 0.01;

export interface PoseReportOptions {
  /** Direction from the subject toward the viewer, in model space (default +z). */
  readonly front?: Tuple3;
  /** Ground height along `up` (default 0). */
  readonly ground?: number;
  /** Up direction (default +y). */
  readonly up?: Tuple3;
  /** Left and right hip joints, and left and right shoulder joints (by name). */
  readonly hips?: readonly [string, string];
  readonly shoulders?: readonly [string, string];
  /** Parts that should stand on the ground. */
  readonly feet?: readonly string[];
  /** Ground contact tolerance (m, default 0.005). */
  readonly contact?: number;
  /** Density of every part, or per part name (kg/m^3, default steel). */
  readonly density?: number | Readonly<Record<string, number>>;
  /** A pose past a joint limit fails (`reject`, the default) or is clamped and reported. */
  readonly limits?: LimitMode;
}

export interface PoseReport {
  /** Tilt of the left-to-right hip and shoulder lines in the front view (degrees, + up to the left). */
  readonly hips?: number;
  readonly shoulders?: number;
  /** Shoulder tilt minus hip tilt (degrees): the counter-tilt of a contrapposto. */
  readonly counterTilt?: number;
  readonly contrapposto?: boolean;
  /** Centre of mass and its signed distance inside the support polygon (m, negative outside). */
  readonly centroid: Tuple3;
  readonly support: readonly Point2[];
  readonly margin?: number;
  /** Each foot's lowest point above the ground (m, negative: below). */
  readonly feet: readonly {
    readonly part: string;
    readonly gap: number;
    readonly grounded: boolean;
  }[];
  /**
   * Front silhouette: covered share of its bounding rectangle and the rectangle (m), and its
   * negative space: the background share inside each row's extent, above the hip line (the
   * whole silhouette without `hips`).
   */
  readonly silhouette: {
    readonly fill: number;
    readonly width: number;
    readonly height: number;
    readonly negativeSpace: number;
  };
  /**
   * The silhouette's midline (row centres) against the straight line from its bottom to its top
   * centre: largest deviation as a share of the height, and its shape (`C` to one side, `S`
   * to both, each beyond 1 % of the height).
   */
  readonly lineOfAction: { readonly deviation: number; readonly shape: 'straight' | 'C' | 'S' };
  /**
   * Open parts (no volume): left out of the centre of mass, and a `massless` finding, since
   * the balance check cannot see them.
   */
  readonly massless: readonly string[];
  /** Joints held at a limit (only with `limits: 'clamp'`). */
  readonly clamped: readonly Clamp[];
  /**
   * What each code looked at. Subjects: the hip and shoulder lines (`no-contrapposto`), the
   * balance check (`unbalanced`), each named foot (`not-grounded`), the front silhouette
   * (`thin-silhouette`, `no-negative-space`, `straight-line-of-action`) and every part
   * (`massless`). A gate an option left out is unchecked as `not-requested` (`contrapposto`
   * without hips and shoulders, balance and grounding without feet), `missing-input` when only
   * one of hips and shoulders is given or the parts carry no mass.
   */
  readonly coverage: Coverage<PoseCode>;
  /** No issue and something checked. */
  readonly pass: boolean;
  /** What fails (severity `warn`), with the measured values in `detail`. */
  readonly issues: readonly Issue<PoseCode>[];
}

/** Convex hull (counter-clockwise) of 2D points, Andrew's monotone chain. */
export function convexHull(points: readonly Point2[]): Point2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Point2, a: Point2, b: Point2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point2[] = [];
  for (const q of p) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2] as Point2, lower[lower.length - 1] as Point2, q) <= 0
    )
      lower.pop();
    lower.push(q);
  }
  const upper: Point2[] = [];
  for (const q of [...p].reverse()) {
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2] as Point2, upper[upper.length - 1] as Point2, q) <= 0
    )
      upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Signed distance of q inside a counter-clockwise convex polygon (negative outside). */
export function insideMargin(polygon: readonly Point2[], q: Point2): number {
  if (polygon.length < 3) return -Infinity;
  let margin = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Point2;
    const b = polygon[(i + 1) % polygon.length] as Point2;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const l = Math.sqrt(ex * ex + ey * ey);
    if (l === 0) continue;
    margin = Math.min(margin, (ex * (q[1] - a[1]) - ey * (q[0] - a[0])) / l);
  }
  return margin;
}

/** A silhouette rasterized on a square grid: covered cells row by row, bottom up. */
interface Raster {
  readonly covered: Uint8Array;
  readonly nx: number;
  readonly ny: number;
  readonly x0: number;
  readonly y0: number;
  readonly step: number;
  readonly width: number;
  readonly height: number;
}

/** Each covered row's first and last covered cell. */
function rowExtents(r: Raster): ({ first: number; last: number; covered: number } | undefined)[] {
  const rows: ({ first: number; last: number; covered: number } | undefined)[] = [];
  for (let j = 0; j < r.ny; j++) {
    let first = -1;
    let last = -1;
    let covered = 0;
    for (let i = 0; i < r.nx; i++) {
      if (r.covered[j * r.nx + i] !== 1) continue;
      if (first < 0) first = i;
      last = i;
      covered++;
    }
    rows.push(first < 0 ? undefined : { first, last, covered });
  }
  return rows;
}

/**
 * Background share inside each row's covered extent, over the rows whose centre is at or
 * above `above` (the hip line): gaps between arms and torso, or between the legs.
 */
export function negativeSpace(r: Raster, above = -Infinity): number {
  let span = 0;
  let gaps = 0;
  for (const [j, row] of rowExtents(r).entries()) {
    if (row === undefined || r.y0 + (j + 0.5) * r.step < above) continue;
    span += row.last - row.first + 1;
    gaps += row.last - row.first + 1 - row.covered;
  }
  return span === 0 ? 0 : gaps / span;
}

/** The midline's largest deviation from the bottom-to-top line (share of the height) and shape. */
export function lineOfAction(r: Raster): { deviation: number; shape: 'straight' | 'C' | 'S' } {
  const mids = rowExtents(r).flatMap((row, j) =>
    row === undefined ? [] : [[j, (row.first + row.last) / 2] as const],
  );
  const a = mids[0];
  const b = mids[mids.length - 1];
  if (a === undefined || b === undefined || b[0] === a[0])
    return { deviation: 0, shape: 'straight' };
  let left = 0;
  let right = 0;
  for (const [j, x] of mids) {
    const d = ((x - (a[1] + ((b[1] - a[1]) * (j - a[0])) / (b[0] - a[0]))) * r.step) / r.height;
    left = Math.max(left, -d);
    right = Math.max(right, d);
  }
  const shape =
    left >= LINE_OF_ACTION && right >= LINE_OF_ACTION
      ? 'S'
      : left >= LINE_OF_ACTION || right >= LINE_OF_ACTION
        ? 'C'
        : 'straight';
  return { deviation: Math.max(left, right), shape };
}

/**
 * Covered share of the bounding rectangle of 2D triangles, rasterized on a grid of `cells`
 * along the longer side (cell centres tested against each triangle).
 */
export function silhouetteFill(
  triangles: readonly (readonly [Point2, Point2, Point2])[],
  cells = 200,
): { fill: number; width: number; height: number; raster: Raster } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const t of triangles) {
    for (const p of t) {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
  }
  const width = x1 - x0;
  const height = y1 - y0;
  if (!(width > 0 && height > 0)) {
    const raster = {
      covered: new Uint8Array(0),
      nx: 0,
      ny: 0,
      x0,
      y0,
      step: 1,
      width: 0,
      height: 0,
    };
    return { fill: 0, width: Math.max(0, width), height: Math.max(0, height), raster };
  }
  const step = Math.max(width, height) / cells;
  const nx = Math.max(1, Math.ceil(width / step));
  const ny = Math.max(1, Math.ceil(height / step));
  const covered = new Uint8Array(nx * ny);
  for (const [a, b, c] of triangles) {
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (area === 0) continue;
    const minX = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - x0) / step));
    const maxX = Math.min(nx - 1, Math.floor((Math.max(a[0], b[0], c[0]) - x0) / step));
    const minY = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - y0) / step));
    const maxY = Math.min(ny - 1, Math.floor((Math.max(a[1], b[1], c[1]) - y0) / step));
    for (let j = minY; j <= maxY; j++) {
      const py = y0 + (j + 0.5) * step;
      for (let i = minX; i <= maxX; i++) {
        const px = x0 + (i + 0.5) * step;
        const w0 = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
        const w1 = (c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0]);
        const w2 = (a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (px - c[0]);
        if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0))
          covered[j * nx + i] = 1;
      }
    }
  }
  let count = 0;
  for (const v of covered) count += v;
  return {
    fill: count / (nx * ny),
    width,
    height,
    raster: { covered, nx, ny, x0, y0, step, width, height },
  };
}
