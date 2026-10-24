import { assetDataBytes } from '@forgeax/engine-assets-runtime/internal';
import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';

/** A standard MeshAsset candidate prepared for one attached World generation. */
export interface DynamicGeometryPrepareInput {
  readonly world: object;
  /** Live ECS entity carrying MeshFilter + MeshRenderer on the attached World. */
  readonly entity?: number;
  /** Optional derived-physics entity whose fixed-step publication gates draw. */
  readonly physicsEntity?: number;
  /** The asset owner captures current content and its dependency versions. */
  readonly meshHandle: AssetHandle<'mesh'>;
  readonly revision: number;
  /** Material identity is a consumer fact; MaterialAsset stays in the World. */
  readonly materialIdentity?: string;
  /** Topology changes invalidate motion/history consumers. */
  readonly topologyRevision?: number;
  /** Captured by the Renderer host from the World FixedTime resource. */
  readonly fixedStep?: number;
}

/** Internal lifecycle input after the host resolves the asset reference. */
export type DynamicGeometryContentInput = Omit<DynamicGeometryPrepareInput, 'meshHandle'> & {
  readonly mesh: MeshAsset;
  readonly meshHandle?: AssetHandle<'mesh'>;
};

/** Explicit ECS/fixed-step ordering proof used by Renderer admission. */
export interface DynamicGeometryOrdering {
  readonly world: object;
  readonly fixedStep: number;
}

export type DynamicGeometryCandidateState =
  | 'prepared'
  | 'accepted'
  | 'published'
  | 'cancelled'
  | 'retired';

export interface DynamicGeometryCandidate {
  readonly candidateId: string;
  readonly generation: number;
  readonly owner: object;
  readonly world: object;
  readonly entity?: number;
  readonly physicsEntity?: number;
  /** False when the pure lifecycle was used without a shared MeshAsset handle. */
  readonly gpuReady: boolean;
  /** CPU/GPU geometry bytes reserved by this candidate budget. */
  readonly meshBytes: number;
  readonly revision: number;
  readonly topologyRevision: number;
  readonly materialIdentity?: string;
  readonly meshHandle?: AssetHandle<'mesh'>;
  readonly fixedStep?: number;
  readonly state: DynamicGeometryCandidateState;
}

/** Record-stage lane that consumed a published dynamic-geometry candidate. */
export type DynamicGeometryRecordStageLane = 'cpu' | 'gpu' | 'mixed';

/** Receipt that ties candidate publication to the sole Renderer FrameReceipt. */
export interface DynamicGeometryReceipt {
  readonly candidateId: string;
  readonly generation: number;
  readonly revision: number;
  readonly topologyRevision: number;
  readonly fixedStep?: number;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly frame: {
    readonly frameId: number;
    readonly deviceGeneration: number;
    readonly completed?: Promise<unknown>;
  };
  /** Whether the Renderer record stage consumed this candidate for this frame. */
  readonly recordStageConsumed: boolean;
  /** Lane evidence from the exact submitted record stage, when attached. */
  readonly recordStageLane?: DynamicGeometryRecordStageLane;
  /** Actual frame fixed step; may be newer than the preparation step. */
  readonly publicationFixedStep?: number;
}

