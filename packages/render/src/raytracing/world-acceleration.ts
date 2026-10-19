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
  /** Capacity of the `faceNormals` table across every resident geometry. */
  readonly maxTriangles: number;
  /** BLAS builds admitted per `update`; later geometries wait and their instances stay out. */
  readonly maxBlasBuildsPerFrame: number;
}

/**
 * Build input bytes of one TLAS instance: the 64-byte native instance record
 * (`VkAccelerationStructureInstanceKHR` / `MTLAccelerationStructureInstanceDescriptor`
 * as wgpu packs it) that every TLAS build uploads.
 */
const TLAS_INSTANCE_BYTES = 64;

/** The work one `update` encoded. */
export interface WorldAccelerationBuild {
  /** Instances still waiting for their BLAS (absent from the TLAS). */
  readonly pending: number;
  /** BLAS builds encoded: geometries that became resident. */
  readonly blasBuilt: number;
  /** TLAS builds encoded: 1 when the traced roster or a transform changed, else 0. */
  readonly tlasBuilt: number;
  /**
   * Build input bytes: BLAS positions + uint32 indices of each built geometry,
   * plus `TLAS_INSTANCE_BYTES` per traced instance of a TLAS build.
   */
  readonly bytesBuilt: number;
}

/**
 * The resources of the `'ray-query'` world traversal: a TLAS over static
 * per-geometry BLAS, `traversalInstances` (row 0: x = pending instance count;
 * row `customIndex`, starting at 1: x = instance id,
 * y = first `faceNormals` row) and `faceNormals` (object-space unit normal per
 * triangle; w marks exact coincident opposite-winding coverage). Each geometry is built once and stays resident for the lifetime of
 * the acceleration, even when no instance references it; instance transforms and
 * roster changes rebuild only the TLAS.
 */
export interface WorldAcceleration {
  readonly tlas: Tlas;
  readonly traversalInstances: Buffer;
  readonly faceNormals: Buffer;
  /** Encodes at most the budgeted BLAS builds plus one TLAS build when the roster changed. */
  update(
    encoder: RhiCommandEncoder,
    geometries: readonly WorldAccelerationGeometry[],
    instances: readonly WorldAccelerationInstance[],
  ): Result<WorldAccelerationBuild, RhiError | RayReferenceError>;
  dispose(): void;
}

interface Resident {
  readonly blas: Blas;
  readonly firstFace: number;
  readonly buffers: readonly Buffer[];
  readonly bytes: number;
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
  const tlasMade = device.createTlas({ label: 'world.tlas', maxInstances: budget.maxInstances });
  if (!tlasMade.ok) return tlasMade;
  const tlas = tlasMade.value;
  const owned: Buffer[] = [];
  const buffer = (label: string, size: number) => {
    const made = device.createBuffer({ label, size, usage: STORAGE | COPY_DST });
    if (made.ok) owned.push(made.value);
    return made;
  };
  const rows = device.createBuffer({
    label: 'world.traversal-instances',
    size: (budget.maxInstances + 1) * 16,
    usage: STORAGE | COPY_DST | 4,
  });
  if (rows.ok) owned.push(rows.value);
  const normals = rows.ok ? buffer('world.face-normals', budget.maxTriangles * 16) : rows;
  const dispose = () => {
    for (const r of resident.values()) {
      device.destroyBlas(r.blas);
      for (const b of r.buffers) device.destroyBuffer(b);
    }
    resident.clear();
    for (const b of owned) device.destroyBuffer(b);
    owned.length = 0;
    device.destroyTlas(tlas);
  };
  const resident = new Map<number, Resident>();
  if (!rows.ok) {
    dispose();
    return rows;
  }
  if (!normals.ok) {
    dispose();
    return normals;
  }
  let faces = 0,
    roster = '';

