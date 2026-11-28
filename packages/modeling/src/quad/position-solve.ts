// Extrinsic 4-PoSy position solve for Instant Meshes (Jakob et al. 2015, optimize_positions).
// With the orientation field fixed, each finest-level vertex keeps an origin on its tangent plane.
// A Gauss-Seidel sweep folds every neighbour link into a running weighted origin via
// compat_position_extrinsic_4, re-projects it onto the tangent plane, and rounds it to the nearest
// lattice point of its own orientation (position_round_4).

import { latticePoint, middlePoint, positionFloorIndex, positionRound } from './field';
import type { Hierarchy, Level } from './hierarchy';

type V3 = [number, number, number];

export interface PositionOptions {
  /** Gauss-Seidel sweeps (Instant Meshes default 6). */
  readonly iterations: number;
  /** Lattice spacing, mesh units. */
  readonly scale: number;
}

function at(v: Float64Array, i: number): V3 {
  return [v[3 * i] as number, v[3 * i + 1] as number, v[3 * i + 2] as number];
}

function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * compat_position_extrinsic_4: both lattices are floored at the middle point, then the closest
 * corner pair among the 4 x 4 cells is kept. Returns each side's lattice point.
 */
function compatPosition(
  p0: V3,
  n0: V3,
  q0: V3,
  o0: V3,
  p1: V3,
  n1: V3,
  q1: V3,
  o1: V3,
  scale: number,
): [V3, V3] {
  const middle = middlePoint(p0, n0, p1, n1);
  const f0 = positionFloorIndex(o0, q0, n0, middle, scale);
  const f1 = positionFloorIndex(o1, q1, n1, middle, scale);
  let best = Infinity;
  let b0: [number, number] = f0;
  let b1: [number, number] = f1;
  for (let i = 0; i < 4; i++) {
    const i0: [number, number] = [f0[0] + (i & 1), f0[1] + ((i & 2) >> 1)];
    const a = latticePoint(o0, q0, n0, i0, scale);
    for (let j = 0; j < 4; j++) {
      const j1: [number, number] = [f1[0] + (j & 1), f1[1] + ((j & 2) >> 1)];
      const b = latticePoint(o1, q1, n1, j1, scale);
      const d: V3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
      const cost = dot(d, d);
      if (cost < best) {
        best = cost;
        b0 = i0;
        b1 = j1;
      }
    }
  }
  return [latticePoint(o0, q0, n0, b0, scale), latticePoint(o1, q1, n1, b1, scale)];
}

/** Projects a point onto the tangent plane of vertex i (normal n, through p). */
function projectTangent(o: V3, p: V3, n: V3): V3 {
  const d = dot(n, [o[0] - p[0], o[1] - p[1], o[2] - p[2]]);
  return [o[0] - d * n[0], o[1] - d * n[1], o[2] - d * n[2]];
}

/**
 * Gauss-Seidel position sweeps on one level with a fixed orientation. `origin` holds the initial
 * lattice origins and is updated in place.
 */
function sweepPositions(
  level: Level,
  direction: Float64Array,
  origin: Float64Array,
  scale: number,
  iterations: number,
): void {
  const nv = level.position.length / 3;
  const graph = level.graph;
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < nv; i++) {
      const vi = at(level.position, i);
      const ni = at(level.normal, i);
      const qi = at(direction, i);
      let sum: V3 = at(origin, i);
      let weightSum = 0;
      for (let e = graph.offset[i] as number; e < (graph.offset[i + 1] as number); e++) {
        const j = graph.id[e] as number;
        const w = graph.weight[e] as number;
        if (w === 0) continue;
        const [first, second] = compatPosition(
          vi,
          ni,
          qi,
          sum,
          at(level.position, j),
          at(level.normal, j),
          at(direction, j),
          at(origin, j),
          scale,
        );
        // Reference optimize_positions_impl: the running sum holds this vertex's matched point
        // (first) and the neighbour's matched point (second), each weighted, then divided by the total.
        sum = [
          first[0] * weightSum + second[0] * w,
          first[1] * weightSum + second[1] * w,
          first[2] * weightSum + second[2] * w,
        ];
        weightSum += w;
        sum = [sum[0] / weightSum, sum[1] / weightSum, sum[2] / weightSum];
        sum = projectTangent(sum, vi, ni);
      }
      if (weightSum > 0) {
        // position_round_4(o = averaged estimate, q, n, p = vertex): the lattice is anchored at the
        // estimate and the vertex position selects the nearest lattice point.
        const r = positionRound(sum, qi, ni, vi, scale);
        origin[3 * i] = r[0];
        origin[3 * i + 1] = r[1];
        origin[3 * i + 2] = r[2];
      }
    }
  }
}

/**
 * Coarse-to-fine position solve (Instant Meshes optimize_positions + propagate_positions). The
 * coarsest level starts from the vertex positions; each finer level inherits its coarse parent's
 * origin, projected into its own tangent plane, then runs the same sweeps. Returns level-0 origins,
 * 3 numbers per finest vertex.
 */
export function solvePositions(
  hierarchy: Hierarchy,
  directions: readonly Float64Array[],
  options: PositionOptions,
): Float64Array {
  const levels = hierarchy.levels;
  const top = levels.length - 1;
  // Zero sweeps is the identity: origins stay at the vertex positions (no coarse propagation).
  if (options.iterations <= 0) return Float64Array.from((levels[0] as Level).position);
  let origin = Float64Array.from((levels[top] as Level).position);
  for (let d = top; d >= 0; d--) {
    const level = levels[d] as Level;
    if (d < top) {
      const coarser = levels[d + 1] as Level;
      const map = coarser.toLower as Uint32Array;
      const nv = level.position.length / 3;
      const fine = new Float64Array(3 * nv);
      for (let i = 0; i < nv; i++) {
        const c = map[i] as number;
        const o = projectTangent(at(origin, c), at(level.position, i), at(level.normal, i));
        fine[3 * i] = o[0];
        fine[3 * i + 1] = o[1];
        fine[3 * i + 2] = o[2];
      }
      origin = fine;
    }
    sweepPositions(level, directions[d] as Float64Array, origin, options.scale, options.iterations);
  }
  return origin;
}
