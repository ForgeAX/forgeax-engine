import { err, ok, type Result } from '@forgeax/engine-types';

/** Experimental opaque reference profile. Distances are ray parameters, not normalized lengths. */
export interface RayMeshInstance {
  readonly instanceId: number;
  readonly geometryId: number;
  readonly materialId: number;
  readonly mask: number;
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
  /** Column-major affine object-to-world transform. */
  readonly transform: ArrayLike<number>;
}

/** Geometry/pose identity shared by traversal and capture; representation settings are separate. */
export function rayGeometryKey(
  instance: Pick<RayMeshInstance, 'instanceId' | 'geometryId' | 'mask' | 'transform'>,
  meshDigest: string,
): string {
  return JSON.stringify([
    instance.instanceId,
    instance.geometryId,
    instance.mask,
    Array.from(instance.transform),
    meshDigest,
  ]);
}

export interface ReferenceRay {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
  readonly tMin: number;
  readonly tMax: number;
  readonly mask: number;
}

export interface ReferenceHit {
  readonly instanceId: number;
  readonly geometryId: number;
  readonly primitiveId: number;
  readonly materialId: number;
  readonly t: number;
  readonly barycentrics: readonly [number, number];
  readonly frontFace: boolean;
}

export interface RayReferenceError {
  readonly code: 'ray-reference-invalid' | 'ray-reference-limit' | 'ray-reference-stale';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly cause: string };
}

export const RAY_REFERENCE_LIMIT = 65_536;
// Traversal and expanded Surface attributes stay within the portable 128 MiB binding floor.
export const RAY_REFERENCE_TRIANGLE_LIMIT = 327_680;
export const RAY_TRIANGLE_STRIDE = 80;
export const RAY_NODE_STRIDE = 48;
export const RAY_INPUT_STRIDE = 48;
export const RAY_HIT_STRIDE = 32;

/** Owned f32 world-space snapshot; rebuilding replaces all geometry, masks and identities atomically. */
export interface RayReferenceScene {
  readonly triangles: Uint8Array;
  readonly nodes: Uint8Array;
  readonly triangleCount: number;
}

export function rayReferenceFailure(
  cause: string,
  limit = false,
): Result<never, RayReferenceError> {
  return err({
    code: limit ? 'ray-reference-limit' : 'ray-reference-invalid',
    expected:
      'finite opaque indexed triangles and finite nonzero rays within the reference profile',
    hint: 'Inspect the input; rebuild a bounded scene snapshot before submitting queries.',
    detail: { cause },
  });
}

const uint = (value: number, max = 0xffffffff) =>
  Number.isInteger(value) && value >= 0 && value <= max;
const finite32 = (value: number) => Number.isFinite(value) && Number.isFinite(Math.fround(value));

