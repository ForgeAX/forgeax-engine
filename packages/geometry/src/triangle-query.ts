import type { FieldVec3 } from '@forgeax/engine-types';

export type QueryTriangle = readonly [FieldVec3, FieldVec3, FieldVec3];
export interface TriangleRayHit {
  primitive: number;
  distance: number;
  frontFace: boolean;
}
/** Shared work allowance for a build batch; exhausted queries never become misses. */
export interface TriangleQueryBudget {
  remaining: number;
}

/** Exact squared distance, including segment/point degeneracies. */
export function triangleDistanceSquared(p: FieldVec3, triangle: QueryTriangle): number {
  const [a, b, c] = triangle;
  const abx = b[0] - a[0],
    aby = b[1] - a[1],
    abz = b[2] - a[2];
  const acx = c[0] - a[0],
    acy = c[1] - a[1],
    acz = c[2] - a[2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const n2 = nx * nx + ny * ny + nz * nz;
  if (n2 > 0) {
    const apx = p[0] - a[0],
      apy = p[1] - a[1],
      apz = p[2] - a[2];
    const d = apx * nx + apy * ny + apz * nz;
    const px = apx - (nx * d) / n2,
      py = apy - (ny * d) / n2,
      pz = apz - (nz * d) / n2;
    const u =
      ((py * acz - pz * acy) * nx + (pz * acx - px * acz) * ny + (px * acy - py * acx) * nz) / n2;
    const v =
      ((aby * pz - abz * py) * nx + (abz * px - abx * pz) * ny + (abx * py - aby * px) * nz) / n2;
    if (u >= 0 && v >= 0 && u + v <= 1) return (d * d) / n2;
  }
  let nearest = Infinity;
  for (let edge = 0; edge < 3; edge++) {
    const from = item(triangle, edge),
      to = item(triangle, (edge + 1) % 3);
    const x = to[0] - from[0],
      y = to[1] - from[1],
      z = to[2] - from[2];
    const dx = p[0] - from[0],
      dy = p[1] - from[1],
      dz = p[2] - from[2];
    const length2 = x * x + y * y + z * z;
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, (dx * x + dy * y + dz * z) / length2));
    nearest = Math.min(nearest, (dx - t * x) ** 2 + (dy - t * y) ** 2 + (dz - t * z) ** 2);
  }
  return nearest;
}

interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

interface Node extends Bounds {
  escape: number;
  first: number;
  count: number;
}

/**
 * Build-time acceleration over validated producer-owned triangles. No source
 * arrays are mutated. The producer must retain its immutable input until done.
 * Closest-point and multi-hit ray callers share this one spatial index.
 */
