import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { FixedTime } from '@forgeax/engine-ecs';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import { err, type Handle, type MeshAsset, ok, type Result } from '@forgeax/engine-types';
import type { AsyncDynamicGeometryHost } from '../async-dynamic-geometry';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import type { GpuResidencyCache } from '../device/gpu-residency';
import type { ResidencyLease } from '../device/residency-lifetime';
import {
  createDynamicGeometryLifecycle,
  type DynamicGeometryCandidate,
  DynamicGeometryError,
  type DynamicGeometryLifecycle,
  type DynamicGeometryOrdering,
  type DynamicGeometryPrepareInput,
  type DynamicGeometryReceipt,
  type DynamicGeometryRecordStageLane,
  MeshResidencyError,
  type MeshResidencyPhaseObserver,
  type PreparedMeshResidency,
  sameCandidateCredential,
} from '../dynamic-geometry';
import type { RecordProfileRunner } from '../record/render-context';
import type { RenderRecordPhase } from '../render-contract';

function cloneTypedArray<T extends Float32Array | Uint16Array | Uint32Array>(
  value: T,
  transfers: ArrayBuffer[],
): T {
  const View = value.constructor;
  const cloned = new (View as new (source: T) => T)(value);
  // Custom constructors can retain aliases. Only built-in allocations are exclusive.
  if (
    (View === Float32Array || View === Uint16Array || View === Uint32Array) &&
    cloned.buffer instanceof ArrayBuffer
  )
    transfers.push(cloned.buffer);
  return cloned;
}

function cloneMesh(mesh: MeshAsset, transfers: ArrayBuffer[]): MeshAsset {
  const attributes = Object.fromEntries(
    Object.entries(mesh.attributes).map(([key, value]) => [
      key,
      value instanceof ArrayBuffer
        ? value.slice(0)
        : value === undefined
          ? undefined
          : cloneTypedArray(value as never, transfers),
    ]),
  ) as MeshAsset['attributes'];
  const vertices = new Float32Array(mesh.vertices);
  const aabb = mesh.aabb === undefined ? undefined : new Float32Array(mesh.aabb);
  transfers.push(vertices.buffer);
  if (aabb !== undefined) transfers.push(aabb.buffer);
  return Object.freeze({
    ...mesh,
    vertices,
    ...(mesh.indices === undefined ? {} : { indices: cloneTypedArray(mesh.indices, transfers) }),
    attributes,
    ...(aabb === undefined ? {} : { aabb }),
    submeshes: Object.freeze(mesh.submeshes.map((submesh) => Object.freeze({ ...submesh }))),
    materialSlots: Object.freeze(mesh.materialSlots.map((slot) => Object.freeze({ ...slot }))),
  });
}

export interface DynamicGeometryHostImplementation {
  prepareDynamicGeometry(
    input: DynamicGeometryPrepareInput,
  ): Result<DynamicGeometryCandidate, DynamicGeometryError>;
  /** Prepare one complete roster under the existing aggregate byte budget. */
  prepareDynamicGeometryCandidates(
    inputs: readonly DynamicGeometryPrepareInput[],
  ): Result<readonly DynamicGeometryCandidate[], DynamicGeometryError>;
  prepareMeshResidency(
    world: World,
    meshHandle: Handle<'MeshAsset', 'shared'>,
    observePhase?: MeshResidencyPhaseObserver,
  ): Result<PreparedMeshResidency, MeshResidencyError>;
  acceptDynamicGeometry(
    candidate: DynamicGeometryCandidate,
    ordering: DynamicGeometryOrdering,
  ): Result<DynamicGeometryCandidate, DynamicGeometryError>;
  /**
   * Atomically swap distinct entities in one attached World. Returned failures
   * retain old bindings; an uncertain rollback throws to require paired rebuild.
   * Invoke inside PhysicsWorld.admitDerivedShapeCandidates commitGeometry.
   */
  acceptDynamicGeometryCandidates(
    candidates: readonly DynamicGeometryCandidate[],
    ordering: DynamicGeometryOrdering,
  ): Result<readonly DynamicGeometryCandidate[], DynamicGeometryError>;
  /** Whether the original candidate still owns current physical residency. */
  isDynamicGeometryCurrent(candidate: DynamicGeometryCandidate): boolean;
  dynamicGeometryReceipt(candidate: DynamicGeometryCandidate): DynamicGeometryReceipt | undefined;
  cancelDynamicGeometry(candidate: DynamicGeometryCandidate): Result<void, DynamicGeometryError>;
  retireDynamicGeometry(candidate: DynamicGeometryCandidate): Result<void, DynamicGeometryError>;
  /** @internal Detach cleanup keeps candidate GPU residency receipt-safe. */
  invalidateDynamicGeometryWorld(world: World): void;
  /** @internal A failed atomic swap blocks all later frame submission for this World. */
  dynamicGeometryFault(world: World): DynamicGeometryError | undefined;
  /** Publish only candidates consumed by the attached ECS render snapshot. */
  publishDynamicGeometry(
    frame: {
      readonly frameId: number;
      readonly deviceGeneration: number;
      readonly completed?: Promise<unknown>;
    },
    worlds?: readonly object[],
    fixedStep?: number,
  ): readonly DynamicGeometryReceipt[];
}

interface PhysicsPublicationLike {
  readonly revision: number;
  readonly fixedStep: number;
}

interface HostCandidateRecord {
  /** Credential plus the lifecycle state this host last issued or observed. */
  candidate: DynamicGeometryCandidate;
  /** Private snapshot metadata; exclusive storage can move to the remote residency owner. */
  readonly mesh: MeshAsset;
  /** New intrinsic allocations can move to a remote owner; author buffers never do. */
  readonly meshTransfers: readonly ArrayBuffer[];
  readonly world: World;
  readonly entity: number;
  readonly previousMeshHandle: Handle<'MeshAsset', 'shared'>;
  readonly meshHandle: Handle<'MeshAsset', 'shared'>;
  residency: DynamicGeometryResidency | undefined;
  /** Pending remote allocation also retains the original candidate budget. */
  residencyPending?: Promise<void>;
  residencyStore: GpuResidencyCache | undefined;
  /** One terminal owner; failure leaves its fence unresolved and its receipt retained. */
  cleanup?: {
    readonly completed: Promise<void>;
    readonly receipt: DynamicGeometryReceipt | undefined;
  };
  readonly generation: number;
  /** Renderer lease retained while the candidate is staged but not ECS-owned. */
  meshLeaseHeld: boolean;
  /** Previous ECS MeshFilter lease retained until the candidate lifecycle ends. */
  previousMeshLeaseHeld: boolean;
}

/** A remote allocation already tracks its own submissions; a local lease may track here. */
export interface DynamicGeometryResidency extends Pick<ResidencyLease, 'release'> {
  isCurrent?(): boolean;
  track?: ResidencyLease['track'];
}

export interface DynamicGeometryResidencyPort {
  readonly maxConcurrentPreparations: number;
  prepare(
    input: {
      readonly world: World;
      readonly entity?: number;
      readonly meshHandle: Handle<'MeshAsset', 'shared'>;
      readonly mesh: MeshAsset;
    },
    options?: {
      readonly signal?: AbortSignal;
      readonly waitForCapacity?: boolean;
      /** Private snapshot allocations only; the source owner retains no mutable aliases. */
      readonly transfers?: readonly ArrayBuffer[];
    },
  ): Promise<Result<DynamicGeometryResidency & { isCurrent(): boolean }, DynamicGeometryError>>;
}

function fixedStepOf(world: World): number | undefined {
  try {
    return world.getResource(FixedTime).tick;
  } catch {
    return undefined;
  }
}

function hasRenderableBinding(world: World, entity: number | undefined): boolean {
  if (entity === undefined || !Number.isInteger(entity)) return false;
  return (
    world.hasComponent(entity as EntityHandle, Transform) &&
    world.hasComponent(entity as EntityHandle, MeshFilter) &&
    world.hasComponent(entity as EntityHandle, MeshRenderer)
  );
}

function meshHandleOf(
  world: World,
  entity: number | undefined,
): Handle<'MeshAsset', 'shared'> | undefined {
  if (entity === undefined || !Number.isInteger(entity)) return undefined;
  return world[worldRead].getFieldValue(entity as EntityHandle, MeshFilter, 'assetHandle') as
    | Handle<'MeshAsset', 'shared'>
    | undefined;
}

