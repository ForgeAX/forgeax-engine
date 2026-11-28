import { err, ok } from '@forgeax/engine-types';
import { maxOf, pushAll } from '../arrays';
import { atan, cos, sin } from '../dmath';
import { pcurvePoint } from './curves';
import { exp, log, tan } from './dmath-explog';
import { faceLoops, gridOf } from './faces';
import { type DiscGrid, discGrid, smoothDisc } from './quad-iso-disc';
import { quadrangulateTrimmed } from './quad-trimmed';
import { surfaceDomain, surfacePoint } from './surfaces';
import type { TrimRing } from './tessellate-trimmed';
import type { Coedge, Curve, Edge, Face, Shape, Surface } from './types';
import { type P2, type P3, TWO_PI } from './vec';

/**
 * Opt-in quad layout of a holed face on a developable quadric or a plane. The cylinder is isometric to the plane
 * ((u, v) -> (r u, v)) and the plane is its own chart, so the face is laid out in the developed plane: an iso grid spanned by the outer
 * rectangle's own edge samples fills the far field. Each hole sits in a carved rectangular block whose perimeter
 * carries exactly as many grid points as the hole loop carries samples, so the annulus is a structured O-grid
 * strip: an orthogonal boundary row, then layers blended to the block perimeter, with no matching and no
 * triangles. Boundary samples are the shared edge samples, so neighbouring faces conform; `isoHoleFloors` raises
 * the hole edge counts to what the block needs. A torus with holes uses the same layout in a chart whose u scale is
 * the metric at the holes (see `Chart`). A sphere is laid out the same way in a latitude-longitude chart: the pole
 * edges become rows of samples that all share the pole vertex, so each pole row of cells collapses to a triangle (the
 * only triangles this layout emits). A cone is the same, with its apex as the single pole edge and a log-chart annulus.
 * A holed plane needs a rectangular outer loop, or one full circle (see `discGrid`: a lattice disc inside the circle,
 * and a sheared outer strip relaxed over a belt of lattice nodes), and holes at least two cells from each other; its outer line edges are
 * sampled up to twice as coarse as the holes (see `isoFarEdges`), so the far field is graded by the grid itself;
 * otherwise it fails closed (`iso-outer-not-rectangle`, `iso-hole-blocks-overlap`, `iso-strip-distorted`).
 * Anything else (a holeless cone, sphere or torus) fails closed with a named reason.
 *
 * Measured limits (trunk 3b6ce395, `quad` with `ISO_FAR_RATIOS` [2, 1.5, 1, 0.75, 0.5]; a size is the requested
 * quad edge length; "minSJ" is the minimum scaled Jacobian of the emitted mesh, which must stay at least
 * `STRIP_MIN_SINE` = 0.3 for the layout to be accepted):
 * - Plate 100 x 70 with a 3 x 4 grid of holes (radius 1, hole gap 1.04), sizes 0.3 to 8 tried. Meshes (tris 0):
 *   0.3 to 3.5 (every size tried in that range, among them 0.8, 1, 1.5, 1.9, 2, 2.1, 2.2, 2.4, 2.6, 2.8, 3, 3.2, 3.5), 4, 4.6, 4.9 and
 *   5. minSJ of the passing sizes lies in 0.302 to 0.581 (lowest 0.302 at size 2.2, which barely clears the 0.3
 *   line; 0.318 to 0.525 below size 1.8). Refused with `iso-strip-distorted`: 3.8, 4.3 and every size from 5.2 up
 *   to 8 (5.2, 5.5, 6, 6.5, 7, 8). The 90 tall control (sizes 5, 4, 3.5, 3,
 *   2.6) always meshes with minSJ 0.563 to 0.701.
 * - Cause of the refusals: the plate-edge nodes (about 5 apart at size 5) are much farther apart than the hole
 *   samples (about 1.8 apart) across the 1.04 wall, so the sheared strip between them falls under the sine floor.
 *   A finer plate edge repairs it; a larger size cannot.
 * - Other refusal codes seen on the same family: a 12 x H plate at size 1 meshes for H = 4.6 (minSJ 0.354) and 4.4
 *   (0.347), refuses `iso-strip-distorted` at 4.3 and `iso-strip-folded` at 4.2 and 4.1; two radius-1 holes
 *   0.1 to 0.4 apart at size 0.5 refuse `iso-hole-blocks-overlap` (0.5 meshes); a 6- or 12-bolt circle refuses
 *   `iso-hole-no-room` at sizes 2 and 3 (6 bolts) and 1.5 and 2 (12 bolts), and meshes at 0.8 to 1.5 (6 bolts,
 *   minSJ 0.547 to 0.590) and 0.5 to 1 (12 bolts, minSJ 0.570 to 0.611).
 * A refusal is always a `model-partial` with the named code, never a partial mesh; the numbers are measurements
 * of sizes tried, not a guarantee for untried sizes.
 */

export type IsoStep<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** What the caller lends: shared edge samples, mesh access and the trim limits it already uses for planar faces. */
export interface IsoHost {
  readonly shape: Shape;
  readonly edgeSamples: (edge: number) => IsoStep<readonly number[]>;
  readonly position: (id: number) => P3;
  /** Mesh id of a B-rep vertex (a pole). */
  readonly vertex: (v: number) => number;
  readonly addVertex: (p: P3) => number;
  readonly limits: {
    readonly angle: number;
    readonly maxPoints: number;
    readonly maxTriangles: number;
  };
}

export interface IsoFace {
  readonly quads: readonly (readonly number[])[];
  /** Pole (apex) triangles of a sphere or cone; empty for every other surface. */
  readonly triangles: readonly (readonly number[])[];
  /** The first this many quads are the boundary rows. */
  readonly rowQuads: number;
}

const FLAT: Surface = {
  kind: 'plane',
  frame: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
};

