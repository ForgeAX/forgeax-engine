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
/** One `traversalInstances` row: x = instance id, y = first `faceNormals` row. */
const ROW_WORDS = 4;

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
 * `customIndex`, starting at 1: x = instance id, y = first `faceNormals` row)
 * uploaded per changed row, and `faceNormals` (object-space unit normal per
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
  /** 1-based TLAS row (its `customIndex`), or 0 while waiting for the BLAS. */
  row: number;
}

const COPY_DST = 0x8,
  STORAGE = 0x80;

/** Object-space unit normal per triangle, plus exact coincident opposite-winding coverage. */
export function triangleFaceNormals(
  positions: Float32Array,
  indices: ArrayLike<number>,
): Float32Array {
  const out = new Float32Array((indices.length / 3) * 4);
  const coincident = new Map<string, number[]>();
  const p = (i: number, k: number) => positions[(indices[i] ?? 0) * 3 + k] ?? 0;
  for (let t = 0; t < indices.length / 3; t++) {
    const e1 = [0, 1, 2].map((k) => p(t * 3 + 1, k) - p(t * 3, k));
    const e2 = [0, 1, 2].map((k) => p(t * 3 + 2, k) - p(t * 3, k));
    const [ax = 0, ay = 0, az = 0] = e1;
    const [bx = 0, by = 0, bz = 0] = e2;
    const n = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
    const length = Math.hypot(...n);
    if (length > 0) {
      out.set(
        n.map((v) => v / length),
        t * 4,
      );
      const vertices = [0, 1, 2].map((corner) =>
        [0, 1, 2].map((axis) => p(t * 3 + corner, axis)).join(','),
      );
      const key = vertices.sort().join('|');
      const group = coincident.get(key);
      if (group === undefined) coincident.set(key, [t]);
      else group.push(t);
    }
  }
  for (const group of coincident.values()) {
    const first = (group[0] ?? 0) * 4;
    if (
      group.some(
        (triangle) =>
          [0, 1, 2].reduce(
            (dot, axis) => dot + (out[first + axis] ?? 0) * (out[triangle * 4 + axis] ?? 0),
            0,
          ) < 0,
      )
    )
      for (const triangle of group) out[triangle * 4 + 3] = 1;
  }
  return out;
}

/** Column-major affine mat4 to the 3x4 row-major object-to-world rows a TLAS instance takes. */
export function tlasTransform(transform: ArrayLike<number>): number[] {
  return [0, 1, 2].flatMap((r) => [0, 4, 8, 12].map((c) => transform[c + r] ?? NaN));
}

export function createWorldAcceleration(
  device: RhiDevice,
  budget: WorldAccelerationBudget,
): Result<WorldAcceleration, RhiError | RayReferenceError> {
  const caps = device.caps.rayQuery;
  if (
    ![budget.maxInstances, budget.maxTriangles, budget.maxBlasBuildsPerFrame].every(
      (v) => Number.isSafeInteger(v) && v >= 1,
    ) ||
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
      size: (budget.maxInstances + 1) * ROW_WORDS * 4,
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
  const table = new Uint32Array((budget.maxInstances + 1) * ROW_WORDS);
  /** Instance id per traced record, for the swap-remove fill. */
  const tracedIds: number[] = [];
  const dirtyRows = new Set<number>();
  let tlasDirty = true;
  let waiting = 0;
  let uploadedPending = -1;
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
    instance.row = row;
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
  ): Result<{ resident: Resident; build: BlasBuildEntry; bytes: number }, RhiError> => {
    const { geometry, indices } = entry;
    const positions = geometry.positions;
    const blas = device.createBlas({
      label: `world.blas.${geometry.geometryId}`,
      geometries: [
        {
          vertexFormat: 'float32x3',
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
        present.mask = instance.mask & 0xff;
        return self.move(instance.instanceId, instance.transform);
      }
      if (present === undefined && owned.size >= budget.maxInstances)
        return rayReferenceFailure('world acceleration exceeds its instance budget', true);
      const referenced = reference(geometry);
      if (!referenced.ok) return referenced;
      const entry = referenced.value;
      entry.refs++;
      if (present !== undefined) drop(instance.instanceId);
      const next: OwnedInstance = {
        geometryId: instance.geometryId,
        mask: instance.mask & 0xff,
        transform: transform.value,
        row: 0,
      };
      owned.set(instance.instanceId, next);
      if (entry.resident !== undefined) trace(instance.instanceId, next, entry);
      else {
        entry.waiting.add(instance.instanceId);
        waiting++;
      }
      return ok(undefined);
    },
    move(id, to) {
      const instance = owned.get(id);
      if (instance === undefined) return ok(undefined);
      const transform = admitTransform(to);
      if (!transform.ok) return transform;
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
      let rowsWritten = 0;
      if (uploadedPending !== waiting) {
        table[0] = waiting;
        dirtyRows.add(0);
        uploadedPending = waiting;
      }
      if (dirtyRows.size > 0) {
        const rows = [...dirtyRows].sort((a, b) => a - b);
        dirtyRows.clear();
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
      }
      const tlasBuilt = builds.length > 0 || tlasDirty;
      if (tlasBuilt) {
        const encoded = encoder.buildAccelerationStructures(builds, [
          { tlas: gpu.tlas, instances: traced },
        ]);
        if (!encoded.ok) return encoded;
        tlasDirty = false;
        bytesBuilt += traced.length * TLAS_INSTANCE_BYTES;
      }
      return ok({
        pending: waiting,
        blasBuilt: builds.length,
        tlasBuilt: tlasBuilt ? 1 : 0,
        bytesBuilt,
        rowsWritten,
        bytesUploaded,
      });
    },
    track(completed) {
      inFlight = completed;
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
      uploadedPending = -1;
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