function hasMaterialIdentity(
  world: World,
  entity: number | undefined,
  mesh: DynamicGeometryPrepareInput['mesh'],
  identity: string | undefined,
): boolean {
  if (identity === undefined) return true;
  const normalized = identity.trim();
  if (normalized.length === 0 || entity === undefined) return false;
  const material = world.get(entity as EntityHandle, MeshRenderer);
  if (!material.ok) return false;
  const values = (material.value as { readonly materials?: readonly unknown[] }).materials ?? [];
  if (
    mesh.materialSlots.some((slot) => slot.sourceKey === normalized || slot.slotName === normalized)
  )
    return true;
  if (
    mesh.materialSlots.some(
      (slot) =>
        slot.defaultMaterial !== undefined &&
        AssetGuid.format(slot.defaultMaterial).toLowerCase() === normalized.toLowerCase(),
    )
  )
    return true;
  return values.some((value) => {
    if (String(value) === normalized) return true;
    try {
      const resolved = world.sharedRefs.resolve(value as never);
      if (!resolved.ok || typeof resolved.value !== 'object' || resolved.value === null)
        return false;
      const payload = resolved.value as { readonly sourceKey?: unknown; readonly guid?: unknown };
      return payload.sourceKey === normalized || payload.guid === normalized;
    } catch {
      return false;
    }
  });
}

function hasMeshBinding(world: World, handle: number): boolean {
  try {
    const query = world.query({ read: [MeshFilter] }).unwrap();
    for (const row of query) {
      if (Number(row.get(MeshFilter).assetHandle) === handle) return true;
    }
  } catch {
    // An already-detached World cannot own a live binding, so eviction is
    // safe. Normal attached Worlds take the query path above.
  }
  return false;
}

function ownsMeshPayload(
  world: World,
  meshHandle: DynamicGeometryPrepareInput['meshHandle'],
  mesh: DynamicGeometryPrepareInput['mesh'],
): boolean {
  if (meshHandle === undefined) return false;
  try {
    const resolved = world.sharedRefs.resolve(meshHandle);
    return resolved.ok && resolved.value === mesh;
  } catch {
    return false;
  }
}

function resolveMeshAsset(
  world: World,
  meshHandle: Handle<'MeshAsset', 'shared'>,
): MeshAsset | undefined {
  try {
    const resolved = world.sharedRefs.resolve(meshHandle);
    return resolved.ok &&
      typeof resolved.value === 'object' &&
      (resolved.value as { readonly kind?: unknown }).kind === 'mesh'
      ? (resolved.value as MeshAsset)
      : undefined;
  } catch {
    return undefined;
  }
}

function physicsPublicationOf(
  world: World,
  entity: number,
  admitting = false,
): PhysicsPublicationLike | undefined {
  try {
    const physics = world.getResource<{
      readonly getDerivedPublication?: (body: number) => PhysicsPublicationLike | undefined;
      readonly getDerivedAdmission?: (body: number) => PhysicsPublicationLike | undefined;
    }>('PhysicsWorld');
    return admitting
      ? physics.getDerivedAdmission?.(entity)
      : physics.getDerivedPublication?.(entity);
  } catch {
    return undefined;
  }
}

type DynamicGeometryAdmissionHost = Omit<
  DynamicGeometryHostImplementation,
  'prepareDynamicGeometry' | 'prepareDynamicGeometryCandidates' | 'prepareMeshResidency'
>;

interface DynamicGeometryHostOptions {
  readonly lifecycle: DynamicGeometryLifecycle;
  readonly attachedWorlds: ReadonlySet<World>;
  readonly currentGeneration: () => number;
  /** Renderer record-stage proof for the most recently submitted frame. */
  readonly isConsumedByRenderFrame: (candidate: DynamicGeometryCandidate) => boolean;
  /** Renderer-owned lane fact for the most recently submitted frame. */
  readonly recordStageLane?: (
    candidate: DynamicGeometryCandidate,
  ) => DynamicGeometryRecordStageLane | undefined;
  /** Optional post-commit notification; RenderScene owns per-surface temporal rejection. */
  readonly onTopologyChanged?: () => void;
  /** The source tick carried by a consumed remote publication, never a second clock. */
  readonly publishedFixedStep?: (world: World) => number | undefined;
}

