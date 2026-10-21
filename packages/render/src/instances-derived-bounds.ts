import type { Mat4Like } from '@forgeax/engine-math';
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
  /** Optional scene/world scope for composite scenes; omitted for standalone tests. */
  readonly worldId?: number;
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

function finiteMatrix(matrix: ArrayLike<number>): matrix is Mat4Like {
  if (matrix.length < 16) return false;
  for (let index = 0; index < 16; index += 1) {
    if (!Number.isFinite(matrix[index] as number)) return false;
  }
  return true;
}

function multiplyMat4(
  out: Float32Array,
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  rightOffset = 0,
): void {
  for (let column = 0; column < 4; column += 1) {
    const rightColumn = rightOffset + column * 4;
    const right0 = Number(right[rightColumn] ?? 0);
    const right1 = Number(right[rightColumn + 1] ?? 0);
    const right2 = Number(right[rightColumn + 2] ?? 0);
    const right3 = Number(right[rightColumn + 3] ?? 0);
    const outOffset = column * 4;
    out[outOffset] =
      Number(left[0] ?? 0) * right0 +
      Number(left[4] ?? 0) * right1 +
      Number(left[8] ?? 0) * right2 +
      Number(left[12] ?? 0) * right3;
    out[outOffset + 1] =
      Number(left[1] ?? 0) * right0 +
      Number(left[5] ?? 0) * right1 +
      Number(left[9] ?? 0) * right2 +
      Number(left[13] ?? 0) * right3;
    out[outOffset + 2] =
      Number(left[2] ?? 0) * right0 +
      Number(left[6] ?? 0) * right1 +
      Number(left[10] ?? 0) * right2 +
      Number(left[14] ?? 0) * right3;
    out[outOffset + 3] =
      Number(left[3] ?? 0) * right0 +
      Number(left[7] ?? 0) * right1 +
      Number(left[11] ?? 0) * right2 +
      Number(left[15] ?? 0) * right3;
  }
}