/** Native frame receipts are immutable data; borrowed accessors stay observable. */
function sharedFrameSnapshot(
  frame: DynamicGeometryReceipt['frame'],
): DynamicGeometryReceipt['frame'] | undefined {
  if (!Object.isFrozen(frame) || Object.getPrototypeOf(frame) !== Object.prototype)
    return undefined;
  for (const key of Reflect.ownKeys(frame)) {
    const descriptor = Object.getOwnPropertyDescriptor(frame, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
  }
  return Object.freeze({ ...frame });
}

/** Renderer-owned GPU residency prepared before a MeshAsset enters the scene. */
export interface PreparedMeshResidency {
  /** True while this handle still maps to the prepared device-generation allocation. */
  isCurrent(): boolean;
  /** Transfer ownership after the named entity binds this asset through MeshFilter. */
  commit(entity: number): boolean;
  /** Drop an uncommitted preparation and evict an allocation created for it. */
  cancel(): void;
}

/** Optional phase timestamps for source-level performance attribution. */
export type MeshResidencyPhaseObserver = (phase: string, startMs: number, endMs: number) => void;

export type MeshResidencyErrorCode =
  | 'mesh-residency-world-not-attached'
  | 'mesh-residency-invalid-handle'
  | 'mesh-residency-gpu-failed'
  | 'mesh-residency-gpu-not-ready';

export class MeshResidencyError extends Error {
  readonly code: MeshResidencyErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly actual: unknown;

  constructor(code: MeshResidencyErrorCode, expected: string, hint: string, actual?: unknown) {
    super(`${code}: ${expected}`);
    this.name = 'MeshResidencyError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.actual = actual;
  }
}

export interface DynamicGeometryInspection {
  readonly generation: number;
  readonly prepared: number;
  readonly accepted: number;
  readonly published: number;
  readonly retired: number;
  readonly latestRevision?: number;
  readonly latestFrameId?: number;
  readonly historyInvalidations: number;
  readonly invalidated: number;
  readonly meshBytes: number;
  readonly maxMeshBytes: number;
}

export interface DynamicGeometryLifecycleOptions {
  /** Prepared transactions and terminal cleanup waiting for physical release. */
  readonly maxRetainedCandidates?: number;
}

export type DynamicGeometryErrorCode =
  | 'dynamic-geometry-disposed'
  | 'dynamic-geometry-world-not-attached'
  | 'dynamic-geometry-invalid'
  | 'dynamic-geometry-gpu-failed'
  | 'dynamic-geometry-gpu-not-ready'
  | 'dynamic-geometry-budget-exceeded'
  | 'dynamic-geometry-stale'
  | 'dynamic-geometry-generation-mismatch'
  | 'dynamic-geometry-candidate-not-found'
  | 'dynamic-geometry-candidate-state'
  | 'dynamic-geometry-receipt-mismatch'
  | 'dynamic-geometry-ordering-required';

export interface DynamicGeometryErrorDetail {
  readonly code: DynamicGeometryErrorCode;
  readonly candidateId?: string;
  readonly revision?: number;
  readonly generation?: number;
  readonly reason?: 'batch-count' | 'retained-count' | 'mesh-bytes';
  readonly requested?: number;
  readonly used?: number;
  readonly limit?: number;
  readonly pendingFenceCandidates?: number;
  readonly actual?: unknown;
}

export class DynamicGeometryError extends Error {
  readonly code: DynamicGeometryErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: DynamicGeometryErrorDetail;

  constructor(
    code: DynamicGeometryErrorCode,
    expected: string,
    hint: string,
    detail: Omit<DynamicGeometryErrorDetail, 'code'> = {},
  ) {
    super(`${code}: ${expected}`);
    this.name = 'DynamicGeometryError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = Object.freeze({ code, ...detail });
  }
}

interface CandidateRecord {
  /** Complete preparation roster; one transient slot while any member needs preparation/release. */
  readonly batch?: readonly string[];
  readonly world: object;
  candidate: DynamicGeometryCandidate;
  /** Published history remains queryable for its completion fence, but a
   * newer topology must prevent that history from being consumed again. */
  historyInvalidated: boolean;
  acceptedFrame?: { readonly frameId: number; readonly deviceGeneration: number };
}

interface CandidateAcceptancePlan {
  readonly record: CandidateRecord;
  readonly accepted: DynamicGeometryCandidate;
  readonly historyRecords: readonly CandidateRecord[];
  readonly invalidatesHistory: boolean;
}

/** One admission input resolved to its current lifecycle record. */
interface ResolvedCandidate {
  readonly candidate: DynamicGeometryCandidate;
  readonly record: CandidateRecord;
  readonly inputIndex: number;
}

/** Revision watermarks and records of one World's entities outside an admission batch. */
interface EntityHistory {
  readonly newestRevision: Map<number | undefined, number>;
  readonly newestTopology: Map<number | undefined, number>;
  readonly records: Map<number | undefined, CandidateRecord[]>;
}

function keepNewest(
  watermarks: Map<number | undefined, number>,
  entity: number | undefined,
  revision: number,
): void {
  const previous = watermarks.get(entity);
  if (previous === undefined || revision > previous) watermarks.set(entity, revision);
}

/** Admission ordering names an object World and a non-negative integer fixed step. */
function isOrdering(ordering: DynamicGeometryOrdering): boolean {
  return (
    ordering !== null &&
    typeof ordering === 'object' &&
    ordering.world !== null &&
    typeof ordering.world === 'object' &&
    Number.isInteger(ordering.fixedStep) &&
    ordering.fixedStep >= 0
  );
}

/**
 * A public candidate is a credential, not a mutable state object. Keep the
 * owner/world check in `current` cheap, then compare every scalar admission
 * fact before a caller can cancel, retire, or inspect another record by
 * copying its candidate id. Geometry payloads stay private to the physical
 * preparation owner; the credential carries no mutable typed arrays.
 */
export function sameCandidateCredential(
  candidate: DynamicGeometryCandidate,
  committed: DynamicGeometryCandidate,
): boolean {
  return (
    candidate.candidateId === committed.candidateId &&
    candidate.owner === committed.owner &&
    candidate.world === committed.world &&
    candidate.generation === committed.generation &&
    candidate.entity === committed.entity &&
    candidate.physicsEntity === committed.physicsEntity &&
    candidate.gpuReady === committed.gpuReady &&
    candidate.meshBytes === committed.meshBytes &&
    candidate.revision === committed.revision &&
    candidate.topologyRevision === committed.topologyRevision &&
    candidate.materialIdentity === committed.materialIdentity &&
    candidate.meshHandle === committed.meshHandle &&
    candidate.fixedStep === committed.fixedStep
  );
}

function validateMesh(mesh: MeshAsset): string | undefined {
  if (mesh.kind !== 'mesh') return 'MeshAsset.kind must be mesh';
  if (!(mesh.vertices instanceof Float32Array) || mesh.vertices.length === 0) {
    return 'MeshAsset.vertices must be a non-empty Float32Array';
  }
  // vertices may be interleaved. Attribute layout validation belongs to the
  // mesh producer/residency path; this gate must not assume an xyz-only stride.
  if (
    mesh.indices !== undefined &&
    !(mesh.indices instanceof Uint16Array || mesh.indices instanceof Uint32Array)
  ) {
    return 'MeshAsset.indices must be Uint16Array or Uint32Array';
  }
  if (mesh.submeshes.length === 0)
    return 'MeshAsset.submeshes must contain at least one topology range';
  if (
    mesh.submeshes.some(
      (submesh) =>
        !Number.isSafeInteger(submesh.materialSlot) ||
        submesh.materialSlot < 0 ||
        submesh.materialSlot >= mesh.materialSlots.length,
    )
  ) {
    return 'MeshAsset.materialSlots must cover every referenced materialSlot';
  }
  const vertices = mesh.vertices;
  // Preserve the native typed-array detached-buffer check for borrowed payloads.
  if (vertices.byteLength === 0) {
    if (vertices.some((value) => !Number.isFinite(value)))
      return 'MeshAsset.vertices must be finite';
  } else {
    for (let index = 0, length = vertices.length; index < length; index++) {
      if (!Number.isFinite(vertices[index])) return 'MeshAsset.vertices must be finite';
    }
  }
  return undefined;
}

function meshByteSize(mesh: MeshAsset): number {
  // Charge the complete private MeshAsset copy, including morph/offline data.
  // This is the same logical-view accounting used by its runtime storage owner.
  return assetDataBytes(mesh);
}

/**
 * Renderer-owned lifecycle for standard MeshAsset candidates. It deliberately
 * has no device, buffer, queue, or frame clock; the host supplies generation
 * and FrameReceipt facts at the boundaries below.
 */
export interface DynamicGeometryLifecycle {
  /** Prepare one complete, byte-bounded roster for atomic admission. */
  prepareCandidates(
    inputs: readonly DynamicGeometryContentInput[],
    generation: number,
  ): Result<readonly DynamicGeometryCandidate[], DynamicGeometryError>;
  prepare(
    input: DynamicGeometryContentInput,
    generation: number,
  ): Result<DynamicGeometryCandidate, DynamicGeometryError>;
  accept(
    candidate: DynamicGeometryCandidate,
    ordering?: DynamicGeometryOrdering,
  ): Result<DynamicGeometryCandidate, DynamicGeometryError>;
  validateCandidates(
    candidates: readonly DynamicGeometryCandidate[],
    ordering: DynamicGeometryOrdering,
  ): Result<void, DynamicGeometryError>;
  acceptCandidates(
    candidates: readonly DynamicGeometryCandidate[],
    ordering: DynamicGeometryOrdering,
  ): Result<readonly DynamicGeometryCandidate[], DynamicGeometryError>;
  cancel(
    candidate: DynamicGeometryCandidate,
    completion?: Promise<unknown>,
  ): Result<void, DynamicGeometryError>;
  retire(candidate: DynamicGeometryCandidate): Result<void, DynamicGeometryError>;
  /** Release the count/byte budget after receipt-bound GPU cleanup completes. */
  finalizeRetirement(candidate: DynamicGeometryCandidate): Result<void, DynamicGeometryError>;
  receipt(candidate: DynamicGeometryCandidate): DynamicGeometryReceipt | undefined;
  publishFrame(
    frame: {
      readonly frameId: number;
      readonly deviceGeneration: number;
      readonly completed?: Promise<unknown>;
    },
    worlds?: readonly object[],
    fixedStep?: number,
    canPublish?: (candidate: DynamicGeometryCandidate) => boolean,
    recordStageLane?: (
      candidate: DynamicGeometryCandidate,
    ) => DynamicGeometryRecordStageLane | undefined,
  ): readonly DynamicGeometryReceipt[];
  invalidateWorld(world: object, completion?: Promise<unknown>): void;
  invalidateGeneration(generation: number): void;
  inspect(): DynamicGeometryInspection;
  dispose(): void;
}

/** Shared admission check for lifecycle and renderer construction, before backend allocation. */
export function validateDynamicGeometryMeshBudget(maxMeshBytes: number): void {
  const maxMeshByteLimit = 512 * 1024 * 1024;
  if (!Number.isSafeInteger(maxMeshBytes) || maxMeshBytes < 1 || maxMeshBytes > maxMeshByteLimit) {
    throw new RangeError(
      `maxMeshBytes must be a positive safe integer no greater than ${maxMeshByteLimit}`,
    );
  }
}

export function createDynamicGeometryLifecycle(
  maxCandidates = 32,
  maxMeshBytes = 64 * 1024 * 1024,
  options: DynamicGeometryLifecycleOptions = {},
): DynamicGeometryLifecycle {
  const maxRetainedCandidates = options.maxRetainedCandidates ?? maxCandidates;
  const maxCandidateLimit = 4096;
  if (
    !Number.isSafeInteger(maxCandidates) ||
    maxCandidates < 1 ||
    maxCandidates > maxCandidateLimit
  ) {
    throw new RangeError(
      `maxCandidates must be a positive safe integer no greater than ${maxCandidateLimit}`,
    );
  }
  validateDynamicGeometryMeshBudget(maxMeshBytes);
  if (
    !Number.isSafeInteger(maxRetainedCandidates) ||
    maxRetainedCandidates < maxCandidates ||
    maxRetainedCandidates > maxCandidateLimit
  ) {
    throw new RangeError(
      `maxRetainedCandidates must be a safe integer from maxCandidates through ${maxCandidateLimit}`,
    );
  }
  const records = new Map<string, CandidateRecord>();
  const owner = {};
  let sequence = 0;
  let currentGeneration = 0;
  let disposed = false;
  let historyInvalidations = 0;
  let latestRevision: number | undefined;
  let latestFrameId: number | undefined;
  let retired = 0;
  let invalidated = 0;
  let meshBytes = 0;
  const latestRevisionByWorld = new WeakMap<object, Map<number | undefined, number>>();
  const latestTopologyRevisionByWorld = new WeakMap<object, Map<number | undefined, number>>();
  const publishedReceipts = new Map<string, DynamicGeometryReceipt>();

  const failure = (
    code: DynamicGeometryErrorCode,
    expected: string,
    hint: string,
    detail: Omit<DynamicGeometryErrorDetail, 'code'> = {},
  ): Result<never, DynamicGeometryError> =>
    err(new DynamicGeometryError(code, expected, hint, detail));
  const batchFailure = (
    code: DynamicGeometryErrorCode,
    phase: string,
    inputIndex?: number,
    candidate?: DynamicGeometryCandidate,
    detail?: unknown,
  ): Result<never, DynamicGeometryError> =>
    failure(
      code,
      'all candidates satisfy the current CPU admission contract',
      'fix the item or retain its credential for owner cleanup',
      {
        ...(candidate === undefined
          ? {}
          : {
              ...(candidate.candidateId === undefined
                ? {}
                : { candidateId: candidate.candidateId }),
              ...(candidate.revision === undefined ? {} : { revision: candidate.revision }),
            }),
        actual: {
          phase,
          ...(inputIndex === undefined ? {} : { inputIndex }),
          ...(candidate?.candidateId === undefined ? {} : { candidateId: candidate.candidateId }),
          ...(detail === undefined ? {} : { detail }),
        },
      },
    );

  const current = (candidate: DynamicGeometryCandidate): CandidateRecord | undefined => {
    const record = records.get(candidate.candidateId);
    if (
      record === undefined ||
      candidate.owner !== owner ||
      record.candidate.owner !== candidate.owner ||
      record.candidate.world !== candidate.world ||
      record.candidate.generation !== candidate.generation
    )
      return undefined;
    return record;
  };
  const planAcceptance = (
    record: CandidateRecord,
    accepted: DynamicGeometryCandidate,
    historyRecords: readonly CandidateRecord[],
    invalidatesHistory: boolean,
  ): CandidateAcceptancePlan => ({
    record,
    accepted,
    historyRecords,
    invalidatesHistory,
  });
  const commitAcceptancePlans = (plans: readonly CandidateAcceptancePlan[]): void => {
    for (const plan of plans) plan.record.candidate = plan.accepted;
    for (const plan of plans) {
      if (plan.invalidatesHistory) historyInvalidations += 1;
      for (const previous of plan.historyRecords) {
        if (previous.historyInvalidated) continue;
        previous.historyInvalidated = true;
        invalidated += 1;
      }
    }
  };
  // The reservation (record + mesh bytes) ends here. A deferred release must
  // not drop a newer record that reused the id after its fence was scheduled.
  const release = (id: string, record: CandidateRecord): void => {
    if (records.get(id) !== record) return;
    records.delete(id);
    meshBytes = Math.max(0, meshBytes - record.candidate.meshBytes);
  };
  const cancelRecord = (
    id: string,
    record: CandidateRecord,
    completion: Promise<unknown> | undefined,
  ): void => {
    record.candidate = Object.freeze({ ...record.candidate, state: 'cancelled' as const });
    if (completion === undefined) release(id, record);
    else {
      const settle = (): void => release(id, record);
      void completion.then(settle, settle);
    }
  };
  const retainedCandidateCount = (): number => {
    const retained = new Set<object>();
    for (const record of records.values()) {
      const state = record.candidate.state;
      // Acceptance transfers a mesh to the live World even before a visible
      // draw. Both resident states retain bytes, but neither blocks new work.
      if (state === 'prepared' || state === 'cancelled' || state === 'retired')
        retained.add(record.batch ?? record);
    }
    return retained.size;
  };
  const pendingFenceCandidateCount = (): number =>
    [...records.values()].reduce(
      (count, record) =>
        count +
        (record.candidate.state === 'cancelled' || record.candidate.state === 'retired' ? 1 : 0),
      0,
    );

  /**
   * Complete declared preparation batches may exceed the per-call candidate
   * budget. One admission may name several of them, so a producer can prepare
   * one transaction in bounded slices; every member of each named batch must
   * be present, the union stays within one declared roster bound, and the
   * whole union is still accepted or refused together.
   */
  const isCompleteDeclaredBatch = (candidates: readonly DynamicGeometryCandidate[]): boolean => {
    if (candidates.length === 0 || candidates.length > maxCandidateLimit) return false;
    const members = new Map<readonly string[], number>();
    for (const candidate of candidates) {
      const declared =
        candidate?.candidateId === undefined
          ? undefined
          : records.get(candidate.candidateId)?.batch;
      if (declared === undefined) return false;
      members.set(declared, (members.get(declared) ?? 0) + 1);
    }
    for (const [declared, count] of members) if (declared.length !== count) return false;
    return true;
  };
  const batchCountFailure = (candidateCount: number): Result<never, DynamicGeometryError> =>
    failure(
      'dynamic-geometry-budget-exceeded',
      'candidate batch remains within the bounded renderer budget',
      'split the batch before preparing its candidates',
      {
        reason: 'batch-count',
        requested: candidateCount,
        used: candidateCount,
        limit: maxCandidates,
        pendingFenceCandidates: pendingFenceCandidateCount(),
        actual: {
          candidateCount,
          maxCandidates,
          retainedCandidates: retainedCandidateCount(),
        },
      },
    );
  /** Each input must be this lifecycle's current credential for its record. */
  const resolveCredentials = (
    candidates: readonly DynamicGeometryCandidate[],
  ): Result<readonly ResolvedCandidate[], DynamicGeometryError> => {
    const resolved: ResolvedCandidate[] = [];
    for (let inputIndex = 0; inputIndex < candidates.length; inputIndex += 1) {
      const candidate = candidates[inputIndex];
      if (candidate === undefined || candidate === null || typeof candidate !== 'object') {
        return batchFailure('dynamic-geometry-candidate-not-found', 'credential', inputIndex);
      }
      const record = current(candidate);
      if (record === undefined) {
        return batchFailure(
          'dynamic-geometry-candidate-not-found',
          'credential',
          inputIndex,
          candidate,
        );
      }
      if (!sameCandidateCredential(candidate, record.candidate)) {
        return batchFailure(
          'dynamic-geometry-receipt-mismatch',
          'credential',
          inputIndex,
          candidate,
        );
      }
      resolved.push({ candidate, record, inputIndex });
    }
    return ok(resolved);
  };
  /**
   * A prepared transaction cannot be split or combined after its budget is
   * reserved, and one admission names each candidate and entity once.
   */
  const batchMembershipFailure = (
    resolved: readonly ResolvedCandidate[],
    completeDeclaredBatch: boolean,
  ): Result<never, DynamicGeometryError> | undefined => {
    if (resolved.some((entry) => entry.record.batch !== undefined) && !completeDeclaredBatch) {
      return batchFailure('dynamic-geometry-invalid', 'input', undefined, undefined, {
        reason: 'admission must contain the complete declared preparation batch',
      });
    }
    const candidateIndexes = new Map<string, number>();
    const entityIndexes = new Map<object, Map<number | undefined, number>>();
    for (const entry of resolved) {
      const candidateIdIndex = candidateIndexes.get(entry.candidate.candidateId);
      if (candidateIdIndex !== undefined) {
        return batchFailure(
          'dynamic-geometry-invalid',
          'duplicate-item',
          entry.inputIndex,
          entry.candidate,
          { firstInputIndex: candidateIdIndex },
        );
      }
      candidateIndexes.set(entry.candidate.candidateId, entry.inputIndex);
      let indexesByEntity = entityIndexes.get(entry.record.world);
      if (indexesByEntity === undefined) {
        indexesByEntity = new Map<number | undefined, number>();
        entityIndexes.set(entry.record.world, indexesByEntity);
      }
      const entityIndex = indexesByEntity.get(entry.record.candidate.entity);
      if (entityIndex !== undefined) {
        return batchFailure(
          'dynamic-geometry-invalid',
          'duplicate-item',
          entry.inputIndex,
          entry.candidate,
          { firstInputIndex: entityIndex, entity: entry.record.candidate.entity },
        );
      }
      indexesByEntity.set(entry.record.candidate.entity, entry.inputIndex);
    }
    return undefined;
  };
  /** Every member must be a current-generation, prepared, non-stale record. */
  const preparedStateFailure = (
    resolved: readonly ResolvedCandidate[],
  ): Result<never, DynamicGeometryError> | undefined => {
    for (const entry of resolved) {
      if (entry.record.candidate.generation !== currentGeneration) {
        return batchFailure(
          'dynamic-geometry-generation-mismatch',
          'generation',
          entry.inputIndex,
          entry.candidate,
          { activeGeneration: currentGeneration },
        );
      }
    }
    for (const entry of resolved) {
      if (entry.candidate.state !== 'prepared' || entry.record.candidate.state !== 'prepared') {
        return batchFailure(
          'dynamic-geometry-candidate-state',
          'state',
          entry.inputIndex,
          entry.candidate,
          { inputState: entry.candidate.state, recordState: entry.record.candidate.state },
        );
      }
      if (entry.record.historyInvalidated) {
        return batchFailure('dynamic-geometry-stale', 'state', entry.inputIndex, entry.candidate, {
          historyInvalidated: true,
        });
      }
    }
    return undefined;
  };
  /** Members belong to the ordering World and were prepared no later than its fixed step. */
  const orderingFailure = (
    resolved: readonly ResolvedCandidate[],
    ordering: DynamicGeometryOrdering,
  ): Result<never, DynamicGeometryError> | undefined => {
    for (const entry of resolved) {
      if (entry.record.world !== ordering.world) {
        return batchFailure(
          'dynamic-geometry-ordering-required',
          'ordering',
          entry.inputIndex,
          entry.candidate,
          { expectedWorld: entry.record.world, actualWorld: ordering.world },
        );
      }
      const preparedFixedStep = entry.record.candidate.fixedStep;
      if (
        preparedFixedStep !== undefined &&
        (!Number.isInteger(preparedFixedStep) ||
          preparedFixedStep < 0 ||
          preparedFixedStep > ordering.fixedStep)
      ) {
        return batchFailure(
          'dynamic-geometry-ordering-required',
          'ordering',
          entry.inputIndex,
          entry.candidate,
          { preparedFixedStep, orderingFixedStep: ordering.fixedStep },
        );
      }
    }
    return undefined;
  };
  /** Newest revision watermarks and same-entity records of this World outside the batch. */
  const entityHistory = (world: object, resolved: readonly ResolvedCandidate[]): EntityHistory => {
    const batchIds = new Set(resolved.map((entry) => entry.candidate.candidateId));
    const history: EntityHistory = {
      newestRevision: new Map<number | undefined, number>(latestRevisionByWorld.get(world)),
      newestTopology: new Map<number | undefined, number>(latestTopologyRevisionByWorld.get(world)),
      records: new Map<number | undefined, CandidateRecord[]>(),
    };
    for (const [candidateId, record] of records) {
      if (record.world !== world || batchIds.has(candidateId)) continue;
      const candidate = record.candidate;
      if (candidate.state === 'prepared' || candidate.state === 'accepted') {
        keepNewest(history.newestRevision, candidate.entity, candidate.revision);
      }
      keepNewest(history.newestTopology, candidate.entity, candidate.topologyRevision);
      const sameEntity = history.records.get(candidate.entity) ?? [];
      sameEntity.push(record);
      history.records.set(candidate.entity, sameEntity);
    }
    return history;
  };
  /** Revisions must advance past the entity's newest; topology may not regress. */
  const revisionFailure = (
    entry: ResolvedCandidate,
    history: EntityHistory,
  ): Result<never, DynamicGeometryError> | undefined => {
    const candidate = entry.record.candidate;
    if (!Number.isInteger(candidate.revision) || candidate.revision < 0) {
      return batchFailure(
        'dynamic-geometry-invalid',
        'revision-topology',
        entry.inputIndex,
        entry.candidate,
        { revision: candidate.revision },
      );
    }
    const newestRevision = history.newestRevision.get(candidate.entity);
    if (newestRevision !== undefined && candidate.revision <= newestRevision) {
      return batchFailure(
        'dynamic-geometry-stale',
        'revision-topology',
        entry.inputIndex,
        entry.candidate,
        { revision: candidate.revision, newestRevision },
      );
    }
    if (!Number.isInteger(candidate.topologyRevision) || candidate.topologyRevision < 0) {
      return batchFailure(
        'dynamic-geometry-invalid',
        'revision-topology',
        entry.inputIndex,
        entry.candidate,
        { topologyRevision: candidate.topologyRevision },
      );
    }
    const newestTopology = history.newestTopology.get(candidate.entity);
    if (newestTopology !== undefined && candidate.topologyRevision < newestTopology) {
      return batchFailure(
        'dynamic-geometry-stale',
        'revision-topology',
        entry.inputIndex,
        entry.candidate,
        { topologyRevision: candidate.topologyRevision, newestTopology },
      );
    }
    return undefined;
  };
  /** Plan each member's acceptance; a newer topology invalidates older entity history. */
  const planAcceptances = (
    resolved: readonly ResolvedCandidate[],
    ordering: DynamicGeometryOrdering,
  ): Result<readonly CandidateAcceptancePlan[], DynamicGeometryError> => {
    const history = entityHistory(ordering.world, resolved);
    const plans: CandidateAcceptancePlan[] = [];
    for (const entry of resolved) {
      const revision = revisionFailure(entry, history);
      if (revision !== undefined) return revision;
      const candidate = entry.record.candidate;
      const newestTopology = history.newestTopology.get(candidate.entity);
      const invalidatesHistory =
        newestTopology !== undefined && candidate.topologyRevision > newestTopology;
      const historyRecords = invalidatesHistory
        ? (history.records.get(candidate.entity) ?? []).filter(
            (record) =>
              record.candidate.topologyRevision < candidate.topologyRevision &&
              !record.historyInvalidated,
          )
        : [];
      const accepted = Object.freeze({
        ...candidate,
        fixedStep: ordering.fixedStep,
        state: 'accepted' as const,
      });
      plans.push(planAcceptance(entry.record, accepted, historyRecords, invalidatesHistory));
    }
    return ok(plans);
  };
  /** Retained count and reserved mesh bytes must still fit and match the running total. */
  const reservedBudgetFailure = (): Result<never, DynamicGeometryError> | undefined => {
    let reservedBytes = 0;
    for (const record of records.values()) {
      reservedBytes += record.candidate.meshBytes;
    }
    const reservedCount = retainedCandidateCount();
    if (reservedCount > maxRetainedCandidates) {
      return batchFailure('dynamic-geometry-budget-exceeded', 'budget', undefined, undefined, {
        reason: 'retained-count',
        requested: 0,
        used: reservedCount,
        limit: maxRetainedCandidates,
        pendingFenceCandidates: pendingFenceCandidateCount(),
      });
    }
    if (
      !Number.isSafeInteger(reservedBytes) ||
      reservedBytes !== meshBytes ||
      reservedBytes > maxMeshBytes
    ) {
      return batchFailure('dynamic-geometry-budget-exceeded', 'budget', undefined, undefined, {
        reservedCount,
        reservedBytes,
        meshBytes,
        maxCandidates,
        maxMeshBytes,
      });
    }
    return undefined;
  };

  const planCandidates = (
    candidates: readonly DynamicGeometryCandidate[],
    ordering: DynamicGeometryOrdering,
  ): Result<readonly CandidateAcceptancePlan[], DynamicGeometryError> => {
    if (disposed)
      return failure('dynamic-geometry-disposed', 'renderer is alive', 'rebuild the Renderer');
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return batchFailure('dynamic-geometry-invalid', 'input', undefined, undefined, {
        candidateCount: Array.isArray(candidates) ? candidates.length : undefined,
      });
    }
    const completeDeclaredBatch = isCompleteDeclaredBatch(candidates);
    if (candidates.length > maxCandidates && !completeDeclaredBatch) {
      return batchCountFailure(candidates.length);
    }
    if (!isOrdering(ordering)) {
      return batchFailure(
        'dynamic-geometry-ordering-required',
        'ordering',
        undefined,
        undefined,
        ordering,
      );
    }
    const resolved = resolveCredentials(candidates);
    if (!resolved.ok) return resolved;
    const rejected =
      batchMembershipFailure(resolved.value, completeDeclaredBatch) ??
      preparedStateFailure(resolved.value) ??
      orderingFailure(resolved.value, ordering);
    if (rejected !== undefined) return rejected;
    const plans = planAcceptances(resolved.value, ordering);
    if (!plans.ok) return plans;
    return reservedBudgetFailure() ?? plans;
  };

  const prepare = (
    input: DynamicGeometryContentInput,
    generation: number,
    batch?: string[],
  ): Result<DynamicGeometryCandidate, DynamicGeometryError> => {
    if (disposed)
      return failure('dynamic-geometry-disposed', 'renderer is alive', 'rebuild the Renderer');
    if (input.world === null || typeof input.world !== 'object') {
      return failure(
        'dynamic-geometry-world-not-attached',
        'candidate belongs to an attached World',
        'attach the World before preparing geometry',
      );
    }
    if (!Number.isInteger(input.revision) || input.revision < 0) {
      return failure(
        'dynamic-geometry-invalid',
        'geometry revision is a non-negative integer',
        'advance the consumer revision monotonically',
        { revision: input.revision },
      );
    }
    const topologyRevision = input.topologyRevision ?? input.revision;
    if (!Number.isInteger(topologyRevision) || topologyRevision < 0) {
      return failure(
        'dynamic-geometry-invalid',
        'topology revision is a non-negative integer',
        'correct the topology revision and prepare geometry again',
        { revision: input.revision, actual: { topologyRevision } },
      );
    }
    if (generation !== currentGeneration && currentGeneration !== 0) {
      return failure(
        'dynamic-geometry-generation-mismatch',
        'candidate uses the active renderer generation',
        'discard stale generation work and prepare again',
        { generation, actual: currentGeneration },
      );
    }
    if (batch === undefined || batch.length === 0) {
      const inFlight = retainedCandidateCount();
      if (inFlight >= maxRetainedCandidates) {
        return failure(
          'dynamic-geometry-budget-exceeded',
          'candidate count remains within the bounded renderer budget',
          'cancel or retire an earlier candidate before retrying',
          {
            reason: 'retained-count',
            requested: 1,
            used: inFlight,
            limit: maxRetainedCandidates,
            pendingFenceCandidates: pendingFenceCandidateCount(),
            actual: inFlight,
          },
        );
      }
    }
    const invalid = validateMesh(input.mesh);
    if (invalid !== undefined)
      return failure(
        'dynamic-geometry-invalid',
        'MeshAsset satisfies the standard geometry contract',
        invalid,
      );
    const candidateBytes = meshByteSize(input.mesh);
    if (
      !Number.isSafeInteger(candidateBytes) ||
      candidateBytes < 0 ||
      meshBytes > maxMeshBytes - candidateBytes
    ) {
      return failure(
        'dynamic-geometry-budget-exceeded',
        'candidate mesh bytes remain within the bounded renderer resource budget',
        'cancel or retire an earlier candidate before retrying',
        {
          reason: 'mesh-bytes',
          requested: candidateBytes,
          used: meshBytes,
          limit: maxMeshBytes,
          pendingFenceCandidates: pendingFenceCandidateCount(),
          actual: { meshBytes, candidateBytes, maxMeshBytes },
        },
      );
    }
    const candidateId = `mesh:${generation}:${++sequence}:${input.revision}`;
    const candidate: DynamicGeometryCandidate = Object.freeze({
      candidateId,
      generation,
      owner,
      world: input.world,
      ...(input.entity === undefined ? {} : { entity: input.entity }),
      ...(input.physicsEntity === undefined ? {} : { physicsEntity: input.physicsEntity }),
      gpuReady: input.meshHandle !== undefined,
      meshBytes: candidateBytes,
      revision: input.revision,
      topologyRevision,
      ...(input.materialIdentity === undefined ? {} : { materialIdentity: input.materialIdentity }),
      ...(input.meshHandle === undefined ? {} : { meshHandle: input.meshHandle }),
      ...(input.fixedStep === undefined ? {} : { fixedStep: input.fixedStep }),
      state: 'prepared',
    });
    const record: CandidateRecord = {
      world: input.world,
      candidate,
      historyInvalidated: false,
      ...(batch === undefined ? {} : { batch }),
    };
    records.set(candidateId, record);
    batch?.push(candidateId);
    meshBytes += candidateBytes;
    currentGeneration = generation;
    return ok(candidate);
  };
  return {
    prepare,
    prepareCandidates(inputs, generation) {
      if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > maxCandidateLimit) {
        return failure(
          'dynamic-geometry-budget-exceeded',
          `one declared preparation has from 1 through ${maxCandidateLimit} members`,
          'submit a complete bounded roster',
          {
            reason: 'batch-count',
            ...(Array.isArray(inputs) ? { requested: inputs.length } : {}),
            limit: maxCandidateLimit,
          },
        );
      }
      const world = inputs[0]?.world;
      const entities = new Set<number | undefined>();
      for (const input of inputs) {
        if (input.world !== world || entities.has(input.entity)) {
          return failure(
            'dynamic-geometry-invalid',
            'one declared preparation has distinct entities in one World',
            'submit each entity exactly once in the complete World transaction',
          );
        }
        entities.add(input.entity);
      }
      const batch: string[] = [];
      const candidates: DynamicGeometryCandidate[] = [];
      const previousGeneration = currentGeneration;
      for (const input of inputs) {
        const result = prepare(input, generation, batch);
        if (!result.ok) {
          for (const id of batch) {
            const record = records.get(id);
            if (record !== undefined) release(id, record);
          }
          currentGeneration = previousGeneration;
          return result;
        }
        candidates.push(result.value);
      }
      Object.freeze(batch);
      return ok(Object.freeze(candidates));
    },
    validateCandidates(candidates, ordering) {
      const planned = planCandidates(candidates, ordering);
      return planned.ok ? ok(undefined) : err(planned.error);
    },
    acceptCandidates(candidates, ordering) {
      const planned = planCandidates(candidates, ordering);
      if (!planned.ok) return err(planned.error);
      const accepted = Object.freeze(planned.value.map((plan) => plan.accepted));
      commitAcceptancePlans(planned.value);
      return ok(accepted);
    },
    accept(candidate, ordering) {
      if (disposed)
        return failure('dynamic-geometry-disposed', 'renderer is alive', 'rebuild the Renderer');
      const record = current(candidate);
      if (record === undefined)
        return failure(
          'dynamic-geometry-candidate-not-found',
          'candidate is owned by this renderer',
          'discard the stale credential',
        );
      if (record.batch !== undefined && record.batch.length !== 1) {
        return failure(
          'dynamic-geometry-invalid',
          'admission contains the complete declared preparation batch',
          'accept every prepared member together',
        );
      }
      if (candidate.generation !== currentGeneration) {
        return failure(
          'dynamic-geometry-generation-mismatch',
          'candidate generation matches the active renderer generation',
          'prepare against the current renderer generation',
          { candidateId: candidate.candidateId },
        );
      }
      if (record.candidate.state !== 'prepared') {
        return failure(
          'dynamic-geometry-candidate-state',
          'candidate is prepared exactly once before acceptance',
          'retain the accepted or published receipt',
          { candidateId: candidate.candidateId },
        );
      }
      if (!sameCandidateCredential(candidate, record.candidate)) {
        return failure(
          'dynamic-geometry-receipt-mismatch',
          'acceptance uses the exact prepared candidate credential',
          'discard the altered credential and use the value returned by prepare',
          { candidateId: candidate.candidateId },
        );
      }
      if (ordering !== undefined) {
        if (
          ordering.world !== record.world ||
          !Number.isInteger(ordering.fixedStep) ||
          ordering.fixedStep < 0
        ) {
          return failure(
            'dynamic-geometry-ordering-required',
            'acceptance ordering names the candidate World and a non-negative fixed step',
            'submit the PhysicsWorld publication ordering for the same attached World',
            { candidateId: candidate.candidateId, actual: ordering },
          );
        }
      }
      const newest = [...records.values()]
        .filter(
          (entry) =>
            entry.candidate.candidateId !== candidate.candidateId &&
            entry.world === record.world &&
            entry.candidate.entity === record.candidate.entity &&
            (entry.candidate.state === 'prepared' || entry.candidate.state === 'accepted'),
        )
        .map((entry) => entry.candidate.revision)
        .concat(latestRevisionByWorld.get(record.world)?.get(record.candidate.entity) ?? -1)
        .sort((a, b) => b - a)[0];
      if (newest !== undefined && record.candidate.revision <= newest) {
        return failure(
          'dynamic-geometry-stale',
          'accepted geometry revision is newer than the active candidate',
          'advance topology revision before accepting',
          { candidateId: candidate.candidateId },
        );
      }
      const accepted = Object.freeze({
        ...record.candidate,
        ...(ordering === undefined ? {} : { fixedStep: ordering.fixedStep }),
        state: 'accepted' as const,
      });
      const previousTopologies = [...records.values()]
        .filter(
          (entry) =>
            entry.candidate.candidateId !== candidate.candidateId &&
            entry.world === record.world &&
            entry.candidate.entity === record.candidate.entity,
        )
        .map((entry) => entry.candidate.topologyRevision);
      const previousLatestTopology = latestTopologyRevisionByWorld
        .get(record.world)
        ?.get(record.candidate.entity);
      const newestTopology = previousTopologies
        .concat(previousLatestTopology === undefined ? [] : [previousLatestTopology])
        .sort((a, b) => b - a)[0];
      if (newestTopology !== undefined && accepted.topologyRevision < newestTopology) {
        return failure(
          'dynamic-geometry-stale',
          'accepted topology revision is not older than the active geometry history',
          'advance topology revision before accepting a replacement candidate',
          { candidateId: candidate.candidateId },
        );
      }
      const invalidatesHistory =
        newestTopology !== undefined && accepted.topologyRevision > newestTopology;
      const historyRecords = invalidatesHistory
        ? [...records.values()].filter(
            (previous) =>
              previous.world === record.world &&
              previous.candidate.entity === record.candidate.entity &&
              previous.candidate.candidateId !== candidate.candidateId &&
              previous.candidate.topologyRevision < accepted.topologyRevision &&
              !previous.historyInvalidated,
          )
        : [];
      const plan = planAcceptance(record, accepted, historyRecords, invalidatesHistory);
      const result = ok(plan.accepted);
      commitAcceptancePlans([plan]);
      return result;
    },
    cancel(candidate, completion) {
      const record = current(candidate);
      if (record === undefined)
        return failure(
          'dynamic-geometry-candidate-not-found',
          'candidate is owned by this renderer',
          'discard the stale credential',
        );
      if (!sameCandidateCredential(candidate, record.candidate))
        return failure(
          'dynamic-geometry-receipt-mismatch',
          'cancellation uses the exact prepared candidate credential',
          'discard the altered credential and use the value returned by prepare',
          { candidateId: candidate.candidateId },
        );
      if (record.candidate.state !== 'prepared' && record.candidate.state !== 'accepted') {
        return failure(
          'dynamic-geometry-candidate-state',
          'only prepared or accepted geometry can be cancelled once',
          'retire published geometry or await the existing terminal cleanup',
        );
      }
      cancelRecord(candidate.candidateId, record, completion);
      return ok(undefined);
    },
    retire(candidate) {
      const record = current(candidate);
      if (record === undefined)
        return failure(
          'dynamic-geometry-candidate-not-found',
          'retirement uses a published candidate owned by this renderer',
          'discard the stale credential and do not evict any unrelated mesh',
          { candidateId: candidate.candidateId },
        );
      if (!sameCandidateCredential(candidate, record.candidate))
        return failure(
          'dynamic-geometry-receipt-mismatch',
          'retirement uses the exact published candidate credential',
          'discard the altered credential and use the value returned by publish',
          { candidateId: candidate.candidateId },
        );
      if (record.candidate.state !== 'published') {
        return failure(
          'dynamic-geometry-candidate-state',
          'only published geometry can enter receipt-bound retirement',
          'publish the candidate from a submitted frame first',
        );
      }
      record.candidate = Object.freeze({ ...record.candidate, state: 'retired' as const });
      publishedReceipts.delete(candidate.candidateId);
      retired += 1;
      // Retiring is the logical state transition. Keep the candidate record
      // and its typed bytes until the owner calls `finalizeRetirement` after
      // every record-stage completion fence and GPU lease are gone. This is
      // what makes the transient count and total byte budgets include this work.
      return ok(undefined);
    },
    finalizeRetirement(candidate) {
      const record = current(candidate);
      if (record === undefined)
        return failure(
          'dynamic-geometry-candidate-not-found',
          'retirement finalization uses a candidate retained by this lifecycle',
          'discard the stale credential or finish the current receipt-bound retirement',
        );
      if (!sameCandidateCredential(candidate, record.candidate))
        return failure(
          'dynamic-geometry-receipt-mismatch',
          'retirement finalization uses the exact published candidate credential',
          'discard the altered credential and use the value returned by publication',
          { candidateId: candidate.candidateId },
        );
      if (record.candidate.state !== 'retired')
        return failure(
          'dynamic-geometry-candidate-state',
          'only a retired candidate can release its deferred budget',
          'retire the published candidate before finalizing its receipt-bound cleanup',
          { candidateId: candidate.candidateId },
        );
      release(candidate.candidateId, record);
      return ok(undefined);
    },
    publishFrame(frame, worlds, fixedStep, canPublish, recordStageLane) {
      if (disposed || frame.deviceGeneration !== currentGeneration) return [];
      const receipts: DynamicGeometryReceipt[] = [];
      let sharedFrame: DynamicGeometryReceipt['frame'] | undefined;
      let frameChecked = false;
      for (const record of records.values()) {
        const canRepeatPublished =
          record.candidate.state === 'published' &&
          // Attached Renderer publication revalidates the entity binding in
          // `canPublish`, so a history-invalidated candidate can still record
          // a real draw for its live entity. Detached lifecycle publication
          // remains one-shot once that history is invalidated.
          (canPublish !== undefined || !record.historyInvalidated);
        if (record.candidate.state !== 'accepted' && !canRepeatPublished) continue;
        if (worlds !== undefined && !worlds.includes(record.world)) continue;
        if (
          record.candidate.fixedStep !== undefined &&
          (fixedStep === undefined || record.candidate.fixedStep > fixedStep)
        ) {
          continue;
        }
        if (canPublish !== undefined && !canPublish(record.candidate)) continue;
        const consumedLane =
          canPublish === undefined ? undefined : recordStageLane?.(record.candidate);
        if (!frameChecked) {
          sharedFrame = sharedFrameSnapshot(frame);
          frameChecked = true;
        }
        if (record.candidate.state !== 'published')
          record.candidate = Object.freeze({ ...record.candidate, state: 'published' as const });
        const receipt = Object.freeze({
          candidateId: record.candidate.candidateId,
          generation: record.candidate.generation,
          revision: record.candidate.revision,
          topologyRevision: record.candidate.topologyRevision,
          ...(record.candidate.fixedStep === undefined
            ? {}
            : { fixedStep: record.candidate.fixedStep }),
          frameId: frame.frameId,
          deviceGeneration: frame.deviceGeneration,
          recordStageConsumed: canPublish !== undefined,
          ...(consumedLane === undefined ? {} : { recordStageLane: consumedLane }),
          ...(fixedStep === undefined ? {} : { publicationFixedStep: fixedStep }),
          frame: sharedFrame ?? Object.freeze({ ...frame }),
        });
        receipts.push(receipt);
        publishedReceipts.set(record.candidate.candidateId, receipt);
        latestRevision = record.candidate.revision;
        latestFrameId = frame.frameId;
        if (!latestRevisionByWorld.has(record.world))
          latestRevisionByWorld.set(record.world, new Map());
        latestRevisionByWorld
          .get(record.world)
          ?.set(record.candidate.entity, record.candidate.revision);
        if (!latestTopologyRevisionByWorld.has(record.world))
          latestTopologyRevisionByWorld.set(record.world, new Map());
        latestTopologyRevisionByWorld
          .get(record.world)
          ?.set(record.candidate.entity, record.candidate.topologyRevision);
      }
      return receipts;
    },
    invalidateWorld(world, completion) {
      for (const [id, record] of records) {
        if (record.world !== world) continue;
        // An earlier terminal operation already owns this reservation's fence.
        if (record.candidate.state === 'cancelled' || record.candidate.state === 'retired')
          continue;
        publishedReceipts.delete(id);
        cancelRecord(id, record, completion);
        invalidated += 1;
      }
      latestRevisionByWorld.delete(world);
      latestTopologyRevisionByWorld.delete(world);
    },
    invalidateGeneration(generation) {
      if (generation === currentGeneration) return;
      currentGeneration = generation;
      const invalidatedWorlds = new Set<object>();
      for (const [id, record] of records) {
        if (record.candidate.generation !== generation) {
          release(id, record);
          publishedReceipts.delete(id);
          invalidatedWorlds.add(record.world);
          invalidated += 1;
        }
      }
      for (const world of invalidatedWorlds) {
        latestRevisionByWorld.delete(world);
        latestTopologyRevisionByWorld.delete(world);
      }
    },
    receipt(candidate) {
      const receipt = publishedReceipts.get(candidate.candidateId);
      const record = records.get(candidate.candidateId);
      if (record === undefined || !sameCandidateCredential(candidate, record.candidate)) {
        return undefined;
      }
      return receipt?.generation === candidate.generation ? receipt : undefined;
    },
    inspect() {
      let prepared = 0;
      let accepted = 0;
      let published = 0;
      for (const record of records.values()) {
        if (record.candidate.state === 'prepared') prepared += 1;
        else if (record.candidate.state === 'accepted') accepted += 1;
        else if (record.candidate.state === 'published') published += 1;
      }
      return Object.freeze({
        generation: currentGeneration,
        prepared,
        accepted,
        published,
        retired,
        ...(latestRevision === undefined ? {} : { latestRevision }),
        ...(latestFrameId === undefined ? {} : { latestFrameId }),
        historyInvalidations,
        invalidated,
        meshBytes,
        maxMeshBytes,
      });
    },
    dispose() {
      disposed = true;
      records.clear();
      publishedReceipts.clear();
      meshBytes = 0;
    },
  };
}
