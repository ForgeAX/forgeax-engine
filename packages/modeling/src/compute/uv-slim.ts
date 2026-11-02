import { err, ok, type Result } from '@forgeax/engine-types';
import { cos, sin } from '../dmath';
import type { ModelingError } from '../errors';
import { cross, dot, length, normalize, sub, type Tuple3 } from '../geom';
import { trianglesOverlap2d } from '../predicates';
import type { WorkMeter } from './job';
import { leastSquaresCholesky, solveSparse, TripletList } from './sparse';

/** One island in element space: 3D point per element and element triples. */
export interface SlimIsland {
  readonly points: readonly Tuple3[];
  readonly triangles: readonly number[];
  /** The one boundary loop of a disk island (Tutte start); undefined for other topologies. */
  readonly disk: readonly number[] | undefined;
}

export interface SlimResult {
  /** Interleaved per-element UVs, every triangle positively oriented. */
  readonly uv: Float64Array;
  readonly iterations: number;
  /** Symmetric Dirichlet energy over 3D area: 4 is isometric. */
  readonly energy: number;
  /** The start folded, so SLIM ran from a Tutte embedding of the disk. */
  readonly tutte: boolean;
}

const MAX_ITERATIONS = 24;
/** Relative energy decrease below which SLIM stops. */
const CONVERGED = 1e-5;
/** Fraction of the largest flip-free step a line search starts from. */
const STEP_MARGIN = 0.8;
const BACKTRACKS = 30;
/**
 * Relative density-spread growth the gate ignores: rounding only. On 1729 charted islands
 * of real parts no accepted refinement widened the spread at all, and the smallest widening
 * a rejected one proposed was 6.8e-3 for an energy gain below 2e-3 (reference/uv-bake.md).
 */
const DENSITY_SLACK = 1e-9;

/** Per-triangle rest facts: 3D area and the UV-to-Jacobian gradient coefficients. */
export interface Rest {
  readonly area: Float64Array;
  /** Six per triangle: d/dx of corners 0..2, then d/dy. */
  readonly g: Float64Array;
}

/** @internal Rest facts of an island; undefined when it has a degenerate triangle. */
export function restOf(island: SlimIsland): Rest | undefined {
  const tris = island.triangles;
  const count = tris.length / 3;
  const area = new Float64Array(count);
  const g = new Float64Array(6 * count);
  let reach = 0;
  for (const p of island.points)
    reach = Math.max(reach, length(sub(p, island.points[0] as Tuple3)));
  for (let t = 0; t < count; t++) {
    const [p0, p1, p2] = [0, 1, 2].map((j) => island.points[tris[3 * t + j] as number]) as [
      Tuple3,
      Tuple3,
      Tuple3,
    ];
    const e1 = sub(p1, p0);
    const e2 = sub(p2, p0);
    const normal = cross(e1, e2);
    const doubled = length(normal);
    if (!(doubled > 1e-12 * reach * reach)) return undefined;
    const x = normalize(e1);
    const y = normalize(cross(normal, x));
    const [x1, x2, y2] = [length(e1), dot(e2, x), dot(e2, y)];
    const det = x1 * y2;
    // D = inverse of the rest edge matrix [[x1, x2], [0, y2]].
    const [d00, d01, d10, d11] = [y2 / det, -x2 / det, 0, x1 / det];
    area[t] = doubled / 2;
    g.set([-d00 - d10, d00, d10, -d01 - d11, d01, d11], 6 * t);
  }
  return { area, g };
}

/** Jacobian [a b; c d] of triangle t under the interleaved layout x. */
function jacobian(
  rest: Rest,
  tris: readonly number[],
  x: Float64Array,
  t: number,
): [number, number, number, number] {
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  for (let k = 0; k < 3; k++) {
    const e = tris[3 * t + k] as number;
    const gx = rest.g[6 * t + k] as number;
    const gy = rest.g[6 * t + 3 + k] as number;
    const u = x[2 * e] as number;
    const v = x[2 * e + 1] as number;
    a += u * gx;
    b += u * gy;
    c += v * gx;
    d += v * gy;
  }
  return [a, b, c, d];
}

