import type {
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  RhiRayQueryCaps,
  RhiRayQueryUnsupportedReason,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { meshAttributeChannels } from '../publication/packed-rows-mesh';
import type { ProbeGlobalRegion } from './renderer-probe-global';
import { type RayReferenceError, rayReferenceFailure } from './scene';
import {
  createWorldAcceleration,
  type WorldAcceleration,
  type WorldAccelerationBuild,
  type WorldAccelerationGeometry,
  type WorldAccelerationInstance,
} from './world-acceleration';

/** BLAS builds admitted per frame; later geometries join the TLAS on following frames. */
export const WORLD_ACCELERATION_BLAS_BUILDS_PER_FRAME = 4;

/**
 * Why a Ray Query capable device still traces the Global SDF:
 * `scene-exceeds-ray-query-limits` when the projected instances or one
 * geometry's triangles exceed `caps.rayQuery` limits.
 */
export type WorldTraversalFallback =
  | RhiRayQueryUnsupportedReason
  | 'scene-exceeds-ray-query-limits';

type WorldTraversalSelection =
  | { readonly traversal: 'ray-query' }
  | { readonly traversal: 'global-sdf'; readonly fallback: WorldTraversalFallback };

/**
 * BLAS identity of one mesh payload version: the same MeshAsset at the same
 * asset revision shares one geometry id (and one BLAS); a new revision is a
 * new geometry whose BLAS the old one's release does not wait for.
 */
export class WorldAccelerationGeometryIds {
  readonly #ids = new WeakMap<object, Map<number, number>>();
  #next = 0;

  id(mesh: object, revision: number): number {
    let revisions = this.#ids.get(mesh);
    if (revisions === undefined) {
      revisions = new Map();
      this.#ids.set(mesh, revisions);
    }
    let id = revisions.get(revision);
    if (id === undefined) {
      id = this.#next++;
      revisions.set(revision, id);
    }
    return id;
  }
}

type AccelerationSource = Pick<
  ProbeGlobalRegion['sources'][number],
  'mesh' | 'assetRevision' | 'firstInstance' | 'instances'
>;

/** One field source's traced geometry, keyed by mesh payload version; `undefined` when not float32 triangles. */
export function worldAccelerationGeometry(
  source: Pick<AccelerationSource, 'mesh' | 'assetRevision'>,
  ids: WorldAccelerationGeometryIds,
): WorldAccelerationGeometry | undefined {
  const positions = meshAttributeChannels(source.mesh).position;
  // The projection admits only static float32 triangle meshes into the field.
  if (!(positions instanceof Float32Array)) return undefined;
  return {
    geometryId: ids.id(source.mesh, source.assetRevision),
    positions,
    indices: source.mesh.indices,
  };
}

/** The projected field's traced roster: instance rows keyed by mesh payload version. */
export function worldAccelerationRoster(
  region: {
    readonly sources: readonly AccelerationSource[];
    readonly instances: readonly WorldAccelerationInstance[];
  },
  ids: WorldAccelerationGeometryIds,
): {
  readonly instances: readonly WorldAccelerationInstance[];
  readonly geometries: readonly WorldAccelerationGeometry[];
} {
  const geometries = new Map<number, WorldAccelerationGeometry>();
  const instances: WorldAccelerationInstance[] = [];
  for (const source of region.sources) {
    const geometry = worldAccelerationGeometry(source, ids);
    if (geometry !== undefined) geometries.set(geometry.geometryId, geometry);
    const count = source.instances?.instanceCount ?? 1;
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const instance = region.instances[source.firstInstance + ordinal];
      if (instance === undefined) continue;
      instances.push({
        instanceId: instance.instanceId,
        geometryId: geometry?.geometryId ?? -1,
        mask: instance.mask,
        transform: instance.transform,
      });
    }
  }
  return { instances, geometries: [...geometries.values()] };
}

const triangleCount = (geometry: WorldAccelerationGeometry) =>
  (geometry.indices?.length ?? geometry.positions.length / 3) / 3;

/** Automatic lane selection: Ray Query when supported and the scene fits its limits. */
export function selectWorldTraversal(
  caps: RhiRayQueryCaps,
  instances: number,
  geometries: readonly WorldAccelerationGeometry[],
): WorldTraversalSelection {
  if (!caps.supported) return { traversal: 'global-sdf', fallback: caps.reason };
  if (
    instances > caps.maxTlasInstanceCount ||
    geometries.some((geometry) => triangleCount(geometry) > caps.maxBlasPrimitiveCount)
  )
    return { traversal: 'global-sdf', fallback: 'scene-exceeds-ray-query-limits' };
  return { traversal: 'ray-query' };
}