function createDynamicGeometryHostOwner(options: DynamicGeometryHostOptions) {
  const {
    lifecycle,
    attachedWorlds,
    currentGeneration,
    isConsumedByRenderFrame,
    recordStageLane = () => undefined,
  } = options;
  const hostCandidates = new Map<string, HostCandidateRecord>();
  const faultedWorlds = new WeakMap<World, DynamicGeometryError>();
  let observedGeneration = -1;
  let batchActive = false;
  const fault = (
    world: World,
    cause: unknown,
    expected = 'the attached World and managed MeshAsset leases remain in a known state',
    hint = 'rebuild the paired World and Renderer before further simulation or rendering',
  ): DynamicGeometryError => {
    const existing = faultedWorlds.get(world);
    if (existing !== undefined) return existing;
    const error =
      cause instanceof DynamicGeometryError
        ? cause
        : new DynamicGeometryError('dynamic-geometry-invalid', expected, hint, { actual: cause });
    faultedWorlds.set(world, error);
    return error;
  };
  const throwFault = (world: World, cause: unknown): never => {
    throw fault(world, cause);
  };
  const ensureHealthyWorld = (world: World): void => {
    const priorFault = faultedWorlds.get(world);
    if (priorFault !== undefined) throw priorFault;
    if (world.execution.health !== 'healthy')
      throwFault(
        world,
        new DynamicGeometryError(
          'dynamic-geometry-invalid',
          'the attached World execution state is healthy before dynamic geometry admission',
          'rebuild the poisoned World and its paired Renderer',
          { actual: world.execution },
        ),
      );
  };
  const releaseMeshLease = (record: HostCandidateRecord): DynamicGeometryError | undefined => {
    if (!record.meshLeaseHeld) return undefined;
    const released = record.world.sharedRefs.release(record.meshHandle);
    if (!released.ok) {
      return new DynamicGeometryError(
        'dynamic-geometry-invalid',
        'the Renderer candidate lease remains a live World shared reference',
        'retain the MeshAsset handle until candidate cancellation or ECS acceptance completes',
        { candidateId: record.candidate.candidateId, actual: released.error },
      );
    }
    record.meshLeaseHeld = false;
    return undefined;
  };
  const releasePreviousMeshLease = (
    record: HostCandidateRecord,
  ): DynamicGeometryError | undefined => {
    if (!record.previousMeshLeaseHeld) return undefined;
    const released = record.world.sharedRefs.release(record.previousMeshHandle);
    if (!released.ok) {
      return new DynamicGeometryError(
        'dynamic-geometry-invalid',
        'the previous ECS MeshFilter binding remains a live World shared reference',
        'retain the previous MeshAsset until candidate cancellation, retirement, or invalidation completes',
        { candidateId: record.candidate.candidateId, actual: released.error },
      );
    }
    record.previousMeshLeaseHeld = false;
    return undefined;
  };
  const releaseMeshLeases = (record: HostCandidateRecord): DynamicGeometryError | undefined => {
    const candidateError = releaseMeshLease(record);
    const previousError = releasePreviousMeshLease(record);
    return candidateError ?? previousError;
  };
  const synchronizeGeneration = (): number => {
    const generation = currentGeneration();
    if (observedGeneration !== generation) {
      for (const record of hostCandidates.values()) {
        if (record.generation !== generation) {
          // The old DeviceScope owns the GPU destruction. The World shared
          // reference is independent and must be released here even when a
          // generation changes before the next explicit cancellation.
          try {
            scheduleCandidateCleanup(record, true);
          } catch (cause) {
            fault(record.world, cause);
          }
        }
      }
      // A failed or fenced owner still holds its lifecycle budget. Advancing
      // the lifecycle generation would release that budget without recovery.
      if ([...hostCandidates.values()].some((record) => record.generation !== generation))
        return generation;
      lifecycle.invalidateGeneration(generation);
      observedGeneration = generation;
    }
    return generation;
  };
  const candidateRecord = (
    candidate: DynamicGeometryCandidate,
  ): HostCandidateRecord | undefined => {
    const record = hostCandidates.get(candidate.candidateId);
    if (record === undefined || !sameCandidateCredential(candidate, record.candidate))
      return undefined;
    return record;
  };
  const scheduleCandidateCleanup = (
    record: HostCandidateRecord,
    force = false,
    terminal?: 'cancel' | 'retire',
  ): Promise<void> | undefined => {
    if (record.cleanup !== undefined) return record.cleanup.completed;
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    record.cleanup = { completed, receipt: lifecycle.receipt(record.candidate) };
    const cancel = (completion?: Promise<void>): void => {
      const cancelled = lifecycle.cancel(record.candidate, completion);
      if (!cancelled.ok) throw cancelled.error;
      record.candidate = Object.freeze({ ...record.candidate, state: 'cancelled' as const });
    };
    const finish = (deferred: boolean): void => {
      // A failed submitted fence or another fault during asynchronous cleanup
      // cannot prove terminal release. Preserve this owner for paired rebuild.
      if (deferred && faultedWorlds.has(record.world)) return;
      const released = releaseMeshLeases(record);
      if (released !== undefined) throw released;
      if (terminal === 'cancel' && !deferred) cancel();
      if (record.candidate.state === 'retired') {
        const finalized = lifecycle.finalizeRetirement(record.candidate);
        if (!finalized.ok) throw finalized.error;
      }
      hostCandidates.delete(record.candidate.candidateId);
      complete();
    };
    if (terminal === 'retire') {
      const retired = lifecycle.retire(record.candidate);
      if (!retired.ok) throw retired.error;
      record.candidate = Object.freeze({ ...record.candidate, state: 'retired' as const });
    }
    if (record.residencyPending !== undefined) {
      if (terminal === 'cancel') cancel(completed);
      void record.residencyPending.then(
        async () => {
          try {
            await record.residency?.release(
              force || !hasMeshBinding(record.world, record.meshHandle),
            );
            finish(true);
          } catch (cause) {
            fault(record.world, cause);
          }
        },
        (cause) => fault(record.world, cause),
      );
      return completed;
    }
    // Preparation registers this owner before native upload. If upload threw
    // before returning a lease, recover it from that exact store and World.
    record.residency ??= record.residencyStore?.retainMeshResidency(
      record.meshHandle,
      record.world,
    );
    if (record.residency === undefined && record.residencyStore !== undefined)
      throw new Error('native preparation has no recoverable allocation owner');
    const completion = record.residency?.release(
      force || !hasMeshBinding(record.world, record.meshHandle),
    );
    if (completion === undefined) {
      finish(false);
      return undefined;
    }
    if (terminal === 'cancel') cancel(completed);
    void completion.then(
      () => {
        try {
          finish(true);
        } catch (cause) {
          fault(record.world, cause);
        }
      },
      (cause) => fault(record.world, cause),
    );
    // Unlike the native completion, this fence never rejects. The lifecycle
    // releases on either settlement; only proven cleanup may settle this one.
    return completed;
  };
  const acceptCandidates = (
    candidates: readonly DynamicGeometryCandidate[],
    ordering: DynamicGeometryOrdering,
  ): Result<readonly DynamicGeometryCandidate[], DynamicGeometryError> => {
    if (!Array.isArray(candidates) || candidates.length === 0)
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-invalid',
          'a geometry group is a nonempty array of owned prepared candidates',
          'prepare one candidate per entity and retry the group admission',
        ),
      );
    const first = candidates[0];
    if (first === undefined || first === null || typeof first !== 'object')
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-candidate-not-found',
          'every geometry candidate is an object issued by this Renderer',
          'discard the invalid candidate and use a prepared credential',
        ),
      );
    const world = first.world as World;
    if (world === null || typeof world !== 'object' || !attachedWorlds.has(world))
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-world-not-attached',
          'candidate and fixed-step ordering belong to the same attached World',
          'attach the World before accepting dynamic geometry',
        ),
      );
    ensureHealthyWorld(world);
    if (batchActive)
      throwFault(world, new Error('dynamic geometry admission reentered its ECS swap'));
    batchActive = true;
    try {
      const generation = currentGeneration();
      const uniqueEntities = new Set<number>();
      const entries: Array<{
        readonly input: DynamicGeometryCandidate;
        readonly record: HostCandidateRecord;
      }> = [];
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (candidate === undefined || candidate === null || typeof candidate !== 'object')
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-candidate-not-found',
              'every geometry candidate is an object issued by this Renderer',
              'discard the invalid candidate and use a prepared credential',
              { actual: { inputIndex: index } },
            ),
          );
        const candidateWorld = candidate.world as World;
        if (candidateWorld === null || typeof candidateWorld !== 'object')
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-world-not-attached',
              'every candidate belongs to the attached World',
              'discard the invalid credential and prepare it against the attached World',
              { actual: { inputIndex: index } },
            ),
          );
        const byId = hostCandidates.get(candidate.candidateId);
        const record = candidateRecord(candidate);
        if (record === undefined)
          return err(
            new DynamicGeometryError(
              byId === undefined
                ? 'dynamic-geometry-candidate-not-found'
                : 'dynamic-geometry-receipt-mismatch',
              'admission uses the exact host candidate owner and lifecycle credential',
              'discard altered or stale credentials and use the value returned by preparation',
              { candidateId: candidate.candidateId, actual: { inputIndex: index } },
            ),
          );
        if (
          candidateWorld !== world ||
          candidate.world !== ordering?.world ||
          !attachedWorlds.has(world)
        )
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-world-not-attached',
              'all candidates and fixed-step ordering belong to the same attached World',
              'attach the World and submit its PhysicsWorld ordering before accepting geometry',
              { candidateId: candidate.candidateId, actual: { inputIndex: index } },
            ),
          );
        ensureHealthyWorld(candidateWorld);
        if (
          record.cleanup !== undefined ||
          record.candidate.state !== 'prepared' ||
          candidate.state !== 'prepared'
        )
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-candidate-state',
              'admission consumes each prepared candidate exactly once',
              'retain the accepted or published receipt instead of admitting it again',
              { candidateId: candidate.candidateId },
            ),
          );
        if (!uniqueEntities.add(record.entity))
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-invalid',
              'a geometry group contains one candidate per distinct entity',
              'prepare one candidate per entity and retry the group admission',
              { candidateId: candidate.candidateId, actual: { entity: record.entity } },
            ),
          );
        entries.push({ input: candidate, record });
      }
      if (ordering === undefined || !Number.isInteger(ordering.fixedStep) || ordering.fixedStep < 0)
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-ordering-required',
            'ordering names the attached World and a non-negative current fixed step',
            'accept candidates during their current paired fixed-step admission',
          ),
        );

      const currentFixedStep = fixedStepOf(world);
      for (const { input, record } of entries) {
        if (input.generation !== generation || record.generation !== generation)
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-generation-mismatch',
              'every candidate uses the active Renderer device generation',
              'prepare candidates again against the active device generation',
              {
                candidateId: input.candidateId,
                actual: { generation, candidate: input.generation },
              },
            ),
          );
        if (
          !input.gpuReady ||
          record.residency === undefined ||
          record.residency.isCurrent?.() === false
        )
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-gpu-not-ready',
              'every candidate retains standard GPU residency before acceptance',
              'repair GPU residency and prepare the candidate again',
              { candidateId: input.candidateId },
            ),
          );
        if (!record.meshLeaseHeld || !record.previousMeshLeaseHeld)
          throwFault(
            world,
            new DynamicGeometryError(
              'dynamic-geometry-invalid',
              'both Renderer-owned MeshAsset shared-reference leases remain held until commit',
              'rebuild the paired World and Renderer because a managed lease was lost',
              { candidateId: input.candidateId },
            ),
          );
        if (
          currentFixedStep === undefined ||
          input.fixedStep === undefined ||
          input.fixedStep > currentFixedStep ||
          ordering.fixedStep !== currentFixedStep
        )
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-ordering-required',
              'ordering matches the current World tick, no earlier than preparation',
              'accept prepared candidates during the current fixed-step admission',
              {
                candidateId: input.candidateId,
                actual: {
                  candidate: input.fixedStep,
                  currentFixedStep,
                  ordering: ordering.fixedStep,
                },
              },
            ),
          );
        if (
          !hasRenderableBinding(world, record.entity) ||
          !hasMaterialIdentity(world, record.entity, record.mesh, input.materialIdentity)
        )
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-invalid',
              'the candidate remains bound to a live ECS MeshFilter and MeshRenderer',
              'keep the candidate MeshFilter binding intact until the consuming draw',
              { candidateId: input.candidateId },
            ),
          );
        if (meshHandleOf(world, record.entity) !== record.previousMeshHandle)
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-invalid',
              'the old MeshFilter binding remains visible until candidate acceptance',
              'reconcile the entity and prepare a fresh candidate before retrying',
              { candidateId: input.candidateId },
            ),
          );
        for (const handle of [record.meshHandle, record.previousMeshHandle]) {
          const resolved = world.sharedRefs.resolve(handle);
          if (!resolved.ok)
            throwFault(
              world,
              new DynamicGeometryError(
                'dynamic-geometry-invalid',
                'each held MeshAsset shared reference resolves before and after the ECS swap',
                'rebuild the paired World and Renderer because a managed payload is unavailable',
                { candidateId: input.candidateId, actual: resolved.error },
              ),
            );
          if (world.sharedRefs.refcount(handle) < 1)
            throwFault(
              world,
              new DynamicGeometryError(
                'dynamic-geometry-invalid',
                'each Renderer-owned MeshAsset shared-reference lease is reflected in its store',
                'rebuild the paired World and Renderer because a managed lease cannot be proven',
                { candidateId: input.candidateId, actual: { handle } },
              ),
            );
        }
        if (input.physicsEntity !== undefined) {
          const publication = physicsPublicationOf(world, input.physicsEntity, true);
          if (
            publication === undefined ||
            publication.fixedStep !== currentFixedStep ||
            publication.revision !== input.revision
          )
            return err(
              new DynamicGeometryError(
                'dynamic-geometry-ordering-required',
                'candidate physicsEntity has the active paired PhysicsWorld admission',
                'accept geometry inside admitDerivedShapeCandidates commitGeometry before physics step',
                { candidateId: input.candidateId, actual: publication },
              ),
            );
        }
      }

      const candidatesForLifecycle = entries.map(({ input }) => input);
      const validated = lifecycle.validateCandidates(candidatesForLifecycle, ordering);
      if (!validated.ok) return err(validated.error);

      const superseded = [...hostCandidates.values()].filter(
        (record) =>
          record.world === world &&
          uniqueEntities.has(record.entity) &&
          !candidatesForLifecycle.some(
            (candidate) => candidate.candidateId === record.candidate.candidateId,
          ) &&
          (record.candidate.state === 'prepared' || record.candidate.state === 'accepted'),
      );
      const allTouched = [...entries.map(({ record }) => record), ...superseded];
      const bindingBefore = new Map<number, Handle<'MeshAsset', 'shared'> | undefined>();
      const referenceCounts = new Map<
        number,
        { readonly handle: Handle<'MeshAsset', 'shared'>; readonly count: number }
      >();
      for (const record of allTouched) {
        if (!bindingBefore.has(record.entity))
          bindingBefore.set(record.entity, meshHandleOf(world, record.entity));
        for (const handle of [record.meshHandle, record.previousMeshHandle]) {
          const key = Number(handle);
          if (!referenceCounts.has(key))
            referenceCounts.set(key, { handle, count: world.sharedRefs.refcount(handle) });
        }
      }
      for (const { record } of entries) {
        if (bindingBefore.get(record.entity) !== record.previousMeshHandle)
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-invalid',
              'all old MeshFilter bindings remain unchanged through whole-batch preflight',
              'reconcile the entity and prepare a fresh candidate before retrying',
              { candidateId: record.candidate.candidateId },
            ),
          );
      }
      const lifecycleBefore = JSON.stringify(lifecycle.inspect());
      const hostBefore = [...hostCandidates.entries()].map(([id, record]) => ({
        id,
        record,
        candidate: record.candidate,
        meshLeaseHeld: record.meshLeaseHeld,
        previousMeshLeaseHeld: record.previousMeshLeaseHeld,
      }));
      const receiptsBefore = new Map(
        hostBefore.map(({ id, candidate }) => [id, lifecycle.receipt(candidate)] as const),
      );
      const attempted: HostCandidateRecord[] = [];
      const stateWasPreserved = (): boolean =>
        JSON.stringify(lifecycle.inspect()) === lifecycleBefore &&
        hostBefore.length === hostCandidates.size &&
        hostBefore.every(
          ({ id, record, candidate, meshLeaseHeld, previousMeshLeaseHeld }) =>
            hostCandidates.get(id) === record &&
            record.candidate === candidate &&
            record.meshLeaseHeld === meshLeaseHeld &&
            record.previousMeshLeaseHeld === previousMeshLeaseHeld &&
            JSON.stringify(lifecycle.receipt(candidate)) === JSON.stringify(receiptsBefore.get(id)),
        );
      const bindingsAndReferencesMatch = (
        expectedBindings: ReadonlyMap<number, Handle<'MeshAsset', 'shared'> | undefined>,
        expectedCounts: ReadonlyMap<
          number,
          { readonly handle: Handle<'MeshAsset', 'shared'>; readonly count: number }
        >,
      ): boolean => {
        if (world.execution.health !== 'healthy') return false;
        for (const [entity, expected] of expectedBindings) {
          if (meshHandleOf(world, entity) !== expected) return false;
        }
        for (const { handle, count } of expectedCounts.values()) {
          const resolved = world.sharedRefs.resolve(handle);
          if (!resolved.ok || world.sharedRefs.refcount(handle) !== count) return false;
        }
        return true;
      };
      const rollback = (cause: unknown): DynamicGeometryError | undefined => {
        for (const record of [...attempted].reverse()) {
          const previous = bindingBefore.get(record.entity);
          const current = meshHandleOf(world, record.entity);
          if (current === previous) continue;
          if (current !== record.meshHandle)
            return fault(
              world,
              new DynamicGeometryError(
                'dynamic-geometry-invalid',
                'a failed batch swap exposes only its previous or attempted MeshFilter handle',
                'rebuild the paired World and Renderer because rollback found an unexpected binding',
                { candidateId: record.candidate.candidateId, actual: { cause, current, previous } },
              ),
            );
          try {
            const restored = world.set(record.entity as EntityHandle, MeshFilter, {
              assetHandle: record.previousMeshHandle,
            });
            if (!restored.ok && meshHandleOf(world, record.entity) !== previous)
              return fault(
                world,
                new DynamicGeometryError(
                  'dynamic-geometry-invalid',
                  'every staged MeshFilter write can be restored through the ECS write barrier',
                  'rebuild the paired World and Renderer after an uncertain rollback',
                  {
                    candidateId: record.candidate.candidateId,
                    actual: { cause, restore: restored.error },
                  },
                ),
              );
          } catch (restoreCause) {
            return fault(
              world,
              new DynamicGeometryError(
                'dynamic-geometry-invalid',
                'every staged MeshFilter write can be restored through the ECS write barrier',
                'rebuild the paired World and Renderer after an uncertain rollback',
                { candidateId: record.candidate.candidateId, actual: { cause, restoreCause } },
              ),
            );
          }
        }
        if (!bindingsAndReferencesMatch(bindingBefore, referenceCounts) || !stateWasPreserved())
          return fault(
            world,
            new DynamicGeometryError(
              'dynamic-geometry-invalid',
              'a refused batch restores all MeshFilter bindings, shared references, lifecycle history, and reservations',
              'rebuild the paired World and Renderer because rollback could not be proven',
              { actual: cause },
            ),
          );
        return undefined;
      };

      for (const { input, record } of entries) {
        attempted.push(record);
        const swapped = (() => {
          try {
            return world.set(record.entity as EntityHandle, MeshFilter, {
              assetHandle: record.meshHandle,
            });
          } catch (cause) {
            const rollbackFault = rollback(cause);
            throw (
              rollbackFault ??
              fault(
                world,
                new DynamicGeometryError(
                  'dynamic-geometry-invalid',
                  'ECS MeshFilter writes either commit or return a recoverable Result',
                  'rebuild the paired World and Renderer after an unexpected write exception',
                  { candidateId: input.candidateId, actual: cause },
                ),
              )
            );
          }
        })();
        if (!swapped.ok) {
          const rollbackFault = rollback(swapped.error);
          if (rollbackFault !== undefined) throw rollbackFault;
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-invalid',
              'a refused MeshFilter swap restores the complete preflight snapshot',
              'retain the prepared candidates and retry after the ECS write barrier is healthy',
              { candidateId: input.candidateId, actual: swapped.error },
            ),
          );
        }
      }

      const expectedCommittedCounts = new Map(referenceCounts);
      for (const { record } of entries) {
        if (record.previousMeshHandle === record.meshHandle) continue;
        const previousKey = Number(record.previousMeshHandle);
        const candidateKey = Number(record.meshHandle);
        const previous = expectedCommittedCounts.get(previousKey);
        const candidate = expectedCommittedCounts.get(candidateKey);
        if (previous !== undefined)
          expectedCommittedCounts.set(previousKey, { ...previous, count: previous.count - 1 });
        if (candidate !== undefined)
          expectedCommittedCounts.set(candidateKey, { ...candidate, count: candidate.count + 1 });
      }
      const expectedCommittedBindings = new Map(bindingBefore);
      for (const { record } of entries)
        expectedCommittedBindings.set(record.entity, record.meshHandle);
      if (!bindingsAndReferencesMatch(expectedCommittedBindings, expectedCommittedCounts)) {
        const rollbackFault = rollback(
          'post-stage binding or shared-reference verification failed',
        );
        if (rollbackFault !== undefined) throw rollbackFault;
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-invalid',
            'the full ECS batch exposes the staged handles with exact managed-reference counts',
            'repair the MeshAsset bindings and retry from the retained prepared candidates',
          ),
        );
      }

      const accepted = (() => {
        try {
          return lifecycle.acceptCandidates(candidatesForLifecycle, ordering);
        } catch (cause) {
          const rollbackFault = rollback(cause);
          throw (
            rollbackFault ??
            fault(
              world,
              new DynamicGeometryError(
                'dynamic-geometry-invalid',
                'lifecycle acceptance commits the preflighted candidate batch once',
                'rebuild the paired World and Renderer after an uncertain lifecycle commit',
                { actual: cause },
              ),
            )
          );
        }
      })();
      if (!accepted.ok) {
        const rollbackFault = rollback(accepted.error);
        if (rollbackFault !== undefined) throw rollbackFault;
        return err(accepted.error);
      }
      if (accepted.value.length !== entries.length)
        throw fault(
          world,
          new DynamicGeometryError(
            'dynamic-geometry-invalid',
            'lifecycle acceptance returns one committed credential per staged ECS entity',
            'rebuild the paired World and Renderer because the batch commit shape changed',
            { actual: { expected: entries.length, received: accepted.value.length } },
          ),
        );
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const committed = accepted.value[index];
        if (entry === undefined || committed === undefined)
          throw fault(world, new Error('lifecycle acceptance returned an incomplete batch'));
        entry.record.candidate = committed;
      }

      const postCommitFailures: DynamicGeometryError[] = [];
      for (const record of superseded) {
        try {
          scheduleCandidateCleanup(record, false, 'cancel');
        } catch (cause) {
          postCommitFailures.push(
            fault(
              world,
              new DynamicGeometryError(
                'dynamic-geometry-invalid',
                'GPU residency release and superseded candidate cleanup complete after commit',
                'rebuild the paired World and Renderer after a post-commit cleanup failure',
                { candidateId: record.candidate.candidateId, actual: cause },
              ),
            ),
          );
        }
      }
      try {
        options.onTopologyChanged?.();
      } catch (cause) {
        postCommitFailures.push(
          fault(
            world,
            new DynamicGeometryError(
              'dynamic-geometry-invalid',
              'the temporal geometry owner accepts one invalidation after the ECS batch commits',
              'rebuild the paired World and Renderer after a post-commit callback failure',
              { actual: cause },
            ),
          ),
        );
      }
      if (postCommitFailures.length > 0) throw postCommitFailures[0];
      return ok(accepted.value);
    } finally {
      batchActive = false;
    }
  };
  const beginPreparation = (
    input: DynamicGeometryPrepareInput,
    candidate?: DynamicGeometryCandidate,
  ): Result<HostCandidateRecord, DynamicGeometryError> => {
    const world = input.world as World;
    if (!attachedWorlds.has(world))
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-world-not-attached',
          'the candidate World is attached to this Renderer',
          'call renderer.attach(world) before preparing dynamic geometry',
        ),
      );
    ensureHealthyWorld(world);
    const generation = synchronizeGeneration();
    ensureHealthyWorld(world);
    if (input.entity === undefined || !hasRenderableBinding(world, input.entity)) {
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-invalid',
          'the candidate entity and MeshAsset payload belong to the attached World',
          'attach MeshFilter/MeshRenderer and pass the payload resolved by its World shared handle',
          { actual: { entity: input.entity, meshHandle: input.meshHandle } },
        ),
      );
    }
    if (input.meshHandle === undefined)
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-gpu-not-ready',
          'the standard MeshAsset shared handle is present before Renderer admission',
          'allocate the MeshAsset through world.allocSharedRef and retry after asset projection',
          { actual: { entity: input.entity, meshHandle: input.meshHandle } },
        ),
      );
    const meshHandle = input.meshHandle;
    if (
      !ownsMeshPayload(world, meshHandle, input.mesh) ||
      !hasMaterialIdentity(world, input.entity, input.mesh, input.materialIdentity)
    ) {
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-invalid',
          'the candidate MeshAsset and material identity belong to the attached World',
          'pass the payload resolved by its World shared handle and its live material slot identity',
          { actual: { entity: input.entity, meshHandle } },
        ),
      );
    }
    const fixedStep = fixedStepOf(world);
    if (fixedStep === undefined) {
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-ordering-required',
          'the attached World exposes its ECS FixedTime resource',
          'prepare geometry from an initialized World fixed-step schedule',
        ),
      );
    }
    const previousMeshHandle = meshHandleOf(world, input.entity);
    if (previousMeshHandle === undefined) {
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-invalid',
          'the prepared entity retains a live MeshFilter binding',
          'keep the ECS render entity alive while staging geometry',
          { actual: { entity: input.entity } },
        ),
      );
    }
    const referenceCounts = new Map(
      [previousMeshHandle, meshHandle].map((handle) => [handle, world.sharedRefs.refcount(handle)]),
    );
    const lifecycleBefore = JSON.stringify(lifecycle.inspect());
    const preparationWasRestored = (): boolean =>
      world.execution.health === 'healthy' &&
      meshHandleOf(world, input.entity) === previousMeshHandle &&
      JSON.stringify(lifecycle.inspect()) === lifecycleBefore &&
      [...referenceCounts].every(
        ([handle, count]) =>
          world.sharedRefs.refcount(handle) === count && world.sharedRefs.resolve(handle).ok,
      );
    try {
      const previousRetained = world.sharedRefs.retain(previousMeshHandle);
      if (!previousRetained.ok) {
        if (!preparationWasRestored()) throw fault(world, previousRetained.error);
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-invalid',
            'the previous ECS MeshFilter binding remains live for Renderer preparation',
            'retain the current MeshAsset handle before staging replacement geometry',
            { actual: previousRetained.error },
          ),
        );
      }
      const retained = world.sharedRefs.retain(meshHandle);
      if (!retained.ok) {
        const releasedPrevious = world.sharedRefs.release(previousMeshHandle);
        if (!releasedPrevious.ok || !preparationWasRestored())
          throw fault(world, { candidate: retained.error, previous: releasedPrevious });
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-invalid',
            'the candidate MeshAsset shared reference remains live for Renderer preparation',
            'retain the World-owned MeshAsset handle before staging a candidate',
            { actual: retained.error },
          ),
        );
      }
      const releaseRetained = (): DynamicGeometryError | undefined => {
        const releasedCandidate = world.sharedRefs.release(meshHandle);
        const releasedPrevious = world.sharedRefs.release(previousMeshHandle);
        if (!releasedCandidate.ok || !releasedPrevious.ok)
          return new DynamicGeometryError(
            'dynamic-geometry-invalid',
            'failed candidate preparation releases both World shared-reference leases',
            'repair the World shared references before retrying geometry preparation',
            {
              actual: {
                candidate: releasedCandidate.ok ? undefined : releasedCandidate.error,
                previous: releasedPrevious.ok ? undefined : releasedPrevious.error,
              },
            },
          );
        return undefined;
      };
      const prepared =
        candidate === undefined
          ? lifecycle.prepare({ ...input, fixedStep }, generation)
          : ok(candidate);
      if (!prepared.ok) {
        const released = releaseRetained();
        if (released !== undefined || !preparationWasRestored())
          throw fault(world, released ?? prepared.error);
        return prepared;
      }
      // Admission rejects count/byte overflow before allocating the private snapshot.
      // The complete batch still snapshots synchronously before its first upload.
      let mesh: MeshAsset;
      const meshTransfers: ArrayBuffer[] = [];
      try {
        mesh = cloneMesh(input.mesh, meshTransfers);
      } catch (cause) {
        // The roster owner cancels pre-reserved batch candidates. A single
        // preparation owns its new lifecycle reservation here.
        const cancelled =
          candidate === undefined ? lifecycle.cancel(prepared.value) : ok(undefined);
        const released = releaseRetained();
        if (!cancelled.ok || released !== undefined || !preparationWasRestored())
          throw fault(world, { cause, cancelled, released });
        throw cause;
      }
      const record: HostCandidateRecord = {
        candidate: prepared.value,
        mesh,
        meshTransfers,
        world,
        entity: input.entity as number,
        previousMeshHandle,
        meshHandle,
        residency: undefined,
        residencyStore: undefined,
        generation,
        meshLeaseHeld: true,
        previousMeshLeaseHeld: true,
      };
      hostCandidates.set(prepared.value.candidateId, record);
      return ok(record);
    } catch (cause) {
      if (preparationWasRestored()) throw cause;
      throw fault(world, cause);
    }
  };
  const host: DynamicGeometryAdmissionHost = {
    acceptDynamicGeometry(candidate, ordering) {
      const accepted = acceptCandidates([candidate], ordering);
      if (!accepted.ok) return accepted;
      const result = accepted.value[0];
      if (result === undefined)
        throw fault(candidate.world as World, new Error('empty accepted batch'));
      return ok(result);
    },
    acceptDynamicGeometryCandidates: acceptCandidates,
    isDynamicGeometryCurrent(candidate) {
      const record = candidateRecord(candidate);
      return (
        record !== undefined &&
        record.cleanup === undefined &&
        record.residency !== undefined &&
        record.residency.isCurrent?.() !== false &&
        record.generation === currentGeneration() &&
        attachedWorlds.has(record.world) &&
        !faultedWorlds.has(record.world)
      );
    },
    dynamicGeometryReceipt(candidate) {
      const world = candidate.world as World;
      if (world !== null && typeof world === 'object' && faultedWorlds.has(world)) return undefined;
      synchronizeGeneration();
      if (candidate.generation !== currentGeneration() || faultedWorlds.has(world))
        return undefined;
      return lifecycle.receipt(candidate);
    },
    dynamicGeometryFault(world) {
      return faultedWorlds.get(world);
    },
    cancelDynamicGeometry(candidate) {
      const world = candidate.world as World;
      if (world !== null && typeof world === 'object') ensureHealthyWorld(world);
      synchronizeGeneration();
      if (world !== null && typeof world === 'object') ensureHealthyWorld(world);
      const record = candidateRecord(candidate);
      if (record === undefined) {
        // A candidate id is not an authority. If this host still has that id,
        // reject the forged owner/lifecycle credential before touching ECS or
        // delegating to the lifecycle state machine.
        if (hostCandidates.has(candidate.candidateId))
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-receipt-mismatch',
              'cancellation uses the exact host candidate owner and lifecycle credential',
              'discard the altered credential and use the value returned by preparation',
              { candidateId: candidate.candidateId },
            ),
          );
        return lifecycle.cancel(candidate);
      }
      const issued = record.candidate.state;
      const unpublished = issued === 'prepared' || issued === 'accepted';
      if (
        unpublished
          ? candidate.state !== issued
          : candidate.state !== 'accepted' && candidate.state !== 'published'
      )
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-receipt-mismatch',
            'cancellation uses the candidate state issued by the host lifecycle',
            'discard the altered credential and use the value returned by preparation or acceptance',
            { candidateId: candidate.candidateId },
          ),
        );
      if (!unpublished || record.cleanup !== undefined || record.generation !== currentGeneration())
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-candidate-state',
            'only current unpublished geometry without terminal cleanup may be cancelled',
            'retain the terminal owner until its cleanup fence completes',
            { candidateId: candidate.candidateId },
          ),
        );
      if (issued === 'accepted') {
        const currentHandle = meshHandleOf(record.world, record.entity);
        if (currentHandle !== record.meshHandle && currentHandle !== record.previousMeshHandle)
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-invalid',
              'cancel does not overwrite a newer ECS MeshFilter binding',
              'reconcile the live entity before cancelling this candidate',
              { candidateId: candidate.candidateId },
            ),
          );
        if (currentHandle === record.meshHandle) {
          const counts = new Map(
            [record.meshHandle, record.previousMeshHandle].map((handle) => [
              handle,
              record.world.sharedRefs.refcount(handle),
            ]),
          );
          const before = JSON.stringify(lifecycle.inspect());
          try {
            const restored = record.world.set(record.entity as EntityHandle, MeshFilter, {
              assetHandle: record.previousMeshHandle,
            });
            const unchanged = () =>
              record.world.execution.health === 'healthy' &&
              JSON.stringify(lifecycle.inspect()) === before &&
              [...counts].every(
                ([handle, count]) =>
                  record.world.sharedRefs.refcount(handle) ===
                  count +
                    (restored.ok
                      ? Number(handle === record.previousMeshHandle) -
                        Number(handle === record.meshHandle)
                      : 0),
              ) &&
              meshHandleOf(record.world, record.entity) ===
                (restored.ok ? record.previousMeshHandle : currentHandle);
            if (!unchanged())
              throw new Error(
                'cancellation scalar write did not preserve its binding and lease contract',
              );
            if (!restored.ok)
              return err(
                new DynamicGeometryError(
                  'dynamic-geometry-invalid',
                  'cancel restores the previous MeshFilter through the ECS write barrier',
                  'restore the entity before retrying cancellation',
                  { candidateId: candidate.candidateId, actual: restored.error },
                ),
              );
          } catch (cause) {
            throw fault(record.world, cause);
          }
        }
      }
      try {
        scheduleCandidateCleanup(record, false, 'cancel');
        return ok(undefined);
      } catch (cause) {
        throw fault(record.world, cause);
      }
    },
    invalidateDynamicGeometryWorld(world) {
      const doomed = [...hostCandidates.values()].filter((record) => record.world === world);
      const completions: Promise<void>[] = [];
      for (const record of doomed) {
        try {
          const completion = scheduleCandidateCleanup(record, true);
          if (completion !== undefined) completions.push(completion);
        } catch (cause) {
          fault(record.world, cause);
          if (record.cleanup !== undefined) completions.push(record.cleanup.completed);
        }
      }
      lifecycle.invalidateWorld(
        world,
        completions.length === 0 ? undefined : Promise.all(completions),
      );
    },
    retireDynamicGeometry(candidate) {
      const world = candidate.world as World;
      if (world !== null && typeof world === 'object') ensureHealthyWorld(world);
      synchronizeGeneration();
      if (world !== null && typeof world === 'object') ensureHealthyWorld(world);
      const record = candidateRecord(candidate);
      if (record === undefined) {
        if (hostCandidates.has(candidate.candidateId))
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-receipt-mismatch',
              'retirement uses the exact host candidate owner and lifecycle credential',
              'discard the altered credential and use the value returned by acceptance',
              { candidateId: candidate.candidateId },
            ),
          );
        return lifecycle.retire(candidate);
      }
      if (candidate.state !== 'accepted' && candidate.state !== 'published')
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-receipt-mismatch',
            'retirement uses a candidate state issued by the host lifecycle',
            'discard the altered credential and use the value returned by acceptance',
            { candidateId: candidate.candidateId },
          ),
        );
      if (meshHandleOf(record.world, record.entity) === record.meshHandle)
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-invalid',
            'retirement does not evict the MeshFilter that still consumes the candidate',
            'swap the ECS MeshFilter through its write barrier before retiring this geometry',
            { candidateId: candidate.candidateId },
          ),
        );
      if (record.cleanup !== undefined) {
        if (record.candidate.state === 'retired') return ok(undefined);
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-candidate-state',
            'retirement cannot replace an already-owned terminal cleanup',
            'retain the terminal owner until its cleanup fence completes',
            { candidateId: candidate.candidateId },
          ),
        );
      }
      if (lifecycle.receipt(record.candidate) === undefined) return lifecycle.retire(candidate);
      try {
        scheduleCandidateCleanup(record, false, 'retire');
        return ok(undefined);
      } catch (cause) {
        throw fault(record.world, cause);
      }
    },
    publishDynamicGeometry(frame, worlds, fixedStep) {
      synchronizeGeneration();
      const targetWorlds = new Set<World>();
      for (const candidateWorld of worlds ?? attachedWorlds) {
        const world = candidateWorld as World;
        if (attachedWorlds.has(world) && !faultedWorlds.has(world)) targetWorlds.add(world);
      }
      const receipts: DynamicGeometryReceipt[] = [];
      for (const world of targetWorlds) {
        const worldFixedStep = fixedStepOf(world);
        if (worldFixedStep === undefined) continue;
        // Local draws derive the tick from their attached World. A remote draw
        // must carry the consumed source tick; missing evidence cannot borrow
        // the current simulation time.
        const publicationFixedStep =
          fixedStep ??
          (options.publishedFixedStep === undefined
            ? worldFixedStep
            : options.publishedFixedStep(world));
        if (publicationFixedStep === undefined) continue;
        receipts.push(
          ...lifecycle.publishFrame(
            frame,
            [world],
            publicationFixedStep,
            (candidate) => {
              const candidateWorld = candidate.world as World;
              if (candidateWorld !== world || !attachedWorlds.has(candidateWorld)) return false;
              const hostRecord = candidateRecord(candidate);
              if (
                hostRecord === undefined ||
                hostRecord.cleanup !== undefined ||
                hostRecord.candidate.state === 'prepared' ||
                !hasRenderableBinding(candidateWorld, candidate.entity) ||
                meshHandleOf(candidateWorld, candidate.entity) !== candidate.meshHandle ||
                !hasMaterialIdentity(
                  candidateWorld,
                  candidate.entity,
                  hostRecord.mesh,
                  candidate.materialIdentity,
                )
              )
                return false;
              if (!isConsumedByRenderFrame(candidate)) return false;
              const actualFixedStep = publicationFixedStep;
              if (candidate.fixedStep === undefined || actualFixedStep === undefined) return false;
              // RenderFrameInput.fixedStep is an assertion from the host, not a
              // second clock. It may name a later World tick in a multi-fixed-step
              // host frame, but it cannot manufacture a step the attached World
              // has not actually published. An explicit mismatch remains a hard
              // rejection; omission uses the World-derived value above.
              if (
                (options.publishedFixedStep === undefined
                  ? worldFixedStep !== actualFixedStep
                  : worldFixedStep < actualFixedStep) ||
                actualFixedStep < candidate.fixedStep
              )
                return false;
              if (candidate.physicsEntity !== undefined) {
                const publication = physicsPublicationOf(candidateWorld, candidate.physicsEntity);
                if (
                  publication === undefined ||
                  publication.fixedStep < candidate.fixedStep ||
                  publication.revision !== candidate.revision
                )
                  return false;
              }
              return true;
            },
            recordStageLane,
          ),
        );
      }
      for (const receipt of receipts) {
        const record = hostCandidates.get(receipt.candidateId);
        if (record !== undefined) {
          if (record.candidate.state !== 'published')
            record.candidate = Object.freeze({ ...record.candidate, state: 'published' as const });
          if (receipt.frame.completed !== undefined) {
            void receipt.frame.completed.then(undefined, (cause) => {
              record.cleanup ??= { completed: new Promise(() => {}), receipt };
              fault(record.world, cause);
            });
            try {
              record.residency?.track?.(receipt.frame.completed);
            } catch (cause) {
              record.cleanup = { completed: new Promise(() => {}), receipt };
              throw fault(record.world, cause);
            }
          }
        }
      }
      return receipts;
    },
  };
  const prepareResidencyAsync = async (
    record: HostCandidateRecord,
    port: DynamicGeometryResidencyPort,
    signal?: AbortSignal,
    waitForCapacity = false,
  ): Promise<Result<DynamicGeometryCandidate, DynamicGeometryError>> => {
    const cancelled = () =>
      new DynamicGeometryError(
        'dynamic-geometry-candidate-state',
        'preparation is current and has not been cancelled',
        'discard the stale preparation',
      );
    if (signal?.aborted) return err(cancelled());
    const pending = Promise.resolve().then(() =>
      port.prepare(
        {
          world: record.world,
          entity: record.entity,
          meshHandle: record.meshHandle,
          mesh: record.mesh,
        },
        {
          ...(signal === undefined ? {} : { signal }),
          waitForCapacity,
          transfers: record.meshTransfers,
        },
      ),
    );
    record.residencyPending = pending.then((result) => {
      if (result.ok) record.residency = result.value;
    });
    void record.residencyPending.catch((cause) => fault(record.world, cause));
    const cancel = () => {
      try {
        scheduleCandidateCleanup(record, false, 'cancel');
      } catch (cause) {
        fault(record.world, cause);
      }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const resident = await pending;
      await record.residencyPending;
      delete record.residencyPending;
      if (!resident.ok) {
        await scheduleCandidateCleanup(record, false, 'cancel');
        return resident;
      }
      const stale = !attachedWorlds.has(record.world)
        ? new DynamicGeometryError(
            'dynamic-geometry-world-not-attached',
            'the preparation World is still attached',
            'discard preparation from the detached World',
          )
        : record.generation !== currentGeneration()
          ? new DynamicGeometryError(
              'dynamic-geometry-generation-mismatch',
              'preparation belongs to the current Render generation',
              'prepare geometry again after Render recovery',
            )
          : signal?.aborted || record.cleanup !== undefined
            ? cancelled()
            : !resident.value.isCurrent()
              ? new DynamicGeometryError(
                  'dynamic-geometry-gpu-not-ready',
                  'the prepared physical allocation remains current',
                  'prepare geometry again after Render readiness',
                )
              : undefined;
      if (stale !== undefined) {
        await scheduleCandidateCleanup(record, true, 'cancel');
        return err(stale);
      }
      ensureHealthyWorld(record.world);
      return ok(record.candidate);
    } catch (cause) {
      throw fault(record.world, cause);
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  };
  const prepareResidencySync = (
    record: HostCandidateRecord,
    getGpuStore: () => GpuResidencyCache,
  ): Result<DynamicGeometryCandidate, DynamicGeometryError> => {
    const world = record.world;
    const meshHandle = record.meshHandle;
    try {
      const residencyStore = getGpuStore();
      record.residencyStore = residencyStore;
      const resident = residencyStore.ensureResident(meshHandle, record.mesh, world);
      // A native refusal does not attest that no allocation or write occurred.
      // Keep the registered owner for paired recovery instead of offering retry.
      if (!resident.ok) throw resident.error;
      try {
        record.residency = residencyStore.retainMeshResidency(meshHandle, world);
        if (record.residency !== undefined) return ok(record.candidate);
        throw new Error('uploaded candidate did not return its owned native residency lease');
      } catch (cause) {
        // Acquisition itself may have retained a lease before throwing. Do
        // not acquire another lease and pretend that releasing it proves cleanup.
        record.cleanup = { completed: new Promise(() => {}), receipt: undefined };
        throw cause;
      }
    } catch (cause) {
      throw fault(world, cause);
    }
  };

  const cancelPreparedBatch = (candidates: readonly DynamicGeometryCandidate[]): void => {
    for (const candidate of candidates) {
      const record = hostCandidates.get(candidate.candidateId);
      if (record === undefined) lifecycle.cancel(candidate);
      else scheduleCandidateCleanup(record, record.residency !== undefined, 'cancel');
    }
  };
  const beginBatch = (
    inputs: readonly DynamicGeometryPrepareInput[],
  ): Result<readonly HostCandidateRecord[], DynamicGeometryError> => {
    const generation = synchronizeGeneration();
    const prepared = lifecycle.prepareCandidates(
      inputs.map((input) => {
        const fixedStep = fixedStepOf(input.world as World);
        return { ...input, ...(fixedStep === undefined ? {} : { fixedStep }) };
      }),
      generation,
    );
    if (!prepared.ok) return prepared;
    const records: HostCandidateRecord[] = [];
    try {
      for (const [index, input] of inputs.entries()) {
        const candidate = prepared.value[index];
        if (candidate === undefined) throw new Error('incomplete prepared geometry roster');
        const result = beginPreparation(input, candidate);
        if (!result.ok) {
          cancelPreparedBatch(prepared.value);
          return result;
        }
        records.push(result.value);
      }
      return ok(records);
    } catch (cause) {
      cancelPreparedBatch(prepared.value);
      throw cause;
    }
  };
  return {
    host,
    fault,
    ensureHealthyWorld,
    async prepareAsync(
      input: DynamicGeometryPrepareInput,
      port: DynamicGeometryResidencyPort,
      signal?: AbortSignal,
    ): Promise<Result<DynamicGeometryCandidate, DynamicGeometryError>> {
      if (signal?.aborted)
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-candidate-state',
            'preparation has not been cancelled',
            'discard the cancelled preparation',
          ),
        );
      const prepared = beginPreparation(input);
      return prepared.ok ? prepareResidencyAsync(prepared.value, port, signal) : prepared;
    },
    prepareSync(
      input: DynamicGeometryPrepareInput,
      getGpuStore: () => GpuResidencyCache,
    ): Result<DynamicGeometryCandidate, DynamicGeometryError> {
      const prepared = beginPreparation(input);
      return prepared.ok ? prepareResidencySync(prepared.value, getGpuStore) : prepared;
    },
    prepareBatchSync(
      inputs: readonly DynamicGeometryPrepareInput[],
      getGpuStore: () => GpuResidencyCache,
    ): Result<readonly DynamicGeometryCandidate[], DynamicGeometryError> {
      const begun = beginBatch(inputs);
      if (!begun.ok) return begun;
      const candidates = begun.value.map((record) => record.candidate);
      const results: DynamicGeometryCandidate[] = [];
      for (const record of begun.value) {
        const result = prepareResidencySync(record, getGpuStore);
        if (!result.ok) {
          cancelPreparedBatch(candidates);
          return result;
        }
        results.push(result.value);
      }
      return ok(Object.freeze(results));
    },
    async prepareBatchAsync(
      inputs: readonly DynamicGeometryPrepareInput[],
      port: DynamicGeometryResidencyPort,
      signal?: AbortSignal,
    ): Promise<Result<readonly DynamicGeometryCandidate[], DynamicGeometryError>> {
      if (signal?.aborted)
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-candidate-state',
            'preparation has not been cancelled',
            'discard the cancelled preparation',
          ),
        );
      const begun = beginBatch(inputs);
      if (!begun.ok) return begun;
      const candidates = begun.value.map((record) => record.candidate);
      const results: DynamicGeometryCandidate[] = [];
      // The port arbitrates shared physical credits across concurrent rosters.
      // Drain every started member before returning a refusal or native fault.
      for (let offset = 0; offset < begun.value.length; offset += port.maxConcurrentPreparations) {
        const window = begun.value.slice(offset, offset + port.maxConcurrentPreparations);
        let prepared: Result<DynamicGeometryCandidate, DynamicGeometryError>[];
        try {
          prepared = await Promise.all(
            window.map((record) => prepareResidencyAsync(record, port, signal, true)),
          );
        } catch (cause) {
          // A fault intentionally retains cleanup fences and their budget for
          // paired recovery. Drain physical prepares without waiting for those
          // fences to declare a release they cannot attest.
          await Promise.allSettled(window.map((record) => record.residencyPending));
          cancelPreparedBatch(candidates);
          throw cause;
        }
        const refused = prepared.find((result) => !result.ok);
        if (refused !== undefined && !refused.ok) {
          cancelPreparedBatch(candidates);
          return refused;
        }
        for (const result of prepared) if (result.ok) results.push(result.value);
      }
      return ok(Object.freeze(results));
    },
  };
}