interface Ring {
  readonly ids: number[];
  readonly uv: P2[];
  /** Sample count of each coedge in loop order. */
  readonly sides: number[];
}

/** How a degenerate (pole) edge is sampled: `count` copies of the pole vertex along its collapsed span. */
interface Pole {
  readonly count: number;
  readonly vertex: (v: number) => number;
}

/** Which parameter directions wrap; a plane wraps in neither, so its samples are never shifted by whole turns. */
interface Period {
  readonly u: boolean;
  readonly v: boolean;
}

/** One loop as shared mesh ids with the (u, v) of each sample, u unwrapped along the loop. */
function loopRing(
  shape: Shape,
  sample: (edge: number) => IsoStep<readonly number[]>,
  loop: readonly number[],
  period: Period,
  pole?: Pole,
): IsoStep<Ring> {
  const ids: number[] = [];
  const uv: P2[] = [];
  const sides: number[] = [];
  let prevU: number | undefined;
  let prevV: number | undefined;
  for (const c of loop) {
    const co = shape.coedges[c] as Coedge;
    const e = shape.edges[co.edge] as Edge;
    let ends: readonly number[];
    if (e.curve < 0) {
      if (pole === undefined) return err('iso-degenerate-edge');
      ends = new Array<number>(pole.count + 1).fill(pole.vertex(e.v0));
    } else {
      const sampled = sample(co.edge);
      if (!sampled.ok) return sampled;
      ends = sampled.value;
    }
    const n = ends.length - 1;

    const points: P2[] = [];
    const edgeIds: number[] = [];
    for (let k = 0; k < n; k++) {
      const i = co.reversed ? n - k : k;
      points.push(pcurvePoint(co.pcurve, e.t0 + ((e.t1 - e.t0) * i) / n));
      edgeIds.push(ends[i] as number);
    }
    const first = points[0] as P2;
    const shift =
      !period.u || prevU === undefined ? 0 : TWO_PI * Math.round((prevU - first[0]) / TWO_PI);
    const lap =
      !period.v || prevV === undefined ? 0 : TWO_PI * Math.round((prevV - first[1]) / TWO_PI);
    for (const p of points) uv.push([p[0] + shift, p[1] + lap]);
    pushAll(ids, edgeIds);
    sides.push(n);
    prevU = (uv[uv.length - 1] as P2)[0];
    prevV = (uv[uv.length - 1] as P2)[1];
  }
  return ok({ ids, uv, sides });
}

function bounds(uv: readonly P2[]): { lo: P2; hi: P2 } {
  let lo: P2 = [Infinity, Infinity];
  let hi: P2 = [-Infinity, -Infinity];
  for (const p of uv) {
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])];
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])];
  }
  return { lo, hi };
}

/** A hole loop lies inside the outer loop's range after whole turns; none fitting means it straddles a seam. */
function holeInside(outer: Ring, hole: Ring, period: Period): IsoStep<Ring> {
  const box = bounds(outer.uv);
  const mine = bounds(hole.uv);
  for (const turnU of period.u ? [0, -1, 1] : [0]) {
    for (const turnV of period.v ? [0, -1, 1] : [0]) {
      const du = TWO_PI * turnU;
      const dv = TWO_PI * turnV;
      const inV = !period.v || (mine.lo[1] + dv >= box.lo[1] && mine.hi[1] + dv <= box.hi[1]);
      if (inV && mine.lo[0] + du >= box.lo[0] && mine.hi[0] + du <= box.hi[0]) {
        return ok({
          ids: hole.ids,
          uv: hole.uv.map((p): P2 => [p[0] + du, p[1] + dv]),
          sides: hole.sides,
        });
      }
    }
  }
  return err('iso-hole-crosses-seam');
}

const AXIS_TOL = 1e-6;

interface Grid {
  readonly xs: number[];
  readonly ys: number[];
  /** Mesh id of each boundary grid point, `ids[i][j]`; interior points are minted on demand. */
  readonly ids: (number | undefined)[][];
  /** A circular outer loop: the cells inside its lattice path are the grid, the strip to the loop is a ring. */
  readonly disc?: DiscGrid;
}