export interface WorldAccelerationInspection {
  /** Instances the TLAS covers once every BLAS is resident. */
  readonly instances: number;
  /** Referenced BLAS geometries (resident or pending), keyed by mesh payload version. */
  readonly geometries: number;
  /** Instances still waiting for their BLAS after the last submitted update. */
  readonly pending: number;
  /** True once a submitted update left no pending instance and no edit is unbuilt; the build pass then stops. */
  readonly settled: boolean;
  /** Submitted BLAS builds of this generation; an edit builds only meshes not yet resident. */
  readonly blasBuilt: number;
  /** Submitted TLAS builds of this generation; each roster or transform edit adds one. */
  readonly tlasBuilt: number;
  /** Submitted GPU build input bytes (`WorldAccelerationBuild.bytesBuilt`) of this generation. */
  readonly bytesBuilt: number;
  /** Submitted `traversalInstances` rows written: changed rows only. */
  readonly rowsWritten: number;
  /** Submitted CPU-written bytes: changed table rows plus new BLAS inputs and face normals. */
  readonly bytesUploaded: number;
  /** Retained TLAS records patched (adds, moves, swap-fills); O(changed instances). */
  readonly recordsPatched: number;
  /** BLAS released after their last instance left. */
  readonly blasReleased: number;
}
/** Extra capacity of an editable field's acceleration: TLAS rows and `faceNormals` rows. */
interface WorldAccelerationHeadroom {
  /** TLAS instance capacity; at least the projected instance count. */
  readonly instances: number;
  /** Spare `faceNormals` rows for meshes an add introduces. */
  readonly triangles: number;
}

/** Spare triangles (16 B of `faceNormals` each) an editable field reserves for added meshes. */
export const WORLD_ACCELERATION_TRIANGLE_HEADROOM = 65_536;

/**
 * One in-place scene delta of the `'ray-query'` lane, addressed by owned field
 * rows (`instanceId`). Moves replace the instance transform, removals drop the
 * row, adds append a row whose `geometry` builds a BLAS only when its
 * `geometryId` (mesh identity) is not yet resident. Material changes carry no
 * acceleration work and never reach this edit.
 */
export interface WorldAccelerationEdit {
  readonly moved: readonly { readonly index: number; readonly to: ArrayLike<number> }[];
  readonly removed: readonly { readonly index: number }[];
  readonly added: readonly {
    readonly instance: WorldAccelerationInstance;
    readonly geometry: WorldAccelerationGeometry;
  }[];
}

/**
 * One field generation's TLAS lane over one incremental {@link WorldAcceleration}.
 * Each geometry's BLAS is built once per mesh payload version, shared by its
 * instances and released after the last one leaves; an edit patches only the
 * changed TLAS records and table rows and re-opens the build pass for one GPU
 * TLAS rebuild (plus BLAS builds of newly introduced meshes); it settles again
 * once submitted. An encoded update that never reached `commit` (a failed
 * submit) recovers through the owner's cold path: new GPU objects, every
 * instance re-entered, the old objects retired after in-flight submissions.
 */
export interface PreparedWorldAcceleration {
  readonly traversal: 'ray-query';
  readonly maxInstances: number;
  readonly maxTriangles: number;
  /** The live owner; its GPU objects change only after a failed-submit recovery. */
  current(): WorldAcceleration;
  /** Recover an abandoned encode before the Graph freezes this frame's imports. */
  beginFrame(): Result<void, RayReferenceError | RhiError>;
  /** Encode this frame's BLAS/TLAS builds; the graph skips the pass once settled. */
  record(encoder: RhiCommandEncoder): Result<void, RayReferenceError | RhiError>;
  readonly settled: () => boolean;
  /**
   * Apply an in-place delta to the traced roster. A failure leaves the roster
   * unchanged: the delta exceeds the TLAS or `faceNormals` capacity or
   * `caps.rayQuery`, so the owner rebuilds the field.
   */
  edit(edit: WorldAccelerationEdit): Result<void, RayReferenceError>;
  track(completed: Promise<unknown>): void;
  /** A physically submitted frame adopts its encoded update. */
  commit(): void;
  inspect(): WorldAccelerationInspection;
  dispose(): void;
}