export function createDynamicGeometryHost(
  options: DynamicGeometryHostOptions & {
    readonly getGpuStore: () => GpuResidencyCache;
  },
): DynamicGeometryHostImplementation {
  const owner = createDynamicGeometryHostOwner(options);
  const { attachedWorlds, getGpuStore } = options;
  return {
    ...owner.host,
    prepareDynamicGeometry: (input) => owner.prepareSync(input, getGpuStore),
    prepareDynamicGeometryCandidates: (inputs) => owner.prepareBatchSync(inputs, getGpuStore),
    prepareMeshResidency(world, meshHandle, observePhase) {
      if (!attachedWorlds.has(world))
        return err(
          new MeshResidencyError(
            'mesh-residency-world-not-attached',
            'the MeshAsset World is attached to this Renderer',
            'call renderer.attach(world) before preparing mesh residency',
            { meshHandle },
          ),
        );
      const mesh = resolveMeshAsset(world, meshHandle);
      if (mesh === undefined)
        return err(
          new MeshResidencyError(
            'mesh-residency-invalid-handle',
            'the shared handle resolves to a MeshAsset in its owning World',
            'allocate the mesh through world.allocSharedRef and pass its live handle',
            { meshHandle },
          ),
        );

      const store = getGpuStore();
      const existing = store.getMeshGpuHandles(meshHandle, world);
      const profilePhase: RecordProfileRunner | undefined =
        observePhase === undefined
          ? undefined
          : <T>(phase: RenderRecordPhase, action: () => T): T => {
              const startMs = performance.now();
              try {
                return action();
              } finally {
                observePhase(phase, startMs, performance.now());
              }
            };
      const resident =
        existing === undefined
          ? store.ensureResident(meshHandle, mesh, world, [], profilePhase)
          : ok(existing);
      if (!resident.ok)
        return err(
          new MeshResidencyError(
            'mesh-residency-gpu-failed',
            'the MeshAsset has GPU residency for the current Renderer device generation',
            'repair the reported asset or RHI error before publishing the streamed mesh',
            resident.error,
          ),
        );
      const residency = store.retainMeshResidency(meshHandle, world);
      if (residency === undefined) {
        if (existing === undefined) store.invalidateMesh(meshHandle, world);
        return err(
          new MeshResidencyError(
            'mesh-residency-gpu-not-ready',
            'the prepared MeshAsset remains resident for the current device generation',
            'retry mesh preparation after Renderer recovery or asset projection',
            { meshHandle },
          ),
        );
      }
      let state: 'prepared' | 'committed' | 'cancelled' = 'prepared';
      return ok({
        isCurrent: () =>
          state === 'prepared' && store.getMeshGpuHandles(meshHandle, world) === resident.value,
        commit: () => {
          if (state !== 'prepared') return false;
          if (
            store.getMeshGpuHandles(meshHandle, world) !== resident.value ||
            !hasMeshBinding(world, Number(meshHandle))
          ) {
            state = 'cancelled';
            residency.release(existing === undefined);
            return false;
          }
          state = 'committed';
          residency.release(false);
          return true;
        },
        cancel: () => {
          if (state !== 'prepared') return;
          state = 'cancelled';
          residency.release(existing === undefined);
        },
      });
    },
  };
}