function signedArea(uv: readonly P2[]): number {
  let a = 0;
  for (let k = 0; k < uv.length; k++) {
    const p = uv[k] as P2;
    const q = uv[(k + 1) % uv.length] as P2;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Reverses the loop direction but keeps its first sample, so the first corner stays the first corner. */
function oriented(ring: Ring, positive: boolean): Ring {
  if (signedArea(ring.uv) > 0 === positive) return ring;
  const n = ring.ids.length;
  const flip = <T>(items: readonly T[]): T[] => items.map((_, k) => items[(n - k) % n] as T);
  return { ids: flip(ring.ids), uv: flip(ring.uv), sides: [...ring.sides].reverse() };
}

function axisIndex(axis: readonly number[], value: number): number {
  for (let k = 0; k < axis.length; k++)
    if (Math.abs((axis[k] as number) - value) <= AXIS_TOL) return k;
  return -1;
}

/** The developed outer loop as a grid: its bottom and left samples are the axes, every loop sample must sit on both. */
function gridOfRing(ring: Ring): IsoStep<Grid> {
  const b = bounds(ring.uv);
  const on = (a: number, c: number): boolean => Math.abs(a - c) <= AXIS_TOL;
  const xs = ring.uv
    .filter((p) => on(p[1], b.lo[1]))
    .map((p) => p[0])
    .sort((p, q) => p - q);
  const ys = ring.uv
    .filter((p) => on(p[0], b.lo[0]))
    .map((p) => p[1])
    .sort((p, q) => p - q);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  if (nx < 1 || ny < 1 || ring.uv.length !== 2 * (nx + ny)) return err('iso-outer-not-rectangle');
  const ids: (number | undefined)[][] = xs.map(() => ys.map(() => undefined));
  for (let k = 0; k < ring.uv.length; k++) {
    const p = ring.uv[k] as P2;
    const i = axisIndex(xs, p[0]);
    const j = axisIndex(ys, p[1]);
    const edge = on(p[0], b.lo[0]) || on(p[0], b.hi[0]) || on(p[1], b.lo[1]) || on(p[1], b.hi[1]);
    if (i < 0 || j < 0 || !edge) return err('iso-outer-not-rectangle');
    (ids[i] as (number | undefined)[])[j] = ring.ids[k];
  }
  return ok({ xs, ys, ids });
}

const CIRCLE_TOL = 1e-6;
/** Cells of disc between a hole block and the staircase, so the shear of the outer strip never meets a hole strip. */
const DISC_CLEARANCE = 1;

/** The grid of an outer loop: its own rectangle, or the lattice disc of a lone circle with holes to carry. */
function gridOfOuter(ring: Ring, holed: boolean): IsoStep<Grid> {
  const rect = gridOfRing(ring);
  if (rect.ok || !holed || ring.sides.length !== 1) return rect;
  const n = ring.uv.length;
  let cx = 0;
  let cy = 0;
  for (const p of ring.uv) {
    cx += p[0] / n;
    cy += p[1] / n;
  }
  const radii = ring.uv.map((p) => distance(p, [cx, cy]));
  const radius = radii.reduce((a, b) => a + b, 0) / n;
  if (radii.some((r) => Math.abs(r - radius) > CIRCLE_TOL * radius)) return rect;
  const disc = discGrid(ring.uv, [cx, cy], radius);
  if (!disc.ok) return disc;
  const { xs, ys } = disc.value;
  return ok({ xs, ys, ids: xs.map(() => ys.map(() => undefined)), disc: disc.value });
}

const LIFT_GUARD = 1e-12;

/**
 * The plane a face is laid out in: (u, v) scaled by the metric at the holes, x = sx u and y = sy v. Exactly isometric
 * for a cylinder; for a torus the u scale is the tube circumference radius at the holes, so rows meet the hole
 * boundary at right angles there and stretch smoothly away from it.
 */
interface Chart {
  readonly surface: Surface;
  readonly sx: number;
  readonly sy: number;
  /**
   * An angle-preserving re-parameterisation of the chart plane for the hole annulus, where a plane right angle must
   * stay a surface right angle however the metric varies across the hole; `from` inverts `to`.
   */
  readonly conformal?: { readonly to: (p: P2) => P2; readonly from: (p: P2) => P2 };
}

function lift(chart: Chart, x: number, y: number): P3 {
  return surfacePoint(chart.surface, x / chart.sx, y / chart.sy);
}

/** Grid cells [i0, i1) x [j0, j1) carved out around one hole; its perimeter carries 2 (ci + cj) grid points. */
interface Block {
  readonly i0: number;
  readonly i1: number;
  readonly j0: number;
  readonly j1: number;
}

const BLOCK_MARGIN = 1;

const perimeterOf = (b: Block): number => 2 * (b.i1 - b.i0 + (b.j1 - b.j0));

/** Largest axis index at or below `value`, smallest at or above it. */
function cellBelow(axis: readonly number[], value: number): number {
  let k = 0;
  while (k + 1 < axis.length && (axis[k + 1] as number) <= value + AXIS_TOL) k++;
  return k;
}
function cellAbove(axis: readonly number[], value: number): number {
  let k = axis.length - 1;
  while (k > 0 && (axis[k - 1] as number) >= value - AXIS_TOL) k--;
  return k;
}

const roomy = (b: Block, grid: Pick<Grid, 'xs' | 'ys' | 'disc'>): boolean => {
  if (b.i0 < 0 || b.j0 < 0 || b.i1 > grid.xs.length - 1 || b.j1 > grid.ys.length - 1) return false;
  const disc = grid.disc;
  if (disc === undefined) return true;
  for (let i = b.i0 - DISC_CLEARANCE; i < b.i1 + DISC_CLEARANCE; i++)
    for (let j = b.j0 - DISC_CLEARANCE; j < b.j1 + DISC_CLEARANCE; j++)
      if (!disc.inside(i, j)) return false;
  return true;
};

/**
 * The block around a hole: its bounding box grown by a margin, then widened one cell at a time until the perimeter
 * holds exactly `count` points. Without a count, the smallest block, which is the sample count the hole needs.
 */
function holeBlock(grid: Grid, hole: Ring, count?: number): IsoStep<Block> {
  const { xs, ys } = grid;
  const box = bounds(hole.uv);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  let b: Block = {
    i0: Math.max(0, cellBelow(xs, box.lo[0]) - BLOCK_MARGIN),
    i1: Math.min(nx, cellAbove(xs, box.hi[0]) + BLOCK_MARGIN),
    j0: Math.max(0, cellBelow(ys, box.lo[1]) - BLOCK_MARGIN),
    j1: Math.min(ny, cellAbove(ys, box.hi[1]) + BLOCK_MARGIN),
  };
  if (!roomy(b, grid)) return err('iso-hole-no-room');
  if (count === undefined) return ok(b);
  const extra = count - perimeterOf(b);
  if (extra < 0) return err('iso-hole-count-short');
  if (extra % 2 !== 0) return err('iso-hole-count-odd');
  for (let k = 0; k < extra / 2; k++) {
    const grown: Block[] = [
      { ...b, j1: b.j1 + 1 },
      { ...b, i1: b.i1 + 1 },
      { ...b, j0: b.j0 - 1 },
      { ...b, i0: b.i0 - 1 },
    ];
    const next = grown
      .slice(k % 4)
      .concat(grown.slice(0, k % 4))
      .find((g) => roomy(g, grid));
    if (next === undefined) return err('iso-hole-no-room');
    b = next;
  }
  return ok(b);
}

/** Grid points of the block perimeter, clockwise from the lower-left corner (the direction hole loops run). */
function perimeter(b: Block): [number, number][] {
  const out: [number, number][] = [];
  for (let j = b.j0; j < b.j1; j++) out.push([b.i0, j]);
  for (let i = b.i0; i < b.i1; i++) out.push([i, b.j1]);
  for (let j = b.j1; j > b.j0; j--) out.push([b.i1, j]);
  for (let i = b.i1; i > b.i0; i--) out.push([i, b.j0]);
  return out;
}

/** The boundary row sits this fraction of the local sample spacing off the hole: shallower raises the strip's worst angle, deeper thins the cells. */
const ROW_DEPTH = 0.3;

const distance = (a: P2, b: P2): number =>
  Math.sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]));

