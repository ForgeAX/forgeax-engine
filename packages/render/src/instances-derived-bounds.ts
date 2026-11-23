import { type Mat4Like, mat4 } from '@forgeax/engine-math';
import { isFiniteBounds3 } from '@forgeax/engine-types';

// `fingerprintNumericArray` runs on every bounds-cache lookup. Keep the bit
// reinterpretation scratch outside the hot path so a cache hit does not
// allocate a pair of typed arrays for each retained render slot.
const fingerprintScalar = new Float32Array(1);
const fingerprintBits = new Uint32Array(fingerprintScalar.buffer);

/**
 * Inputs owned by the render extract/persistent-scene boundary. Bounds are
 * deliberately derived here instead of being added to the author-facing
 * `Instances` component or written back to a Pack asset.
 */
export interface DerivedInstancesUnionBoundsInput {
  readonly meshAabb: ArrayLike<number> | undefined;
  readonly entityWorld: ArrayLike<number>;
  readonly transforms: ArrayLike<number> | undefined;
}

/**
 * Renderer-owned cache key. Each generation is supplied by the owner that can
 * observe that mutation: mesh/AABB publication, entity world transform, and
 * the packed instance matrix array respectively.
 */
export interface InstanceBoundsCacheKey {
  readonly entityKey: number;
  readonly meshGeneration: number;
  readonly transformGeneration: number;
  readonly matrixGeneration: number;
}

export type InstanceBoundsCacheInput = InstanceBoundsCacheKey & DerivedInstancesUnionBoundsInput;

/**
 * Stable bitwise fingerprint for detached numeric facts used by the cache.
 * Float32 bits are hashed rather than decimal text so a real matrix/AABB
 * change invalidates the projection without keeping another mutable ledger.
 */
