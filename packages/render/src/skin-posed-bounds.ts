import type { World } from '@forgeax/engine-ecs';
import { box3, type Mat4Like, mat4 } from '@forgeax/engine-math';
import type { MeshAsset } from '@forgeax/engine-types';
import { compareSkinGeometryBytes } from './skin-geometry-bytes';
import type { SkinPose } from './systems/skin-palette-types';

const cachesByWorld = new WeakMap<World, Map<string, SkinPosedBoundsCache>>();
const MAX_CACHED_SKINS = 32;
const MAX_CACHED_GEOMETRY_BYTES = 1_048_576;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const bufferOf = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const offsetOf = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const lengthOf = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;

function ordinaryBuffer(value: ArrayBufferView, prototype: object): boolean {
  try {
    return (
      bufferOf?.call(value) instanceof ArrayBuffer &&
      Object.getPrototypeOf(value) === prototype &&
      Object.getOwnPropertyDescriptor(value, 'length') === undefined
    );
  } catch {
    // A Proxy can advertise a TypedArray prototype without its native slots.
    return false;
  }
}

/** Bounded source-owner scratch; no caller-owned bytes or returned bounds are retained. */
export function skinPosedBoundsCache(world: World, identity: string): SkinPosedBoundsCache {
  let entries = cachesByWorld.get(world);
  if (entries === undefined) {
    entries = new Map();
    cachesByWorld.set(world, entries);
  }
  let cache = entries.get(identity);
  if (cache === undefined) {
    if (entries.size === MAX_CACHED_SKINS) entries.delete(entries.keys().next().value as string);
    cache = new SkinPosedBoundsCache();
    entries.set(identity, cache);
  }
  return cache;
}

function sameBytes(first: ArrayBufferView, second: ArrayBufferView): boolean {
  const byteLength = lengthOf?.call(first) as number;
  if (byteLength !== lengthOf?.call(second)) return false;
  const firstOffset = offsetOf?.call(first) as number;
  const secondOffset = offsetOf?.call(second) as number;
  const firstBuffer = bufferOf?.call(first) as ArrayBuffer;
  const secondBuffer = bufferOf?.call(second) as ArrayBuffer;
  const compared = compareSkinGeometryBytes(
    firstBuffer,
    firstOffset,
    secondBuffer,
    secondOffset,
    byteLength,
  );
  if (compared !== undefined) return compared;
  if (firstOffset % 4 === 0 && secondOffset % 4 === 0 && byteLength % 4 === 0) {
    const words = byteLength / 4;
    const a = new Uint32Array(firstBuffer, firstOffset, words);
    const b = new Uint32Array(secondBuffer, secondOffset, words);
    for (let index = 0; index < words; index++) if (a[index] !== b[index]) return false;
    return true;
  }
  const a = new Uint8Array(firstBuffer, firstOffset, byteLength);
  const b = new Uint8Array(secondBuffer, secondOffset, byteLength);
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

interface JointEnvelopes {
  readonly positions: Float32Array;
  readonly indices: Uint16Array;
  readonly weights: Float32Array;
  readonly jointCount: number;
  readonly bounds: Float64Array;
  readonly minimumSum: number;
  readonly maximumSum: number;
}

function jointEnvelopes(
  positions: Float32Array,
  indices: Uint16Array,
  weights: Float32Array,
  jointCount: number,
): JointEnvelopes | undefined {
  const bounds = new Float64Array(jointCount * 6);
  for (let joint = 0; joint < jointCount; joint++) {
    bounds.fill(Infinity, joint * 6, joint * 6 + 3);
    bounds.fill(-Infinity, joint * 6 + 3, joint * 6 + 6);
  }
  let minimumSum = Infinity;
  let maximumSum = -Infinity;
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const x = positions[vertex * 3] as number;
    const y = positions[vertex * 3 + 1] as number;
    const z = positions[vertex * 3 + 2] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
    let sum = 0;
    for (let lane = 0; lane < 4; lane++) {
      const influence = vertex * 4 + lane;
      const joint = indices[influence] as number;
      const weight = weights[influence] as number;
      if (joint >= jointCount || !Number.isFinite(weight) || weight < 0) return undefined;
      sum += weight;
      if (weight === 0) continue;
      const base = joint * 6;
      bounds[base] = Math.min(bounds[base] as number, x);
      bounds[base + 1] = Math.min(bounds[base + 1] as number, y);
      bounds[base + 2] = Math.min(bounds[base + 2] as number, z);
      bounds[base + 3] = Math.max(bounds[base + 3] as number, x);
      bounds[base + 4] = Math.max(bounds[base + 4] as number, y);
      bounds[base + 5] = Math.max(bounds[base + 5] as number, z);
    }
    if (!(sum > 0) || !Number.isFinite(sum)) return undefined;
    minimumSum = Math.min(minimumSum, sum);
    maximumSum = Math.max(maximumSum, sum);
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint16Array(indices),
    weights: new Float32Array(weights),
    jointCount,
    bounds,
    minimumSum,
    maximumSum,
  };
}

