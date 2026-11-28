import {
  BLAS_INPUT_BUFFER_USAGE,
  type Blas,
  type BlasBuildEntry,
  type Buffer,
  type RhiCommandEncoder,
  type RhiDevice,
  type RhiError,
  type Tlas,
  type TlasInstance,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { createIndexAllocator, type IndexRun } from './index-allocator';
import { type RayReferenceError, rayReferenceFailure } from './scene';
import type { SdfSurfaceCoverage } from './sdf-surface-coverage';
import {
  createWorldAccelerationCoverage,
  WORLD_ACCELERATION_MOTION_ROW_WORDS,
  WORLD_ACCELERATION_TABLE_LAYOUT,
  type WorldAccelerationCoverage,
  worldAccelerationMotionStart,
  worldAccelerationTableWords,
} from './world-acceleration-coverage';

/** Static triangle geometry of one `geometryId`; positions are object-space float32x3. */
export interface WorldAccelerationGeometry {
  readonly geometryId: number;
  readonly positions: Float32Array;
  readonly indices?: Uint16Array | Uint32Array | undefined;
}

/** One traced instance: `transform` is the engine's column-major affine mat4. */
export interface WorldAccelerationInstance {
  readonly instanceId: number;
  readonly geometryId: number;
  readonly mask: number;
  readonly transform: ArrayLike<number>;
  /** Accepted placement qualification in the complete Mesh primitive namespace. */
  readonly surfaceCoverage?: SdfSurfaceCoverage | undefined;
}

export interface WorldAccelerationCoverageChange {
  readonly index: number;
  readonly surfaceCoverage: SdfSurfaceCoverage | undefined;
}

interface WorldAccelerationBudget {
  readonly maxInstances: number;
  /** Capacity of the `faceNormals` table across every referenced geometry. */
  readonly maxTriangles: number;
  /** BLAS builds admitted per `update`; later geometries wait and their instances stay out. */
  readonly maxBlasBuildsPerFrame: number;
}

/**
 * Build input bytes of one TLAS instance: the 64-byte native instance record
 * (`VkAccelerationStructureInstanceKHR` / `MTLAccelerationStructureInstanceDescriptor`
 * as wgpu packs it) that every TLAS build consumes.
 */
const TLAS_INSTANCE_BYTES = 64;
/** One row: instance id, first face normal, (primitive count << modeBits) | coverage mode, bitmap word. */
const ROW_WORDS = WORLD_ACCELERATION_TABLE_LAYOUT.rowWords;

/** The work one `update` encoded. */
export interface WorldAccelerationBuild {
  /** Instances still waiting for their BLAS (absent from the TLAS). */
  readonly pending: number;
  /** BLAS builds encoded: geometries that became resident. */
  readonly blasBuilt: number;
  /** TLAS builds encoded: 1 when a traced record changed, else 0. */
  readonly tlasBuilt: number;
  /**
   * GPU build input bytes: BLAS positions + uint32 indices of each built
   * geometry, plus `TLAS_INSTANCE_BYTES` per traced instance of a TLAS build
   * (the GPU rebuild consumes every record; only changed records are written).
   */
  readonly bytesBuilt: number;
  /** `traversalInstances` rows written: only rows whose record changed, plus row 0 when its count did. */
  readonly rowsWritten: number;
  /** Bytes this owner wrote from the CPU: changed table rows plus new BLAS inputs and face normals. */
  readonly bytesUploaded: number;
  /** Actual partial-coverage payload bytes written; included in bytesUploaded. */
  readonly coverageBytesUploaded: number;
}

/** Cumulative CPU-side work of one acceleration owner; regression evidence for O(changes). */
export interface WorldAccelerationWork {
  /** Traced records written into the retained TLAS instance list (adds, moves, swap-fills). */
  readonly recordsPatched: number;
  /** BLAS released after their last referencing instance left. */
  readonly blasReleased: number;
}

/**
 * The `'ray-query'` world traversal, owned incrementally: one BLAS per
 * `geometryId` (built once, reference-counted by the instances that use it,
 * released after the submission that last referenced it), a dense retained
 * TLAS instance list patched per changed instance (removals swap the last
 * record in), `traversalInstances` (row 0: x = pending instance count; row
 * `customIndex`, starting at 1: instance id, first face normal, count/coverage mode,
 * bitmap word). Its tail holds at most maxTriangles u32 bitmap words, shared by
 * same-Mesh same-pattern placements; the CPU image is the sole retained bitmap.
 * Rows and newly admitted payloads upload only when changed. `faceNormals` (object-space unit normal per
 * triangle; w marks exact coincident opposite-winding coverage) written once
 * per resident geometry. CPU work and uploads are O(changed instances +
 * newly built geometry); the GPU TLAS rebuild itself consumes every record.
 * {@link recover} replaces every GPU object and re-enters every instance
 * through the same build path as a cold start.
 */
export interface WorldAcceleration {
  readonly tlas: Tlas;
  readonly traversalInstances: Buffer;
  readonly faceNormals: Buffer;
  /** Instances owned (traced or waiting for their BLAS). */
  readonly instances: number;
  /** Geometries referenced by at least one instance. */
  readonly geometries: number;
  /** Face rows referenced geometries occupy (or hold until their release submits). */
  readonly triangles: number;
  /** Bounded immutable bitmap words currently referenced by placements, not per-placement copies. */
  readonly coverageWords: number;
  /** A submitted transform changed; publish its stationary successor on the next frame. */
  readonly motionPending: boolean;
  readonly work: WorldAccelerationWork;
  has(instanceId: number): boolean;
  /** Whether `geometryId` is referenced (its face rows are reserved and its BLAS built or queued). */
  hasGeometry(geometryId: number): boolean;
  /**
   * Insert or replace one instance. A new `geometryId` reserves its face rows
   * now and builds its BLAS within a later `update` budget; a resident one is
   * reused. A failure leaves the owner unchanged.
   */
  set(
    instance: WorldAccelerationInstance,
    geometry: WorldAccelerationGeometry,
  ): Result<void, RayReferenceError>;
  /** Replace one owned instance's transform; its BLAS and row stay. */
  move(instanceId: number, transform: ArrayLike<number>): Result<void, RayReferenceError>;
  /** Replace only accepted material qualification; geometry and BLAS remain shared. */
  setCoverage(
    instanceId: number,
    coverage: SdfSurfaceCoverage | undefined,
  ): Result<void, RayReferenceError>;
  /** Acquire the complete material batch before changing any owned record. */
  setCoverages(
    changes: readonly WorldAccelerationCoverageChange[],
  ): Result<void, RayReferenceError>;
  remove(instanceId: number): void;
  /** Encode the budgeted BLAS builds plus one TLAS build when a traced record changed. */
  update(encoder: RhiCommandEncoder): Result<WorldAccelerationBuild, RhiError | RayReferenceError>;
  /** The submission that consumes everything encoded or released so far. */
  track(completed: Promise<unknown>): void;
  /** Replace every GPU object (retired after in-flight work) and rebuild from the owned roster. */
  recover(): Result<void, RhiError | RayReferenceError>;
  dispose(): void;
}

interface Resident {
  readonly blas: Blas;
  readonly buffers: readonly Buffer[];
}

interface GeometryEntry {
  readonly geometry: WorldAccelerationGeometry;
  readonly indices: Uint32Array;
  readonly faces: IndexRun;
  readonly bytes: number;
  refs: number;
  resident: Resident | undefined;
  /** Waiting instances (by id) that join the TLAS once the BLAS is resident. */
  readonly waiting: Set<number>;
}

interface OwnedInstance {
  readonly geometryId: number;
  mask: number;
  transform: number[];
  previousTransform: number[] | undefined;
  /** 1-based TLAS row (its `customIndex`), or 0 while waiting for the BLAS. */
  row: number;
  coverage: WorldAccelerationCoverage;
}

const COPY_DST = 0x8,
  STORAGE = 0x80;

const FACE_BITS_F32 = new Float32Array(1);
const FACE_BITS_U32 = new Uint32Array(FACE_BITS_F32.buffer);

function canonicalFloatBits(v: number): number {
  if (v === 0) return 0;
  FACE_BITS_F32[0] = v;
  return FACE_BITS_U32[0] ?? 0;
}

function compareVertexTriple(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  if (ax !== bx) return ax < bx ? -1 : 1;
  if (ay !== by) return ay < by ? -1 : 1;
  return az === bz ? 0 : az < bz ? -1 : 1;
}

function hashNineWords(keys: Uint32Array, base: number): number {
  let h = 2166136261;
  for (let i = 0; i < 9; i++) {
    h = Math.imul(h ^ (keys[base + i] ?? 0), 16777619);
  }
  return h >>> 0;
}

function sameNineWords(keys: Uint32Array, a: number, b: number): boolean {
  for (let i = 0; i < 9; i++) {
    if (keys[a + i] !== keys[b + i]) return false;
  }
  return true;
}

function writeSortedVertexKeys(
  keys: Uint32Array,
  base: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
): void {
  let ax = canonicalFloatBits(x0);
  let ay = canonicalFloatBits(y0);
  let az = canonicalFloatBits(z0);
  let bx = canonicalFloatBits(x1);
  let by = canonicalFloatBits(y1);
  let bz = canonicalFloatBits(z1);
  let cx = canonicalFloatBits(x2);
  let cy = canonicalFloatBits(y2);
  let cz = canonicalFloatBits(z2);
  if (compareVertexTriple(ax, ay, az, bx, by, bz) > 0) {
    let tmp = ax;
    ax = bx;
    bx = tmp;
    tmp = ay;
    ay = by;
    by = tmp;
    tmp = az;
    az = bz;
    bz = tmp;
  }
  if (compareVertexTriple(bx, by, bz, cx, cy, cz) > 0) {
    let tmp = bx;
    bx = cx;
    cx = tmp;
    tmp = by;
    by = cy;
    cy = tmp;
    tmp = bz;
    bz = cz;
    cz = tmp;
    if (compareVertexTriple(ax, ay, az, bx, by, bz) > 0) {
      tmp = ax;
      ax = bx;
      bx = tmp;
      tmp = ay;
      ay = by;
      by = tmp;
      tmp = az;
      az = bz;
      bz = tmp;
    }
  }
  keys[base] = ax;
  keys[base + 1] = ay;
  keys[base + 2] = az;
  keys[base + 3] = bx;
  keys[base + 4] = by;
  keys[base + 5] = bz;
  keys[base + 6] = cx;
  keys[base + 7] = cy;
  keys[base + 8] = cz;
}

function markCoincidentOppositeWinding(
  out: Float32Array,
  keys: Uint32Array,
  heads: Int32Array,
  next: Int32Array,
  mask: number,
  t: number,
): void {
  const keyBase = t * 9;
  const outBase = t * 4;
  const unx = out[outBase] as number;
  const uny = out[outBase + 1] as number;
  const unz = out[outBase + 2] as number;
  const bucket = hashNineWords(keys, keyBase) & mask;
  let existing = heads[bucket] as number;
  while (existing !== -1) {
    if (sameNineWords(keys, existing * 9, keyBase)) {
      const eBase = existing * 4;
      const dot =
        (out[eBase] as number) * unx +
        (out[eBase + 1] as number) * uny +
        (out[eBase + 2] as number) * unz;
      if (dot < 0 || out[eBase + 3] === 1) {
        out[eBase + 3] = 1;
        out[outBase + 3] = 1;
      }
    }
    existing = next[existing] as number;
  }
  next[t] = heads[bucket] as number;
  heads[bucket] = t;
}

function posCoord(positions: Float32Array, index: number): number {
  return positions[index] ?? 0;
}

/** Object-space unit normal per triangle, plus exact coincident opposite-winding coverage. */
export function triangleFaceNormals(
  positions: Float32Array,
  indices: ArrayLike<number>,
): Float32Array {
  const triCount = (indices.length / 3) | 0;
  const out = new Float32Array(triCount * 4);
  if (triCount === 0) return out;
  let tableSize = 16;
  while (tableSize < triCount * 2) tableSize <<= 1;
  const mask = tableSize - 1;
  const heads = new Int32Array(tableSize).fill(-1);
  const next = new Int32Array(triCount).fill(-1);
  const keys = new Uint32Array(triCount * 9);
  for (let t = 0; t < triCount; t++) {
    const i0 = (indices[t * 3] ?? 0) * 3;
    const i1 = (indices[t * 3 + 1] ?? 0) * 3;
    const i2 = (indices[t * 3 + 2] ?? 0) * 3;
    const x0 = posCoord(positions, i0);
    const y0 = posCoord(positions, i0 + 1);
    const z0 = posCoord(positions, i0 + 2);
    const x1 = posCoord(positions, i1);
    const y1 = posCoord(positions, i1 + 1);
    const z1 = posCoord(positions, i1 + 2);
    const x2 = posCoord(positions, i2);
    const y2 = posCoord(positions, i2 + 1);
    const z2 = posCoord(positions, i2 + 2);
    const ax = x1 - x0;
    const ay = y1 - y0;
    const az = z1 - z0;
    const bx = x2 - x0;
    const by = y2 - y0;
    const bz = z2 - z0;
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const length = Math.hypot(nx, ny, nz);
    if (length > 0) {
      const inv = 1 / length;
      const outBase = t * 4;
      out[outBase] = nx * inv;
      out[outBase + 1] = ny * inv;
      out[outBase + 2] = nz * inv;
      writeSortedVertexKeys(keys, t * 9, x0, y0, z0, x1, y1, z1, x2, y2, z2);
      markCoincidentOppositeWinding(out, keys, heads, next, mask, t);
    }
  }
  return out;
}

/** Column-major affine mat4 to the 3x4 row-major object-to-world rows a TLAS instance takes. */
export function tlasTransform(transform: ArrayLike<number>): number[] {
  return [
    transform[0] ?? NaN,
    transform[4] ?? NaN,
    transform[8] ?? NaN,
    transform[12] ?? NaN,
    transform[1] ?? NaN,
    transform[5] ?? NaN,
    transform[9] ?? NaN,
    transform[13] ?? NaN,
    transform[2] ?? NaN,
    transform[6] ?? NaN,
    transform[10] ?? NaN,
    transform[14] ?? NaN,
  ];
}

export function createWorldAcceleration(
  device: RhiDevice,
  budget: WorldAccelerationBudget,
): Result<WorldAcceleration, RhiError | RayReferenceError> {
  const caps = device.caps.rayQuery;
  const tableWords = worldAccelerationTableWords(budget.maxInstances, budget.maxTriangles);
  if (
    ![budget.maxInstances, budget.maxTriangles, budget.maxBlasBuildsPerFrame].every(
      (v) => Number.isSafeInteger(v) && v >= 1,
    ) ||
    !Number.isSafeInteger(tableWords) ||
    tableWords * 4 > (device.limits.maxStorageBufferBindingSize ?? Infinity) ||
    (caps.supported && budget.maxInstances > caps.maxTlasInstanceCount)
  )
    return rayReferenceFailure(
      'world acceleration requires positive budgets within caps.rayQuery.maxTlasInstanceCount',
      true,
    );
  interface Gpu {
    readonly tlas: Tlas;
    readonly rows: Buffer;
    readonly normals: Buffer;
  }
  const createGpu = (): Result<Gpu, RhiError | RayReferenceError> => {
    const tlas = device.createTlas({ label: 'world.tlas', maxInstances: budget.maxInstances });
    if (!tlas.ok) return tlas;
    const rows = device.createBuffer({
      label: 'world.traversal-instances',
      size: tableWords * 4,
      usage: STORAGE | COPY_DST | 4,
    });
    if (!rows.ok) {
      device.destroyTlas(tlas.value);
      return rows;
    }
    const normals = device.createBuffer({
      label: 'world.face-normals',
      size: budget.maxTriangles * 16,
      usage: STORAGE | COPY_DST,
    });
    if (!normals.ok) {
      device.destroyTlas(tlas.value);
      device.destroyBuffer(rows.value);
      return normals;
    }
    return ok({ tlas: tlas.value, rows: rows.value, normals: normals.value });
  };
  const made = createGpu();
  if (!made.ok) return made;
  let gpu = made.value;

  const geometries = new Map<number, GeometryEntry>();
  const owned = new Map<number, OwnedInstance>();
  const faces = createIndexAllocator(budget.maxTriangles);
  /** Dense retained TLAS records; record i has `customIndex` i + 1. */
  const traced: TlasInstance[] = [];
  /** CPU image of `traversalInstances`; rows are rewritten only when their record changes. */
  const table = new Uint32Array(tableWords);
  const motionStart = worldAccelerationMotionStart(budget.maxInstances, budget.maxTriangles);
  const motionRows = new Float32Array(table.buffer);
  const dirtyMotion = new Set<OwnedInstance>();
  const encodedMotion = new Map<OwnedInstance, number[]>();
  const coverage = createWorldAccelerationCoverage(
    table,
    (budget.maxInstances + 1) * ROW_WORDS,
    budget.maxTriangles,
  );
  /** Instance id per traced record, for the swap-remove fill. */
  const tracedIds: number[] = [];
  const dirtyRows = new Set<number>();
  let tlasDirty = true;
  let waiting = 0;
  let uploadedPending = -1;
  let unknownPlacements = 0;
  let uploadedUnknown = -1;
  /** Geometries whose BLAS is unbuilt, in reference order; released entries are skipped. */
  let queue: number[] = [];
  /** Released BLAS and face rows, retired with the next tracked submission. */
  let releasing: { readonly resident: Resident | undefined; readonly faces: IndexRun }[] = [];
  let inFlight: Promise<unknown> = Promise.resolve();
  const work = { recordsPatched: 0, blasReleased: 0 };
  let triangleRows = 0;
  const freeFaces = (run: IndexRun) => {
    faces.free(run);
    triangleRows -= run.end - run.first;
  };

  const destroyResident = (resident: Resident) => {
    device.destroyBlas(resident.blas);
    for (const buffer of resident.buffers) device.destroyBuffer(buffer);
  };
  const destroyGpu = (retired: Gpu) => {
    device.destroyTlas(retired.tlas);
    device.destroyBuffer(retired.rows);
    device.destroyBuffer(retired.normals);
  };
  const afterFlight = (release: () => void) => {
    void inFlight.then(release, release);
  };

  const writeCoverage = (row: number, qualified: WorldAccelerationCoverage) => {
    table[row * ROW_WORDS + 2] =
      qualified.primitives * (1 << WORLD_ACCELERATION_TABLE_LAYOUT.modeBits) + qualified.mode;
    table[row * ROW_WORDS + 3] = qualified.firstWord;
    dirtyRows.add(row);
  };
  const writeRecord = (row: number, id: number, entry: GeometryEntry, instance: OwnedInstance) => {
    const resident = entry.resident;
    if (resident === undefined) throw new Error('world acceleration traced an unbuilt BLAS');
    traced[row - 1] = {
      blas: resident.blas,
      transform: instance.transform,
      customIndex: row,
      mask: instance.mask,
    };
    tracedIds[row - 1] = id;
    table[row * ROW_WORDS] = id;
    table[row * ROW_WORDS + 1] = entry.faces.first;
    writeCoverage(row, instance.coverage);
    instance.row = row;
    dirtyMotion.add(instance);
    dirtyRows.add(row);
    tlasDirty = true;
    work.recordsPatched++;
  };
  const trace = (id: number, instance: OwnedInstance, entry: GeometryEntry) => {
    writeRecord(traced.length + 1, id, entry, instance);
  };
  const untrace = (instance: OwnedInstance) => {
    const row = instance.row;
    instance.row = 0;
    const last = traced.length;
    const lastId = tracedIds[last - 1];
    traced.pop();
    tracedIds.pop();
    tlasDirty = true;
    if (row === last || lastId === undefined) return;
    const moved = owned.get(lastId);
    const entry = moved === undefined ? undefined : geometries.get(moved.geometryId);
    if (moved === undefined || entry === undefined)
      throw new Error('world acceleration lost a traced instance');
    writeRecord(row, lastId, entry, moved);
  };
  /** Geometries whose last instance left during this edit; released at the next update. */
  const orphaned = new Set<number>();
  const release = (entry: GeometryEntry, id: number) => {
    if (--entry.refs === 0) orphaned.add(id);
  };
  // A same-edit remove and re-add (a moved or respawned instance) keeps its BLAS.
  const releaseOrphans = () => {
    for (const id of orphaned) {
      const entry = geometries.get(id);
      if (entry === undefined || entry.refs > 0) continue;
      geometries.delete(id);
      releasing.push({ resident: entry.resident, faces: entry.faces });
      work.blasReleased++;
    }
    orphaned.clear();
  };
  const drop = (id: number) => {
    const instance = owned.get(id);
    if (instance === undefined) return;
    owned.delete(id);
    dirtyMotion.delete(instance);
    encodedMotion.delete(instance);
    coverage.release(instance.coverage);
    if (instance.coverage.mode !== 0) unknownPlacements--;
    const entry = geometries.get(instance.geometryId);
    if (entry === undefined) throw new Error('world acceleration lost a referenced geometry');
    if (instance.row > 0) untrace(instance);
    else if (entry.waiting.delete(id)) waiting--;
    release(entry, instance.geometryId);
  };

  const reference = (
    geometry: WorldAccelerationGeometry,
  ): Result<GeometryEntry, RayReferenceError> => {
    const present = geometries.get(geometry.geometryId);
    if (present !== undefined) return ok(present);
    const positions = geometry.positions;
    const indices = Uint32Array.from(
      geometry.indices ?? { length: positions.length / 3 },
      (v, i) => v ?? i,
    );
    if (positions.length < 9 || positions.length % 3 || indices.length % 3 || !indices.length)
      return rayReferenceFailure('world acceleration requires whole float32x3 triangle lists');
    if (caps.supported && indices.length / 3 > caps.maxBlasPrimitiveCount)
      return rayReferenceFailure('a mesh exceeds caps.rayQuery.maxBlasPrimitiveCount', true);
    const run = faces.allocate(indices.length / 3);
    if (run === undefined)
      return rayReferenceFailure('world acceleration exceeds its triangle budget', true);
    triangleRows += run.end - run.first;
    const entry: GeometryEntry = {
      geometry,
      indices,
      faces: run,
      bytes: positions.byteLength + indices.byteLength,
      refs: 0,
      resident: undefined,
      waiting: new Set(),
    };
    geometries.set(geometry.geometryId, entry);
    queue.push(geometry.geometryId);
    return ok(entry);
  };

  const build = (
    entry: GeometryEntry,
  ): Result<
    {
      resident: Resident;
      build: BlasBuildEntry;
      bytes: number;
    },
    RhiError
  > => {
    const { geometry, indices } = entry;
    const positions = geometry.positions;
    const blas = device.createBlas({
      label: `world.blas.${geometry.geometryId}`,
      geometries: [
        {
          vertexFormat: 'float32x3',
          // The query forces opaque only when every placement is known opaque.
          // Mixed scenes must expose candidates, including equal-distance unknown triangles.
          opaque: false,
          vertexCount: positions.length / 3,
          index: { format: 'uint32', count: indices.length },
        },
      ],
    });
    if (!blas.ok) return blas;
    const vertexBuffer = device.createBuffer({
      label: `world.blas.${geometry.geometryId}.positions`,
      size: positions.byteLength,
      usage: BLAS_INPUT_BUFFER_USAGE | COPY_DST,
    });
    const indexBuffer = vertexBuffer.ok
      ? device.createBuffer({
          label: `world.blas.${geometry.geometryId}.indices`,
          size: indices.byteLength,
          usage: BLAS_INPUT_BUFFER_USAGE | COPY_DST,
        })
      : vertexBuffer;
    const releaseBuild = () => {
      device.destroyBlas(blas.value);
      if (vertexBuffer.ok) device.destroyBuffer(vertexBuffer.value);
      if (indexBuffer.ok) device.destroyBuffer(indexBuffer.value);
    };
    if (!vertexBuffer.ok) {
      releaseBuild();
      return vertexBuffer;
    }
    if (!indexBuffer.ok) {
      releaseBuild();
      return indexBuffer;
    }
    const normals = triangleFaceNormals(positions, indices);
    for (const [target, offset, bytes] of [
      [vertexBuffer.value, 0, positions],
      [indexBuffer.value, 0, indices],
      [gpu.normals, entry.faces.first * 16, normals],
    ] as const) {
      const wrote = device.queue.writeBuffer(target, offset, bytes);
      if (!wrote.ok) {
        releaseBuild();
        return wrote;
      }
    }
    return ok({
      resident: { blas: blas.value, buffers: [vertexBuffer.value, indexBuffer.value] },
      build: {
        blas: blas.value,
        geometries: [
          {
            vertexBuffer: vertexBuffer.value,
            vertexStride: 12,
            index: { buffer: indexBuffer.value },
          },
        ],
      },
      bytes: entry.bytes + normals.byteLength,
    });
  };

  const admitTransform = (transform: ArrayLike<number>): Result<number[], RayReferenceError> => {
    const rows = tlasTransform(transform);
    return rows.every(Number.isFinite)
      ? ok(rows)
      : rayReferenceFailure('world acceleration requires finite instance transforms');
  };

  const setCoverages = (changes: readonly WorldAccelerationCoverageChange[]) => {
    const staged: { instance: OwnedInstance; qualified: WorldAccelerationCoverage }[] = [];
    const reject = (error: ReturnType<typeof rayReferenceFailure>) => {
      for (const change of staged) coverage.release(change.qualified);
      return error;
    };
    for (const change of changes) {
      const instance = owned.get(change.index);
      if (instance === undefined) continue;
      const entry = geometries.get(instance.geometryId);
      if (entry === undefined)
        return reject(rayReferenceFailure('world acceleration lost coverage geometry'));
      const qualified = coverage.acquire(
        instance.geometryId,
        entry.indices.length / 3,
        change.surfaceCoverage,
      );
      if (!qualified.ok) return reject(qualified);
      staged.push({ instance, qualified: qualified.value });
    }
    for (const { instance, qualified } of staged) {
      if (
        instance.coverage.mode === qualified.mode &&
        instance.coverage.firstWord === qualified.firstWord
      ) {
        coverage.release(qualified);
        continue;
      }
      if (instance.coverage.mode !== 0) unknownPlacements--;
      coverage.release(instance.coverage);
      instance.coverage = qualified;
      if (instance.coverage.mode !== 0) unknownPlacements++;
      if (instance.row > 0) writeCoverage(instance.row, instance.coverage);
    }
    return ok(undefined);
  };

  const uploadCoverage = () => {
    if (uploadedPending !== waiting || uploadedUnknown !== unknownPlacements) {
      table[0] = waiting;
      table[1] = unknownPlacements;
      table[2] = (budget.maxInstances + 1) * ROW_WORDS;
      table[3] = budget.maxTriangles;
      dirtyRows.add(0);
      uploadedPending = waiting;
      uploadedUnknown = unknownPlacements;
    }
    let bytes = 0;
    for (const payload of coverage.pending()) {
      const wrote = device.queue.writeBuffer(gpu.rows, payload.firstWord * 4, payload.data);
      if (!wrote.ok) return wrote;
      bytes += payload.data.byteLength;
    }
    coverage.committed();
    return ok(bytes);
  };

  const uploadMotion = (motion: readonly OwnedInstance[]) => {
    let bytesUploaded = 0;
    const motionOffset = (row: number) =>
      motionStart + (row - 1) * WORLD_ACCELERATION_MOTION_ROW_WORDS;
    for (const instance of motion) {
      const base = motionOffset(instance.row);
      const previous = instance.previousTransform;
      const moved =
        previous !== undefined && !previous.every((value, i) => value === instance.transform[i]);
      if (moved) motionRows.set(previous, base);
      else motionRows.fill(0, base, base + 12);
      table[base + 12] = moved ? 2 : previous === undefined ? 0 : 1;
    }
    for (let i = 0; i < motion.length; ) {
      const first = (motion[i] as OwnedInstance).row;
      let end = first + 1;
      while (motion[++i]?.row === end) end++;
      const offset = motionOffset(first);
      const data = table.subarray(offset, motionOffset(end));
      const wrote = device.queue.writeBuffer(gpu.rows, offset * 4, data);
      if (!wrote.ok) return wrote;
      bytesUploaded += data.byteLength;
    }
    return ok(bytesUploaded);
  };

  const uploadDirtyRows = () => {
    const rows = [...dirtyRows].sort((a, b) => a - b);
    dirtyRows.clear();
    let bytesUploaded = 0;
    let rowsWritten = 0;
    for (let i = 0; i < rows.length; ) {
      const first = rows[i] as number;
      let end = first + 1;
      while (rows[++i] === end) end++;
      const data = table.subarray(first * ROW_WORDS, end * ROW_WORDS);
      const wrote = device.queue.writeBuffer(gpu.rows, first * ROW_WORDS * 4, data);
      if (!wrote.ok) return wrote;
      rowsWritten += end - first;
      bytesUploaded += data.byteLength;
    }
    return ok({ rowsWritten, bytesUploaded });
  };

  const self: WorldAcceleration = {
    get tlas() {
      return gpu.tlas;
    },
    get traversalInstances() {
      return gpu.rows;
    },
    get faceNormals() {
      return gpu.normals;
    },
    get instances() {
      return owned.size;
    },
    get geometries() {
      return geometries.size;
    },
    get triangles() {
      return triangleRows;
    },
    get coverageWords() {
      return coverage.words;
    },
    get motionPending() {
      return dirtyMotion.size !== 0;
    },
    work,
    has: (id) => owned.has(id),
    hasGeometry: (id) => geometries.has(id),
    set(instance, geometry) {
      if (geometry.geometryId !== instance.geometryId)
        return rayReferenceFailure('world acceleration instance and geometry identities differ');
      const transform = admitTransform(instance.transform);
      if (!transform.ok) return transform;
      const present = owned.get(instance.instanceId);
      if (present?.geometryId === instance.geometryId) {
        const changed = self.setCoverage(instance.instanceId, instance.surfaceCoverage);
        if (!changed.ok) return changed;
        present.mask = instance.mask & 0xff;
        return self.move(instance.instanceId, instance.transform);
      }
      if (present === undefined && owned.size >= budget.maxInstances)
        return rayReferenceFailure('world acceleration exceeds its instance budget', true);
      const qualified = coverage.acquire(
        instance.geometryId,
        (geometry.indices?.length ?? geometry.positions.length / 3) / 3,
        instance.surfaceCoverage,
      );
      if (!qualified.ok) return qualified;
      const referenced = reference(geometry);
      if (!referenced.ok) {
        coverage.release(qualified.value);
        return referenced;
      }
      const entry = referenced.value;
      entry.refs++;
      if (present !== undefined) drop(instance.instanceId);
      const next: OwnedInstance = {
        geometryId: instance.geometryId,
        mask: instance.mask & 0xff,
        transform: transform.value,
        previousTransform: undefined,
        row: 0,
        coverage: qualified.value,
      };
      if (next.coverage.mode !== 0) unknownPlacements++;
      owned.set(instance.instanceId, next);
      if (entry.resident !== undefined) trace(instance.instanceId, next, entry);
      else {
        entry.waiting.add(instance.instanceId);
        waiting++;
      }
      return ok(undefined);
    },
    setCoverage(id, source) {
      return setCoverages([{ index: id, surfaceCoverage: source }]);
    },
    setCoverages,
    move(id, to) {
      const instance = owned.get(id);
      if (instance === undefined) return ok(undefined);
      const transform = admitTransform(to);
      if (!transform.ok) return transform;
      if (!transform.value.every((value, i) => value === instance.transform[i]))
        instance.transform = transform.value;
      const entry = geometries.get(instance.geometryId);
      if (instance.row > 0 && entry !== undefined) writeRecord(instance.row, id, entry, instance);
      return ok(undefined);
    },
    remove: drop,
    update(encoder) {
      releaseOrphans();
      const builds: BlasBuildEntry[] = [];
      let bytesBuilt = 0;
      let bytesUploaded = 0;
      const built: GeometryEntry[] = [];
      let consumed = 0;
      for (; consumed < queue.length && builds.length < budget.maxBlasBuildsPerFrame; consumed++) {
        const entry = geometries.get(queue[consumed] as number);
        if (entry === undefined || entry.resident !== undefined) continue;
        const made = build(entry);
        if (!made.ok) return made;
        entry.resident = made.value.resident;
        builds.push(made.value.build);
        built.push(entry);
        bytesBuilt += entry.bytes;
        bytesUploaded += made.value.bytes;
      }
      queue = consumed === queue.length ? [] : queue.slice(consumed);
      for (const entry of built) {
        for (const id of entry.waiting) {
          const instance = owned.get(id);
          if (instance !== undefined) trace(id, instance, entry);
        }
        waiting -= entry.waiting.size;
        entry.waiting.clear();
      }
      // Coverage belongs to the roster being encoded: an omitted BLAS proves neither hit nor miss.
      const uploaded = uploadCoverage();
      if (!uploaded.ok) return uploaded;
      const coverageBytesUploaded = uploaded.value;
      bytesUploaded += coverageBytesUploaded;
      const uploadedRows = uploadDirtyRows();
      if (!uploadedRows.ok) return uploadedRows;
      bytesUploaded += uploadedRows.value.bytesUploaded;
      const motion = [...dirtyMotion].sort((a, b) => a.row - b.row);
      const motionUploaded = uploadMotion(motion);
      if (!motionUploaded.ok) return motionUploaded;
      bytesUploaded += motionUploaded.value;
      const tlasBuilt = builds.length > 0 || tlasDirty;
      if (tlasBuilt) {
        const encoded = encoder.buildAccelerationStructures(builds, [
          { tlas: gpu.tlas, instances: traced },
        ]);
        if (!encoded.ok) return encoded;
        tlasDirty = false;
        bytesBuilt += traced.length * TLAS_INSTANCE_BYTES;
      }
      for (const instance of motion) {
        if (instance.previousTransform !== instance.transform)
          encodedMotion.set(instance, instance.transform);
      }
      dirtyMotion.clear();
      return ok({
        pending: waiting,
        blasBuilt: builds.length,
        tlasBuilt: tlasBuilt ? 1 : 0,
        bytesBuilt,
        rowsWritten: uploadedRows.value.rowsWritten,
        bytesUploaded,
        coverageBytesUploaded,
      });
    },
    track(completed) {
      inFlight = completed;
      for (const [instance, transform] of encodedMotion) {
        instance.previousTransform = transform;
        dirtyMotion.add(instance);
      }
      encodedMotion.clear();
      if (releasing.length === 0) return;
      const retired = releasing;
      releasing = [];
      // Face rows are reused by later queue writes, which order after this submission.
      for (const released of retired) freeFaces(released.faces);
      afterFlight(() => {
        for (const released of retired)
          if (released.resident !== undefined) destroyResident(released.resident);
      });
    },
    recover() {
      const replacement = createGpu();
      if (!replacement.ok) return replacement;
      releaseOrphans();
      const retired = gpu;
      const residents: Resident[] = [];
      for (const released of releasing) {
        freeFaces(released.faces);
        if (released.resident !== undefined) residents.push(released.resident);
      }
      releasing = [];
      gpu = replacement.value;
      // Clear derived, mark every source dirty: every geometry rebuilds, every instance waits.
      traced.length = 0;
      tracedIds.length = 0;
      waiting = 0;
      queue = [];
      for (const [id, entry] of geometries) {
        if (entry.resident !== undefined) residents.push(entry.resident);
        entry.resident = undefined;
        entry.waiting.clear();
        queue.push(id);
      }
      for (const [id, instance] of owned) {
        instance.row = 0;
        geometries.get(instance.geometryId)?.waiting.add(id);
        waiting++;
      }
      dirtyRows.clear();
      dirtyMotion.clear();
      encodedMotion.clear();
      uploadedPending = -1;
      uploadedUnknown = -1;
      coverage.recover();
      tlasDirty = true;
      afterFlight(() => {
        destroyGpu(retired);
        for (const resident of residents) destroyResident(resident);
      });
      return ok(undefined);
    },
    dispose() {
      orphaned.clear();
      for (const entry of geometries.values())
        if (entry.resident !== undefined) destroyResident(entry.resident);
      for (const released of releasing)
        if (released.resident !== undefined) destroyResident(released.resident);
      geometries.clear();
      owned.clear();
      releasing = [];
      destroyGpu(gpu);
    },
  };
  return ok(self);
}
