import type {
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  RhiRayQueryCaps,
  RhiRayQueryUnsupportedReason,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { ProbeGlobalRegion } from './renderer-probe-global';
import { type RayReferenceError, rayReferenceFailure } from './scene';
import {
  createWorldAcceleration,
  type WorldAcceleration,
  type WorldAccelerationBuild,
  type WorldAccelerationGeometry,
  type WorldAccelerationInstance,
} from './world-acceleration';
import type { WorldTraversal } from './world-traversal';

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

export type WorldTraversalSelection =
  | { readonly traversal: 'ray-query' }
  | { readonly traversal: 'global-sdf'; readonly fallback: WorldTraversalFallback };

/** The projected scene's static triangle geometry, keyed by projection `geometryId`. */
export function worldAccelerationGeometries(
  region: Pick<ProbeGlobalRegion, 'sources' | 'instances'>,
): readonly WorldAccelerationGeometry[] {
  const geometries = new Map<number, WorldAccelerationGeometry>();
  for (const source of region.sources) {
    const geometryId = region.instances[source.firstInstance]?.geometryId;
    const positions = source.mesh.attributes.position;
    // The projection admits only static float32 triangle meshes into the field.
    if (geometryId === undefined || !(positions instanceof Float32Array)) continue;
    if (!geometries.has(geometryId))
      geometries.set(geometryId, { geometryId, positions, indices: source.mesh.indices });
  }
  return [...geometries.values()];
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
  /** Resident-or-pending BLAS geometries, keyed by mesh identity. */
  readonly geometries: number;
  /** Instances still waiting for their BLAS after the last submitted update. */
  readonly pending: number;
  /** True once a submitted update left no pending instance and no edit is unbuilt; the build pass then stops. */
  readonly settled: boolean;
  /** Submitted BLAS builds of this generation; an edit builds only meshes not yet resident. */
  readonly blasBuilt: number;
  /** Submitted TLAS builds of this generation; each roster or transform edit adds one. */
  readonly tlasBuilt: number;
  /** Submitted build input bytes (`WorldAccelerationBuild.bytesBuilt`) of this generation. */
  readonly bytesBuilt: number;
}

/** Extra capacity of an editable field's acceleration: TLAS rows and `faceNormals` rows. */
export interface WorldAccelerationHeadroom {
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
 * One field generation's TLAS lane. Each geometry's BLAS is built once (by mesh
 * identity) and reused by every later edit; an edit re-opens the build pass for
 * one TLAS rebuild (plus BLAS builds of newly introduced meshes) and it settles
 * again once submitted. BLAS residency is decided at encode time, so an encoded
 * update that never reached `commit` (a failed submit) recreates the
 * acceleration once in-flight submissions complete.
 */
export interface PreparedWorldAcceleration {
  readonly traversal: 'ray-query';
  readonly maxInstances: number;
  readonly maxTriangles: number;
  /** The live resources; their identity changes only after a failed-submit recovery. */
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
  const roster = new Map<number, WorldAccelerationInstance>(
    region.instances.map((instance) => [
      instance.instanceId,
      {
        instanceId: instance.instanceId,
        geometryId: instance.geometryId,
        mask: instance.mask,
        transform: instance.transform,
      },
    ]),
  );
  const resident = new Map(geometries.map((geometry) => [geometry.geometryId, geometry]));
  let triangles = projectedTriangles;
  const create = () =>
    createWorldAcceleration(device, {
      maxInstances,
      maxTriangles,
      maxBlasBuildsPerFrame: WORLD_ACCELERATION_BLAS_BUILDS_PER_FRAME,
    });
  const made = create();
  if (!made.ok) return made;
  let resources = made.value;
  // One queue completes in submission order, so the latest submission bounds every earlier one.
  let inFlight: Promise<unknown> = Promise.resolve();
  let pending = roster.size;
  let encoded: { build: WorldAccelerationBuild; revision: number } | undefined;
  let settled = false;
  // Bumped by every edit: a commit settles only an update encoded after the last edit.
  let revision = 0;
  const totals = { blasBuilt: 0, tlasBuilt: 0, bytesBuilt: 0 };
  const retireAfterFlight = (retired: WorldAcceleration) => {
    void inFlight.then(
      () => retired.dispose(),
      () => retired.dispose(),
    );
  };
  const beginFrame = (): Result<void, RayReferenceError | RhiError> => {
    if (encoded === undefined) return ok(undefined);
    const replacement = create();
    if (!replacement.ok) return replacement;
    retireAfterFlight(resources);
    resources = replacement.value;
    pending = roster.size;
    settled = false;
    encoded = undefined;
    return ok(undefined);
  };
  return ok({
    traversal: 'ray-query',
    maxInstances,
    maxTriangles,
    current: () => resources,
    beginFrame,
    record(encoder) {
      const recovered = beginFrame();
      if (!recovered.ok) return recovered;
      const updated = resources.update(encoder, [...resident.values()], [...roster.values()]);
      if (!updated.ok) return updated;
      encoded = { build: updated.value, revision };
      return ok(undefined);
    },
    settled: () => settled,
    edit(edit) {
      const removed = new Set(edit.removed.map((r) => r.index));
      const fresh = new Map<number, WorldAccelerationGeometry>();
      for (const { geometry } of edit.added)
        if (!resident.has(geometry.geometryId)) fresh.set(geometry.geometryId, geometry);
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
      if (triangles + added > maxTriangles)
        return rayReferenceFailure('world acceleration exceeds its triangle headroom', true);
      const size =
        roster.size - [...removed].filter((index) => roster.has(index)).length + edit.added.length;
      if (size > maxInstances)
        return rayReferenceFailure('world acceleration exceeds its instance headroom', true);
      for (const move of edit.moved) {
        const owned = roster.get(move.index);
        if (owned !== undefined)
          roster.set(move.index, { ...owned, transform: Array.from(move.to) });
      }
      for (const index of removed) roster.delete(index);
      for (const geometry of fresh.values()) resident.set(geometry.geometryId, geometry);
      triangles += added;
      for (const { instance } of edit.added) {
        roster.delete(instance.instanceId);
        roster.set(instance.instanceId, instance);
      }
      revision++;
      settled = false;
      return ok(undefined);
    },
    track(completed) {
      inFlight = completed;
    },
    commit() {
      if (encoded === undefined) return;
      const { build } = encoded;
      pending = build.pending;
      settled = build.pending === 0 && encoded.revision === revision;
      totals.blasBuilt += build.blasBuilt;
      totals.tlasBuilt += build.tlasBuilt;
      totals.bytesBuilt += build.bytesBuilt;
      encoded = undefined;
    },
    inspect: () => ({
      instances: roster.size,
      geometries: resident.size,
      pending,
      settled,
      ...totals,
    }),
    dispose: () => resources.dispose(),
  });
}

/** The traversal a prepared field composes into its world-trace kernels. */
export function preparedTraversal(
  acceleration: PreparedWorldAcceleration | undefined,
): WorldTraversal {
  return acceleration === undefined ? 'global-sdf' : acceleration.traversal;
}