/** Symmetric Dirichlet energy sum A (|J|^2 + |J^-1|^2); Infinity once a triangle folds. */
function energyOf(rest: Rest, tris: readonly number[], x: Float64Array): number {
  let total = 0;
  for (let t = 0; t < rest.area.length; t++) {
    const [a, b, c, d] = jacobian(rest, tris, x, t);
    const det = a * d - b * c;
    if (!(det > 0)) return Infinity;
    const f = a * a + b * b + c * c + d * d;
    total += (rest.area[t] as number) * (f + f / (det * det));
  }
  return total;
}

/** Scale of `x` that gives it the 3D area; undefined when its signed UV area is not positive. */
function areaScale(rest: Rest, tris: readonly number[], x: Float64Array): number | undefined {
  let area3d = 0;
  let areaUv = 0;
  for (let t = 0; t < rest.area.length; t++) {
    const [a, b, c, d] = jacobian(rest, tris, x, t);
    area3d += rest.area[t] as number;
    areaUv += (rest.area[t] as number) * (a * d - b * c);
  }
  return areaUv > 0 ? Math.sqrt(area3d / areaUv) : undefined;
}

/**
 * Symmetric Dirichlet energy per 3D area of a layout at the scale that gives it the
 * island's 3D area (4 is isometric, larger is more stretched or compressed); Infinity
 * when some triangle is flipped or collapsed, or the island has a degenerate triangle.
 */
export function slimEnergy(island: SlimIsland, uv: Float64Array): number {
  const rest = restOf(island);
  if (rest === undefined) return Infinity;
  const k = areaScale(rest, island.triangles, uv);
  if (k === undefined) return Infinity;
  const scaled = uv.map((v) => v * k);
  let area3d = 0;
  for (const a of rest.area) area3d += a;
  return energyOf(rest, island.triangles, scaled) / area3d;
}

/** Largest step along `dir` before some triangle's Jacobian determinant reaches zero. */
function flipFreeStep(rest: Rest, tris: readonly number[], x: Float64Array, dir: Float64Array) {
  let step = Infinity;
  for (let t = 0; t < rest.area.length; t++) {
    const [a, b, c, d] = jacobian(rest, tris, x, t);
    const [p, q, r, s] = jacobian(rest, tris, dir, t);
    const c0 = a * d - b * c;
    const c1 = a * s + p * d - b * r - q * c;
    const c2 = p * s - q * r;
    let root = Infinity;
    if (Math.abs(c2) <= 1e-14 * (Math.abs(c1) + Math.abs(c0))) {
      if (c1 < 0) root = -c0 / c1;
    } else {
      const disc = c1 * c1 - 4 * c2 * c0;
      if (disc >= 0) {
        const h = -(c1 + Math.sign(c1 === 0 ? 1 : c1) * Math.sqrt(disc)) / 2;
        for (const candidate of [h / c2, c0 / h]) {
          if (candidate > 0 && candidate < root) root = candidate;
        }
      }
    }
    step = Math.min(step, root);
  }
  return step;
}

/**
 * @internal One SLIM line search: halve from a margin inside the largest flip-free step
 * along `dir` until the energy drops; undefined when no step lowers it. Bounding the
 * start keeps the whole segment positive, so a step can never pass through a fold.
 */
export function lineSearch(
  rest: Rest,
  tris: readonly number[],
  x: Float64Array,
  dir: Float64Array,
  energy: number,
): { readonly x: Float64Array; readonly energy: number } | undefined {
  let step = Math.min(1, STEP_MARGIN * flipFreeStep(rest, tris, x, dir));
  for (let b = 0; b < BACKTRACKS && step > 0; b++, step /= 2) {
    const candidate = x.map((v, i) => v + step * (dir[i] as number));
    const value = energyOf(rest, tris, candidate);
    if (value < energy) return { x: candidate, energy: value };
  }
  return undefined;
}