/** Use the same candidate/World owner with an asynchronous physical residency port. */
export function createDynamicGeometrySourceHost(
  options: Omit<DynamicGeometryHostOptions, 'currentGeneration'> & {
    readonly currentGeneration: () => number | undefined;
    readonly residency: DynamicGeometryResidencyPort;
  },
): AsyncDynamicGeometryHost &
  Pick<
    DynamicGeometryAdmissionHost,
    'publishDynamicGeometry' | 'invalidateDynamicGeometryWorld' | 'dynamicGeometryFault'
  > {
  if (
    !Number.isSafeInteger(options.residency.maxConcurrentPreparations) ||
    options.residency.maxConcurrentPreparations < 1
  )
    throw new RangeError('residency preparation concurrency must be a positive safe integer');
  const owner = createDynamicGeometryHostOwner({
    ...options,
    currentGeneration: () => options.currentGeneration() ?? 0,
  });
  return {
    ...owner.host,
    currentGeneration: options.currentGeneration,
    prepareDynamicGeometry(input, preparation) {
      if (options.currentGeneration() === undefined)
        return Promise.resolve(
          err(
            new DynamicGeometryError(
              'dynamic-geometry-gpu-not-ready',
              'the source has an active Render generation',
              'wait for Render readiness before preparing geometry',
            ),
          ),
        );
      return owner.prepareAsync(input, options.residency, preparation?.signal);
    },
    prepareDynamicGeometryCandidates(inputs, preparation) {
      if (options.currentGeneration() === undefined)
        return Promise.resolve(
          err(
            new DynamicGeometryError(
              'dynamic-geometry-gpu-not-ready',
              'the source has an active Render generation',
              'wait for Render readiness before preparing geometry',
            ),
          ),
        );
      return owner.prepareBatchAsync(inputs, options.residency, preparation?.signal);
    },
    async prepareMeshResidency(world, meshHandle, preparation) {
      const failure = (code: MeshResidencyError['code'], actual?: unknown) =>
        err(
          new MeshResidencyError(
            code,
            'a live source MeshAsset and current physical residency',
            'wait for Render readiness and retain the MeshAsset through preparation',
            actual,
          ),
        );
      if (!options.attachedWorlds.has(world)) return failure('mesh-residency-world-not-attached');
      owner.ensureHealthyWorld(world);
      const mesh = resolveMeshAsset(world, meshHandle);
      if (mesh === undefined) return failure('mesh-residency-invalid-handle');
      const generation = options.currentGeneration();
      if (generation === undefined || preparation?.signal?.aborted)
        return failure('mesh-residency-gpu-not-ready');
      const retained = world.sharedRefs.retain(meshHandle);
      if (!retained.ok) return failure('mesh-residency-invalid-handle', retained.error);
      const releaseWorld = () => world.sharedRefs.release(meshHandle).unwrap();
      let result: Awaited<ReturnType<DynamicGeometryResidencyPort['prepare']>>;
      try {
        result = await options.residency.prepare({ world, meshHandle, mesh }, preparation);
      } catch (cause) {
        // Unknown physical ownership keeps its source reference for paired
        // recovery, exactly like a failed dynamic candidate preparation.
        throw owner.fault(world, cause);
      }
      if (!result.ok) {
        releaseWorld();
        return failure('mesh-residency-gpu-failed', result.error);
      }
      const residency = result.value;
      let active = true;
      const isCurrent = () =>
        active &&
        options.attachedWorlds.has(world) &&
        options.currentGeneration() === generation &&
        residency.isCurrent();
      const release = (evict: boolean) => {
        if (!active) return;
        active = false;
        try {
          const completion = residency.release(evict);
          if (completion === undefined) releaseWorld();
          else void completion.then(releaseWorld).catch((cause) => owner.fault(world, cause));
        } catch (cause) {
          throw owner.fault(world, cause);
        }
      };
      if (preparation?.signal?.aborted || !isCurrent()) {
        release(true);
        return failure('mesh-residency-gpu-not-ready');
      }
      return ok({
        isCurrent,
        commit: () => {
          if (!isCurrent() || !hasMeshBinding(world, meshHandle)) {
            release(true);
            return false;
          }
          release(false);
          return true;
        },
        cancel: () => release(!hasMeshBinding(world, meshHandle)),
      });
    },
  };
}

