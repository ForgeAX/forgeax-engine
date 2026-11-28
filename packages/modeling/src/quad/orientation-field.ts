// Extrinsic 4-RoSy orientation solve for Instant Meshes (Jakob et al. 2015, optimize_orientations).
// Each level runs Gauss-Seidel sweeps over its vertices in index order. A vertex takes the weighted
// average of its neighbours' directions after the extrinsic compat rotation, then the constraint
// pull (CQ), then projects back into its tangent plane. Each coarse solution seeds the next finer
// level through the finer-to-coarser map.

import type { Hierarchy, Level } from './hierarchy';

type V3 = [number, number, number];

const RCP_OVERFLOW = 1e-30;

export interface OrientationConstraint {
  /** Constraint direction per vertex, 3 numbers per vertex (unit, tangent). */
  readonly direction: Float64Array;
  /** Per-vertex blend weight in [0, 1]; 0 leaves the vertex unconstrained. */
  readonly weight: Float64Array;
}

export interface OrientationOptions {
  /** Gauss-Seidel sweeps per level (Instant Meshes default 6). */
  readonly iterations: number;
  /** Applied on the finest level only, as the reference does for CQ. */
  readonly constraint?: OrientationConstraint;
}

export interface OrientationResult {
  /** Unit direction per finest-level vertex, 3 numbers per vertex. */
  readonly direction: Float64Array;
  /** Mean (1 - |dot|) between the last two sweeps on the finest level; 0 when converged. */
  readonly residual: number;
  /** Unit direction per vertex for every hierarchy level, finest first (levels[0] is level 0). */
  readonly levels: readonly Float64Array[];
}

function at(v: Float64Array, i: number): V3 {
  return [v[3 * i] as number, v[3 * i + 1] as number, v[3 * i + 2] as number];
}

function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function scale(a: V3, s: number): V3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function add(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** Projects q onto the tangent plane of n (removing the normal component), then normalizes. */
function tangentUnit(q: V3, n: V3): V3 {
  const r = sub(q, scale(n, dot(n, q)));
  const l = Math.sqrt(dot(r, r));
  return l > RCP_OVERFLOW ? scale(r, 1 / l) : r;
}

/**
 * Extrinsic 4-RoSy compat (compat_orientation_extrinsic_4): the best-matching pair among the two
 * tangent axes of each side, with the second representative flipped to agree with the first.
 */
function compatExtrinsic(q0: V3, n0: V3, q1: V3, n1: V3): [V3, V3] {
  const A: [V3, V3] = [q0, cross(n0, q0)];
  const B: [V3, V3] = [q1, cross(n1, q1)];
  let best = -Infinity;
  let ba: V3 = A[0];
  let bb: V3 = B[0];
  for (const a of A)
    for (const b of B) {
      const score = Math.abs(dot(a, b));
      if (score > best) {
        best = score;
        ba = a;
        bb = b;
      }
    }
  const s = dot(ba, bb) < 0 ? -1 : 1;
  return [ba, scale(bb, s)];
}

/**
 * Deterministic initial tangent per vertex: the first tangent of a branchless orthonormal frame.
 * Instant Meshes draws a random angle here; a fixed frame keeps the solve reproducible.
 */
export function initialDirections(level: Level): Float64Array {
  const nv = level.area.length;
  const out = new Float64Array(3 * nv);
  for (let i = 0; i < nv; i++) {
    const [s] = coordinateSystem(at(level.normal, i));
    out[3 * i] = s[0];
    out[3 * i + 1] = s[1];
    out[3 * i + 2] = s[2];
  }
  return out;
}

/** Orthonormal tangent pair (s, t) for a unit normal n (Duff et al. 2017). */
export function coordinateSystem(n: V3): [V3, V3] {
  const sign = n[2] >= 0 ? 1 : -1;
  const a = -1 / (sign + n[2]);
  const b = n[0] * n[1] * a;
  return [
    [1 + sign * n[0] * n[0] * a, sign * b, -sign * n[0]],
    [b, sign + n[1] * n[1] * a, -n[1]],
  ];
}

/**
 * One Gauss-Seidel sweep (solve_normal of optimize_orientations_impl). Returns the mean
 * (1 - |dot|) between the old and new directions, a convergence residual.
 */
function sweep(
  level: Level,
  Q: Float64Array,
  constraint: OrientationConstraint | undefined,
): number {
  const { graph, normal: N } = level;
  const nv = level.area.length;
  let residual = 0;
  for (let i = 0; i < nv; i++) {
    const ni = at(N, i);
    const qi = at(Q, i);
    let sum: V3 = qi;
    let weightSum = 0;
    for (let e = graph.offset[i] as number; e < (graph.offset[i + 1] as number); e++) {
      const j = graph.id[e] as number;
      const w = graph.weight[e] as number;
      if (w === 0) continue;
      const [first, second] = compatExtrinsic(sum, ni, at(Q, j), at(N, j));
      sum = add(scale(first, weightSum), scale(second, w));
      weightSum += w;
      sum = sub(sum, scale(ni, dot(ni, sum)));
      const l = Math.sqrt(dot(sum, sum));
      if (l > RCP_OVERFLOW) sum = scale(sum, 1 / l);
    }
    if (constraint) {
      const cw = constraint.weight[i] as number;
      if (cw !== 0) {
        const [first, second] = compatExtrinsic(sum, ni, at(constraint.direction, i), ni);
        sum = add(scale(first, 1 - cw), scale(second, cw));
        sum = sub(sum, scale(ni, dot(ni, sum)));
        const l = Math.sqrt(dot(sum, sum));
        if (l > RCP_OVERFLOW) sum = scale(sum, 1 / l);
      }
    }
    if (weightSum > 0) {
      const next = tangentUnit(sum, ni);
      residual += 1 - Math.abs(dot(next, qi));
      Q[3 * i] = next[0];
      Q[3 * i + 1] = next[1];
      Q[3 * i + 2] = next[2];
    }
  }
  return nv === 0 ? 0 : residual / nv;
}

/** Each finer vertex inherits its coarse parent's direction, re-projected into its own tangent plane. */
function prolong(fine: Level, finerToCoarse: Uint32Array, coarseQ: Float64Array): Float64Array {
  const nv = fine.area.length;
  const out = new Float64Array(3 * nv);
  for (let i = 0; i < nv; i++) {
    const q = tangentUnit(at(coarseQ, finerToCoarse[i] as number), at(fine.normal, i));
    out[3 * i] = q[0];
    out[3 * i + 1] = q[1];
    out[3 * i + 2] = q[2];
  }
  return out;
}

/**
 * Coarse-to-fine orientation solve. The coarsest level starts from a deterministic tangent field;
 * each finer level inherits from its parents through `toLower` and sweeps again. The constraint
 * applies only on level 0.
 */
export function solveOrientation(
  hierarchy: Hierarchy,
  options: OrientationOptions,
): OrientationResult {
  const levels = hierarchy.levels;
  const top = levels.length - 1;
  let Q = initialDirections(levels[top] as Level);
  let residual = 0;
  const perLevel: Float64Array[] = new Array(levels.length);
  for (let d = top; d >= 0; d--) {
    const level = levels[d] as Level;
    if (d < top) {
      const coarser = levels[d + 1] as Level;
      Q = prolong(level, coarser.toLower as Uint32Array, Q);
    }
    for (let it = 0; it < options.iterations; it++) {
      residual = sweep(level, Q, d === 0 ? options.constraint : undefined);
    }
    perLevel[d] = Q;
  }
  return { direction: Q, residual, levels: perLevel };
}