/** Builds a deterministic binned-SAH BVH in depth-first order. Never borrows caller arrays. */
export function buildRayReferenceScene(
  instances: readonly RayMeshInstance[],
): Result<RayReferenceScene, RayReferenceError> {
  if (instances.length > 1024) return rayReferenceFailure('instance limit exceeded', true);
  const rows: number[][] = [];
  const ids = new Set<number>();
  for (const instance of instances) {
    const {
      instanceId,
      geometryId,
      materialId,
      mask,
      positions: p,
      indices,
      transform: m,
    } = instance;
    if (
      !uint(instanceId, 0xfffffffe) ||
      ids.has(instanceId) ||
      !uint(geometryId) ||
      !uint(materialId) ||
      !uint(mask, 255)
    )
      return rayReferenceFailure(
        'instance identities must be unique; IDs are u32 and masks are u8',
      );
    ids.add(instanceId);
    if (
      p.length === 0 ||
      p.length % 3 !== 0 ||
      indices.length === 0 ||
      indices.length % 3 !== 0 ||
      m.length !== 16
    )
      return rayReferenceFailure('expected nonempty xyz positions, triangle indices, and a mat4');
    if (rows.length + indices.length / 3 > RAY_REFERENCE_TRIANGLE_LIMIT)
      return rayReferenceFailure('triangle limit exceeded', true);
    if (
      !Array.from(p).every(finite32) ||
      !Array.from(m).every(finite32) ||
      m[3] !== 0 ||
      m[7] !== 0 ||
      m[11] !== 0 ||
      m[15] !== 1
    )
      return rayReferenceFailure('positions and affine transforms must be finite f32');
    const det =
      item(m, 0) * (item(m, 5) * item(m, 10) - item(m, 9) * item(m, 6)) -
      item(m, 4) * (item(m, 1) * item(m, 10) - item(m, 9) * item(m, 2)) +
      item(m, 8) * (item(m, 1) * item(m, 6) - item(m, 5) * item(m, 2));
    if (!Number.isFinite(det) || det === 0) return rayReferenceFailure('singular transform');
    for (let primitive = 0; primitive < indices.length / 3; primitive++) {
      const row: number[] = [];
      for (let vertex = 0; vertex < 3; vertex++) {
        const index = item(indices, primitive * 3 + vertex);
        if (!uint(index) || index * 3 + 2 >= p.length)
          return rayReferenceFailure('index outside positions');
        const x = item(p, index * 3),
          y = item(p, index * 3 + 1),
          z = item(p, index * 3 + 2);
        for (let axis = 0; axis < 3; axis++)
          row.push(
            Math.fround(
              item(m, axis) * x +
                item(m, 4 + axis) * y +
                item(m, 8 + axis) * z +
                item(m, 12 + axis),
            ),
          );
        row.push(0);
      }
      if (!row.every(finite32)) return rayReferenceFailure('world position overflow');
      const ab = [
        item(row, 4) - item(row, 0),
        item(row, 5) - item(row, 1),
        item(row, 6) - item(row, 2),
      ];
      const ac = [
        item(row, 8) - item(row, 0),
        item(row, 9) - item(row, 1),
        item(row, 10) - item(row, 2),
      ];
      // Zero-area source primitives have no coverage. Preserve IDs and counts, but
      // mark them inactive just as a hardware triangle AS does.
      const activeMask = cross(ab, ac).every((v) => v === 0) ? 0 : mask;
      rows.push([...row, instanceId, geometryId, primitive, materialId, activeMask, 0, 0, 0]);
    }
  }
  const { nodes, order } = buildBinnedBvh(rows);
  const ordered = Array.from(order, (index) => item(rows, index));
  // One unreachable dummy element keeps WebGPU runtime arrays bindable for an empty scene.
  const triangles = new Uint8Array(Math.max(1, rows.length) * RAY_TRIANGLE_STRIDE);
  const tv = new DataView(triangles.buffer);
  ordered.forEach((row, i) => {
    row.forEach((v, j) => {
      if (j < 12) tv.setFloat32(i * 80 + j * 4, v, true);
      else tv.setUint32(i * 80 + j * 4, v, true);
    });
  });
  const nodeBytes = new Uint8Array(Math.max(1, nodes.length) * RAY_NODE_STRIDE);
  const nv = new DataView(nodeBytes.buffer);
  nodes.forEach((n, i) => {
    for (let axis = 0; axis < 3; axis++) {
      nv.setFloat32(i * 48 + axis * 4, item(n.min, axis), true);
      nv.setFloat32(i * 48 + 16 + axis * 4, item(n.max, axis), true);
    }
    nv.setUint32(i * 48 + 12, n.escape, true);
    nv.setUint32(i * 48 + 28, n.first, true);
    nv.setUint32(i * 48 + 32, n.count, true);
    nv.setUint32(i * 48 + 36, n.right, true);
    nv.setUint32(i * 48 + 40, n.axis, true);
  });
  return ok({ triangles, nodes: nodeBytes, triangleCount: rows.length });
}

export function packReferenceRays(
  rays: readonly ReferenceRay[],
): Result<Uint8Array, RayReferenceError> {
  if (!rays.length || rays.length > RAY_REFERENCE_LIMIT)
    return rayReferenceFailure('ray count must be 1..65536', true);
  const bytes = new Uint8Array(rays.length * RAY_INPUT_STRIDE),
    view = new DataView(bytes.buffer);
  for (let i = 0; i < rays.length; i++) {
    const r = item(rays, i);
    if (
      r.origin.length !== 3 ||
      r.direction.length !== 3 ||
      ![...r.origin, ...r.direction, r.tMin, r.tMax].every(finite32) ||
      r.direction.every((v) => Math.fround(v) === 0) ||
      r.tMin < 0 ||
      Math.fround(r.tMax) <= Math.fround(r.tMin) ||
      !uint(r.mask, 255)
    )
      return rayReferenceFailure(`invalid ray ${i}`);
    [...r.origin, r.tMin, ...r.direction, r.tMax].forEach((v, j) => {
      view.setFloat32(i * 48 + j * 4, v, true);
    });
    view.setUint32(i * 48 + 32, r.mask, true);
  }
  return ok(bytes);
}