/** Smallest corner sine of a quad in the chart: 1 for a rectangle, 0 at a degenerate or inverted corner. */
function cornerSine(q: readonly P2[]): number {
  let least = 1;
  for (let k = 0; k < 4; k++) {
    const a = q[k] as P2;
    const b = q[(k + 1) % 4] as P2;
    const c = q[(k + 3) % 4] as P2;
    const u: P2 = [b[0] - a[0], b[1] - a[1]];
    const v: P2 = [c[0] - a[0], c[1] - a[1]];
    least = Math.min(least, (u[0] * v[1] - u[1] * v[0]) / (distance(a, b) * distance(a, c)));
  }
  return least;
}

/**
 * Strip cells below this corner sine are refused: the charts of the curved faces are conformal, so the chart sine is
 * the surface scaled Jacobian, and a hole whose strip cannot reach it (a cone hole close to the apex, a torus hole far
 * off the crest) gets a named failure instead of a sliver quad.
 */
const STRIP_MIN_SINE = 0.3;

/**
 * Where the blend layers sit between the boundary row (0) and the block perimeter (1). The tangential cell size grows
 * linearly from the hole's sample spacing `near` to the perimeter's `far`, so the layer thickness follows it: each
 * layer is `q` times the last, q = 1 + (far - near) / gap, which keeps the cells near square all the way out. The last
 * fraction is always 1.
 */
function gradedFractions(gap: number, near: number, far: number): number[] {
  if (!(far > near * 1.05)) {
    const layers = Math.max(1, Math.round(gap / far));
    return Array.from({ length: layers }, (_, l) => (l + 1) / layers);
  }
  const q = 1 + (far - near) / gap;
  const layers = Math.max(1, Math.round(log(far / near) / log(q)));
  const reach: number[] = [];
  let step = 1;
  let sum = 0;
  for (let l = 0; l < layers; l++) {
    sum += step;
    reach.push(sum);
    step *= q;
  }
  return reach.map((r, l) => (l + 1 === layers ? 1 : r / sum));
}

const RELAX_WEIGHT = 0.5;

/** One Laplacian pass over the blend layers between the boundary row and the block perimeter (both stay fixed). */
function relaxLayers(uvs: P2[][]): void {
  const n = (uvs[0] as P2[]).length;
  const snapshot = uvs.map((layer) => layer.slice());
  for (let l = 2; l + 1 < uvs.length; l++) {
    const mid = snapshot[l] as P2[];
    const lo = snapshot[l - 1] as P2[];
    const hi = snapshot[l + 1] as P2[];
    uvs[l] = mid.map((p, k): P2 => {
      const a = mid[(k + n - 1) % n] as P2;
      const b = mid[(k + 1) % n] as P2;
      const c = lo[k] as P2;
      const d = hi[k] as P2;
      return [
        p[0] + RELAX_WEIGHT * ((a[0] + b[0] + c[0] + d[0]) / 4 - p[0]),
        p[1] + RELAX_WEIGHT * ((a[1] + b[1] + c[1] + d[1]) / 4 - p[1]),
      ];
    });
  }
}

/**
 * The annulus between a hole and its block as an O-grid: the hole's samples pair one for one with the block
 * perimeter's grid points, the first layer is the boundary row (offset along the hole's inward normal, so its rungs
 * leave the boundary at right angles), and the remaining layers blend that row into the perimeter. Every interior
 * point has four edges; the four block corners are the only irregular points.
 */