export class SkinPosedBoundsCache {
  private envelopes: JointEnvelopes | undefined;
  private last:
    | {
        geometry?: { positions: Float32Array; indices: Uint16Array; weights: Float32Array };
        palette: Float32Array;
        inverse: Float32Array;
        bounds: Float32Array;
      }
    | undefined;
  private previousPoseRepeated = false;
  private captureGeometry = false;

  conservative(
    positions: Float32Array,
    indices: Uint16Array,
    weights: Float32Array,
    palette: Float32Array,
    inverse: Float32Array,
  ): Float32Array | undefined {
    // The union proof requires affine joints and nonnegative influences.
    // General projective/signed skinning keeps the exact vertex path.
    for (let joint = 0; joint < palette.length / 16; joint++) {
      const base = joint * 16;
      if (
        palette[base + 3] !== 0 ||
        palette[base + 7] !== 0 ||
        palette[base + 11] !== 0 ||
        palette[base + 15] !== 1
      )
        return undefined;
    }
    if (inverse[3] !== 0 || inverse[7] !== 0 || inverse[11] !== 0 || inverse[15] !== 1)
      return undefined;
    this.last = undefined;
    this.previousPoseRepeated = false;
    this.captureGeometry = false;
    let envelope = this.envelopes;
    const jointCount = palette.length / 16;
    if (
      envelope === undefined ||
      envelope.jointCount !== jointCount ||
      !sameBytes(positions, envelope.positions) ||
      !sameBytes(indices, envelope.indices) ||
      !sameBytes(weights, envelope.weights)
    ) {
      envelope = jointEnvelopes(positions, indices, weights, jointCount);
      this.envelopes = envelope;
    }
    if (envelope === undefined) return undefined;
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    let magnitude = 1;
    for (let joint = 0; joint < jointCount; joint++) {
      const box = joint * 6;
      if (envelope.bounds[box] === Infinity) continue;
      const matrix = joint * 16;
      for (let axis = 0; axis < 3; axis++) {
        let low = palette[matrix + 12 + axis] as number;
        let high = low;
        let absolute = Math.abs(low);
        for (let dimension = 0; dimension < 3; dimension++) {
          const coefficient = palette[matrix + dimension * 4 + axis] as number;
          const a = coefficient * (envelope.bounds[box + dimension] as number);
          const b = coefficient * (envelope.bounds[box + dimension + 3] as number);
          low += Math.min(a, b);
          high += Math.max(a, b);
          absolute += Math.max(Math.abs(a), Math.abs(b));
        }
        minimum[axis] = Math.min(minimum[axis] as number, low);
        maximum[axis] = Math.max(maximum[axis] as number, high);
        magnitude = Math.max(magnitude, absolute);
      }
    }
    // Positive normalized weights form a convex combination of transformed
    // joint boxes. Include the raw XYZ envelope as well for unnormalized sums.
    const padding = 64 * 2 ** -23 * magnitude * Math.max(1, envelope.maximumSum);
    const worldBounds = new Float64Array(6);
    for (let axis = 0; axis < 3; axis++) {
      const low = minimum[axis] as number;
      const high = maximum[axis] as number;
      worldBounds[axis] =
        Math.min(
          low,
          low * envelope.minimumSum,
          low * envelope.maximumSum,
          high * envelope.minimumSum,
          high * envelope.maximumSum,
        ) - padding;
      worldBounds[axis + 3] =
        Math.max(
          high,
          low * envelope.minimumSum,
          low * envelope.maximumSum,
          high * envelope.minimumSum,
          high * envelope.maximumSum,
        ) + padding;
    }
    if (!worldBounds.every(Number.isFinite)) return undefined;
    const local = box3.transformBox3(box3.create(), worldBounds, inverse);
    const localPadding = 64 * 2 ** -23 * Math.max(1, ...Array.from(local, Math.abs));
    for (let axis = 0; axis < 3; axis++) {
      local[axis] = (local[axis] as number) - localPadding;
      local[axis + 3] = (local[axis + 3] as number) + localPadding;
    }
    return local.every(Number.isFinite) ? local : undefined;
  }