/** Independent f64 plane/Gram-matrix oracle: deliberately does not traverse the GPU BVH. */
export function traceReferenceRay(
  scene: RayReferenceScene,
  ray: ReferenceRay,
): ReferenceHit | null {
  const view = new DataView(
    scene.triangles.buffer,
    scene.triangles.byteOffset,
    scene.triangles.byteLength,
  );
  let best: ReferenceHit | null = null;
  for (let i = 0; i < scene.triangleCount; i++) {
    const base = i * 80;
    if (!(view.getUint32(base + 64, true) & ray.mask)) continue;
    const point = (offset: number) =>
      [0, 4, 8].map((a) => view.getFloat32(base + offset + a, true));
    const a = point(0),
      b = point(16),
      c = point(32);
    const ab = sub(b, a),
      ac = sub(c, a),
      normal = cross(ab, ac);
    const denom = dot(normal, ray.direction);
    if (denom === 0) continue;
    const t = dot(normal, sub(a, ray.origin)) / denom;
    if (t < ray.tMin || t > ray.tMax || (best !== null && t >= best.t)) continue;
    const q = ray.origin.map((o, axis) => o + item(ray.direction, axis) * t - item(a, axis));
    const bb = dot(ab, ab),
      cc = dot(ac, ac),
      bc = dot(ab, ac),
      qb = dot(q, ab),
      qc = dot(q, ac);
    const d = bb * cc - bc * bc;
    const u = (qb * cc - qc * bc) / d,
      v = (qc * bb - qb * bc) / d;
    if (u < 0 || v < 0 || u + v > 1) continue;
    best = {
      instanceId: view.getUint32(base + 48, true),
      geometryId: view.getUint32(base + 52, true),
      primitiveId: view.getUint32(base + 56, true),
      materialId: view.getUint32(base + 60, true),
      t,
      barycentrics: [u, v],
      frontFace: denom < 0,
    };
  }
  return best;
}

function sub(a: ArrayLike<number>, b: ArrayLike<number>) {
  return [0, 1, 2].map((i) => item(a, i) - item(b, i));
}
function dot(a: ArrayLike<number>, b: ArrayLike<number>) {
  return item(a, 0) * item(b, 0) + item(a, 1) * item(b, 1) + item(a, 2) * item(b, 2);
}
function cross(a: ArrayLike<number>, b: ArrayLike<number>) {
  return [
    item(a, 1) * item(b, 2) - item(a, 2) * item(b, 1),
    item(a, 2) * item(b, 0) - item(a, 0) * item(b, 2),
    item(a, 0) * item(b, 1) - item(a, 1) * item(b, 0),
  ];
}

// Inputs are validated once; this assertion also protects internal BVH indexing invariants.
function item<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined)
    throw new RangeError(`reference kernel index ${index} is outside its validated span`);
  return value;
}

interface BvhNode {
  readonly min: number[];
  readonly max: number[];
  /** Index after this subtree; for an inner node's left child it is the right child. */
  escape: number;
  readonly first: number;
  count: number;
  right: number;
  axis: number;
}

const BVH_LEAF_SIZE = 4;
const BVH_BINS = 16;
// Ordered traversal keeps a fixed private stack; the median fallback bounds depth
// to SAH_DEPTH + log2(RAY_REFERENCE_TRIANGLE_LIMIT / BVH_LEAF_SIZE) < 64.
const BVH_SAH_DEPTH = 40;