export function fingerprintNumericArray(values: ArrayLike<number>): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < values.length; index += 1) {
    fingerprintScalar[0] = Number(values[index]);
    hash = Math.imul(hash ^ (fingerprintBits[0] ?? 0), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function finiteMatrix(matrix: ArrayLike<number>, offset = 0): matrix is Mat4Like {
  if (matrix.length - offset < 16) return false;
  for (let index = 0; index < 16; index += 1) {
    if (!Number.isFinite(matrix[offset + index] as number)) return false;
  }
  return true;
}

function isAffine(matrix: ArrayLike<number>): boolean {
  return (
    (matrix[3] as number) === 0 &&
    (matrix[7] as number) === 0 &&
    (matrix[11] as number) === 0 &&
    (matrix[15] as number) === 1
  );
}

function includeBox(
  out: Float32Array,
  candidate: ArrayLike<number>,
  initialized: boolean,
): boolean {
  const minX = candidate[0] as number;
  const minY = candidate[1] as number;
  const minZ = candidate[2] as number;
  const maxX = candidate[3] as number;
  const maxY = candidate[4] as number;
  const maxZ = candidate[5] as number;
  if (!initialized) {
    out[0] = minX;
    out[1] = minY;
    out[2] = minZ;
    out[3] = maxX;
    out[4] = maxY;
    out[5] = maxZ;
    return true;
  }
  if (minX < (out[0] ?? Number.POSITIVE_INFINITY)) out[0] = minX;
  if (minY < (out[1] ?? Number.POSITIVE_INFINITY)) out[1] = minY;
  if (minZ < (out[2] ?? Number.POSITIVE_INFINITY)) out[2] = minZ;
  if (maxX > (out[3] ?? Number.NEGATIVE_INFINITY)) out[3] = maxX;
  if (maxY > (out[4] ?? Number.NEGATIVE_INFINITY)) out[4] = maxY;
  if (maxZ > (out[5] ?? Number.NEGATIVE_INFINITY)) out[5] = maxZ;
  return true;
}

/** Transform an AABB without per-instance arrays or corner tuples. */
function transformAabb(
  out: Float32Array,
  local: ArrayLike<number>,
  matrix: ArrayLike<number>,
): boolean {
  const minX = local[0] as number;
  const minY = local[1] as number;
  const minZ = local[2] as number;
  const maxX = local[3] as number;
  const maxY = local[4] as number;
  const maxZ = local[5] as number;
  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;
  const extentX = (maxX - minX) * 0.5;
  const extentY = (maxY - minY) * 0.5;
  const extentZ = (maxZ - minZ) * 0.5;

  if (isAffine(matrix)) {
    const centerWorldX =
      (matrix[0] as number) * centerX +
      (matrix[4] as number) * centerY +
      (matrix[8] as number) * centerZ +
      (matrix[12] as number);
    const centerWorldY =
      (matrix[1] as number) * centerX +
      (matrix[5] as number) * centerY +
      (matrix[9] as number) * centerZ +
      (matrix[13] as number);
    const centerWorldZ =
      (matrix[2] as number) * centerX +
      (matrix[6] as number) * centerY +
      (matrix[10] as number) * centerZ +
      (matrix[14] as number);
    const extentWorldX =
      Math.abs(matrix[0] as number) * extentX +
      Math.abs(matrix[4] as number) * extentY +
      Math.abs(matrix[8] as number) * extentZ;
    const extentWorldY =
      Math.abs(matrix[1] as number) * extentX +
      Math.abs(matrix[5] as number) * extentY +
      Math.abs(matrix[9] as number) * extentZ;
    const extentWorldZ =
      Math.abs(matrix[2] as number) * extentX +
      Math.abs(matrix[6] as number) * extentY +
      Math.abs(matrix[10] as number) * extentZ;
    out[0] = centerWorldX - extentWorldX;
    out[1] = centerWorldY - extentWorldY;
    out[2] = centerWorldZ - extentWorldZ;
    out[3] = centerWorldX + extentWorldX;
    out[4] = centerWorldY + extentWorldY;
    out[5] = centerWorldZ + extentWorldZ;
    return isFiniteBounds3(out);
  }

  // Projective/non-affine matrices need the reference corner route. A w
  // interval crossing zero is unbounded, so explicitly return no-cull rather
  // than pretending the finite corner samples enclose the volume.
  let minimumW = Number.POSITIVE_INFINITY;
  let maximumW = Number.NEGATIVE_INFINITY;
  for (let corner = 0; corner < 8; corner += 1) {
    const x = (corner & 1) === 0 ? minX : maxX;
    const y = (corner & 2) === 0 ? minY : maxY;
    const z = (corner & 4) === 0 ? minZ : maxZ;
    const w =
      (matrix[3] as number) * x +
      (matrix[7] as number) * y +
      (matrix[11] as number) * z +
      (matrix[15] as number);
    if (!Number.isFinite(w)) return false;
    if (w < minimumW) minimumW = w;
    if (w > maximumW) maximumW = w;
  }
  if (minimumW <= 0 && maximumW >= 0) return false;

  let unionMinX = Number.POSITIVE_INFINITY;
  let unionMinY = Number.POSITIVE_INFINITY;
  let unionMinZ = Number.POSITIVE_INFINITY;
  let unionMaxX = Number.NEGATIVE_INFINITY;
  let unionMaxY = Number.NEGATIVE_INFINITY;
  let unionMaxZ = Number.NEGATIVE_INFINITY;
  for (let corner = 0; corner < 8; corner += 1) {
    const x = (corner & 1) === 0 ? minX : maxX;
    const y = (corner & 2) === 0 ? minY : maxY;
    const z = (corner & 4) === 0 ? minZ : maxZ;
    const rawX =
      (matrix[0] as number) * x +
      (matrix[4] as number) * y +
      (matrix[8] as number) * z +
      (matrix[12] as number);
    const rawY =
      (matrix[1] as number) * x +
      (matrix[5] as number) * y +
      (matrix[9] as number) * z +
      (matrix[13] as number);
    const rawZ =
      (matrix[2] as number) * x +
      (matrix[6] as number) * y +
      (matrix[10] as number) * z +
      (matrix[14] as number);
    const w =
      (matrix[3] as number) * x +
      (matrix[7] as number) * y +
      (matrix[11] as number) * z +
      (matrix[15] as number);
    const projectedX = rawX / w;
    const projectedY = rawY / w;
    const projectedZ = rawZ / w;
    if (
      !Number.isFinite(projectedX) ||
      !Number.isFinite(projectedY) ||
      !Number.isFinite(projectedZ)
    ) {
      return false;
    }
    if (projectedX < unionMinX) unionMinX = projectedX;
    if (projectedY < unionMinY) unionMinY = projectedY;
    if (projectedZ < unionMinZ) unionMinZ = projectedZ;
    if (projectedX > unionMaxX) unionMaxX = projectedX;
    if (projectedY > unionMaxY) unionMaxY = projectedY;
    if (projectedZ > unionMaxZ) unionMaxZ = projectedZ;
  }
  out[0] = unionMinX;
  out[1] = unionMinY;
  out[2] = unionMinZ;
  out[3] = unionMaxX;
  out[4] = unionMaxY;
  out[5] = unionMaxZ;
  return isFiniteBounds3(out);
}

const composedScratch = mat4.create();
const transformedScratch = new Float32Array(6);

/**
 * Derive the world-space AABB enclosing every instance of a mesh.
 *
 * `undefined` is a conservative signal: the caller must skip CPU culling
 * when an input is missing, malformed, or empty. This prevents an empty
 * `Instances` row from becoming a synthetic identity draw/bounds candidate.
 */
export function deriveInstancesUnionBounds(
  input: DerivedInstancesUnionBoundsInput,
): Float32Array | undefined {
  const { meshAabb, entityWorld, transforms } = input;
  if (!isFiniteBounds3(meshAabb) || !finiteMatrix(entityWorld) || transforms === undefined) {
    return undefined;
  }
  if (transforms.length === 0 || transforms.length % 16 !== 0) return undefined;
  const local = meshAabb;
  const union = new Float32Array(6);
  const composed = composedScratch;
  const transformed = transformedScratch;
  let initialized = false;
  for (let offset = 0; offset < transforms.length; offset += 16) {
    if (!finiteMatrix(transforms, offset)) return undefined;
    mat4.multiply(composed, entityWorld, transforms, offset);
    if (!finiteMatrix(composed) || !transformAabb(transformed, local, composed)) return undefined;
    initialized = includeBox(union, transformed, initialized);
  }
  return initialized && isFiniteBounds3(union) ? union : undefined;
}

interface InstanceBoundsCacheEntry extends InstanceBoundsCacheKey {
  readonly bounds: Float32Array | undefined;
}

export interface InstanceBoundsCacheInspection {
  readonly hits: number;
  readonly misses: number;
  readonly derives: number;
  readonly invalidations: number;
}

/**
 * Small renderer-owned per-entity cache. A changed generation replaces the
 * entry atomically; packed-id reuse is safe when its owner supplies a new
 * generation (the normal RenderScene slot generation contract).
 */
export class InstanceBoundsCache {
  private readonly entries = new Map<number, InstanceBoundsCacheEntry>();
  private hits = 0;
  private misses = 0;
  private derives = 0;
  private invalidations = 0;

  private key(input: Pick<InstanceBoundsCacheKey, 'entityKey'>): number {
    return input.entityKey;
  }

  get(input: InstanceBoundsCacheInput): Float32Array | undefined {
    const key = this.key(input);
    const previous = this.entries.get(key);
    if (
      previous !== undefined &&
      previous.meshGeneration === input.meshGeneration &&
      previous.transformGeneration === input.transformGeneration &&
      previous.matrixGeneration === input.matrixGeneration
    ) {
      this.hits += 1;
      return previous.bounds;
    }
    this.misses += 1;
    this.derives += 1;
    const bounds = deriveInstancesUnionBounds(input);
    this.entries.set(key, {
      entityKey: input.entityKey,
      meshGeneration: input.meshGeneration,
      transformGeneration: input.transformGeneration,
      matrixGeneration: input.matrixGeneration,
      bounds,
    });
    return bounds;
  }

  invalidate(entityKey?: number): void {
    if (entityKey === undefined) {
      if (this.entries.size > 0) this.invalidations += this.entries.size;
      this.entries.clear();
    } else {
      if (this.entries.delete(this.key({ entityKey }))) {
        this.invalidations += 1;
      }
    }
  }

  inspect(): InstanceBoundsCacheInspection {
    return {
      hits: this.hits,
      misses: this.misses,
      derives: this.derives,
      invalidations: this.invalidations,
    };
  }
}