export function createTriangleQuery(triangles: readonly QueryTriangle[]) {
  const order = Uint32Array.from({ length: triangles.length }, (_, i) => i);
  const nodes: Node[] = [];
  const centers = new Float64Array(triangles.length * 3);
  const scratch = new Uint32Array(triangles.length);
  for (let primitive = 0; primitive < triangles.length; primitive++) {
    const triangle = item(triangles, primitive);
    for (const axis of [0, 1, 2] as const)
      centers[primitive * 3 + axis] =
        (triangle[0][axis] + triangle[1][axis] + triangle[2][axis]) / 3;
  }
  const build = (first: number, count: number): void => {
    const node: Node = {
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
      first,
      count: 0,
      escape: 0,
    };
    nodes.push(node);
    for (let i = first; i < first + count; i++) {
      for (const p of item(triangles, item(order, i))) {
        for (const axis of [0, 1, 2] as const) {
          node.min[axis] = Math.min(node.min[axis], p[axis]);
          node.max[axis] = Math.max(node.max[axis], p[axis]);
        }
      }
    }
    // Keep sign-ray and closest-point budgets focused on nearby primitives.
    if (count <= 2) node.count = count;
    else {
      // Fixed-bin surface-area partitioning separates small nearby surfaces
      // from large overlapping triangles without changing the primitive IDs.
      const binCount = 12;
      let bestCost = Infinity;
      let split:
        | { axis: number; bin: number; min: number; scale: number; left: number }
        | undefined;
      for (const axis of [0, 1, 2] as const) {
        let min = Infinity,
          max = -Infinity;
        for (let i = first; i < first + count; i++) {
          const center = item(centers, item(order, i) * 3 + axis);
          min = Math.min(min, center);
          max = Math.max(max, center);
        }
        if (!(max > min)) continue;
        const scale = binCount / (max - min);
        const bins = Array.from({ length: binCount }, () => ({ ...emptyBounds(), count: 0 }));
        for (let i = first; i < first + count; i++) {
          const primitive = item(order, i);
          const bin = item(
            bins,
            Math.min(binCount - 1, Math.floor((item(centers, primitive * 3 + axis) - min) * scale)),
          );
          bin.count++;
          for (const point of item(triangles, primitive))
            for (const component of [0, 1, 2] as const) {
              bin.min[component] = Math.min(bin.min[component], point[component]);
              bin.max[component] = Math.max(bin.max[component], point[component]);
            }
        }
        const rightAreas = new Float64Array(binCount);
        const rightCounts = new Uint32Array(binCount);
        const rightBounds = emptyBounds();
        let rightCount = 0;
        for (let i = binCount - 1; i >= 0; i--) {
          const bin = item(bins, i);
          includeBounds(rightBounds, bin);
          rightCount += bin.count;
          rightCounts[i] = rightCount;
          rightAreas[i] = surfaceArea(rightBounds);
        }
        const leftBounds = emptyBounds();
        let leftCount = 0;
        for (let i = 0; i < binCount - 1; i++) {
          const bin = item(bins, i);
          includeBounds(leftBounds, bin);
          leftCount += bin.count;
          const right = item(rightCounts, i + 1);
          if (!leftCount || !right) continue;
          const cost = surfaceArea(leftBounds) * leftCount + item(rightAreas, i + 1) * right;
          if (cost < bestCost) {
            bestCost = cost;
            split = { axis, bin: i, min, scale, left: leftCount };
          }
        }
      }
      const left = split?.left ?? Math.floor(count / 2);
      if (split) {
        let leftCursor = first,
          rightCursor = first + left;
        for (let i = first; i < first + count; i++) {
          const primitive = item(order, i);
          const bin = Math.min(
            binCount - 1,
            Math.floor((item(centers, primitive * 3 + split.axis) - split.min) * split.scale),
          );
          scratch[bin <= split.bin ? leftCursor++ : rightCursor++] = primitive;
        }
        order.set(scratch.subarray(first, first + count), first);
      } else {
        // Coincident centroids (including points) still form bounded leaves.
        order.subarray(first, first + count).sort();
      }
      build(first, left);
      build(first + left, count - left);
    }
    node.escape = nodes.length;
  };
  if (triangles.length) build(0, triangles.length);
  return {
    nodeCount: nodes.length,
    /** Returns null on primitive-test exhaustion; a partial nearest value is not a distance bound. */
    nearestSquared(
      p: FieldVec3,
      maxDistance = Infinity,
      budget?: TriangleQueryBudget,
    ): number | null {
      let nearest = maxDistance * maxDistance;
      const pending = nodes.length ? [0] : [];
      const bounds = nodes.length ? [pointBoundSquared(p, item(nodes, 0))] : [];
      while (pending.length) {
        const bound = item(bounds, bounds.length - 1);
        const cursor = item(pending, pending.length - 1);
        bounds.pop();
        pending.pop();
        if (bound > nearest) continue;
        const node = item(nodes, cursor);
        if (node.count === 0) {
          const left = cursor + 1,
            right = item(nodes, left).escape;
          const leftBound = pointBoundSquared(p, item(nodes, left));
          const rightBound = pointBoundSquared(p, item(nodes, right));
          // Push the farther child first so the next leaf tightens the bound.
          if (leftBound <= rightBound) {
            pending.push(right, left);
            bounds.push(rightBound, leftBound);
          } else {
            pending.push(left, right);
            bounds.push(leftBound, rightBound);
          }
          continue;
        }
        for (let i = node.first; i < node.first + node.count; i++) {
          if (budget) {
            if (budget.remaining <= 0) return null;
            budget.remaining--;
          }
          nearest = Math.min(nearest, triangleDistanceSquared(p, item(triangles, item(order, i))));
        }
      }
      return nearest;
    },
    /** Ray parameter distances. False leaves out unchanged; null is exhausted, not a miss. */
    trace(
      out: TriangleRayHit,
      origin: FieldVec3,
      direction: FieldVec3,
      tMin: number,
      tMax: number,
      budget?: TriangleQueryBudget,
    ): boolean | null {
      let nearest = tMax,
        found = false;
      const pending = nodes.length ? [0] : [];
      const bounds = nodes.length ? [rayBound(origin, direction, item(nodes, 0), tMin, tMax)] : [];
      while (pending.length) {
        const bound = item(bounds, bounds.length - 1);
        const cursor = item(pending, pending.length - 1);
        pending.pop();
        bounds.pop();
        if (!Number.isFinite(bound) || bound > nearest) continue;
        const node = item(nodes, cursor);
        if (node.count === 0) {
          const left = cursor + 1,
            right = item(nodes, left).escape;
          const a = rayBound(origin, direction, item(nodes, left), tMin, nearest);
          const b = rayBound(origin, direction, item(nodes, right), tMin, nearest);
          if (a <= b) {
            pending.push(right, left);
            bounds.push(b, a);
          } else {
            pending.push(left, right);
            bounds.push(a, b);
          }
          continue;
        }
        for (let i = node.first; i < node.first + node.count; i++) {
          if (budget) {
            if (budget.remaining <= 0) return null;
            budget.remaining--;
          }
          const primitive = item(order, i),
            [a, b, c] = item(triangles, primitive);
          const ex = b[0] - a[0],
            ey = b[1] - a[1],
            ez = b[2] - a[2];
          const fx = c[0] - a[0],
            fy = c[1] - a[1],
            fz = c[2] - a[2];
          const px = direction[1] * fz - direction[2] * fy;
          const py = direction[2] * fx - direction[0] * fz;
          const pz = direction[0] * fy - direction[1] * fx;
          const det = ex * px + ey * py + ez * pz;
          if (det === 0) continue;
          const tx = origin[0] - a[0],
            ty = origin[1] - a[1],
            tz = origin[2] - a[2];
          const u = (tx * px + ty * py + tz * pz) / det;
          if (u < 0 || u > 1) continue;
          const qx = ty * ez - tz * ey,
            qy = tz * ex - tx * ez,
            qz = tx * ey - ty * ex;
          const v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) / det;
          if (v < 0 || u + v > 1) continue;
          const t = (fx * qx + fy * qy + fz * qz) / det;
          if (t < tMin || t > nearest || (found && t === nearest && primitive >= out.primitive))
            continue;
          nearest = t;
          found = true;
          out.primitive = primitive;
          out.distance = t;
          out.frontFace = det > 0;
        }
      }
      return found;
    },
  };
}