function solveLeastSquares(
  system: TripletList,
  rhs: Float64Array,
  work: WorkMeter,
  initial: Float64Array,
): Result<Float64Array | undefined, ModelingError> {
  const matrix = system.toCsr();
  const direct = leastSquaresCholesky(matrix, rhs, work);
  const solved =
    direct ?? solveSparse(matrix, rhs, { method: 'cgls', tolerance: 1e-10 }, work, initial);
  if (solved.ok) return ok(solved.value.x);
  return work.failure === undefined ? ok(undefined) : err(solved.error);
}

/**
 * Tutte embedding of a disk: the boundary loop on a circle by 3D arc length, every
 * interior element at the mean of its neighbors. Flip-free for a disk;
 * undefined when the solve or that guarantee fails.
 */
function tutte(
  island: SlimIsland,
  loop: readonly number[],
  rest: Rest,
  work: WorkMeter,
): Result<Float64Array | undefined, ModelingError> {
  const n = island.points.length;
  const tris = island.triangles;
  const x = new Float64Array(2 * n);
  const fixed = new Uint8Array(n);
  const steps = loop.map((e, i) =>
    length(
      sub(
        island.points[loop[(i + 1) % loop.length] as number] as Tuple3,
        island.points[e] as Tuple3,
      ),
    ),
  );
  const perimeter = steps.reduce((s, v) => s + v, 0);
  if (!(perimeter > 0)) return ok(undefined);
  let run = 0;
  for (const [i, e] of loop.entries()) {
    const angle = (2 * Math.PI * run) / perimeter;
    x[2 * e] = cos(angle);
    x[2 * e + 1] = sin(angle);
    fixed[e] = 1;
    run += steps[i] as number;
  }
  const neighbors: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < tris.length; t += 3) {
    for (let j = 0; j < 3; j++) {
      const a = tris[t + j] as number;
      const b = tris[t + ((j + 1) % 3)] as number;
      (neighbors[a] as Set<number>).add(b);
      (neighbors[b] as Set<number>).add(a);
    }
  }
  const column = new Int32Array(n).fill(-1);
  let free = 0;
  for (let e = 0; e < n; e++) if (fixed[e] === 0) column[e] = free++;
  if (free > 0) {
    if (!work.spend(tris.length * 4)) return err(work.failure as ModelingError);
    const system = new TripletList(2 * free, 2 * free);
    const rhs = new Float64Array(2 * free);
    for (let e = 0; e < n; e++) {
      const c = column[e] as number;
      if (c < 0) continue;
      const around = neighbors[e] as Set<number>;
      system.add(2 * c, 2 * c, around.size);
      system.add(2 * c + 1, 2 * c + 1, around.size);
      for (const o of around) {
        const k = column[o] as number;
        if (k < 0) {
          rhs[2 * c] = (rhs[2 * c] as number) + (x[2 * o] as number);
          rhs[2 * c + 1] = (rhs[2 * c + 1] as number) + (x[2 * o + 1] as number);
        } else {
          system.add(2 * c, 2 * k, -1);
          system.add(2 * c + 1, 2 * k + 1, -1);
        }
      }
    }
    const solved = solveLeastSquares(system, rhs, work, new Float64Array(2 * free));
    if (!solved.ok) return solved;
    if (solved.value === undefined) return ok(undefined);
    for (let e = 0; e < n; e++) {
      const c = column[e] as number;
      if (c < 0) continue;
      x[2 * e] = solved.value[2 * c] as number;
      x[2 * e + 1] = solved.value[2 * c + 1] as number;
    }
  }
  if (energyOf(rest, tris, x) === Infinity) {
    // A clockwise boundary walk: mirror once, then require every triangle positive.
    for (let e = 0; e < n; e++) x[2 * e + 1] = -(x[2 * e + 1] as number);
    if (energyOf(rest, tris, x) === Infinity) return ok(undefined);
  }
  return ok(x);
}

/** sqrt(f'(s) / (2 (s - 1))) for f(s) = s^2 + s^-2: the SLIM weight of a singular value. */
function weight(s: number): number {
  return Math.sqrt(((s + 1) * (s * s + 1)) / (s * s * s));
}