export function prepareWorldAcceleration(
  device: RhiDevice,
  region: { readonly instances: readonly WorldAccelerationInstance[] },
  geometries: readonly WorldAccelerationGeometry[],
  headroom?: WorldAccelerationHeadroom,
): Result<PreparedWorldAcceleration, RayReferenceError | RhiError> {
  const caps = device.caps.rayQuery;
  const projectedTriangles = geometries.reduce((sum, geometry) => sum + triangleCount(geometry), 0);
  const maxInstances = Math.max(
    1,
    region.instances.length,
    Math.min(headroom?.instances ?? 0, caps.supported ? caps.maxTlasInstanceCount : 0),
  );
  const maxTriangles = Math.max(1, projectedTriangles + (headroom?.triangles ?? 0));
  const made = createWorldAcceleration(device, {
    maxInstances,
    maxTriangles,
    maxBlasBuildsPerFrame: WORLD_ACCELERATION_BLAS_BUILDS_PER_FRAME,
  });
  if (!made.ok) return made;
  const world = made.value;
  const byId = new Map(geometries.map((geometry) => [geometry.geometryId, geometry]));
  // Cold start enters every instance through the same per-instance path as an edit.
  for (const instance of region.instances) {
    const geometry = byId.get(instance.geometryId);
    const entered =
      geometry === undefined
        ? rayReferenceFailure(`world acceleration has no geometry ${instance.geometryId}`)
        : world.set(instance, geometry);
    if (!entered.ok) {
      world.dispose();
      return entered;
    }
  }
  let pending = world.instances;
  let encoded: { build: WorldAccelerationBuild; revision: number } | undefined;
  let settled = false;
  // Bumped by every edit: a commit settles only an update encoded after the last edit.
  let revision = 0;
  const totals = { blasBuilt: 0, tlasBuilt: 0, bytesBuilt: 0, rowsWritten: 0, bytesUploaded: 0 };
  const beginFrame = (): Result<void, RayReferenceError | RhiError> => {
    if (encoded === undefined) return ok(undefined);
    // An encoded update never reached commit (a failed submit): rebuild every GPU object.
    const recovered = world.recover();
    if (!recovered.ok) return recovered;
    pending = world.instances;
    settled = false;
    encoded = undefined;
    return ok(undefined);
  };
  return ok({
    traversal: 'ray-query',
    maxInstances,
    maxTriangles,
    current: () => world,
    beginFrame,
    record(encoder) {
      const recovered = beginFrame();
      if (!recovered.ok) return recovered;
      const updated = world.update(encoder);
      if (!updated.ok) return updated;
      encoded = { build: updated.value, revision };
      return ok(undefined);
    },
    settled: () => settled,
    edit(edit) {
      // Validate the whole delta first: a rejected edit leaves the roster unchanged.
      let removed = 0;
      for (const removal of edit.removed) if (world.has(removal.index)) removed++;
      const fresh = new Map<number, WorldAccelerationGeometry>();
      for (const { geometry } of edit.added)
        if (!world.hasGeometry(geometry.geometryId)) fresh.set(geometry.geometryId, geometry);
      let added = 0;
      for (const geometry of fresh.values()) {
        const count = triangleCount(geometry);
        if (caps.supported && count > caps.maxBlasPrimitiveCount)
          return rayReferenceFailure(
            'an added mesh exceeds caps.rayQuery.maxBlasPrimitiveCount',
            true,
          );
        added += count;
      }
      if (world.triangles + added > maxTriangles)
        return rayReferenceFailure('world acceleration exceeds its triangle headroom', true);
      if (world.instances - removed + edit.added.length > maxInstances)
        return rayReferenceFailure('world acceleration exceeds its instance headroom', true);
      for (const move of edit.moved) {
        const moved = world.move(move.index, move.to);
        if (!moved.ok) return moved;
      }
      for (const removal of edit.removed) world.remove(removal.index);
      for (const { instance, geometry } of edit.added) {
        const entered = world.set(instance, geometry);
        if (!entered.ok) return entered;
      }
      revision++;
      settled = false;
      return ok(undefined);
    },
    track(completed) {
      world.track(completed);
    },
    commit() {
      if (encoded === undefined) return;
      const { build } = encoded;
      pending = build.pending;
      settled = build.pending === 0 && encoded.revision === revision;
      totals.blasBuilt += build.blasBuilt;
      totals.tlasBuilt += build.tlasBuilt;
      totals.bytesBuilt += build.bytesBuilt;
      totals.rowsWritten += build.rowsWritten;
      totals.bytesUploaded += build.bytesUploaded;
      encoded = undefined;
    },
    inspect: () => ({
      instances: world.instances,
      geometries: world.geometries,
      pending,
      settled,
      ...totals,
      ...world.work,
    }),
    dispose: () => world.dispose(),
  });
}