/**
 * Renderer assembly adapter for dynamic geometry residency and submission.
 *
 * Mesh identity changes are reactive in RenderScene. A local swap must not
 * discard the submitted camera or unrelated surfaces' temporal history.
 */
export function createRendererDynamicGeometryHost(options: {
  readonly lifecycle: DynamicGeometryLifecycle;
  readonly attachedWorlds: ReadonlySet<World>;
  readonly getGpuStore: () => GpuResidencyCache;
  readonly currentGeneration: () => number;
  readonly renderSystem: {
    readonly isDynamicGeometryConsumed: (
      world: World,
      entity: number,
      meshHandle: DynamicGeometryCandidate['meshHandle'],
    ) => boolean;
    readonly dynamicGeometryRecordStageLane: (
      world: World,
      entity: number,
      meshHandle: DynamicGeometryCandidate['meshHandle'],
    ) => DynamicGeometryRecordStageLane | undefined;
  };
}): DynamicGeometryHostImplementation {
  const { renderSystem, ...hostOptions } = options;
  return createDynamicGeometryHost({
    ...hostOptions,
    isConsumedByRenderFrame: (candidate) =>
      renderSystem.isDynamicGeometryConsumed(
        candidate.world as World,
        candidate.entity ?? -1,
        candidate.meshHandle,
      ),
    recordStageLane: (candidate) =>
      renderSystem.dynamicGeometryRecordStageLane(
        candidate.world as World,
        candidate.entity ?? -1,
        candidate.meshHandle,
      ),
  });
}

export function createRendererDynamicGeometryController(
  options: Omit<Parameters<typeof createRendererDynamicGeometryHost>[0], 'lifecycle'>,
  maxMeshBytes?: number,
): {
  readonly lifecycle: DynamicGeometryLifecycle;
  readonly host: DynamicGeometryHostImplementation;
} {
  const lifecycle = createDynamicGeometryLifecycle(undefined, maxMeshBytes);
  return {
    lifecycle,
    host: createRendererDynamicGeometryHost({ ...options, lifecycle }),
  };
}