/** Binned surface-area-heuristic split by centroid; median split when SAH has no choice. */
function buildBinnedBvh(rows: readonly number[][]): { nodes: BvhNode[]; order: Uint32Array } {
  const count = rows.length;
  const lo = new Float64Array(count * 3);
  const hi = new Float64Array(count * 3);
  const center = new Float64Array(count * 3);
  for (let t = 0; t < count; t++) {
    const row = item(rows, t);
    for (let axis = 0; axis < 3; axis++) {
      const a = item(row, axis),
        b = item(row, 4 + axis),
        c = item(row, 8 + axis);
      lo[t * 3 + axis] = Math.min(a, b, c);
      hi[t * 3 + axis] = Math.max(a, b, c);
      center[t * 3 + axis] = (a + b + c) / 3;
    }
  }
  const order = Uint32Array.from({ length: count }, (_, t) => t);
  const nodes: BvhNode[] = [];
  const area = (min: ArrayLike<number>, max: ArrayLike<number>) => {
    const x = Math.max(0, item(max, 0) - item(min, 0)),
      y = Math.max(0, item(max, 1) - item(min, 1)),
      z = Math.max(0, item(max, 2) - item(min, 2));
    return x * y + y * z + z * x;
  };
  const binLo = new Float64Array(BVH_BINS * 3);
  const binHi = new Float64Array(BVH_BINS * 3);
  const binCount = new Uint32Array(BVH_BINS);
  const rightArea = new Float64Array(BVH_BINS);
  const visit = (start: number, end: number, depth: number): void => {
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    const cmin = [Infinity, Infinity, Infinity],
      cmax = [-Infinity, -Infinity, -Infinity];
    for (let k = start; k < end; k++) {
      const t = item(order, k);
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(item(min, axis), item(lo, t * 3 + axis));
        max[axis] = Math.max(item(max, axis), item(hi, t * 3 + axis));
        cmin[axis] = Math.min(item(cmin, axis), item(center, t * 3 + axis));
        cmax[axis] = Math.max(item(cmax, axis), item(center, t * 3 + axis));
      }
    }
    const node: BvhNode = { min, max, escape: 0, first: start, count: 0, right: 0, axis: 0 };
    nodes.push(node);
    const n = end - start;
    if (n <= BVH_LEAF_SIZE) {
      node.count = n;
      node.escape = nodes.length;
      return;
    }
    let bestAxis = -1,
      bestBin = 0,
      bestCost = Infinity;
    for (let axis = 0; depth < BVH_SAH_DEPTH && axis < 3; axis++) {
      const extent = item(cmax, axis) - item(cmin, axis);
      if (!(extent > 0)) continue;
      binLo.fill(Infinity);
      binHi.fill(-Infinity);
      binCount.fill(0);
      const scale = BVH_BINS / extent;
      for (let k = start; k < end; k++) {
        const t = item(order, k);
        const bin = Math.min(
          BVH_BINS - 1,
          Math.floor((item(center, t * 3 + axis) - item(cmin, axis)) * scale),
        );
        binCount[bin] = item(binCount, bin) + 1;
        for (let c = 0; c < 3; c++) {
          binLo[bin * 3 + c] = Math.min(item(binLo, bin * 3 + c), item(lo, t * 3 + c));
          binHi[bin * 3 + c] = Math.max(item(binHi, bin * 3 + c), item(hi, t * 3 + c));
        }
      }
      const accLo = [Infinity, Infinity, Infinity],
        accHi = [-Infinity, -Infinity, -Infinity];
      for (let bin = BVH_BINS - 1; bin > 0; bin--) {
        for (let c = 0; c < 3; c++) {
          accLo[c] = Math.min(item(accLo, c), item(binLo, bin * 3 + c));
          accHi[c] = Math.max(item(accHi, c), item(binHi, bin * 3 + c));
        }
        rightArea[bin] = area(accLo, accHi);
      }
      accLo.fill(Infinity);
      accHi.fill(-Infinity);
      let left = 0;
      for (let bin = 0; bin < BVH_BINS - 1; bin++) {
        left += item(binCount, bin);
        for (let c = 0; c < 3; c++) {
          accLo[c] = Math.min(item(accLo, c), item(binLo, bin * 3 + c));
          accHi[c] = Math.max(item(accHi, c), item(binHi, bin * 3 + c));
        }
        if (left === 0 || left === n) continue;
        const cost = area(accLo, accHi) * left + item(rightArea, bin + 1) * (n - left);
        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = axis;
          bestBin = bin;
        }
      }
    }
    let middle: number;
    if (bestAxis >= 0) {
      const axis = bestAxis;
      const scale = BVH_BINS / (item(cmax, axis) - item(cmin, axis));
      const isLeft = (t: number) =>
        Math.min(
          BVH_BINS - 1,
          Math.floor((item(center, t * 3 + axis) - item(cmin, axis)) * scale),
        ) <= bestBin;
      let i = start,
        j = end - 1;
      while (i <= j) {
        if (isLeft(item(order, i))) i++;
        else {
          const swap = item(order, i);
          order[i] = item(order, j);
          order[j] = swap;
          j--;
        }
      }
      middle = i;
      node.axis = axis;
    } else {
      const axis = [0, 1, 2].sort(
        (a, b) => item(max, b) - item(min, b) - (item(max, a) - item(min, a)) || a - b,
      )[0] as number;
      const span = Array.from(order.subarray(start, end)).sort(
        (a, b) => item(center, a * 3 + axis) - item(center, b * 3 + axis) || a - b,
      );
      order.set(span, start);
      middle = start + Math.floor(n / 2);
      node.axis = axis;
    }
    visit(start, middle, depth + 1);
    node.right = nodes.length;
    visit(middle, end, depth + 1);
    node.escape = nodes.length;
  };
  if (count) visit(0, count, 0);
  return { nodes, order };
}