function holeStrip(
  chart: Chart,
  addVertex: (p: P3) => number,
  hole: Ring,
  ring: readonly (readonly [number, number])[],
  xs: readonly number[],
  ys: readonly number[],
  at: (i: number, j: number) => number,
  paired = false,
  smooth?: (layers: P2[][]) => void,
): IsoStep<{ rows: number[][]; rest: number[][] }> {
  const n = hole.ids.length;
  if (ring.length !== n) return err('iso-hole-count-short');
  const to = chart.conformal?.to ?? ((p: P2): P2 => p);
  const from = chart.conformal?.from ?? ((p: P2): P2 => p);
  const mint = (p: P2): number => {
    const q = from(p);
    return addVertex(lift(chart, q[0], q[1]));
  };
  const pos = ring.map(([i, j]): P2 => to([xs[i] as number, ys[j] as number]));
  const inner = hole.uv.map(to);
  let shift = 0;
  let best = paired ? 0 : Infinity;
  for (let s = 0; s < n && !paired; s++) {
    let cost = 0;
    for (let k = 0; k < n; k++) {
      const d = distance(inner[k] as P2, pos[(k + s) % n] as P2);
      cost += d * d;
    }
    if (cost < best) {
      best = cost;
      shift = s;
    }
  }
  const target = (k: number): number => (k + shift) % n;

  const first: P2[] = inner.map((p, k) => {
    const prev = inner[(k + n - 1) % n] as P2;
    const next = inner[(k + 1) % n] as P2;
    const t: P2 = [next[0] - prev[0], next[1] - prev[1]];
    const len = distance(next, prev);
    const h = (distance(p, prev) + distance(p, next)) / 2;
    return [p[0] - (t[1] / len) * ROW_DEPTH * h, p[1] + (t[0] / len) * ROW_DEPTH * h];
  });
  let gap = 0;
  for (let k = 0; k < n; k++) gap = Math.max(gap, distance(first[k] as P2, pos[target(k)] as P2));
  let ring0 = 0;
  for (let k = 0; k < n; k++) ring0 += distance(inner[k] as P2, inner[(k + 1) % n] as P2);
  const along = ring0 / n;
  let outside = 0;
  for (let k = 0; k < n; k++) outside += distance(pos[k] as P2, pos[(k + 1) % n] as P2);
  const fractions = gradedFractions(gap, along, outside / n);

  const uvs: P2[][] = [inner, first];
  for (const t of fractions) {
    uvs.push(
      first.map((p, k): P2 => {
        const q = pos[target(k)] as P2;
        return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      }),
    );
  }
  if (smooth === undefined) relaxLayers(uvs);
  else smooth(uvs);
  const layers: { uv: P2[]; ids: number[] }[] = uvs.map((uv, l) => {
    if (l === 0) return { uv, ids: hole.ids };
    if (l < uvs.length - 1) return { uv, ids: uv.map(mint) };
    return {
      uv,
      ids: uv.map((_, k) => {
        const [i, j] = ring[target(k)] as readonly [number, number];
        return at(i, j);
      }),
    };
  });
  const rows: number[][] = [];
  const rest: number[][] = [];
  for (let l = 0; l + 1 < layers.length; l++) {
    const lo = layers[l] as { uv: P2[]; ids: number[] };
    const hi = layers[l + 1] as { uv: P2[]; ids: number[] };
    for (let k = 0; k < n; k++) {
      const m = (k + 1) % n;
      const corners = [lo.uv[k], lo.uv[m], hi.uv[m], hi.uv[k]] as P2[];
      const sine = cornerSine(corners);
      if (!(sine > LIFT_GUARD)) return err('iso-strip-folded');
      if (sine < STRIP_MIN_SINE) return err('iso-strip-distorted');
      (l === 0 ? rows : rest).push([
        lo.ids[k] as number,
        lo.ids[m] as number,
        hi.ids[m] as number,
        hi.ids[k] as number,
      ]);
    }
  }
  return ok({ rows, rest });
}

interface Layout {
  readonly chart: Chart;
  readonly outer: Ring;
  readonly holes: Ring[];
  readonly grid: IsoStep<Grid>;
}

/** The Mercator ordinate of a latitude and its inverse (the Gudermannian). */
const mercator = (v: number): number => log(tan(Math.PI / 4 + v / 2));
const gudermannian = (t: number): number => 2 * atan(exp(t)) - Math.PI / 2;

/** Laid-out kinds: the plane is its own chart, the cylinder is isometric to it, the others are metric-scaled at their holes. */
type LaidSurface = Extract<Surface, { kind: 'plane' | 'cylinder' | 'torus' | 'sphere' | 'cone' }>;

const isLaid = (surface: Surface): surface is LaidSurface =>
  surface.kind === 'plane' ||
  surface.kind === 'cylinder' ||
  surface.kind === 'torus' ||
  surface.kind === 'sphere' ||
  surface.kind === 'cone';

const MIN_LATITUDE_SCALE = 0.2;

/**
 * A cone is developed with u scaled by the circumference radius at the holes and v by arc length along the generatrix.
 * The annulus works in the conformal log chart (u sin a, ln rho), rho the distance to the apex, so its rows stay
 * orthogonal however the radius changes across the hole. Holes reaching toward the apex fail closed.
 */
function coneChart(
  surface: Extract<Surface, { kind: 'cone' }>,
  holes: readonly Ring[],
): IsoStep<Chart> {
  const sinHalf = sin(surface.halfAngle);
  const slope = Math.abs(sinHalf);
  if (!(slope > AXIS_TOL)) return err('iso-surface-not-developable');
  const radiusAt = (v: number): number => surface.radius + v * sinHalf;
  let sum = 0;
  let count = 0;
  let least = Number.POSITIVE_INFINITY;
  for (const hole of holes) {
    for (const p of hole.uv) {
      const radius = radiusAt(p[1]);
      sum += radius;
      least = Math.min(least, radius);
      count++;
    }
  }
  const mean = sum / count;
  if (!(least > MIN_LATITUDE_SCALE * mean)) return err('iso-hole-near-pole');
  const rho = mean / slope;
  const toward = sinHalf < 0 ? -1 : 1;
  return ok({
    surface,
    sx: mean,
    sy: 1,
    conformal: {
      to: (p) => [p[0], toward * rho * log(radiusAt(p[1]) / slope)],
      from: (p) => [p[0], (slope * exp((toward * p[1]) / rho) - surface.radius) / sinHalf],
    },
  });
}

function chartOf(surface: LaidSurface, holes: readonly Ring[]): IsoStep<Chart> {
  if (surface.kind === 'plane') return ok({ surface, sx: 1, sy: 1 });
  if (surface.kind === 'cylinder') return ok({ surface, sx: surface.radius, sy: 1 });
  if (surface.kind === 'cone') return coneChart(surface, holes);
  let sum = 0;
  let count = 0;
  for (const hole of holes) {
    for (const p of hole.uv) {
      sum += cos(p[1]);
      count++;
    }
  }
  const mean = sum / count;
  if (surface.kind === 'sphere') {
    if (!(mean > MIN_LATITUDE_SCALE)) return err('iso-hole-near-pole');
    const r = surface.radius;
    return ok({
      surface,
      sx: r * mean,
      sy: r,
      conformal: {
        to: (p) => [p[0], r * mean * mercator(p[1] / r)],
        from: (p) => [p[0], r * gudermannian(p[1] / (r * mean))],
      },
    });
  }
  const { major: R, minor: r } = surface;
  const k = Math.sqrt((R - r) / (R + r));
  const scale = 2 / Math.sqrt(R * R - r * r);
  const m = R + r * mean;
  return ok({
    surface,
    sx: m,
    sy: r,
    conformal: {
      to: (p) => {
        const v = p[1] / r;
        const turn = Math.round(v / TWO_PI);
        return [p[0], m * r * scale * (atan(k * tan((v - TWO_PI * turn) / 2)) + Math.PI * turn)];
      },
      from: (p) => {
        const t = p[1] / (m * r * scale);
        const turn = Math.round(t / Math.PI);
        return [p[0], r * (2 * atan(tan(t - Math.PI * turn) / k) + TWO_PI * turn)];
      },
    },
  });
}