function emptyBounds(): Bounds {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function includeBounds(target: Bounds, source: Bounds): void {
  for (const axis of [0, 1, 2] as const) {
    target.min[axis] = Math.min(target.min[axis], source.min[axis]);
    target.max[axis] = Math.max(target.max[axis], source.max[axis]);
  }
}

function surfaceArea(bounds: Bounds): number {
  const x = Math.max(0, bounds.max[0] - bounds.min[0]);
  const y = Math.max(0, bounds.max[1] - bounds.min[1]);
  const z = Math.max(0, bounds.max[2] - bounds.min[2]);
  return 2 * (x * y + y * z + z * x);
}

function rayBound(
  origin: FieldVec3,
  direction: FieldVec3,
  node: Node,
  tMin: number,
  tMax: number,
): number {
  let near = tMin,
    far = tMax;
  for (const axis of [0, 1, 2] as const) {
    if (direction[axis] === 0) {
      if (origin[axis] < node.min[axis] || origin[axis] > node.max[axis]) return Infinity;
    } else {
      const a = (node.min[axis] - origin[axis]) / direction[axis];
      const b = (node.max[axis] - origin[axis]) / direction[axis];
      // Slab division and triangle intersection can round the same distance
      // differently. Widen only the pruning interval; triangles retain the
      // caller's exact interval and deterministic equal-distance identity.
      const roundoff = 8 * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b));
      near = Math.max(near, Math.min(a, b) - roundoff);
      far = Math.min(far, Math.max(a, b) + roundoff);
    }
  }
  return far < near ? Infinity : near;
}

function pointBoundSquared(p: FieldVec3, node: Node): number {
  let bound = 0;
  for (const axis of [0, 1, 2] as const) {
    const delta = Math.max(node.min[axis] - p[axis], 0, p[axis] - node.max[axis]);
    bound += delta * delta;
  }
  return bound;
}

function item<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError('Triangle query index outside validated input');
  return value;
}