  read(
    positions: Float32Array,
    indices: Uint16Array,
    weights: Float32Array,
    palette: Float32Array,
    inverse: Float32Array,
  ): Float32Array | undefined {
    this.envelopes = undefined;
    const last = this.last;
    const samePose =
      last !== undefined && sameBytes(palette, last.palette) && sameBytes(inverse, last.inverse);
    // A continuously moving pose has no reuse opportunity. Snapshot geometry
    // only after an observed hold, including the next newly sampled pose.
    this.captureGeometry = samePose || this.previousPoseRepeated;
    this.previousPoseRepeated = samePose;
    const geometry = last?.geometry;
    if (
      !samePose ||
      geometry === undefined ||
      !sameBytes(positions, geometry.positions) ||
      !sameBytes(indices, geometry.indices) ||
      !sameBytes(weights, geometry.weights)
    )
      return undefined;
    return new Float32Array(last.bounds);
  }

  remember(
    positions: Float32Array,
    indices: Uint16Array,
    weights: Float32Array,
    palette: Float32Array,
    inverse: Float32Array,
    bounds: Float32Array,
  ): void {
    let last = this.last;
    if (last === undefined || last.palette.length !== palette.length) {
      last = {
        palette: new Float32Array(palette.length),
        inverse: new Float32Array(inverse.length),
        bounds: new Float32Array(bounds.length),
      };
      this.last = last;
    }
    const previous = last.geometry;
    if (this.captureGeometry) {
      last.geometry = {
        positions:
          previous !== undefined && sameBytes(positions, previous.positions)
            ? previous.positions
            : new Float32Array(positions),
        indices:
          previous !== undefined && sameBytes(indices, previous.indices)
            ? previous.indices
            : new Uint16Array(indices),
        weights:
          previous !== undefined && sameBytes(weights, previous.weights)
            ? previous.weights
            : new Float32Array(weights),
      };
    } else delete last.geometry;
    last.palette.set(palette);
    last.inverse.set(inverse);
    last.bounds.set(bounds);
  }
}