/**
 * Samples per pole edge of a loop. A pole row opposite a parallel of the same u span (a cone apex over its base) takes
 * that parallel's count so the outer loop stays a rectangle. Otherwise (a sphere) the pole row spans the same chart
 * width as the cells beside it are tall, so the cells next to a pole are as wide as the meridian samples are long.
 * 0 when the loop has no pole edge.
 */
function poleCount(
  shape: Shape,
  sample: (edge: number) => IsoStep<readonly number[]>,
  loop: readonly number[],
  chart: Chart,
): IsoStep<number> {
  const coedges = loop.map((c) => shape.coedges[c] as Coedge);
  const poles = coedges.filter((co) => (shape.edges[co.edge] as Edge).curve < 0);
  if (poles.length === 0) return ok(0);
  let height: number | undefined;
  for (const co of coedges) {
    const e = shape.edges[co.edge] as Edge;
    if (e.curve < 0) continue;
    const a = pcurvePoint(co.pcurve, e.t0);
    const b = pcurvePoint(co.pcurve, e.t1);
    if (Math.abs(a[0] - b[0]) > AXIS_TOL || Math.abs(a[1] - b[1]) <= AXIS_TOL) continue;
    const sampled = sample(co.edge);
    if (!sampled.ok) return sampled;
    height = (chart.sy * Math.abs(b[1] - a[1])) / (sampled.value.length - 1);
    break;
  }
  const pole = poles[0] as Coedge;
  const e = shape.edges[pole.edge] as Edge;
  const span = Math.abs(pcurvePoint(pole.pcurve, e.t1)[0] - pcurvePoint(pole.pcurve, e.t0)[0]);
  for (const co of coedges) {
    const other = shape.edges[co.edge] as Edge;
    if (other.curve < 0) continue;
    const a = pcurvePoint(co.pcurve, other.t0);
    const b = pcurvePoint(co.pcurve, other.t1);
    if (Math.abs(a[1] - b[1]) > AXIS_TOL || Math.abs(Math.abs(b[0] - a[0]) - span) > AXIS_TOL)
      continue;
    const sampled = sample(co.edge);
    if (!sampled.ok) return sampled;
    return ok(sampled.value.length - 1);
  }
  const width =
    chart.sx * Math.abs(pcurvePoint(pole.pcurve, e.t1)[0] - pcurvePoint(pole.pcurve, e.t0)[0]);
  if (height === undefined || width <= AXIS_TOL) return err('iso-pole-no-meridian');
  return ok(Math.max(3, Math.round(width / height)));
}

/** The developed loops of a face: outer positively oriented, holes inside it and negatively oriented. */
function layoutOf(
  shape: Shape,
  f: number,
  surface: LaidSurface,
  sample: (edge: number) => IsoStep<readonly number[]>,
  vertex: (v: number) => number,
): IsoStep<Layout> {
  const { outer, holes } = faceLoops(shape, f);
  const domain = surfaceDomain(surface);
  const period: Period = { u: domain.uPeriod > 0, v: domain.vPeriod > 0 };
  const loops: Ring[] = [];
  for (const loop of holes) {
    const ring = loopRing(shape, sample, loop, period);
    if (!ring.ok) return ring;
    loops.push(ring.value);
  }
  const made = chartOf(surface, loops);
  if (!made.ok) return made;
  const chart = made.value;
  const poles = poleCount(shape, sample, outer, chart);
  if (!poles.ok) return poles;
  const outerLoop = loopRing(shape, sample, outer, period, { count: poles.value, vertex });
  if (!outerLoop.ok) return outerLoop;
  const first = oriented(outerLoop.value, true);
  const placedHoles: Ring[] = [];
  for (const hole of loops) {
    const placed = holeInside(first, hole, period);
    if (!placed.ok) return placed;
    placedHoles.push(placed.value);
  }
  const developed = (ring: Ring): Ring => ({
    ids: ring.ids,
    uv: ring.uv.map((p): P2 => [chart.sx * p[0], chart.sy * p[1]]),
    sides: ring.sides,
  });
  const outerRing = developed(first);
  return ok({
    chart,
    outer: outerRing,
    holes: placedHoles.map((hole) => oriented(developed(hole), false)),
    grid: gridOfOuter(outerRing, placedHoles.length > 0),
  });
}

/**
 * Edge floors that give each hole the samples its block perimeter needs, from the counts solved so far. The caller
 * re-solves with them until none remain; a face whose layout fails here reports its own reason when meshed.
 */