/**
 * SLIM: flip-free minimization of the symmetric Dirichlet
 * energy, which penalizes stretch and compression alike. Each iteration solves the
 * reweighted local/global proxy and line-searches toward it within the largest step
 * that keeps every triangle positive. The start must be flip-free; a folding start of
 * a disk island restarts from its Tutte embedding. Undefined when neither applies or
 * the island has a degenerate triangle.
 */
export function slim(
  island: SlimIsland,
  start: Float64Array,
  work: WorkMeter,
): Result<SlimResult | undefined, ModelingError> {
  const rest = restOf(island);
  if (rest === undefined) return ok(undefined);
  const tris = island.triangles;
  const n = island.points.length;
  let x: Float64Array = start.slice();
  let usedTutte = false;
  if (energyOf(rest, tris, x) === Infinity) {
    if (island.disk === undefined) return ok(undefined);
    const embedded = tutte(island, island.disk, rest, work);
    if (!embedded.ok) return embedded;
    if (embedded.value === undefined) return ok(undefined);
    x = embedded.value;
    usedTutte = true;
  }
  // Scale to the 3D area so the energy compares against isometry.
  let area3d = 0;
  for (const a of rest.area) area3d += a;
  const k = areaScale(rest, tris, x);
  if (k === undefined) return ok(undefined);
  for (let i = 0; i < x.length; i++) x[i] = (x[i] as number) * k;
  const pin = tris[0] as number;
  const column = new Int32Array(n).fill(-1);
  let free = 0;
  for (let e = 0; e < n; e++) if (e !== pin) column[e] = free++;
  let energy = energyOf(rest, tris, x);
  let iterations = 0;
  while (iterations < MAX_ITERATIONS) {
    if (!work.spend(rest.area.length * 48)) return err(work.failure as ModelingError);
    iterations++;
    const system = new TripletList(4 * rest.area.length, 2 * free);
    const rhs = new Float64Array(4 * rest.area.length);
    for (let t = 0; t < rest.area.length; t++) {
      const [a, b, c, d] = jacobian(rest, tris, x, t);
      const e = (a + d) / 2;
      const h = (c - b) / 2;
      const f = (a - d) / 2;
      const gg = (c + b) / 2;
      const q = Math.sqrt(e * e + h * h);
      const r = Math.sqrt(f * f + gg * gg);
      const [s1, s2] = [q + r, q - r];
      // Closest rotation and W = U diag(w) U^T as a spectral function of J J^T.
      const rot = [e / q, -h / q, h / q, e / q] as const;
      const m = [a * a + b * b, a * c + b * d, a * c + b * d, c * c + d * d] as const;
      const [w1, w2] = [weight(s1), weight(s2)];
      const [l1, l2] = [s1 * s1, s2 * s2];
      const W =
        l1 - l2 > 1e-12 * l1
          ? [0, 1, 2, 3].map((i) => {
              const id = i === 0 || i === 3 ? 1 : 0;
              return (
                (w1 * ((m[i] as number) - l2 * id) - w2 * ((m[i] as number) - l1 * id)) / (l1 - l2)
              );
            })
          : [w1, 0, 0, w1];
      const root = Math.sqrt(rest.area[t] as number);
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
          const row = 4 * t + 2 * i + j;
          const wi0 = (W[2 * i] as number) * root;
          const wi1 = (W[2 * i + 1] as number) * root;
          let target = wi0 * (rot[j] as number) + wi1 * (rot[2 + j] as number);
          for (let k3 = 0; k3 < 3; k3++) {
            const el = tris[3 * t + k3] as number;
            const gj = rest.g[6 * t + 3 * j + k3] as number;
            const col = column[el] as number;
            if (col < 0) {
              target -= wi0 * gj * (x[2 * el] as number) + wi1 * gj * (x[2 * el + 1] as number);
              continue;
            }
            system.add(row, 2 * col, wi0 * gj);
            system.add(row, 2 * col + 1, wi1 * gj);
          }
          rhs[row] = target;
        }
      }
    }
    const initial = new Float64Array(2 * free);
    for (let el = 0; el < n; el++) {
      const col = column[el] as number;
      if (col < 0) continue;
      initial[2 * col] = x[2 * el] as number;
      initial[2 * col + 1] = x[2 * el + 1] as number;
    }
    const solved = solveLeastSquares(system, rhs, work, initial);
    if (!solved.ok) return solved;
    if (solved.value === undefined) break;
    const dir = new Float64Array(2 * n);
    for (let el = 0; el < n; el++) {
      const col = column[el] as number;
      if (col < 0) continue;
      dir[2 * el] = (solved.value[2 * col] as number) - (x[2 * el] as number);
      dir[2 * el + 1] = (solved.value[2 * col + 1] as number) - (x[2 * el + 1] as number);
    }
    const next = lineSearch(rest, tris, x, dir, energy);
    if (next === undefined) break;
    const gain = (energy - next.energy) / energy;
    x = next.x;
    energy = next.energy;
    if (gain < CONVERGED) break;
  }
  const final = areaScale(rest, tris, x);
  if (final === undefined) return ok(undefined);
  const uv = x.map((v) => v * final);
  return ok({ uv, iterations, energy: energyOf(rest, tris, uv) / area3d, tutte: usedTutte });
}