function finiteMatrixAt(values: ArrayLike<number>, offset: number): boolean {
  if (values.length - offset < 16) return false;
  for (let index = 0; index < 16; index += 1) {
    if (!Number.isFinite(values[offset + index] as number)) return false;
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
  const composed = new Float32Array(16);
  const transformed = new Float32Array(6);
  let initialized = false;
  for (let offset = 0; offset < transforms.length; offset += 16) {
    if (!finiteMatrixAt(transforms, offset)) return undefined;
    multiplyMat4(composed, entityWorld, transforms, offset);
    if (!finiteMatrix(composed) || !transformAabb(transformed, local, composed)) return undefined;
    initialized = includeBox(union, transformed, initialized);
  }
  return initialized && isFiniteBounds3(union) ? union : undefined;
}

/** Children per hierarchy node; four levels cover 65,536 rows. */
const HIERARCHY_FANOUT = 16;
/** Past this many dirty row ranges the change boxes collapse into one pair. */
const MAX_ROW_CHANGE_RANGES = 32;

const composedScratch = new Float32Array(16);
/** Row/node box scratch: hierarchy writes copy out of it instead of allocating subarray views per row. */
const boxScratch = new Float32Array(6);

/**
 * World-space AABBs of changed instance rows for one revision step: pairs of
 * `[old, new]` boxes (12 floats per changed row range). Downstream
 * invalidation (shadow caches) can union these instead of the whole
 * collection bounds when a few rows move.
 */
export interface InstanceRowBoxChange {
  readonly revision: number;
  /** `count * 12` floats: old box (6) then new box (6) per entry. */
  readonly boxes: Float32Array;
  readonly count: number;
}

/**
 * The hierarchy stores affine coefficients independently of the mesh bounds.
 * Editing a shared mesh evaluates one root interval; only changed instance
 * transforms update leaves and ancestors. Coefficient intervals can be looser
 * than the exact union, so actual GPU/triangle queries retain precise culling.
 */
class InstanceRowBoundsHierarchy {
  private readonly coefficients: Float32Array;
  private readonly rowValid: Uint8Array;
  private invalidRows = 0;
  private readonly levels: { readonly coefficients: Float32Array; readonly filled: Uint8Array }[] =
    [];

  constructor(readonly rows: number) {
    this.coefficients = new Float32Array(rows * 12);
    this.rowValid = new Uint8Array(rows);
    let width = rows;
    do {
      width = Math.ceil(width / HIERARCHY_FANOUT);
      this.levels.push({
        coefficients: new Float32Array(width * 24),
        filled: new Uint8Array(width),
      });
    } while (width > 1);
  }

  writeRow(row: number, transforms: ArrayLike<number>): void {
    const offset = row * 16;
    const valid =
      finiteMatrixAt(transforms, offset) &&
      transforms[offset + 3] === 0 &&
      transforms[offset + 7] === 0 &&
      transforms[offset + 11] === 0 &&
      transforms[offset + 15] === 1;
    if (valid) {
      for (let column = 0; column < 4; column++)
        for (let axis = 0; axis < 3; axis++)
          this.coefficients[row * 12 + column * 3 + axis] = transforms[
            offset + column * 4 + axis
          ] as number;
    }
    const was = this.rowValid[row] === 1;
    if (was !== valid) this.invalidRows += valid ? -1 : 1;
    this.rowValid[row] = valid ? 1 : 0;
  }

  markAllRowsUnset(): void {
    this.invalidRows = this.rows;
    this.rowValid.fill(0);
  }

  private refreshNode(level: number, node: number): number {
    const target = this.levels[level] as (typeof this.levels)[number];
    const previous = this.levels[level - 1] as (typeof this.levels)[number];
    const source = level === 0 ? this.coefficients : previous.coefficients;
    const filled = level === 0 ? this.rowValid : previous.filled;
    const stride = level === 0 ? 12 : 24;
    const first = node * HIERARCHY_FANOUT;
    const last = Math.min(first + HIERARCHY_FANOUT, filled.length);
    let initialized = false;
    for (let child = first; child < last; child++) {
      if (filled[child] !== 1) continue;
      for (let field = 0; field < 12; field++) {
        const lo = source[child * stride + field] as number;
        const hi = level === 0 ? lo : (source[child * stride + field + 12] as number);
        const offset = node * 24 + field;
        target.coefficients[offset] = initialized
          ? Math.min(target.coefficients[offset] as number, lo)
          : lo;
        target.coefficients[offset + 12] = initialized
          ? Math.max(target.coefficients[offset + 12] as number, hi)
          : hi;
      }
      initialized = true;
    }
    target.filled[node] = initialized ? 1 : 0;
    return last - first;
  }

  /** Rebuild every node bottom-up; returns node visits. */
  refreshAll(): number {
    let visits = 0;
    for (let level = 0; level < this.levels.length; level += 1) {
      const width = this.levels[level]?.filled.length ?? 0;
      for (let node = 0; node < width; node += 1) visits += this.refreshNode(level, node);
    }
    return visits;
  }

  /** Refresh the ancestors of the given sorted, disjoint row ranges. */
  refreshRows(ranges: readonly { readonly start: number; readonly end: number }[]): number {
    let visits = 0;
    let spans = ranges.map((range) => ({ start: range.start, end: range.end }));
    for (let level = 0; level < this.levels.length; level += 1) {
      const parents: { start: number; end: number }[] = [];
      for (const span of spans) {
        const start = Math.floor(span.start / HIERARCHY_FANOUT);
        const end = Math.floor((span.end - 1) / HIERARCHY_FANOUT) + 1;
        const tail = parents[parents.length - 1];
        if (tail !== undefined && start <= tail.end) tail.end = Math.max(tail.end, end);
        else parents.push({ start, end });
      }
      for (const span of parents) {
        for (let node = span.start; node < span.end; node += 1) {
          visits += this.refreshNode(level, node);
        }
      }
      spans = parents;
    }
    return visits;
  }

  union(mesh: ArrayLike<number> | undefined, world: ArrayLike<number>): Float32Array | undefined {
    if (
      this.invalidRows > 0 ||
      mesh === undefined ||
      !isFiniteBounds3(mesh) ||
      !finiteMatrix(world)
    )
      return undefined;
    const root = this.levels[this.levels.length - 1] as (typeof this.levels)[number];
    if (root.filled[0] !== 1) return undefined;
    const values = root.coefficients;
    for (let axis = 0; axis < 3; axis++) {
      let lo = values[9 + axis] as number;
      let hi = values[21 + axis] as number;
      for (let input = 0; input < 3; input++) {
        const a = values[input * 3 + axis] as number;
        const b = values[input * 3 + axis + 12] as number;
        const x = mesh[input] as number;
        const y = mesh[input + 3] as number;
        lo += Math.min(a * x, a * y, b * x, b * y);
        hi += Math.max(a * x, a * y, b * x, b * y);
      }
      boxScratch[axis] = lo;
      boxScratch[axis + 3] = hi;
    }
    const result = new Float32Array(6);
    return transformAabb(result, boxScratch, world) ? result : undefined;
  }

  rowBounds(
    out: Float32Array,
    first: number,
    last: number,
    mesh: ArrayLike<number>,
    world: ArrayLike<number>,
  ): void {
    let initialized = false;
    for (let row = first; row < last; row++) {
      for (let column = 0; column < 4; column++)
        for (let axis = 0; axis < 3; axis++)
          rowMatrixScratch[column * 4 + axis] = this.coefficients[
            row * 12 + column * 3 + axis
          ] as number;
      multiplyMat4(composedScratch, world, rowMatrixScratch);
      transformAabb(boxScratch, mesh, composedScratch);
      initialized = includeBox(out, boxScratch, initialized);
    }
  }
}

const rowMatrixScratch = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

interface InstanceBoundsCacheEntry extends InstanceBoundsCacheKey {
  readonly bounds: Float32Array | undefined;
  readonly collectionId?: number;
  readonly revision?: number;
  readonly hierarchy?: InstanceRowBoundsHierarchy;
  readonly rowChange?: InstanceRowBoxChange;
}

export interface InstanceBoundsCacheInspection {
  readonly hits: number;
  readonly misses: number;
  readonly derives: number;
  readonly invalidations: number;
  /** Revisions answered by refreshing only dirty rows. */
  readonly rowUpdates: number;
  /** Hierarchy child visits (row boxes or nodes) across derives and updates. */
  readonly nodeVisits: number;
}

/**
 * Optional revision facts for a renderer-owned instance collection. When the
 * cached entry holds `revision - 1` of the same collection and `dirtyRows`
 * is known, the cache refreshes only those rows and their hierarchy chain.
 */
export interface InstanceBoundsRevisionInput {
  readonly collectionId?: number;
  readonly revision?: number;
  /** Sorted, disjoint row ranges changed since `revision - 1`. */
  readonly dirtyRows?: readonly { readonly start: number; readonly end: number }[];
}

/**
 * Small renderer-owned per-entity cache. A changed generation replaces the
 * entry atomically; packed-id reuse is safe when its owner supplies a new
 * generation (the normal RenderScene slot generation contract).
 */
export class InstanceBoundsCache {
  private readonly entries = new Map<string, InstanceBoundsCacheEntry>();
  private hits = 0;
  private misses = 0;
  private derives = 0;
  private invalidations = 0;
  private rowUpdates = 0;
  private nodeVisits = 0;

  private key(input: Pick<InstanceBoundsCacheKey, 'worldId' | 'entityKey'>): string {
    return `${input.worldId === undefined ? '' : `${input.worldId}:`}${input.entityKey}`;
  }

  get(input: InstanceBoundsCacheInput & InstanceBoundsRevisionInput): Float32Array | undefined {
    const key = this.key(input);
    const previous = this.entries.get(key);
    if (
      previous !== undefined &&
      previous.meshGeneration === input.meshGeneration &&
      previous.transformGeneration === input.transformGeneration &&
      previous.matrixGeneration === input.matrixGeneration &&
      previous.collectionId === input.collectionId
    ) {
      this.hits += 1;
      return previous.bounds;
    }
    this.misses += 1;
    if (
      previous?.hierarchy !== undefined &&
      previous.matrixGeneration === input.matrixGeneration &&
      previous.collectionId === input.collectionId &&
      input.transforms?.length === previous.hierarchy.rows * 16
    ) {
      const { rowChange: _stale, ...retained } = previous;
      const adopted = {
        ...retained,
        meshGeneration: input.meshGeneration,
        transformGeneration: input.transformGeneration,
        bounds: previous.hierarchy.union(input.meshAabb, input.entityWorld),
      };
      this.entries.set(key, adopted);
      return adopted.bounds;
    }
    const updated = this.updateRows(previous, input);
    if (updated !== undefined) {
      this.rowUpdates += 1;
      this.entries.set(key, updated);
      return updated.bounds;
    }
    this.derives += 1;
    const entry = this.derive(input);
    this.entries.set(key, entry);
    return entry.bounds;
  }

  /**
   * Old/new world boxes of the rows changed by the entry's latest revision,
   * or undefined when that revision was a full derive (callers then fall
   * back to whole-collection bounds).
   */
  rowChange(entityKey: number, worldId?: number): InstanceRowBoxChange | undefined {
    return this.entries.get(this.key({ entityKey, ...(worldId === undefined ? {} : { worldId }) }))
      ?.rowChange;
  }

  private derive(
    input: InstanceBoundsCacheInput & InstanceBoundsRevisionInput,
  ): InstanceBoundsCacheEntry {
    const base = {
      ...(input.worldId === undefined ? {} : { worldId: input.worldId }),
      entityKey: input.entityKey,
      meshGeneration: input.meshGeneration,
      transformGeneration: input.transformGeneration,
      matrixGeneration: input.matrixGeneration,
    };
    const { meshAabb, entityWorld, transforms } = input;
    if (transforms === undefined || transforms.length === 0 || transforms.length % 16 !== 0) {
      return { ...base, bounds: undefined };
    }
    // A full re-derive of a same-size collection (a moving collection without
    // dirty-row proof) rewrites the previous hierarchy in place: every row and
    // node is recomputed below, and the replaced entry is dropped from the map.
    const reusable = this.entries.get(this.key(input))?.hierarchy;
    const hierarchy =
      reusable !== undefined && reusable.rows === transforms.length / 16
        ? reusable
        : new InstanceRowBoundsHierarchy(transforms.length / 16);
    hierarchy.markAllRowsUnset();
    for (let row = 0; row < hierarchy.rows; row += 1) {
      hierarchy.writeRow(row, transforms);
    }
    this.nodeVisits += hierarchy.rows + hierarchy.refreshAll();
    return {
      ...base,
      bounds: hierarchy.union(meshAabb, entityWorld),
      ...(input.collectionId === undefined ? {} : { collectionId: input.collectionId }),
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      hierarchy,
    };
  }

  private updateRows(
    previous: InstanceBoundsCacheEntry | undefined,
    input: InstanceBoundsCacheInput & InstanceBoundsRevisionInput,
  ): InstanceBoundsCacheEntry | undefined {
    const hierarchy = previous?.hierarchy;
    const { meshAabb, entityWorld, transforms, dirtyRows } = input;
    if (
      previous === undefined ||
      hierarchy === undefined ||
      dirtyRows === undefined ||
      input.revision === undefined ||
      previous.collectionId !== input.collectionId ||
      previous.revision !== input.revision - 1 ||
      previous.meshGeneration !== input.meshGeneration ||
      previous.transformGeneration !== input.transformGeneration ||
      meshAabb === undefined ||
      transforms === undefined ||
      transforms.length !== hierarchy.rows * 16
    ) {
      return undefined;
    }
    for (const range of dirtyRows) {
      if (range.start < 0 || range.end > hierarchy.rows || range.start >= range.end)
        return undefined;
    }
    const collapse = dirtyRows.length > MAX_ROW_CHANGE_RANGES;
    const count = collapse ? 1 : dirtyRows.length;
    const boxes = new Float32Array(count * 12);
    let rowsVisited = 0;
    for (let index = 0; index < dirtyRows.length; index += 1) {
      const range = dirtyRows[index] as { readonly start: number; readonly end: number };
      const entry = collapse ? 0 : index;
      if (!collapse || index === 0) {
        hierarchy.rowBounds(
          boxes.subarray(entry * 12, entry * 12 + 6),
          range.start,
          range.end,
          meshAabb,
          entityWorld,
        );
      } else {
        hierarchy.rowBounds(scratchBox, range.start, range.end, meshAabb, entityWorld);
        includeBox(boxes.subarray(0, 6), scratchBox, true);
      }
      for (let row = range.start; row < range.end; row += 1) {
        hierarchy.writeRow(row, transforms);
      }
      rowsVisited += range.end - range.start;
      if (!collapse || index === 0) {
        hierarchy.rowBounds(
          boxes.subarray(entry * 12 + 6, entry * 12 + 12),
          range.start,
          range.end,
          meshAabb,
          entityWorld,
        );
      } else {
        hierarchy.rowBounds(scratchBox, range.start, range.end, meshAabb, entityWorld);
        includeBox(boxes.subarray(6, 12), scratchBox, true);
      }
    }
    this.nodeVisits += rowsVisited + hierarchy.refreshRows(dirtyRows);
    const { rowChange: _stale, ...retained } = previous;
    const bounds = hierarchy.union(meshAabb, entityWorld);
    // Row boxes are only meaningful while every row (before and after) was
    // finite; otherwise consumers fall back to whole-collection bounds.
    return {
      ...retained,
      matrixGeneration: input.matrixGeneration,
      revision: input.revision,
      bounds,
      ...(bounds === undefined || previous.bounds === undefined
        ? {}
        : { rowChange: { revision: input.revision, boxes, count } }),
    };
  }

  invalidate(entityKey?: number, worldId?: number): void {
    if (entityKey === undefined) {
      if (this.entries.size > 0) this.invalidations += this.entries.size;
      this.entries.clear();
    } else {
      if (
        this.entries.delete(this.key({ entityKey, ...(worldId === undefined ? {} : { worldId }) }))
      ) {
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
      rowUpdates: this.rowUpdates,
      nodeVisits: this.nodeVisits,
    };
  }
}

const scratchBox = new Float32Array(6);