export function isoHoleRaises(
  shape: Shape,
  counts: ReadonlyMap<number, number>,
): Map<number, number> {
  const raises = new Map<number, number>();
  shape.faces.forEach((face, f) => {
    const surface = shape.surfaces[face.surface] as Surface;
    if (!isLaid(surface) || faceLoops(shape, f).holes.length === 0) return;
    const planned = layoutOf(
      shape,
      f,
      surface,
      (e) => ok(new Array<number>((counts.get(e) ?? 0) + 1).fill(0)),
      () => 0,
    );
    if (!planned.ok || !planned.value.grid.ok) return;
    for (const [k, loop] of faceLoops(shape, f).holes.entries()) {
      const hole = planned.value.holes[k] as Ring;
      const block = holeBlock(planned.value.grid.value, hole);
      if (!block.ok) continue;
      let have = hole.ids.length;
      const edges = loop.map((c) => (shape.coedges[c] as Coedge).edge);
      const length = new Map<number, number>();
      let from = 0;
      edges.forEach((e, c) => {
        const side = hole.sides[c] as number;
        const pts = hole.uv.slice(from, from + side + 1);
        if (pts.length <= side) pts.push(hole.uv[0] as P2);
        let sum = 0;
        for (let q = 0; q + 1 < pts.length; q++) sum += distance(pts[q] as P2, pts[q + 1] as P2);
        length.set(e, (length.get(e) ?? 0) + sum);
        from += side;
      });
      const need = perimeterOf(block.value);
      while (have < need) {
        let pick = edges[0] as number;
        let worst = -1;
        for (const e of edges) {
          const ratio = (length.get(e) as number) / (raises.get(e) ?? (counts.get(e) as number));
          if (ratio > worst) {
            worst = ratio;
            pick = e;
          }
        }
        raises.set(pick, (raises.get(pick) ?? (counts.get(pick) as number)) + 2);
        have += 2 * edges.filter((e) => e === pick).length;
      }
    }
  });
  return raises;
}

/**
 * Four sides, opposite sides with equal sample counts: a transfinite grid between the sides, so rows and columns
 * follow the boundary samples one for one (a ruled band between a circle and a saddle curve).
 */
function ruledGrid(host: IsoHost, chart: Chart, ring: Ring): IsoStep<IsoFace> | undefined {
  const [a, b, c, d] = ring.sides;
  if (ring.sides.length !== 4 || a !== c || b !== d || a === undefined || b === undefined)
    return undefined;
  const side = (from: number, n: number): P2[] => ring.uv.slice(from, from + n);
  const bottom = side(0, a);
  const right = side(a, b);
  const topReversed = side(a + b, a);
  const leftReversed = side(2 * a + b, b);
  const corner = (k: number): P2 => ring.uv[k % ring.uv.length] as P2;
  const at = (i: number, j: number): P2 => {
    const s = i / a;
    const t = j / b;
    const bot = i < a ? bottom[i] : corner(a);
    const top = i === 0 ? corner(2 * a + b) : (topReversed[a - i] as P2);
    const lef = j === 0 ? corner(0) : (leftReversed[b - j] as P2);
    const rig = j < b ? right[j] : corner(a + b);
    const p = (k: 0 | 1): number =>
      (1 - t) * (bot as P2)[k] +
      t * top[k] +
      (1 - s) * lef[k] +
      s * (rig as P2)[k] -
      ((1 - s) * (1 - t) * corner(0)[k] +
        s * (1 - t) * corner(a)[k] +
        (1 - s) * t * corner(2 * a + b)[k] +
        s * t * corner(a + b)[k]);
    return [p(0), p(1)];
  };
  const id = (i: number, j: number): number => {
    if (j === 0) return i < a ? (ring.ids[i] as number) : (ring.ids[a] as number);
    if (j === b)
      return i === 0 ? (ring.ids[2 * a + b] as number) : (ring.ids[a + b + (a - i)] as number);
    if (i === 0) return ring.ids[2 * a + 2 * b - j] as number;
    if (i === a) return ring.ids[a + j] as number;
    const p = at(i, j);
    return host.addVertex(lift(chart, p[0], p[1]));
  };
  const lattice: number[][] = [];
  for (let i = 0; i <= a; i++) {
    const col: number[] = [];
    for (let j = 0; j <= b; j++) col.push(id(i, j));
    lattice.push(col);
  }
  const quads: number[][] = [];
  for (let i = 0; i < a; i++) {
    for (let j = 0; j < b; j++) {
      const lo = lattice[i] as number[];
      const hi = lattice[i + 1] as number[];
      quads.push([lo[j] as number, hi[j] as number, hi[j + 1] as number, lo[j + 1] as number]);
    }
  }
  return ok({ quads, triangles: [], rowQuads: 0 });
}

/** A holeless face whose outer loop is not a rectangle (a saddle or oblique edge): boundary rows plus a matched interior. */
function trimmedBand(host: IsoHost, chart: Chart, ring: Ring): IsoStep<IsoFace> {
  const dev: P3[] = [];
  const mesh: number[] = [];
  const local: TrimRing = {
    uv: ring.uv,
    ids: ring.ids.map((id, k) => {
      const p = ring.uv[k] as P2;
      dev.push([p[0], p[1], 0]);
      mesh.push(id);
      return dev.length - 1;
    }),
  };
  const built = quadrangulateTrimmed(
    FLAT,
    [local],
    (id) => dev[id] as P3,
    (p) => {
      dev.push(p);
      mesh.push(host.addVertex(lift(chart, p[0], p[1])));
      return dev.length - 1;
    },
    { ...host.limits, rowFront: true },
  );
  if (!built.ok) return err(built.error.reason);
  if (built.value.singles.length > 0) return err('iso-row-front-odd-count');
  return ok({
    quads: built.value.quads.map((q) => q.map((id) => mesh[id] as number)),
    triangles: [],
    rowQuads: built.value.rowQuadCount,
  });
}

/**
 * Opposite-edge pairs of the holeless four-sided faces this layout meshes as a ruled grid: they must share a sample
 * count, the same rule the count owner applies to gridded faces. A seam used twice already agrees with itself.
 */