  const residentBlas = (
    geometry: WorldAccelerationGeometry,
  ): Result<{ resident: Resident; entry: BlasBuildEntry }, RhiError | RayReferenceError> => {
    const positions = geometry.positions;
    const indices = Uint32Array.from(
      geometry.indices ?? { length: positions.length / 3 },
      (v, i) => v ?? i,
    );
    if (positions.length < 9 || positions.length % 3 || indices.length % 3 || !indices.length)
      return rayReferenceFailure('world acceleration requires whole float32x3 triangle lists');
    const count = indices.length / 3;
    if (count > budget.maxTriangles - faces)
      return rayReferenceFailure('world acceleration exceeds its triangle budget', true);
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
    const release = () => {
      device.destroyBlas(blas.value);
      if (vertexBuffer.ok) device.destroyBuffer(vertexBuffer.value);
      if (indexBuffer.ok) device.destroyBuffer(indexBuffer.value);
    };
    if (!vertexBuffer.ok) {
      release();
      return vertexBuffer;
    }
    if (!indexBuffer.ok) {
      release();
      return indexBuffer;
    }
    for (const [target, offset, bytes] of [
      [vertexBuffer.value, 0, positions],
      [indexBuffer.value, 0, indices],
      [normals.value, faces * 16, triangleFaceNormals(positions, indices)],
    ] as const) {
      const wrote = device.queue.writeBuffer(target, offset, bytes);
      if (!wrote.ok) {
        release();
        return wrote;
      }
    }
    const r: Resident = {
      blas: blas.value,
      firstFace: faces,
      buffers: [vertexBuffer.value, indexBuffer.value],
      bytes: positions.byteLength + indices.byteLength,
    };
    faces += count;
    return ok({
      resident: r,
      entry: {
        blas: blas.value,
        geometries: [
          {
            vertexBuffer: vertexBuffer.value,
            vertexStride: 12,
            index: { buffer: indexBuffer.value },
          },
        ],
      },
    });
  };

  return ok({
    tlas,
    traversalInstances: rows.value,
    faceNormals: normals.value,
    update(encoder, geometries, instances) {
      if (instances.length > budget.maxInstances)
        return rayReferenceFailure('world acceleration exceeds its instance budget', true);
      const byId = new Map(geometries.map((g) => [g.geometryId, g]));
      const builds: BlasBuildEntry[] = [];
      let bytesBuilt = 0;
      for (const id of new Set(instances.map((i) => i.geometryId))) {
        if (resident.has(id) || builds.length >= budget.maxBlasBuildsPerFrame) continue;
        const geometry = byId.get(id);
        if (geometry === undefined)
          return rayReferenceFailure(`world acceleration has no geometry ${id}`);
        const made = residentBlas(geometry);
        if (!made.ok) return made;
        resident.set(id, made.value.resident);
        builds.push(made.value.entry);
        bytesBuilt += made.value.resident.bytes;
      }
      const traced: TlasInstance[] = [];
      const transforms: number[][] = [];
      const table = new Uint32Array((instances.length + 1) * 4);
      for (const instance of instances) {
        const r = resident.get(instance.geometryId);
        if (r === undefined) continue;
        const transform = tlasTransform(instance.transform);
        if (!transform.every(Number.isFinite))
          return rayReferenceFailure('world acceleration requires finite instance transforms');
        table.set([instance.instanceId, r.firstFace], (traced.length + 1) * 4);
        transforms.push(transform);
        traced.push({
          blas: r.blas,
          transform,
          customIndex: traced.length + 1,
          mask: instance.mask & 0xff,
        });
      }
      const key = JSON.stringify(
        traced.map((t, i) => [
          table[(i + 1) * 4],
          table[(i + 1) * 4 + 1],
          t.mask,
          ...(transforms[i] ?? []),
        ]),
      );
      const built = builds.length > 0 || key !== roster;
      // Coverage belongs to the roster being encoded, not the previous CPU
      // commit. An omitted BLAS cannot prove either a hit or an environment miss.
      const pending = instances.length - traced.length;
      table[0] = pending;
      const wrote = device.queue.writeBuffer(rows.value, 0, table);
      if (!wrote.ok) return wrote;
      if (built) {
        const encoded = encoder.buildAccelerationStructures(builds, [{ tlas, instances: traced }]);
        if (!encoded.ok) return encoded;
        roster = key;
        bytesBuilt += traced.length * TLAS_INSTANCE_BYTES;
      }
      return ok({
        pending,
        blasBuilt: builds.length,
        tlasBuilt: built ? 1 : 0,
        bytesBuilt,
      });
    },
    dispose,
  });
}