/**
 * Pairs of the triangles (element triples over interleaved `uv`) that overlap with
 * positive area, by a sweep over u extents and the exact predicates; a clockwise
 * triangle is read in its flipped order and a collapsed one has no area to overlap.
 */
export function overlapPairs(triangles: readonly number[], uv: Float64Array): number {
  interface Box {
    readonly lo: number;
    readonly hi: number;
    readonly ylo: number;
    readonly yhi: number;
    readonly p: number[][];
  }
  const boxes: Box[] = [];
  for (let t = 0; t < triangles.length; t += 3) {
    const ids = [0, 1, 2].map((j) => triangles[t + j] as number);
    const p = ids.map((e) => [uv[2 * e] as number, uv[2 * e + 1] as number]);
    const [a, b, c] = p as [number[], number[], number[]];
    const turn =
      ((b[0] as number) - (a[0] as number)) * ((c[1] as number) - (a[1] as number)) -
      ((c[0] as number) - (a[0] as number)) * ((b[1] as number) - (a[1] as number));
    if (turn === 0 || Number.isNaN(turn)) continue;
    const ccw = turn > 0 ? p : [a, c, b];
    const xs = ccw.map((q) => q[0] as number);
    const ys = ccw.map((q) => q[1] as number);
    boxes.push({
      lo: Math.min(...xs),
      hi: Math.max(...xs),
      ylo: Math.min(...ys),
      yhi: Math.max(...ys),
      p: ccw,
    });
  }
  boxes.sort((a, b) => a.lo - b.lo);
  let pairs = 0;
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i] as Box;
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j] as Box;
      if (b.lo >= a.hi) break;
      if (b.ylo >= a.yhi || a.ylo >= b.yhi) continue;
      if (trianglesOverlap2d(a.p, b.p)) pairs++;
    }
  }
  return pairs;
}

/** What the gate looks at in one layout of an island. */
export interface LayoutFacts {
  /** Symmetric Dirichlet energy per 3D area (Infinity when folded). */
  readonly energy: number;
  /** Flipped plus zero-area triangles. */
  readonly flipped: number;
  /** Overlapping triangle pairs. */
  readonly overlaps: number;
  /** Largest per-triangle relative-area distortion (the texel density spread, >= 1). */
  readonly areaDistortion: number;
}

export type RefineVerdict = 'accepted' | 'flipped' | 'no-gain' | 'overlap' | 'density';

/**
 * Whether a refined layout replaces the start: it must be flip-free, lower the
 * symmetric Dirichlet energy, overlap no more than the start did, and not widen the
 * texel density spread (the largest area distortion), so refinement can only improve
 * the island on every measure the unwrap reports.
 */
export function acceptRefinement(before: LayoutFacts, after: LayoutFacts): RefineVerdict {
  if (after.flipped > 0) return 'flipped';
  if (!(after.energy < before.energy)) return 'no-gain';
  if (after.overlaps > before.overlaps) return 'overlap';
  if (after.areaDistortion > before.areaDistortion * (1 + DENSITY_SLACK)) return 'density';
  return 'accepted';
}