export function isoOpposingEdgePairs(shape: Shape): [number, number][] {
  const pairs: [number, number][] = [];
  shape.faces.forEach((face, f) => {
    const kind = (shape.surfaces[face.surface] as Surface).kind;
    if (kind !== 'cylinder' && kind !== 'plane') return;
    const { outer, holes } = faceLoops(shape, f);
    // A holed plane is laid out here; a holeless one keeps the count owner's own opposite-side rule.
    if ((kind === 'plane') !== holes.length > 0 || outer.length !== 4 || gridOf(shape, f).ok)
      return;
    const edges = outer.map((c) => (shape.coedges[c] as Coedge).edge);
    for (const [a, b] of [
      [0, 2],
      [1, 3],
    ] as const) {
      if (edges[a] !== edges[b]) pairs.push([edges[a] as number, edges[b] as number]);
    }
  });
  return pairs;
}

/** Outer-loop line edges (and a lone circle) of the holed planes: the far field's boundary, sampled coarser than the holes. */
export function isoFarEdges(shape: Shape): Set<number> {
  const far = new Set<number>();
  const near = new Set<number>();
  shape.faces.forEach((face, f) => {
    const { outer, holes } = faceLoops(shape, f);
    const plane = (shape.surfaces[face.surface] as Surface).kind === 'plane';
    for (const c of holes.flat()) near.add((shape.coedges[c] as Coedge).edge);
    if (!plane || holes.length === 0) return;
    for (const c of outer) {
      const edge = shape.edges[(shape.coedges[c] as Coedge).edge] as Edge;
      const kind = edge.curve >= 0 ? (shape.curves[edge.curve] as Curve).kind : undefined;
      if (kind === 'line' || (kind === 'circle' && outer.length === 1))
        far.add((shape.coedges[c] as Coedge).edge);
    }
  });
  for (const e of near) far.delete(e);
  return far;
}

/**
 * Floors that make the outer rectangle of each holed plane square in samples. A hole needs grid lines on every side of
 * it, which a rectangle sampled two cells across one axis cannot give; the equal counts also keep the cells from
 * stretching. Applied only on the retry after a layout that refused the unequal counts.
 */
export function isoOuterBalance(
  shape: Shape,
  counts: ReadonlyMap<number, number>,
): Map<number, number> {
  const raises = new Map<number, number>();
  shape.faces.forEach((_, f) => {
    const { outer, holes } = faceLoops(shape, f);
    const surface = shape.surfaces[(shape.faces[f] as Face).surface] as Surface;
    if (surface.kind !== 'plane' || holes.length === 0 || outer.length !== 4 || gridOf(shape, f).ok)
      return;
    const edges = outer.map((c) => (shape.coedges[c] as Coedge).edge);
    const widest = maxOf(edges.map((e) => counts.get(e) ?? 0));
    for (const e of edges) if ((counts.get(e) ?? 0) < widest) raises.set(e, widest);
  });
  return raises;
}

export function isoQuadricFace(host: IsoHost, f: number): IsoStep<IsoFace> {
  const { shape } = host;
  const surface = shape.surfaces[(shape.faces[f] as Face).surface] as Surface;
  if (!isLaid(surface)) return err('iso-surface-not-developable');
  if (surface.kind !== 'cylinder' && faceLoops(shape, f).holes.length === 0)
    return err('iso-surface-not-developable');
  const laid = layoutOf(shape, f, surface, host.edgeSamples, host.vertex);
  if (!laid.ok) return laid;
  const { chart, outer: outerRing, holes: holeRings, grid } = laid.value;
  if (!grid.ok) {
    if (holeRings.length > 0) return grid;
    return ruledGrid(host, chart, outerRing) ?? trimmedBand(host, chart, outerRing);
  }
  const { xs, ys, ids, disc } = grid.value;
  const nx = xs.length - 1;
  const ny = ys.length - 1;

  const blocks: Block[] = [];
  for (const hole of holeRings) {
    const block = holeBlock(grid.value, hole, hole.ids.length);
    if (!block.ok) return block;
    for (const other of blocks)
      if (
        block.value.i0 < other.i1 &&
        other.i0 < block.value.i1 &&
        block.value.j0 < other.j1 &&
        other.j0 < block.value.j1
      )
        return err('iso-hole-blocks-overlap');
    blocks.push(block.value);
  }

  const relocated = new Map<number, P2>();
  const at = (i: number, j: number): number => {
    const column = ids[i] as (number | undefined)[];
    const known = column[j];
    if (known !== undefined) return known;
    const moved = relocated.get(i * ys.length + j);
    const made = host.addVertex(
      lift(
        chart,
        moved === undefined ? (xs[i] as number) : moved[0],
        moved === undefined ? (ys[j] as number) : moved[1],
      ),
    );
    column[j] = made;
    return made;
  };
  const rows: number[][] = [];
  const quads: number[][] = [];
  for (const [k, hole] of holeRings.entries()) {
    const strip = holeStrip(chart, host.addVertex, hole, perimeter(blocks[k] as Block), xs, ys, at);
    if (!strip.ok) return strip;
    pushAll(rows, strip.value.rows);
    pushAll(quads, strip.value.rest);
  }
  if (disc !== undefined) {
    const inBlock = (i: number, j: number): boolean =>
      blocks.some((b) => i >= b.i0 && i < b.i1 && j >= b.j0 && j < b.j1);
    const strip = holeStrip(
      chart,
      host.addVertex,
      outerRing,
      disc.path,
      xs,
      ys,
      at,
      true,
      (layers) => {
        for (const [id, p] of smoothDisc(disc, layers, inBlock)) relocated.set(id, p);
      },
    );
    if (!strip.ok) return strip;
    pushAll(rows, strip.value.rows);
    pushAll(quads, strip.value.rest);
  }
  const triangles: number[][] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (disc !== undefined && !disc.inside(i, j)) continue;
      if (blocks.some((b) => i >= b.i0 && i < b.i1 && j >= b.j0 && j < b.j1)) continue;
      const cell = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      const corners = cell.filter((id, k) => id !== cell[(k + 3) % 4]);
      (corners.length === 4 ? quads : triangles).push(corners);
    }
  }
  return ok({ quads: [...rows, ...quads], triangles, rowQuads: rows.length });
}