/** Current palette vertices, expressed in the mesh-local space used by culling. */
export function skinPosedBounds(
  mesh: MeshAsset,
  pose: SkinPose,
  meshWorld: Mat4Like,
  cache?: SkinPosedBoundsCache,
  conservative = false,
): Float32Array | undefined {
  const positions = mesh.attributes.position;
  const indices = mesh.attributes.skinIndex;
  const weights = mesh.attributes.skinWeight;
  if (
    !(positions instanceof Float32Array) ||
    positions.length === 0 ||
    positions.length % 3 !== 0 ||
    !(indices instanceof Uint16Array) ||
    !(weights instanceof Float32Array) ||
    indices.length !== (positions.length / 3) * 4 ||
    weights.length !== indices.length
  )
    return undefined;

  const inverse = mat4.invert(mat4.create(), meshWorld);
  const matrix = mat4.multiply(mat4.create(), meshWorld, inverse);
  // Math deliberately returns identity for singular inverses. Such a mesh
  // transform cannot represent this world-space Skin envelope in local space.
  if (
    !matrix.every(
      (value, index) =>
        Number.isFinite(value) && Math.abs(value - (index % 5 === 0 ? 1 : 0)) <= 1e-4,
    )
  )
    return undefined;
  const palette = new Float32Array(pose.jointCount * 16);
  for (let joint = 0; joint < pose.jointCount; joint++) {
    const world = pose.jointWorlds[joint];
    const ibm = pose.inverseBindMatrices[joint];
    if (world === undefined || ibm === undefined || ibm.length !== 16) return undefined;
    mat4.multiply(matrix, world, ibm);
    if (!matrix.every(Number.isFinite)) return undefined;
    palette.set(matrix, joint * 16);
  }
  // Read and validate the live palette first, including caller accessors and
  // invalid/singular input. Only private ordinary buffers enter exact reuse.
  const reusable =
    cache !== undefined &&
    ordinaryBuffer(positions, Float32Array.prototype) &&
    ordinaryBuffer(indices, Uint16Array.prototype) &&
    ordinaryBuffer(weights, Float32Array.prototype) &&
    (lengthOf?.call(positions) as number) +
      (lengthOf?.call(indices) as number) +
      (lengthOf?.call(weights) as number) +
      palette.byteLength +
      (conservative ? pose.jointCount * 6 * 8 : 0) +
      inverse.byteLength +
      24 <=
      MAX_CACHED_GEOMETRY_BYTES
      ? cache
      : undefined;
  if (conservative) {
    const enclosure = reusable?.conservative(positions, indices, weights, palette, inverse);
    if (enclosure !== undefined) return enclosure;
  }
  const previous = reusable?.read(positions, indices, weights, palette, inverse);
  if (previous !== undefined) return previous;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const x = positions[vertex * 3] as number;
    const y = positions[vertex * 3 + 1] as number;
    const z = positions[vertex * 3 + 2] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
    let pointX = 0,
      pointY = 0,
      pointZ = 0;
    let homogeneousWeight = 0;
    for (let lane = 0; lane < 4; lane++) {
      const influence = vertex * 4 + lane;
      const joint = indices[influence] as number;
      const weight = weights[influence] as number;
      if (joint >= pose.jointCount || !Number.isFinite(weight)) return undefined;
      if (weight === 0) continue;
      const base = joint * 16;
      homogeneousWeight +=
        weight *
        ((palette[base + 3] as number) * x +
          (palette[base + 7] as number) * y +
          (palette[base + 11] as number) * z +
          (palette[base + 15] as number));
      pointX +=
        weight *
        ((palette[base] as number) * x +
          (palette[base + 4] as number) * y +
          (palette[base + 8] as number) * z +
          (palette[base + 12] as number));
      pointY +=
        weight *
        ((palette[base + 1] as number) * x +
          (palette[base + 5] as number) * y +
          (palette[base + 9] as number) * z +
          (palette[base + 13] as number));
      pointZ +=
        weight *
        ((palette[base + 2] as number) * x +
          (palette[base + 6] as number) * y +
          (palette[base + 10] as number) * z +
          (palette[base + 14] as number));
    }
    if (!(homogeneousWeight > 0)) return undefined;
    const projectedX = pointX / homogeneousWeight;
    const projectedY = pointY / homogeneousWeight;
    const projectedZ = pointZ / homogeneousWeight;
    if (
      !Number.isFinite(pointX) ||
      !Number.isFinite(pointY) ||
      !Number.isFinite(pointZ) ||
      !Number.isFinite(projectedX) ||
      !Number.isFinite(projectedY) ||
      !Number.isFinite(projectedZ)
    )
      return undefined;
    // Preserve each lane's double-precision accumulation order and include
    // both world XYZ and the homogeneous clip-space position for culling.
    minimum[0] = Math.min(minimum[0] as number, pointX, projectedX);
    minimum[1] = Math.min(minimum[1] as number, pointY, projectedY);
    minimum[2] = Math.min(minimum[2] as number, pointZ, projectedZ);
    maximum[0] = Math.max(maximum[0] as number, pointX, projectedX);
    maximum[1] = Math.max(maximum[1] as number, pointY, projectedY);
    maximum[2] = Math.max(maximum[2] as number, pointZ, projectedZ);
  }
  const worldBounds = [...minimum, ...maximum];
  const localBounds = box3.transformBox3(box3.create(), worldBounds, inverse);
  if (!localBounds.every(Number.isFinite)) return undefined;
  reusable?.remember(positions, indices, weights, palette, inverse, localBounds);
  return localBounds;
}
