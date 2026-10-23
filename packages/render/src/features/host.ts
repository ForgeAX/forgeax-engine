import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';

import type { EntityHandle } from '@forgeax/engine-ecs';
import type { Buffer, RhiCaps, Sampler, TextureFormat, TextureView } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { DeviceScope, LifecycleResourceSpec } from '../device/device-scope';
import {
  type RenderError,
  RenderFeatureCapabilityMissingError,
  RenderFeaturePreparationFailedError,
  RenderFeatureRegistrationConflictError,
  RenderFeatureStageFailedError,
} from '../errors/render';
import { renderMaterialContext } from '../extract/material-context';
import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_COPY_SRC } from '../gpu-usage';
import type { RenderFeatureHostInspection } from '../inspection-types';
import type {
  PreparedGraphicsReference,
  PreparedGraphicsResolvedSnapshot,
  PreparedGraphicsResolver,
  PreparedGraphicsResourceLease,
} from '../prepare/prepared-graphics-resolver';
import type { CameraSnapshot, FramePresentationPendingReason } from '../render-contract';
import { isSceneDataTarget, type SceneDataTarget } from '../temporal/scene-data';
import { createSceneDataCatalog, type SceneDataCatalog } from '../temporal/scene-data-catalog';
import {
  featureScopeKey,
  resolveFeatureWorkResources,
  resolveNativeFeatureWorkResources,
} from './frame-plan';
import { sameRenderFeatureNativeExecutionTopology } from './native-execution-topology';
import { coalesceNativeReadOnlyDepthPasses } from './native-read-only-depth-passes';
import {
  createNativeResourceAdmission,
  createPreparedResourceMaps,
  type PreparedPlanResources,
} from './native-resource-admission';
import {
  cloneOwnedRenderFeaturePlanSignatureSnapshot,
  freezeRenderFeaturePlan,
  isRenderFeatureSceneResource,
  type RenderFeatureLogicalTarget,
  type RenderFeaturePassDeclaration,
  type RenderFeaturePlannedFrame,
  type RenderFeaturePlanSignatureMetrics,
  type RenderFeaturePlanSignatureSnapshot,
  type RenderFeatureResourceDeclaration,
  type RenderFeatureSceneResource,
  type RenderFeatureWorkPlan,
  rememberRenderFeaturePlanSignature,
  renderFeaturePlanSignature,
} from './plan';
import type {
  RenderFeatureGpuBufferRef,
  RenderFeatureGpuComputePassDescriptor,
  RenderFeatureGpuPrepareSession,
  RenderFeatureGpuWorkOwner,
  RenderFeatureNativeResourceAdmission,
} from './prepared-gpu-work';
import {
  consumeRenderFeatureNativePlan,
  createRenderFeatureNativePlanBuilder,
  isRenderFeatureNativePlan,
  renderFeatureNativeDepthBatchPermission,
  renderFeatureNativeResourceAdmission,
} from './prepared-gpu-work';
import type {
  RenderFeatureGraphicsPassDescriptor,
  RenderFeatureGraphicsPrepare,
  RenderFeaturePreparedGraphicsState,
  RenderFeaturePreparedRef,
} from './prepared-graphics';
import {
  createPreparedGraphicsStore,
  type PreparedGraphicsStore,
  type PreparedGraphicsTransaction,
} from './prepared-graphics-store';
import { isRenderFeatureTargetHandle } from './targets';
import type {
  RenderFeature,
  RenderFeatureCapabilityKey,
  RenderFeatureCleanupFailure,
  RenderFeatureDiagnostics,
  RenderFeatureErrorDescriptor,
  RenderFeatureHiddenEntityReport,
  RenderFeatureRecoverInput,
  RenderFeatureShaderModuleMode,
  RenderFeatureStatus,
  RenderFeatureTargetHandle,
  RenderFeatureWorldVisibilitySnapshot,
} from './types';

const planExecutionProjections = new WeakMap<
  RenderFeaturePlannedFrame,
  { readonly execution: RenderFeaturePlanExecution; readonly nativeSignature?: string }
>();

const submissionSensitivePlans = new WeakSet<RenderFeaturePlannedFrame>();

/** A cached command graph must not replay a producer's already-consumed intents. */
export function hasSubmissionSensitiveFeatures(
  plans: readonly RenderFeaturePlannedFrame[],
): boolean {
  return plans.some((plan) => submissionSensitivePlans.has(plan));
}

export interface RenderFeaturePlanExecutionPass {
  readonly enabled?: boolean | undefined;
  readonly shadowCaster?: true;
  readonly featureIdentity: string;
  readonly order: number;
  readonly name: string;
  readonly graphics?: RenderFeatureGraphicsPassDescriptor;
  readonly graphicsState?: RenderFeaturePreparedGraphicsState;
  readonly gpuCompute?: RenderFeatureGpuComputePassDescriptor;
  readonly resolvedGraphics?: PreparedGraphicsResolvedSnapshot;
  readonly resolvedGpuCompute?: import('./prepared-gpu-work').RenderFeatureResolvedGpuComputePass;
  readonly resolvedGpuCopies?: readonly {
    readonly enabled?: boolean | undefined;
    readonly source: import('./prepared-gpu-work').RenderFeatureResolvedGpuBuffer;
    readonly destination: import('./prepared-gpu-work').RenderFeatureResolvedGpuBuffer;
    readonly size: number;
    readonly sourceOffset: number;
    readonly destinationOffset: number;
  }[];
}

/** Host-owned device projection of one frozen plan; graph access is derived later. */
export interface RenderFeaturePlanExecution {
  /** Canonical host-owned work scope; omitted only by direct graph adapters. */
  readonly scope?: string;
  readonly featureIdentity: string;
  readonly order: number;
  readonly placement?: import('./types').RenderFeaturePlacement;
  readonly passes: readonly RenderFeaturePlanExecutionPass[];
}

const preparedResourceKeyPlans = new WeakSet<RenderFeaturePlannedFrame>();

/** Physical imports that cannot be retained by a graph across this plan replacement. */
export function renderFeaturePlanRequiresPreparedResourceKey(
  plan: RenderFeaturePlannedFrame,
): boolean {
  return preparedResourceKeyPlans.has(plan);
}

/** @internal Typed-graph adapter for the host-owned projection of a validated plan. */
export function getRenderFeaturePlanExecutionProjection(
  planned: RenderFeaturePlannedFrame,
): RenderFeaturePlanExecution | undefined {
  return planExecutionProjections.get(planned)?.execution;
}

/** Native publication uses the same Host execution authority, never a raw-plan brand. */
export function hasNativeRenderFeatureExecutionSignature(
  planned: RenderFeaturePlannedFrame,
): boolean {
  const publication = planExecutionProjections.get(planned);
  return (
    publication?.nativeSignature !== undefined && publication.nativeSignature === planned.signature
  );
}

export interface RenderFeatureStageEvent {
  readonly featureIdentity: string;
  readonly order: number;
  readonly stage: 'extract' | 'plan';
}

export interface RenderFeatureFrameInput {
  readonly resolveAsset?: import('./plan').RenderFeaturePlanContext['resolveAsset'];
  readonly publishedFeatures?: readonly { readonly identity: string; readonly data: unknown }[];
  readonly onFeatureSourceSubmitted?: (identity: string, feedback: unknown) => void;
  readonly identity: string;
  readonly render: boolean;
  readonly motionBlur?: import('./motion-blur/motion-blur-feature').MotionBlurFeatureInput;
  readonly worlds: readonly import('@forgeax/engine-ecs').World[];
  readonly owner: number;
  readonly frameNumber: number;
  /** Renderer-selected display camera forwarded to feature extraction. */
  readonly selectedCamera?: CameraSnapshot;
  readonly selectedView?: import('./types').RenderFeatureExtractView['selectedView'];
  /** Physical render extent for bounded feature dispatch sizing. */
  readonly frameSize?: { readonly width: number; readonly height: number };
  readonly visibilitySnapshots?: readonly RenderFeatureWorldVisibilitySnapshot[];
  readonly hiddenEntityReports?: readonly RenderFeatureHiddenEntityReport[];
  /** Active-pipeline logical targets available to producer-owned features. */
  readonly targets?: readonly RenderFeatureTargetHandle[];
  /** Optional renderer-owned semantic catalog for the current plan generation. */
  readonly sceneData?: SceneDataCatalog;
  readonly generation?: number;
  readonly caps: Readonly<RhiCaps>;
  /** Default-off Renderer profile experiment; native producer permission is still required. */
  readonly featureReadOnlyDepthBatchDiagnostic?: boolean;
  readonly limits?: Readonly<Partial<GPUSupportedLimits>>;
  /** Normal frame-owner facts shared with producer extraction. */
  readonly frame?: import('./types').RenderFeatureFrameContext;
  /** Renderer-owned material binding contract projection for producer plans. */
  /** Read a build-time cooked utility selected for the receiving device. */
  readonly getFeatureShaderSource?: ((identifier: string) => string | undefined) | undefined;
  readonly materialShaderBindingContract?: (
    materialShaderId: string,
  ) => import('./plan').RenderFeatureMaterialShaderContract;
  readonly sceneResources?:
    | {
        prepare(
          identity: string,
          resource: RenderFeatureSceneResource,
        ):
          | { readonly view: TextureView; readonly target?: RenderFeatureTargetHandle }
          | { readonly buffer: Buffer; readonly size: number };
        abortFeature(identity: string): void;
      }
    | undefined;
  readonly createPreparedGraphicsResolver?: (
    input: RenderFeaturePreparedGraphicsResolverInput,
  ) => PreparedGraphicsResolver;
  /** Single renderer-owned GPU preparation owner for all feature sessions. */
  readonly gpuWork?: RenderFeatureGpuWorkOwner;
}

export interface RenderFeaturePreparedGraphicsResolverInput {
  readonly featureIdentity: string;
  readonly order: number;
  readonly generation: number;
  /** Shader preparation policy selected by the owning feature. */
  readonly shaderModuleMode?: RenderFeatureShaderModuleMode;
  readonly transaction: PreparedGraphicsTransaction;
  readonly fullscreenEffects: ReadonlyMap<string, PostProcessShaderEntry>;
  readonly lookup: (
    reference: import('./prepared-graphics').RenderFeaturePreparedRef,
  ) => import('./prepared-graphics-store').PreparedGraphicsItem | undefined;
}

export interface RenderFeatureFrameResult {
  /** Explicit GPU preparation has not produced every requested pipeline/resource yet. */
  readonly preparationPending?: boolean;
  readonly preparationPendingFeatureIdentity?: string;
  readonly preparationPendingReason?: FramePresentationPendingReason;
  readonly stageEvents: readonly RenderFeatureStageEvent[];
  readonly errors: readonly RenderError[];
  readonly plans: readonly RenderFeaturePlannedFrame[];
  readonly fullscreenEffects: ReadonlyMap<string, PostProcessShaderEntry>;
  /** Public Standard post-effect identities; graph-local fullscreen resources are not included. */
  readonly postProcessIdentities: readonly string[];
  readonly preparedResourceBatches: readonly RenderFeaturePreparedResourceBatch[];
  /**
   * True only when the current graph imports a transient graphics buffer.
   * Retired GPU-work leases are kept alive until queue completion but are not
   * referenced by this candidate and therefore do not require a new graph.
   */
  readonly requiresPreparedResourceKey: boolean;
  readonly hiddenEntityReports: readonly RenderFeatureHiddenEntityReport[];
  /** Invoke producer consumption after the frame reaches queue submission. */
  readonly onSubmitted: () => void;
  /** Discard producer frame state after graph admission/submission failure. */
  readonly onAborted: () => void;
}

export interface RenderFeatureHost {
  readonly size: number;
  readonly features: readonly RenderFeature<unknown>[];
  readonly preparedGeneration: number;
  /** Install a producer after renderer creation; same object identity is idempotent. */
  install(feature: RenderFeature<unknown>): Result<void, RenderError>;
  /** Remove one installed producer and release every resource it owns. */
  uninstall(feature: RenderFeature<unknown>): Result<void, RenderError>;
  advancePreparedGeneration(): number;
  setStatus(
    identity: string,
    status: RenderFeatureStatus,
    latestError?: RenderFeatureErrorDescriptor,
  ): Result<void, RenderError>;
  /** Record a failure from active-graph execution against its owning slot. */
  recordError(identity: string, error: RenderError): RenderError;
  beginPreparedFrame(identity: string, generation: number): PreparedGraphicsTransaction | undefined;
  retainPreparedGraphics(
    identity: string,
    leases: readonly PreparedGraphicsResourceLease[],
  ): Result<RenderFeaturePreparedResourceBatch, RenderError>;
  /** Mark batches used by the just-recorded frame as protected by queue work. */
  markPreparedGraphicsSubmitted(batches: readonly RenderFeaturePreparedResourceBatch[]): void;
  /** Release completed batches, or all batches that were never submitted. */
  retirePreparedGraphics(
    batches?: readonly RenderFeaturePreparedResourceBatch[],
  ): Result<void, RenderError>;
  /** Release submitted batches when queue completion rejects and cannot prove completion. */
  recoverPreparedGraphics(
    batches: readonly RenderFeaturePreparedResourceBatch[],
  ): Result<void, RenderError>;
  recover(input: RenderFeatureRecoverInput): Result<void, RenderError>;
  createRecoveryRoot(scope: DeviceScope): LifecycleResourceSpec<unknown>;
  diagnostics(): readonly RenderFeatureDiagnostics[];
  /** Retain an explicitly producer-published detached inspection value. */
  setInspection(identity: string, inspection: unknown): void;
  /** Subscribe to lifecycle projection changes; unchanged active frames are silent. */
  subscribeDiagnostics(listener: () => void): () => void;
  /** Detached signature and prepared-resource accounting for diagnostics. */
  readonly inspection?: () => RenderFeatureHostInspection;
  beginDepthBatchInspection?(frameNumber: number | undefined, generation: number): void;
  recordDepthBatchInspection?(before: number, after: number, admitted: number): void;
  /** Host-owned signature entry point so accounting remains per feature. */
  readonly recordPlanSignature?: (
    identity: string,
    plan: RenderFeatureWorkPlan,
    scope?: string,
  ) => string;
  readonly recordNativeExecutionSignature?: (
    identity: string,
    execution: RenderFeaturePlanExecution,
    scope: string,
  ) => string;
  retainPlanScopes?(identity: string, scopes: readonly string[]): void;
  dispose(): Result<void, RenderError>;
}

export interface RenderFeaturePreparedResourceBatch {
  release(): Result<void, RenderError>;
}

/**
 * Resolve a submitted batch from queue completion without conflating promise
 * rejection with retirement failures. Rejection is treated as lost completion
 * evidence, so the host releases only batches still marked submitted.
 */
export function settlePreparedGraphicsCompletion(
  host: RenderFeatureHost,
  batches: readonly RenderFeaturePreparedResourceBatch[],
  completion: PromiseLike<unknown>,
  onError: (error: unknown) => void,
): void {
  const run = (operation: () => Result<void, RenderError>): void => {
    try {
      const result = operation();
      if (!result.ok) onError(result.error);
    } catch (error) {
      onError(error);
    }
  };

  void completion.then(
    () => run(() => host.retirePreparedGraphics(batches)),
    () => run(() => host.recoverPreparedGraphics(batches)),
  );
}

interface FeatureSlot {
  readonly feature: RenderFeature<unknown>;
  order: number;
  readonly preparedResourceBatches: Set<RenderFeaturePreparedResourceBatch>;
  readonly preparedStore: PreparedGraphicsStore;
  status: RenderFeatureStatus;
  latestError: RenderFeatureErrorDescriptor | undefined;
  latestInspection?: unknown;
}

function freezeError(error: RenderFeatureErrorDescriptor): RenderFeatureErrorDescriptor {
  const detail = { ...error.detail } as RenderFeatureErrorDescriptor['detail'];
  if ('cleanupFailures' in detail && detail.cleanupFailures !== undefined) {
    (detail as { cleanupFailures: readonly RenderFeatureCleanupFailure[] }).cleanupFailures =
      Object.freeze([...detail.cleanupFailures]);
  }
  return Object.freeze({
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: Object.freeze(detail),
  }) as RenderFeatureErrorDescriptor;
}

function freezeDiagnostics(slot: FeatureSlot): RenderFeatureDiagnostics {
  return Object.freeze({
    identity: slot.feature.identity,
    order: slot.order,
    status: slot.status,
    latestError: slot.latestError === undefined ? undefined : freezeError(slot.latestError),
    ...(slot.latestInspection === undefined ? {} : { inspection: slot.latestInspection }),
  });
}

function findSlot(slots: readonly FeatureSlot[], identity: string): FeatureSlot | undefined {
  return slots.find((slot) => slot.feature.identity === identity);
}

function registrationConflict(
  featureIdentity: string,
  order: number,
  conflictingOrder: number,
): RenderFeatureRegistrationConflictError {
  return new RenderFeatureRegistrationConflictError(featureIdentity, order, conflictingOrder);
}

function unknownFeatureError(
  identity: string,
  stage: 'recover' | 'dispose',
): RenderFeatureStageFailedError {
  return new RenderFeatureStageFailedError(identity, -1, stage, 'registration');
}

function missingCapability(
  feature: RenderFeature<unknown>,
  caps: Readonly<RhiCaps>,
): RenderFeatureCapabilityKey | undefined {
  return feature.requiredCapabilities?.find((capability) => caps[capability] !== true);
}

/**
 * Capability declarations gate work that the current plan actually admits.
 * A producer is still allowed to extract and return an empty plan when its
 * authored feature is disabled; that path must remain allocation-free on a
 * backend which cannot support the optional feature.
 */
function hasActivePlan(plan: RenderFeatureWorkPlan): boolean {
  return plan.resources.length > 0 || plan.passes.length > 0;
}

function createPreparedGraphicsPrepare(
  transaction: PreparedGraphicsTransaction,
  native?: true,
): RenderFeatureGraphicsPrepare {
  return {
    preparePipeline: (name, descriptor) =>
      transaction.prepare('pipeline', name, descriptor, native),
    prepareBindings: (name, descriptor) =>
      transaction.prepare('bindings', name, descriptor, native),
    prepareVertexData: (name, descriptor) =>
      transaction.prepare('vertex-data', name, descriptor, native),
    prepareIndexData: (name, descriptor) =>
      transaction.prepare('index-data', name, descriptor, native),
  };
}

function* preparedGraphicsReferences(
  descriptor: import('./prepared-graphics').RenderFeatureGraphicsPassDescriptor,
): IterableIterator<PreparedGraphicsReference> {
  for (const draw of descriptor.draws) {
    yield draw.pipeline;
    yield* draw.bindings;
    for (const vertex of draw.vertexData) yield vertex.resource;
    if (draw.indexData !== undefined) yield draw.indexData.resource;
  }
}

function resolveGraphicsSnapshot(
  resolver: PreparedGraphicsResolver,
  descriptor: import('./prepared-graphics').RenderFeatureGraphicsPassDescriptor,
  generation: number,
  resolveGpuResource?: (
    name: string,
  ) => import('./prepared-gpu-work').RenderFeatureResolvedGpuBuffer | undefined,
  captureGpuResources = false,
  onResolutionFailure?: (reference: PreparedGraphicsReference, error: RenderError) => void,
): Result<PreparedGraphicsResolvedSnapshot, RenderError> {
  const resources = new Map<
    object,
    import('../prepare/prepared-graphics-resolver').PreparedGraphicsResolvedResource
  >();
  for (const reference of preparedGraphicsReferences(descriptor)) {
    if (resources.has(reference)) continue;
    const resolved = resolver.resolve(reference);
    if (!resolved.ok) {
      onResolutionFailure?.(reference, resolved.error);
      return resolved;
    }
    resources.set(reference, resolved.value);
  }
  // The native topology owner compares two completed private packets. Never
  // call a prior frame's live GPU session from that comparison: resolving can
  // touch/retain current transaction resources. Capture actual dependencies
  // once now and publish pure map lookups with the same packet lifetime.
  let readGpuBuffer = resolver.resolveGpuBuffer;
  let readGpuResource = resolveGpuResource;
  if (captureGpuResources) {
    const gpuBuffers = new Map<
      RenderFeatureGpuBufferRef,
      import('./prepared-gpu-work').RenderFeatureResolvedGpuBuffer
    >();
    const gpuResources = new Map<
      string,
      import('./prepared-gpu-work').RenderFeatureResolvedGpuBuffer
    >();
    for (const draw of descriptor.draws) {
      if (draw.kind === 'draw-indirect' || draw.kind === 'draw-indexed-indirect') {
        const ref = draw.command.buffer;
        if (!gpuBuffers.has(ref)) {
          const buffer = resolver.resolveGpuBuffer?.(ref);
          if (buffer !== undefined) gpuBuffers.set(ref, buffer);
        }
      }
    }
    for (const resource of resources.values()) {
      const names =
        resource.kind === 'bindings' ? resource.descriptor?.values.storageBuffers : undefined;
      if (!Array.isArray(names)) continue;
      for (const name of names)
        if (typeof name === 'string' && !gpuResources.has(name)) {
          const buffer = resolveGpuResource?.(name);
          if (buffer !== undefined) gpuResources.set(name, buffer);
        }
    }
    if (readGpuBuffer !== undefined) readGpuBuffer = (reference) => gpuBuffers.get(reference);
    if (readGpuResource !== undefined) readGpuResource = (name) => gpuResources.get(name);
  }

  return ok({
    generation,
    leases: resolver.leases,
    resolve: (reference) => resources.get(reference),
    ...(readGpuBuffer === undefined ? {} : { resolveGpuBuffer: readGpuBuffer }),
    ...(readGpuResource === undefined ? {} : { resolveGpuResource: readGpuResource }),
  });
}

function graphicsValidator(
  identity: string,
  transaction: PreparedGraphicsTransaction,
  capabilityAvailable: boolean,
): (
  descriptor: RenderFeatureGraphicsPassDescriptor,
  resources: readonly { readonly name: string }[],
) => Result<RenderFeaturePreparedGraphicsState, RenderError> {
  return (descriptor, resources) => {
    const attachments = [
      ...descriptor.attachments.colors
        .filter(
          (attachment) =>
            typeof attachment.resource !== 'string' ||
            attachment.resource === 'swapchain' ||
            resources.some((resource) => resource.name === `${identity}::${attachment.resource}`),
        )
        .map((attachment) => ({ resource: attachment.resource, format: attachment.format })),
      ...(descriptor.attachments.depthStencil === undefined
        ? []
        : resources.some(
              (resource) =>
                resource.name === `${identity}::${descriptor.attachments.depthStencil?.resource}`,
            ) || typeof descriptor.attachments.depthStencil.resource !== 'string'
          ? [
              {
                resource: descriptor.attachments.depthStencil.resource,
                format: descriptor.attachments.depthStencil.format,
              },
            ]
          : []),
    ];
    return transaction.validateGraphicsPass(descriptor, capabilityAvailable, attachments);
  };
}

function asFeatureError(
  error: unknown,
  identity: string,
  order: number,
  stage: 'extract' | 'plan',
): RenderError {
  if (error instanceof Error && typeof (error as Partial<RenderError>).code === 'string') {
    return error as RenderError;
  }
  return new RenderFeatureStageFailedError(identity, order, stage, 'next-frame', error);
}

function featureErrorForSlot(slot: FeatureSlot, error: RenderError): RenderError {
  switch (error.code) {
    case 'render-feature-registration-conflict':
    case 'render-feature-stage-failed':
    case 'render-feature-capability-missing':
    case 'render-feature-pass-order-conflict':
    case 'render-feature-preparation-failed':
    case 'render-feature-prepared-state-mismatch':
    case 'render-feature-draw-recording-failed':
      return error.detail.featureIdentity === slot.feature.identity
        ? error
        : new RenderFeatureStageFailedError(
            slot.feature.identity,
            slot.order,
            'plan',
            'next-frame',
            error,
          );
    default:
      return new RenderFeatureStageFailedError(
        slot.feature.identity,
        slot.order,
        'plan',
        'next-frame',
        error,
      );
  }
}

function errorDescriptor(error: RenderError): RenderFeatureErrorDescriptor {
  switch (error.code) {
    case 'render-feature-registration-conflict':
    case 'render-feature-stage-failed':
    case 'render-feature-capability-missing':
    case 'render-feature-pass-order-conflict':
    case 'render-feature-preparation-failed':
    case 'render-feature-prepared-state-mismatch':
    case 'render-feature-draw-recording-failed':
      return {
        code: error.code,
        expected: error.expected,
        hint: error.hint,
        detail: { ...error.detail },
      } as RenderFeatureErrorDescriptor;
    default:
      return {
        code: 'render-feature-stage-failed',
        expected: error.expected,
        hint: error.hint,
        detail: {
          featureIdentity: 'unknown',
          order: -1,
          stage: 'plan',
          recovery: 'next-frame',
          cause: error,
        },
      };
  }
}

function recordFailure(
  slot: FeatureSlot,
  stage: 'extract' | 'plan',
  failure: unknown,
  errors: RenderError[],
): void {
  const error = asFeatureError(failure, slot.feature.identity, slot.order, stage);
  errors.push(error);
  slot.status = 'failed';
  slot.latestError = errorDescriptor(error);
}

function logicalTargets(
  targets: readonly RenderFeatureTargetHandle[],
): readonly RenderFeatureLogicalTarget[] {
  return Object.freeze(
    targets.map((target) => ({
      name: target.name ?? (target.kind === 'scene-color' ? 'color' : 'depth'),
      kind: target.kind === 'scene-color' ? ('color' as const) : ('depth' as const),
      format: target.format,
      sampleCount: target.sampleCount,
    })),
  );
}

function createPreparedResourceScopes(
  prepared: PreparedPlanResources,
): (keys: ReadonlyMap<string, string>) => PreparedPlanResources {
  // These Maps are produced privately by preparePlanResources and stop changing
  // before projection. Keep per-scope copies so retained graphics callbacks
  // cannot retain another view's resource namespace through a lazy lookup.
  const kinds = Object.keys(prepared) as (keyof PreparedPlanResources)[];
  const byKey = new Map<string, [keyof PreparedPlanResources, unknown][]>();
  for (const kind of kinds) {
    for (const [key, value] of prepared[kind]) {
      if (value === undefined) continue;
      const entries = byKey.get(key);
      if (entries === undefined) byKey.set(key, [[kind, value]]);
      else entries.push([kind, value]);
    }
  }
  return (keys) => {
    const scoped = Object.fromEntries(
      kinds.map((kind) => [kind, new Map<string, unknown>()]),
    ) as Record<keyof PreparedPlanResources, Map<string, unknown>>;
    for (const [name, key] of keys) {
      const entries = byKey.get(key);
      if (entries === undefined) continue;
      for (const [kind, value] of entries) scoped[kind].set(name, value);
    }
    return scoped as unknown as PreparedPlanResources;
  };
}

function planFailure(slot: FeatureSlot): RenderFeatureStageFailedError {
  return new RenderFeatureStageFailedError(slot.feature.identity, slot.order, 'plan', 'next-frame');
}

function targetHandle(
  name: string | SceneDataTarget,
  targets: readonly RenderFeatureTargetHandle[],
): string | RenderFeatureTargetHandle | SceneDataTarget | undefined {
  if (name === 'swapchain') return 'swapchain';
  if (typeof name !== 'string') return name;
  return targets.find(
    (target) =>
      target.name === name ||
      (target.name === undefined &&
        ((name === 'color' && target.kind === 'scene-color') ||
          (name === 'depth' && target.kind === 'scene-depth'))),
  );
}

function targetFormat(
  name: string,
  targets: readonly RenderFeatureLogicalTarget[],
  fallback: string | undefined,
): TextureFormat | undefined {
  const target = targets.find((candidate) => candidate.name === name);
  return (target?.format ?? fallback) as TextureFormat | undefined;
}

function preparePlanResources(
  slot: FeatureSlot,
  plan: RenderFeatureWorkPlan,
  graphics: RenderFeatureGraphicsPrepare,
  gpu: RenderFeatureGpuPrepareSession | undefined,
  targetsForResource: (name: string) => readonly RenderFeatureTargetHandle[],
  sceneResources: RenderFeatureFrameInput['sceneResources'],
  native?: {
    readonly keys: ReadonlyMap<string, string>;
    readonly shared?: PreparedPlanResources;
    readonly admission?: PreparedPlanResources;
  },
): Result<PreparedPlanResources, RenderError> {
  const {
    computePrograms,
    graphicsPrograms,
    buffers,
    preparedGpuResources,
    computeBindings,
    graphicsBindings,
    vertexData,
    indexData,
  } = createPreparedResourceMaps(
    native?.admission ?? native?.shared,
    native?.admission === undefined ? undefined : native.shared,
    native?.admission !== undefined,
  );
  const ownerName = (name: string): string => native?.keys.get(name) ?? name;
  const buckets =
    native === undefined ? undefined : new Map<string, RenderFeatureResourceDeclaration[]>();
  if (buckets !== undefined)
    for (const resource of plan.resources) {
      const bucket = buckets.get(resource.kind);
      if (bucket === undefined) buckets.set(resource.kind, [resource]);
      else bucket.push(resource);
    }
  const byKind = <Kind extends RenderFeatureResourceDeclaration['kind']>(
    kind: Kind,
  ): Extract<RenderFeatureResourceDeclaration, { readonly kind: Kind }>[] =>
    buckets === undefined
      ? plan.resources.filter(
          (
            resource,
          ): resource is Extract<RenderFeatureResourceDeclaration, { readonly kind: Kind }> =>
            resource.kind === kind,
        )
      : ((buckets.get(kind) ?? []) as Extract<
          RenderFeatureResourceDeclaration,
          { readonly kind: Kind }
        >[]);

  if (
    gpu === undefined &&
    plan.resources.some(
      (resource) =>
        isRenderFeatureSceneResource(resource) ||
        ['compute-program', 'buffer', 'prepared-gpu-resource', 'compute-bindings'].includes(
          resource.kind,
        ),
    )
  ) {
    return err(planFailure(slot));
  }
  for (const resource of byKind('compute-program')) {
    const prepared = gpu?.prepareProgram(
      ownerName(resource.name),
      resource.program,
      resource.preparePipelines,
    );
    if (prepared === undefined) return err(planFailure(slot));
    if (!prepared.ok) return prepared;
    computePrograms.set(resource.name, prepared.value);
  }
  for (const resource of byKind('graphics-program')) {
    const prepared = graphics.preparePipeline(ownerName(resource.name), resource.program);
    if (!prepared.ok) return prepared;
    graphicsPrograms.set(resource.name, prepared.value);
  }
  for (const resource of byKind('buffer')) {
    const prepared = gpu?.prepareBuffer(ownerName(resource.name), {
      size: resource.size,
      usage: resource.usage,
      ...(resource.data === undefined ? {} : { data: resource.data }),
      ...(resource.uploads === undefined ? {} : { uploads: resource.uploads }),
    });
    if (prepared === undefined) return err(planFailure(slot));
    if (!prepared.ok) return prepared;
    buffers.set(resource.name, prepared.value);
  }
  for (const resource of byKind('prepared-gpu-resource')) {
    if (gpu === undefined) return err(planFailure(slot));
    if (resource.resource.kind === 'buffer') {
      const prepared = gpu.prepareBufferResource(
        ownerName(resource.name),
        resource.resource.value as Buffer,
        {
          size: resource.resource.size,
          usage: resource.resource.usage ?? ['uniform'],
        },
      );
      if (!prepared.ok) return prepared;
      preparedGpuResources.set(resource.name, { kind: 'buffer', reference: prepared.value });
      continue;
    }
    if (resource.resource.kind === 'texture-view') {
      const logical =
        resource.logicalTarget === undefined
          ? undefined
          : targetHandle(resource.logicalTarget, targetsForResource(ownerName(resource.name)));
      if (
        resource.logicalTarget !== undefined &&
        (logical === undefined ||
          (typeof logical !== 'string' &&
            !isRenderFeatureTargetHandle(logical) &&
            !isSceneDataTarget(logical)))
      ) {
        return err(planFailure(slot));
      }
      const prepared = gpu.prepareTextureView(
        ownerName(resource.name),
        resource.resource.value as TextureView | undefined,
        logical === undefined ? undefined : logical,
      );
      if (!prepared.ok) return prepared;
      preparedGpuResources.set(resource.name, {
        kind: 'texture-view',
        reference: prepared.value,
      });
      continue;
    }
    const prepared = gpu.prepareSampler(
      ownerName(resource.name),
      resource.resource.value as Sampler,
    );
    if (!prepared.ok) return prepared;
    preparedGpuResources.set(resource.name, { kind: 'sampler', reference: prepared.value });
  }
  for (const resource of plan.resources) {
    if (!isRenderFeatureSceneResource(resource)) continue;
    if (gpu === undefined || sceneResources === undefined) return err(planFailure(slot));
    const scene = sceneResources.prepare(slot.feature.identity, resource);
    if ('buffer' in scene) {
      const prepared = gpu.prepareBufferResource(ownerName(resource.name), scene.buffer, {
        size: scene.size,
        usage: ['storage'],
      });
      if (!prepared.ok) return prepared;
      preparedGpuResources.set(resource.name, { kind: 'buffer', reference: prepared.value });
      continue;
    }
    const prepared = gpu.prepareTextureView(ownerName(resource.name), scene.view, scene.target);
    if (!prepared.ok) return prepared;
    preparedGpuResources.set(resource.name, { kind: 'texture-view', reference: prepared.value });
  }
  const namedBindingResources =
    native === undefined ? undefined : { buffers, resources: preparedGpuResources };
  for (const resource of byKind('compute-bindings')) {
    const program = computePrograms.get(resource.program);
    if (namedBindingResources !== undefined) {
      if (program === undefined || gpu === undefined) return err(planFailure(slot));
      const prepared = gpu.prepareNamedBindings(
        ownerName(resource.name),
        {
          program,
          entries: resource.entries,
        },
        namedBindingResources,
      );
      if (!prepared.ok) return prepared;
      computeBindings.set(resource.name, prepared.value);
      continue;
    }
    const entries = resource.entries.map((entry) => {
      const buffer = buffers.get(entry.resource);
      const range = {
        ...(entry.offset === undefined ? {} : { offset: entry.offset }),
        ...(entry.size === undefined ? {} : { size: entry.size }),
      };
      if (buffer !== undefined) return { binding: entry.binding, buffer, ...range } as const;
      const prepared = preparedGpuResources.get(entry.resource);
      return prepared === undefined
        ? undefined
        : ({ binding: entry.binding, resource: prepared, ...range } as const);
    });
    if (program === undefined || entries.some((entry) => entry === undefined)) {
      return err(planFailure(slot));
    }
    const prepared = gpu?.prepareBindings(ownerName(resource.name), {
      program,
      entries: entries as NonNullable<(typeof entries)[number]>[],
    });
    if (prepared === undefined) return err(planFailure(slot));
    if (!prepared.ok) return prepared;
    computeBindings.set(resource.name, prepared.value);
  }
  for (const resource of byKind('graphics-bindings')) {
    const program = graphicsPrograms.get(resource.program);
    if (program === undefined) return err(planFailure(slot));
    const values: Record<string, unknown> = { ...resource.values };
    for (const [key, targetName] of Object.entries(resource.logicalTargets ?? {})) {
      const target = targetHandle(targetName, targetsForResource(ownerName(resource.name)));
      if (target === undefined || typeof target === 'string') return err(planFailure(slot));
      values[key] = target;
    }
    const prepared = graphics.prepareBindings(ownerName(resource.name), {
      pipeline: program,
      values,
    });
    if (!prepared.ok) return prepared;
    graphicsBindings.set(resource.name, prepared.value);
  }
  for (const resource of byKind('vertex-data')) {
    const descriptor =
      resource.buffer === undefined
        ? { layout: resource.layout, data: resource.data }
        : {
            layout: resource.layout,
            buffer: buffers.get(resource.buffer),
            ...(resource.offset === undefined ? {} : { offset: resource.offset }),
            ...(resource.size === undefined ? {} : { size: resource.size }),
          };
    if ('buffer' in descriptor && descriptor.buffer === undefined) return err(planFailure(slot));
    const prepared = graphics.prepareVertexData(
      ownerName(resource.name),
      descriptor as import('./prepared-graphics').RenderFeatureVertexDataDescriptor,
    );
    if (!prepared.ok) return prepared;
    vertexData.set(resource.name, prepared.value);
  }
  for (const resource of byKind('index-data')) {
    const descriptor =
      resource.buffer === undefined
        ? { format: resource.format, data: resource.data }
        : {
            format: resource.format,
            buffer: buffers.get(resource.buffer),
            ...(resource.offset === undefined ? {} : { offset: resource.offset }),
            ...(resource.size === undefined ? {} : { size: resource.size }),
          };
    if ('buffer' in descriptor && descriptor.buffer === undefined) return err(planFailure(slot));
    const prepared = graphics.prepareIndexData(
      ownerName(resource.name),
      descriptor as import('./prepared-graphics').RenderFeatureIndexDataDescriptor,
    );
    if (!prepared.ok) return prepared;
    indexData.set(resource.name, prepared.value);
  }
  return ok({
    computePrograms,
    graphicsPrograms,
    buffers,
    preparedGpuResources,
    computeBindings,
    graphicsBindings,
    vertexData,
    indexData,
  });
}

function projectDraw(
  slot: FeatureSlot,
  draw: Extract<RenderFeaturePassDeclaration, { readonly kind: 'raster' }>['draws'][number],
  prepared: PreparedPlanResources,
): Result<import('./prepared-graphics').RenderFeatureDrawRecord, RenderError> {
  const pipeline = prepared.graphicsPrograms.get(draw.program);
  const bindings = draw.bindings.map((name) => prepared.graphicsBindings.get(name));
  const vertexData = draw.vertexData.map((entry) => ({
    slot: entry.slot,
    resource: prepared.vertexData.get(entry.resource),
  }));
  const indexData =
    draw.indexData === undefined
      ? undefined
      : {
          resource: prepared.indexData.get(draw.indexData.resource),
          format: draw.indexData.format,
        };
  if (
    pipeline === undefined ||
    bindings.some((binding) => binding === undefined) ||
    vertexData.some((vertex) => vertex.resource === undefined) ||
    (indexData !== undefined && indexData.resource === undefined)
  ) {
    return err(planFailure(slot));
  }
  const common = {
    enabled: draw.enabled,
    pipeline,
    bindings: bindings as readonly RenderFeaturePreparedRef<'bindings'>[],
    vertexData: vertexData as readonly {
      readonly slot: number;
      readonly resource: RenderFeaturePreparedRef<'vertex-data'>;
    }[],
    ...(draw.vertexLayout === undefined ? {} : { vertexLayout: draw.vertexLayout }),
  };
  switch (draw.draw.kind) {
    case 'draw':
      return ok({
        kind: 'draw',
        ...common,
        ...(indexData === undefined
          ? {}
          : {
              indexData: {
                resource: indexData.resource as RenderFeaturePreparedRef<'index-data'>,
                format: indexData.format,
              },
            }),
        command: {
          vertexCount: draw.draw.vertexCount,
          instanceCount: draw.draw.instanceCount,
          ...(draw.draw.firstVertex === undefined ? {} : { firstVertex: draw.draw.firstVertex }),
          ...(draw.draw.firstInstance === undefined
            ? {}
            : { firstInstance: draw.draw.firstInstance }),
        },
      });
    case 'draw-indexed':
      return ok({
        kind: 'draw-indexed',
        ...common,
        indexData:
          indexData === undefined
            ? undefined
            : {
                resource: indexData.resource as RenderFeaturePreparedRef<'index-data'>,
                format: indexData.format,
              },
        command: {
          indexCount: draw.draw.indexCount,
          instanceCount: draw.draw.instanceCount,
          ...(draw.draw.firstIndex === undefined ? {} : { firstIndex: draw.draw.firstIndex }),
          ...(draw.draw.baseVertex === undefined ? {} : { baseVertex: draw.draw.baseVertex }),
          ...(draw.draw.firstInstance === undefined
            ? {}
            : { firstInstance: draw.draw.firstInstance }),
        },
      });
    case 'draw-indirect':
    case 'draw-indexed-indirect': {
      const buffer = prepared.buffers.get(draw.draw.resource);
      if (buffer === undefined) return err(planFailure(slot));
      const command = {
        buffer,
        ...(draw.draw.offset === undefined ? {} : { offset: draw.draw.offset }),
      };
      if (draw.draw.kind === 'draw-indexed-indirect') {
        return ok({
          kind: 'draw-indexed-indirect',
          ...common,
          indexData:
            indexData === undefined
              ? undefined
              : {
                  resource: indexData.resource as RenderFeaturePreparedRef<'index-data'>,
                  format: indexData.format,
                },
          command,
        });
      }
      return ok({
        kind: 'draw-indirect',
        ...common,
        ...(indexData === undefined
          ? {}
          : {
              indexData: {
                resource: indexData.resource as RenderFeaturePreparedRef<'index-data'>,
                format: indexData.format,
              },
            }),
        command,
      });
    }
  }
}

function projectPlanPasses(
  slot: FeatureSlot,
  plan: RenderFeatureWorkPlan,
  prepared: PreparedPlanResources,
  gpu: RenderFeatureGpuPrepareSession | undefined,
  targets: readonly RenderFeatureTargetHandle[],
  validateGraphics: (
    descriptor: RenderFeatureGraphicsPassDescriptor,
    resources: readonly { readonly name: string }[],
  ) => Result<RenderFeaturePreparedGraphicsState, RenderError>,
  resolveGraphics?: (
    descriptor: RenderFeatureGraphicsPassDescriptor,
    passName: string,
  ) => Result<PreparedGraphicsResolvedSnapshot, RenderError> | undefined,
): Result<RenderFeaturePlanExecution, RenderError> {
  const logical = logicalTargets(targets);
  const projected: RenderFeaturePlanExecutionPass[] = [];
  for (const pass of plan.passes) {
    if (pass.kind === 'copy') {
      const resolve = (name: string) => {
        const borrowed = prepared.preparedGpuResources.get(name);
        const reference =
          prepared.buffers.get(name) ??
          (borrowed?.kind === 'buffer' ? borrowed.reference : undefined);
        return reference === undefined ? undefined : gpu?.resolveBuffer(reference);
      };
      const copies: NonNullable<RenderFeaturePlanExecutionPass['resolvedGpuCopies']>[number][] = [];
      for (const copy of pass.copies) {
        const source = resolve(copy.source),
          destination = resolve(copy.destination);
        const sourceOffset = copy.sourceOffset ?? 0,
          destinationOffset = copy.destinationOffset ?? 0;
        if (
          source === undefined ||
          destination === undefined ||
          source.buffer === destination.buffer ||
          (source.physicalUsage & GPU_BUFFER_USAGE_COPY_SRC) === 0 ||
          (destination.physicalUsage & GPU_BUFFER_USAGE_COPY_DST) === 0 ||
          copy.size > source.size - sourceOffset ||
          copy.size > destination.size - destinationOffset
        )
          return err(planFailure(slot));
        copies.push({
          enabled: copy.enabled,
          source,
          destination,
          size: copy.size,
          sourceOffset,
          destinationOffset,
        });
      }
      projected.push({
        enabled: pass.enabled,
        featureIdentity: slot.feature.identity,
        order: slot.order,
        name: pass.name,
        resolvedGpuCopies: copies,
      });
      continue;
    }
    if (pass.kind === 'compute') {
      const program = prepared.computePrograms.get(pass.program);
      const bindings = prepared.computeBindings.get(pass.bindings);
      if (program === undefined || bindings === undefined) return err(planFailure(slot));
      let missingBindings = false;
      const descriptor: RenderFeatureGpuComputePassDescriptor = {
        program,
        bindings,
        dispatches: pass.dispatches.map((dispatch) => {
          const name = dispatch.bindings;
          const dispatchBindings =
            name === undefined ? bindings : prepared.computeBindings.get(name);
          if (dispatchBindings === undefined) missingBindings = true;
          return dispatch.kind === 'direct'
            ? {
                entryPoint: dispatch.entryPoint,
                bindings: dispatchBindings ?? bindings,
                workgroups: dispatch.workgroups,
              }
            : {
                entryPoint: dispatch.entryPoint,
                bindings: dispatchBindings ?? bindings,
                indirect: {
                  buffer: prepared.buffers.get(dispatch.resource) as RenderFeatureGpuBufferRef,
                  offset: dispatch.offset,
                },
              };
        }),
      };
      if (
        missingBindings ||
        descriptor.dispatches.some(
          (dispatch) => dispatch.indirect !== undefined && dispatch.indirect.buffer === undefined,
        )
      ) {
        return err(planFailure(slot));
      }
      const resolved = gpu?.resolveComputePass(slot.feature.identity, descriptor);
      if (resolved === undefined) return err(planFailure(slot));
      if (!resolved.ok) return resolved;
      projected.push({
        enabled: pass.enabled,
        featureIdentity: slot.feature.identity,
        order: slot.order,
        name: pass.name,
        gpuCompute: descriptor,
        resolvedGpuCompute: resolved.value,
      });
      continue;
    }

    const draws: import('./prepared-graphics').RenderFeatureDrawRecord[] = [];
    for (const draw of pass.draws) {
      const projected = projectDraw(slot, draw, prepared);
      if (!projected.ok) return projected;
      draws.push(projected.value);
    }
    const fallbackFormat = (() => {
      const firstProgram = prepared.graphicsPrograms.get(pass.draws[0]?.program ?? '');
      const declaration = plan.resources.find(
        (resource) =>
          resource.kind === 'graphics-program' &&
          prepared.graphicsPrograms.get(resource.name) === firstProgram,
      );
      return declaration?.kind === 'graphics-program'
        ? declaration.program.colorFormats[0]
        : undefined;
    })();
    const colors = (pass.kind === 'raster' ? pass.colorAttachments : []).map((attachment) => ({
      resource: targetHandle(attachment.target, targets),
      format: targetFormat(attachment.target, logical, fallbackFormat),
      loadOp: attachment.loadOp,
      storeOp: attachment.storeOp,
    }));
    const depth =
      pass.kind !== 'raster' || pass.depthStencilAttachment === undefined
        ? undefined
        : {
            resource: targetHandle(pass.depthStencilAttachment.target, targets),
            format: targetFormat(pass.depthStencilAttachment.target, logical, undefined),
            depthLoadOp: pass.depthStencilAttachment.depthLoadOp,
            depthStoreOp: pass.depthStencilAttachment.depthStoreOp,
          };
    const sampledTargets = (pass.kind === 'raster' ? (pass.sampledTargets ?? []) : []).map((name) =>
      targetHandle(name, targets),
    );
    if (
      colors.some(
        (attachment) => attachment.resource === undefined || attachment.format === undefined,
      ) ||
      (depth !== undefined && (depth.resource === undefined || depth.format === undefined)) ||
      sampledTargets.some((target) => target === undefined || typeof target === 'string')
    ) {
      return err(planFailure(slot));
    }
    const attachments: RenderFeatureGraphicsPassDescriptor['attachments'] =
      depth === undefined
        ? { colors: colors as RenderFeatureGraphicsPassDescriptor['attachments']['colors'] }
        : {
            colors: colors as RenderFeatureGraphicsPassDescriptor['attachments']['colors'],
            depthStencil: depth as NonNullable<
              RenderFeatureGraphicsPassDescriptor['attachments']['depthStencil']
            >,
          };
    const descriptor: RenderFeatureGraphicsPassDescriptor = {
      attachments,
      ...(pass.kind !== 'raster' || pass.sceneDepth === undefined
        ? {}
        : { sceneDepth: pass.sceneDepth }),
      ...(sampledTargets.length === 0
        ? {}
        : {
            sampledTargets: sampledTargets as readonly RenderFeatureTargetHandle[],
          }),
      draws,
    };
    const graphicsState = validateGraphics(descriptor, []);
    if (!graphicsState.ok) return graphicsState;
    const resolved = resolveGraphics?.(descriptor, pass.name);
    if (
      resolved !== undefined &&
      !resolved.ok &&
      resolved.error instanceof RenderFeaturePreparationFailedError &&
      resolved.error.detail.reason === 'pipeline-pending'
    ) {
      continue;
    }
    if (resolved !== undefined && !resolved.ok) return resolved;
    projected.push({
      enabled: pass.enabled,
      featureIdentity: slot.feature.identity,
      order: slot.order,
      name: pass.name,
      graphics: descriptor,
      ...(pass.kind === 'shadow-caster' ? { shadowCaster: true as const } : {}),
      graphicsState: graphicsState.value,
      ...(resolved?.ok === true ? { resolvedGraphics: resolved.value } : {}),
    });
  }
  return ok({
    featureIdentity: slot.feature.identity,
    order: slot.order,
    ...(slot.feature.placement === undefined ? {} : { placement: slot.feature.placement }),
    passes: Object.freeze(projected),
  });
}

function invokeStage<T>(
  slot: FeatureSlot,
  stage: RenderFeatureStageEvent['stage'],
  action: () => Result<T, RenderError>,
  stageEvents: RenderFeatureStageEvent[],
  errors: RenderError[],
): Result<T, RenderError> {
  const identity = slot.feature.identity;
  stageEvents.push({ featureIdentity: identity, order: slot.order, stage });
  try {
    const result = action();
    if (result.ok) return result;
    recordFailure(slot, stage, result.error, errors);
    return err(result.error);
  } catch (failure) {
    recordFailure(slot, stage, failure, errors);
    return err(errors[errors.length - 1] as RenderError);
  }
}

class FeatureHostImpl implements RenderFeatureHost {
  private depthBatchInspection:
    | {
        frameNumber: number;
        generation: number;
        stage: 'prepared';
        scopes: number;
        beforePasses: number;
        afterPasses: number;
        removedRasterPasses: number;
        admittedPasses: number;
      }
    | undefined;
  private disposed = false;
  private generation = 0;
  private lastRecoveryFrame: number | undefined;
  private readonly diagnosticsListeners = new Set<() => void>();
  private readonly signatureByFeature = new Map<
    string,
    RenderFeatureHostInspection['signatures'][number]
  >();
  private readonly signatureCacheByFeature = new Map<
    string,
    Map<
      string,
      { readonly signature: string; readonly snapshot: RenderFeaturePlanSignatureSnapshot }
    >
  >();
  private readonly nativeExecutionSignatures = new Map<
    string,
    Map<string, { readonly execution: RenderFeaturePlanExecution; readonly signature: string }>
  >();

  /** Monotonic compact identity for a changed feature-plan snapshot. */
  private signatureRevision = 0;
  private readonly preparedInspection = {
    retained: 0,
    submitted: 0,
    released: 0,
    releaseFailures: 0,
  };
  private readonly preparedBatchStates = new WeakMap<
    RenderFeaturePreparedResourceBatch,
    'unsubmitted' | 'submitted'
  >();

  constructor(private readonly slots: FeatureSlot[]) {}

  get size(): number {
    return this.slots.length;
  }

  get preparedGeneration(): number {
    return this.generation;
  }

  get features(): readonly RenderFeature<unknown>[] {
    return this.slots.map((slot) => slot.feature);
  }

  retainPlanScopes(identity: string, scopes: readonly string[]): void {
    for (const cache of [
      this.signatureCacheByFeature.get(identity),
      this.nativeExecutionSignatures.get(identity),
    ])
      if (cache !== undefined)
        for (const scope of cache.keys()) if (!scopes.includes(scope)) cache.delete(scope);
  }

  recordNativeExecutionSignature(
    identity: string,
    execution: RenderFeaturePlanExecution,
    scope: string,
  ): string {
    const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());
    const started = now();
    let cache = this.nativeExecutionSignatures.get(identity);
    if (cache === undefined) {
      cache = new Map();
      this.nativeExecutionSignatures.set(identity, cache);
    }
    const previous = cache.get(scope);
    const hit =
      previous !== undefined &&
      sameRenderFeatureNativeExecutionTopology(previous.execution, execution);
    const signature = hit ? previous.signature : `native-revision-${++this.signatureRevision}`;
    if (!hit) cache.set(scope, { execution, signature });
    const prior = this.signatureByFeature.get(identity);
    this.signatureByFeature.set(identity, {
      featureIdentity: identity,
      calls: prior?.calls ?? 0,
      typedArrayBytes: prior?.typedArrayBytes ?? 0,
      outputChars: prior?.outputChars ?? 0,
      nativeCalls: (prior?.nativeCalls ?? 0) + 1,
      cpuMs: (prior?.cpuMs ?? 0) + now() - started,
      cacheHits: (prior?.cacheHits ?? 0) + (hit ? 1 : 0),
      cacheMisses: (prior?.cacheMisses ?? 0) + (hit ? 0 : 1),
    });
    return signature;
  }

  recordPlanSignature(identity: string, plan: RenderFeatureWorkPlan, scope = 'frame'): string {
    const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());
    const started = now();
    let cache = this.signatureCacheByFeature.get(identity);
    if (cache === undefined) {
      cache = new Map();
      this.signatureCacheByFeature.set(identity, cache);
    }
    const previous = cache.get(scope);
    // Snapshot capture already compares every declaration and returns the prior
    // root when unchanged. A separate whole-plan comparison would revisit the
    // unchanged prefix whenever a later VFX resource or pass changes.
    const snapshot = cloneOwnedRenderFeaturePlanSignatureSnapshot(plan, previous?.snapshot);
    if (previous !== undefined && snapshot === previous.snapshot) {
      const elapsed = now() - started;
      const priorInspection = this.signatureByFeature.get(identity);
      this.signatureByFeature.set(identity, {
        featureIdentity: identity,
        ...(priorInspection?.nativeCalls === undefined
          ? {}
          : { nativeCalls: priorInspection.nativeCalls }),
        calls: priorInspection?.calls ?? 0,
        typedArrayBytes: priorInspection?.typedArrayBytes ?? 0,
        outputChars: priorInspection?.outputChars ?? 0,
        cpuMs: (priorInspection?.cpuMs ?? 0) + elapsed,
        cacheHits: (priorInspection?.cacheHits ?? 0) + 1,
        cacheMisses: priorInspection?.cacheMisses ?? 0,
      });
      // The graph validator receives a fresh plan object every frame. Reuse
      // is safe only because it will perform the same exact structural check
      // against this detached snapshot.
      rememberRenderFeaturePlanSignature(plan, previous.signature, previous.snapshot);
      return previous.signature;
    }
    // A changed plan usually mutates a small VFX membership/pass leaf.  Keep
    // the previous detached evidence as a sharing source so unchanged
    // resource/program subtrees remain immutable and allocation-free; the
    // candidate snapshot is still a fresh root and is revalidated by graph
    // admission exactly as before.
    // Keep one canonical spelling for the initial diagnostic/API observation.
    // Subsequent changes only need a compact monotonic identity: the detached
    // snapshot remains the exact structural proof and avoids rebuilding
    // megabytes of text for every VFX plan revision.
    const metrics: RenderFeaturePlanSignatureMetrics = {
      calls: 0,
      typedArrayBytes: 0,
      outputChars: 0,
    };
    const signature =
      previous === undefined
        ? renderFeaturePlanSignature(plan, metrics)
        : `revision-${++this.signatureRevision}`;
    cache.set(scope, { signature, snapshot });
    rememberRenderFeaturePlanSignature(plan, signature, snapshot);
    const elapsed = now() - started;
    const priorInspection = this.signatureByFeature.get(identity);
    this.signatureByFeature.set(identity, {
      featureIdentity: identity,
      ...(priorInspection?.nativeCalls === undefined
        ? {}
        : { nativeCalls: priorInspection.nativeCalls }),
      calls: (priorInspection?.calls ?? 0) + metrics.calls,
      typedArrayBytes: (priorInspection?.typedArrayBytes ?? 0) + metrics.typedArrayBytes,
      outputChars: (priorInspection?.outputChars ?? 0) + metrics.outputChars,
      cpuMs: (priorInspection?.cpuMs ?? 0) + elapsed,
      cacheHits: priorInspection?.cacheHits ?? 0,
      cacheMisses: (priorInspection?.cacheMisses ?? 0) + 1,
    });
    return signature;
  }

  inspection(): RenderFeatureHostInspection {
    return Object.freeze({
      ...(this.depthBatchInspection === undefined
        ? {}
        : { featureReadOnlyDepthBatchDiagnostic: Object.freeze({ ...this.depthBatchInspection }) }),
      signatures: Object.freeze(
        [...this.signatureByFeature.values()]
          .sort((left, right) => left.featureIdentity.localeCompare(right.featureIdentity))
          .map((entry) => Object.freeze({ ...entry })),
      ),
      prepared: Object.freeze({ ...this.preparedInspection }),
    });
  }

  beginDepthBatchInspection(frameNumber: number | undefined, generation: number): void {
    this.depthBatchInspection =
      frameNumber === undefined
        ? undefined
        : {
            frameNumber,
            generation,
            stage: 'prepared',
            scopes: 0,
            beforePasses: 0,
            afterPasses: 0,
            removedRasterPasses: 0,
            admittedPasses: 0,
          };
  }

  recordDepthBatchInspection(before: number, after: number, admitted: number): void {
    const stats = this.depthBatchInspection;
    if (stats === undefined) return;
    stats.scopes++;
    stats.beforePasses += before;
    stats.afterPasses += after;
    stats.removedRasterPasses += before - after;
    stats.admittedPasses += admitted;
  }

  createRecoveryRoot(scope: DeviceScope): LifecycleResourceSpec<unknown> {
    return {
      kind: 'feature',
      create: () => {
        if (!scope.isAlive()) throw new Error('Feature candidate scope is not active.');
        // The root carries the detached host owner itself. A scalar marker is
        // not evidence that feature planning/preparation actually ran; the
        // candidate graph and host own the prepared resources.
        return this;
      },
      cleanup: () => undefined,
    };
  }

  private publishDiagnosticsChanged(): void {
    for (const listener of this.diagnosticsListeners) {
      try {
        listener();
      } catch {
        // Diagnostics are a projection of renderer state. An observer failure
        // must not alter an already-applied feature lifecycle transition.
      }
    }
  }

  install(feature: RenderFeature<unknown>): Result<void, RenderError> {
    if (this.disposed) return err(unknownFeatureError(feature.identity, 'dispose'));
    const existingOrder = this.slots.findIndex(
      (slot) => slot.feature.identity === feature.identity,
    );
    if (existingOrder >= 0) {
      const existing = this.slots[existingOrder];
      if (existing?.feature === feature) return ok(undefined);
      return err(registrationConflict(feature.identity, this.slots.length, existingOrder));
    }
    this.slots.push({
      feature,
      order: this.slots.length,
      preparedResourceBatches: new Set(),
      preparedStore: createPreparedGraphicsStore(),
      status: 'active',
      latestError: undefined,
    });
    this.publishDiagnosticsChanged();
    return ok(undefined);
  }

  uninstall(feature: RenderFeature<unknown>): Result<void, RenderError> {
    if (this.disposed) return err(unknownFeatureError(feature.identity, 'dispose'));
    const index = this.slots.findIndex((slot) => slot.feature === feature);
    if (index < 0) return ok(undefined);
    const slot = this.slots[index];
    if (slot === undefined) return ok(undefined);

    let firstError: RenderError | undefined;
    for (const batch of slot.preparedResourceBatches) {
      const result = batch.release();
      if (!result.ok && firstError === undefined) firstError = result.error;
    }
    slot.status = 'disposed';
    this.slots.splice(index, 1);
    this.signatureByFeature.delete(feature.identity);
    this.signatureCacheByFeature.delete(feature.identity);
    this.nativeExecutionSignatures.delete(feature.identity);
    for (const [order, remaining] of this.slots.entries()) remaining.order = order;
    this.publishDiagnosticsChanged();
    return firstError === undefined ? ok(undefined) : err(firstError);
  }

  advancePreparedGeneration(): number {
    if (this.disposed) return this.generation;
    this.depthBatchInspection = undefined;
    this.generation += 1;
    for (const slot of this.slots) {
      slot.preparedStore.invalidate(slot.feature.identity, this.generation);
    }
    this.lastRecoveryFrame = undefined;
    return this.generation;
  }

  setStatus(
    identity: string,
    status: RenderFeatureStatus,
    latestError?: RenderFeatureErrorDescriptor,
  ): Result<void, RenderError> {
    const slot = findSlot(this.slots, identity);
    if (slot === undefined || this.disposed || slot.status === 'disposed') {
      return err(unknownFeatureError(identity, 'recover'));
    }
    if (slot.status === status && slot.latestError === undefined && latestError === undefined) {
      return ok(undefined);
    }
    slot.status = status;
    slot.latestError = latestError === undefined ? undefined : freezeError(latestError);
    this.publishDiagnosticsChanged();
    return ok(undefined);
  }

  recordError(identity: string, error: RenderError): RenderError {
    const slot = findSlot(this.slots, identity);
    if (slot === undefined || this.disposed || slot.status === 'disposed') return error;
    const owned = featureErrorForSlot(slot, error);
    slot.status = 'failed';
    slot.latestError = errorDescriptor(owned);
    this.publishDiagnosticsChanged();
    return owned;
  }

  beginPreparedFrame(
    identity: string,
    generation: number,
  ): PreparedGraphicsTransaction | undefined {
    const slot = findSlot(this.slots, identity);
    if (slot === undefined || this.disposed || slot.status === 'disposed') return undefined;
    if (generation > this.generation) this.generation = generation;
    return slot.preparedStore.beginFrame(identity, this.generation);
  }

  retainPreparedGraphics(
    identity: string,
    leases: readonly PreparedGraphicsResourceLease[],
  ): Result<RenderFeaturePreparedResourceBatch, RenderError> {
    const slot = findSlot(this.slots, identity);
    if (slot === undefined || this.disposed || slot.status === 'disposed') {
      return err(unknownFeatureError(identity, 'dispose'));
    }
    if (leases.length === 0) {
      return ok({ release: () => ok(undefined) });
    }
    let released = false;
    let batch!: RenderFeaturePreparedResourceBatch;
    batch = {
      release: () => {
        if (released) return ok(undefined);
        released = true;
        this.preparedBatchStates.delete(batch);
        slot.preparedResourceBatches.delete(batch);
        let firstError: RenderError | undefined;
        for (const lease of leases) {
          const result = lease.release();
          if (!result.ok && firstError === undefined) firstError = result.error;
        }
        this.preparedInspection.released += 1;
        if (firstError !== undefined) this.preparedInspection.releaseFailures += 1;
        return firstError === undefined ? ok(undefined) : err(firstError);
      },
    };
    this.preparedBatchStates.set(batch, 'unsubmitted');
    slot.preparedResourceBatches.add(batch);
    this.preparedInspection.retained += 1;
    return ok(batch);
  }

  markPreparedGraphicsSubmitted(batches: readonly RenderFeaturePreparedResourceBatch[]): void {
    for (const batch of batches) {
      if (this.preparedBatchStates.get(batch) === 'unsubmitted') {
        this.preparedBatchStates.set(batch, 'submitted');
        this.preparedInspection.submitted += 1;
      }
    }
  }

  retirePreparedGraphics(
    batches?: readonly RenderFeaturePreparedResourceBatch[],
  ): Result<void, RenderError> {
    const owned = batches ?? this.slots.flatMap((slot) => [...slot.preparedResourceBatches]);
    let firstError: RenderError | undefined;
    for (const batch of owned) {
      const state = this.preparedBatchStates.get(batch);
      if (state === undefined || (batches === undefined && state === 'submitted')) continue;
      if (batches !== undefined && state !== 'submitted') continue;
      const result = batch.release();
      if (!result.ok && firstError === undefined) firstError = result.error;
    }
    return firstError === undefined ? ok(undefined) : err(firstError);
  }

  recoverPreparedGraphics(
    batches: readonly RenderFeaturePreparedResourceBatch[],
  ): Result<void, RenderError> {
    let firstError: RenderError | undefined;
    for (const batch of batches) {
      if (this.preparedBatchStates.get(batch) !== 'submitted') continue;
      const result = batch.release();
      if (!result.ok && firstError === undefined) firstError = result.error;
    }
    return firstError === undefined ? ok(undefined) : err(firstError);
  }

  recover(input: RenderFeatureRecoverInput): Result<void, RenderError> {
    if (this.disposed) return err(unknownFeatureError('render-feature-host', 'recover'));
    if (this.lastRecoveryFrame === input.frameNumber) return ok(undefined);
    const retired = this.retirePreparedGraphics();
    this.advancePreparedGeneration();
    this.lastRecoveryFrame = input.frameNumber;
    const firstError: RenderError | undefined = retired.ok ? undefined : retired.error;
    let diagnosticsChanged = false;
    for (const slot of this.slots) {
      if (slot.status === 'disposed') continue;
      // Replacement capabilities admit actual work at the next plan. Recovery
      // cannot infer a demand from an optional feature's declaration alone.
      if (slot.status !== 'active' || slot.latestError !== undefined) {
        slot.status = 'active';
        slot.latestError = undefined;
        diagnosticsChanged = true;
      }
    }
    if (diagnosticsChanged) this.publishDiagnosticsChanged();
    return firstError === undefined ? ok(undefined) : err(firstError);
  }

  diagnostics(): readonly RenderFeatureDiagnostics[] {
    return Object.freeze(this.slots.map(freezeDiagnostics));
  }

  /** Retain only an explicitly producer-published detached inspection value. */
  setInspection(identity: string, inspection: unknown): void {
    const slot = findSlot(this.slots, identity);
    if (slot === undefined || slot.status === 'disposed') return;
    slot.latestInspection = inspection;
  }

  subscribeDiagnostics(listener: () => void): () => void {
    this.diagnosticsListeners.add(listener);
    return () => this.diagnosticsListeners.delete(listener);
  }

  dispose(): Result<void, RenderError> {
    if (this.disposed) return ok(undefined);
    this.depthBatchInspection = undefined;
    this.disposed = true;

    const retired = this.retirePreparedGraphics();
    const firstError: RenderError | undefined = retired.ok ? undefined : retired.error;
    for (const slot of this.slots) {
      slot.status = 'disposed';
    }
    this.publishDiagnosticsChanged();
    this.diagnosticsListeners.clear();

    return firstError === undefined ? ok(undefined) : err(firstError);
  }
}

export interface RenderFeatureFrameBatch {
  readonly frame: RenderFeatureFrameResult;
  readonly views: ReadonlyMap<string, RenderFeatureFrameResult>;
  readonly preparedResourceBatches: readonly RenderFeaturePreparedResourceBatch[];
  /** Seal a detached recovery allocation without acknowledging unrecorded work. */
  readonly commitPreparedResources: () => void;
  readonly onSubmitted: () => void;
  readonly onAborted: () => void;
}

/** Extract, plan and prepare each Feature once for the complete Renderer frame. */
export function runRenderFeatureFrame(
  host: RenderFeatureHost,
  inputs: readonly RenderFeatureFrameInput[],
): RenderFeatureFrameBatch {
  const input = inputs[0];
  if (input === undefined) throw new Error('a Feature frame requires its complete view roster');
  host.beginDepthBatchInspection?.(
    input.featureReadOnlyDepthBatchDiagnostic === true ? input.frameNumber : undefined,
    input.generation ?? 0,
  );
  let preparationPendingFeatureIdentity: string | undefined;
  let preparationPendingReason: FramePresentationPendingReason | undefined;
  // Capture only at the existing first blocker. Never consult a later inspection
  // or serialize a complete program/plan to explain a receipt.
  const markPreparationPending = (
    identity: string,
    preparationStage: NonNullable<FramePresentationPendingReason['preparationStage']>,
    error?: unknown,
    graphics?: { readonly pass: string; readonly shader?: string },
  ) => {
    if (preparationPendingFeatureIdentity !== undefined) return;
    preparationPendingFeatureIdentity = identity;
    const detail = error instanceof RenderFeaturePreparationFailedError ? error.detail : undefined;
    preparationPendingReason = Object.freeze({
      code: 'feature-preparation',
      featureIdentity: identity.slice(0, 256),
      preparationStage,
      ...(detail === undefined
        ? {}
        : {
            resource: detail.resourceName.slice(0, 256),
            operation: detail.operation.slice(0, 64),
            reason: detail.reason.slice(0, 128),
          }),
      ...(graphics === undefined
        ? {}
        : {
            pass: graphics.pass.slice(0, 256),
            ...(graphics.shader === undefined ? {} : { shader: graphics.shader.slice(0, 256) }),
          }),
    });
  };
  const stageEvents: RenderFeatureStageEvent[] = [];
  const errors: RenderError[] = [];
  const preparedResourceBatches: RenderFeaturePreparedResourceBatch[] = [];
  const submittedWorks = new Set<RenderFeaturePlannedFrame>();
  const callbacks: { commitResources: () => void; submit: () => void; abort: () => void }[] = [];
  const results = new Map<string, RenderFeatureFrameResult>();
  const postProcessIdentities = new Set<string>();
  const featureHiddenEntityReports: RenderFeatureHiddenEntityReport[] = [];
  const makeResult = (key: string): RenderFeatureFrameResult => {
    const plans: RenderFeaturePlannedFrame[] = [];
    const fullscreenEffects = new Map<string, PostProcessShaderEntry>();
    const hiddenEntityReports: RenderFeatureHiddenEntityReport[] = [];
    const result: RenderFeatureFrameResult = {
      stageEvents,
      errors,
      plans,
      fullscreenEffects,
      hiddenEntityReports,
      postProcessIdentities: [],
      preparedResourceBatches: [],
      requiresPreparedResourceKey: false,
      onSubmitted: () => {
        for (const plan of plans) submittedWorks.add(plan);
      },
      onAborted: () => {},
    };
    results.set(key, result);
    return result;
  };
  const shared = makeResult('frame');
  for (const view of inputs) {
    if (results.has(featureScopeKey({ view: view.identity })))
      throw new Error('duplicate render view identity');
    const result = makeResult(featureScopeKey({ view: view.identity }));
    (result.hiddenEntityReports as RenderFeatureHiddenEntityReport[]).push(
      ...(view.hiddenEntityReports ?? []),
    );
  }
  const heldResourcePrefixes = inputs
    .filter((view) => !view.render)
    .map((view) => `${JSON.stringify([featureScopeKey({ view: view.identity })]).slice(0, -1)},`);
  const belongsToHeldView = (name: string) =>
    heldResourcePrefixes.some((prefix) => name.startsWith(prefix));
  const diagnostics = host.diagnostics();
  for (const [order, feature] of host.features.entries()) {
    const diagnostic = diagnostics[order];
    if (diagnostic?.status === 'disposed') continue;
    if (
      diagnostic?.status === 'disabled' &&
      (diagnostic.latestError?.code !== 'render-feature-capability-missing' ||
        missingCapability(feature, input.caps) === undefined)
    )
      continue;
    const slot: FeatureSlot = {
      feature,
      order,
      preparedResourceBatches: new Set(),
      preparedStore: createPreparedGraphicsStore(),
      status: 'active',
      latestError: undefined,
    };
    const identity = feature.identity;
    const transaction = host.beginPreparedFrame(
      identity,
      input.generation ?? host.preparedGeneration,
    );
    if (transaction === undefined) continue;
    const gpu = input.gpuWork?.beginFeature(
      identity,
      input.generation ?? 0,
      feature.shaderModuleMode,
    );
    const abortResources = () => {
      drainFeatureFinalizers([
        () => transaction.abort(),
        () => {
          const aborted = gpu?.abortFrame();
          if (aborted !== undefined && !aborted.ok) errors.push(aborted.error);
        },
      ]);
    };
    // A rejected producer must return its failure as data so already prepared
    // siblings still reach the Renderer submission/abort barrier.
    const cleanupPreparation = (actions: readonly (() => void)[], stage: 'extract' | 'plan') => {
      try {
        drainFeatureFinalizers(actions);
      } catch (cause) {
        recordFailure(slot, stage, cause, errors);
      }
    };
    const reports: RenderFeatureHiddenEntityReport[] = [];
    const extracted = invokeStage(
      slot,
      'extract',
      () => {
        const published = input.publishedFeatures?.find((row) => row.identity === identity);
        return published === undefined
          ? feature.extract({
              worlds: input.worlds,
              owner: input.owner,
              frameNumber: input.frameNumber,
              caps: input.caps,
              ...renderMaterialContext(input.caps, input.limits),
              views: inputs.map((view) => ({
                identity: view.identity,
                render: view.render,
                ...(view.selectedCamera === undefined
                  ? {}
                  : { selectedCamera: view.selectedCamera }),
                ...(view.selectedView === undefined ? {} : { selectedView: view.selectedView }),
                ...(view.frame === undefined ? {} : { frame: view.frame }),
                ...(view.frameSize === undefined ? {} : { frameSize: view.frameSize }),
                ...(view.motionBlur === undefined ? {} : { motionBlur: view.motionBlur }),
              })),
              ...(input.visibilitySnapshots === undefined
                ? {}
                : { visibilitySnapshots: input.visibilitySnapshots }),
              reportHiddenEntity: (report) => reports.push(report),
            })
          : ok(published.data);
      },
      stageEvents,
      errors,
    );
    if (!extracted.ok) {
      cleanupPreparation([abortResources], 'extract');
      host.setStatus(identity, 'failed', slot.latestError);
      continue;
    }
    const publishInspection = () => {
      if (
        typeof extracted.value === 'object' &&
        extracted.value !== null &&
        'inspection' in extracted.value
      )
        host.setInspection(identity, (extracted.value as { inspection?: unknown }).inspection);
    };
    const views = inputs.map((view) => ({
      identity: view.identity,
      render: view.render,
      frame: { frameNumber: input.frameNumber, ...view.frameSize },
      ...(view.selectedView === undefined ? {} : { selectedView: view.selectedView }),
      targets: logicalTargets(view.targets ?? []),
      sceneData:
        view.sceneData ??
        createSceneDataCatalog({
          featureIdentity: identity,
          generation: transaction.generation,
          planIdentity: `${identity}:${view.identity}:${transaction.generation}`,
          rgba16floatRenderable: input.caps.rgba16floatRenderable === true,
        }),
    }));
    let sourceRequiresPreparation = false;
    const nativeAdmissions = new Map<
      RenderFeatureNativeResourceAdmission,
      ReturnType<typeof createNativeResourceAdmission>
    >();
    try {
      sourceRequiresPreparation = feature.requiresPreparation?.(extracted.value) === true;
    } catch (cause) {
      // A declared readiness guard cannot fail open before plan resources exist.
      markPreparationPending(identity, 'source-guard');
      recordFailure(slot, 'plan', cause, errors);
      cleanupPreparation(
        [
          () => input.sceneResources?.abortFeature(identity),
          abortResources,
          () => feature.onFrameAborted?.(extracted.value),
        ],
        'plan',
      );
      host.setStatus(identity, 'failed', slot.latestError);
      continue;
    }
    let nativePlanningOpen = true;
    const declared = invokeStage(
      slot,
      'plan',
      () =>
        feature.plan(extracted.value, {
          getFeatureShaderSource: input.getFeatureShaderSource,
          resolveAsset:
            input.resolveAsset ??
            ((index, handle, revision) => {
              const world = input.worlds[index];
              return world === undefined
                ? err(new Error(`Missing feature asset source ${index}`))
                : runtimeAssets(world.assets).resolveAsset(handle, revision);
            }),
          caps: input.caps,
          ...(input.limits === undefined ? {} : { limits: input.limits }),
          ...renderMaterialContext(input.caps, input.limits),
          frame: { frameNumber: input.frameNumber },
          generation: transaction.generation,
          createNativePlan: () => {
            const retained =
              gpu === undefined || missingCapability(feature, input.caps) !== undefined
                ? undefined
                : createNativeResourceAdmission({
                    gpu,
                    frame: input.frameNumber,
                    isActive: () => nativePlanningOpen,
                    prepare: (resources, keys, inherited) =>
                      preparePlanResources(
                        slot,
                        { resources, passes: [] },
                        createPreparedGraphicsPrepare(transaction, true),
                        gpu,
                        () => [],
                        input.sceneResources,
                        { keys, admission: inherited },
                      ),
                  });
            const builder = createRenderFeatureNativePlanBuilder(
              {
                featureIdentity: identity,
                frameNumber: input.frameNumber,
                generation: transaction.generation,
                transaction,
                views,
              },
              retained?.admission,
            );
            if (retained !== undefined && builder.resourceAdmission !== undefined)
              nativeAdmissions.set(builder.resourceAdmission, retained);
            return builder;
          },
          views,
          ...(input.materialShaderBindingContract === undefined
            ? {}
            : { materialShaderBindingContract: input.materialShaderBindingContract }),
        }),
      stageEvents,
      errors,
    );
    nativePlanningOpen = false;
    const resolvers: PreparedGraphicsResolver[] = [];
    const featurePlans: RenderFeaturePlannedFrame[] = [];
    const projections: {
      planned: RenderFeaturePlannedFrame;
      projected: RenderFeaturePlanExecution;
      result: RenderFeatureFrameResult;
      effects: Map<string, PostProcessShaderEntry>;
      requiresGraphRebuild: boolean;
    }[] = [];
    let nativeWork: readonly import('./plan').RenderFeatureWork[] | undefined;
    let nativeFailure: unknown;
    // The private wrapper identity is the protocol. Raw author objects never
    // acquire a new property read (including an unknown `native` accessor).
    if (declared.ok && isRenderFeatureNativePlan(declared.value)) {
      try {
        nativeWork = consumeRenderFeatureNativePlan(declared.value, {
          featureIdentity: identity,
          frameNumber: input.frameNumber,
          generation: transaction.generation,
          transaction,
          views,
        });
        if (nativeWork === undefined)
          nativeFailure = new Error('Invalid native Feature frame authority');
      } catch (cause) {
        nativeFailure = cause;
      }
    }
    const declaredWork = nativeWork ?? (declared.ok ? declared.value.work : []);
    const nativeAdmission =
      declared.ok && nativeWork !== undefined
        ? renderFeatureNativeResourceAdmission(declared.value)
        : undefined;
    const admittedResources =
      nativeAdmission === undefined ? undefined : nativeAdmissions.get(nativeAdmission);
    let nativeRequiresPreparation = false;
    for (const admission of nativeAdmissions.values()) {
      nativeRequiresPreparation ||= admission.requestsPreparation();
      for (const scope of admission.usedScopes())
        if (
          admission !== admittedResources ||
          !declaredWork.some((work) => featureScopeKey(work.scope) === scope)
        )
          nativeFailure = new Error('Native resource admission must finish its exact work scopes');
    }
    const requiresPreparation =
      sourceRequiresPreparation ||
      nativeRequiresPreparation ||
      (declared.ok &&
        declaredWork.some((work) =>
          work.resources.some(
            (resource) =>
              (resource.kind === 'graphics-program' &&
                resource.program.preparePipelines === true) ||
              (resource.kind === 'compute-program' && resource.preparePipelines === true),
          ),
        ));
    const fail = (
      error?: unknown,
      pendingError: unknown = error,
      stage: NonNullable<
        FramePresentationPendingReason['preparationStage']
      > = pendingError instanceof RenderFeaturePreparationFailedError
        ? 'resource-preparation'
        : 'plan-projection',
    ) => {
      if (requiresPreparation) markPreparationPending(identity, stage, pendingError);
      if (error !== undefined) recordFailure(slot, 'plan', error, errors);
      cleanupPreparation(
        [
          () => input.sceneResources?.abortFeature(identity),
          abortResources,
          ...resolvers.map((resolver) => () => {
            const released = resolver.release();
            if (!released.ok) throw released.error;
          }),
          () => feature.onFrameAborted?.(extracted.value),
        ],
        'plan',
      );
      host.setStatus(identity, 'failed', slot.latestError);
    };
    if (!declared.ok) {
      fail(
        undefined,
        declared.error,
        declared.error instanceof RenderFeaturePreparationFailedError
          ? nativeRequiresPreparation
            ? 'native-admission'
            : 'resource-preparation'
          : 'source-plan',
      );
      continue;
    }
    if (nativeFailure !== undefined) {
      fail(nativeFailure);
      continue;
    }
    try {
      publishInspection();
      const workResources =
        nativeWork === undefined
          ? resolveFeatureWorkResources(declaredWork)
          : resolveNativeFeatureWorkResources(nativeWork);
      host.retainPlanScopes?.(
        identity,
        workResources.map((row) => featureScopeKey(row.work.scope)),
      );
      const targetInputs = new Map<string, readonly RenderFeatureTargetHandle[]>();
      for (const row of workResources) {
        const workScope = row.work.scope;
        if (workScope !== 'frame' && row.work.resources.some(isRenderFeatureSceneResource))
          throw new Error('Scene inputs belong to frame-scoped work');
        const view =
          workScope === 'frame'
            ? undefined
            : inputs.find((view) => view.identity === workScope.view);
        if (row.work.scope !== 'frame' && view === undefined)
          throw new Error('Feature work references a missing view');
        if (view?.render === false && row.work.passes.length > 0)
          throw new Error('held views cannot declare render work');
        if (nativeWork === undefined) {
          const frozen = freezeRenderFeaturePlan(
            identity,
            row.closure,
            logicalTargets(view?.targets ?? []),
          );
          if (!frozen.ok) throw frozen.error;
        }
        for (const resource of row.resources) {
          const name = row.native ? row.keys.get(resource.name) : resource.name;
          if (name === undefined) throw new Error('Missing native resource namespace');
          targetInputs.set(name, view?.targets ?? []);
        }
      }
      const missing = missingCapability(feature, input.caps);
      if (missing !== undefined && workResources.some((row) => hasActivePlan(row.closure))) {
        if (requiresPreparation) markPreparationPending(identity, 'capability');
        const failure = new RenderFeatureCapabilityMissingError(identity, order, missing);
        errors.push(failure);
        cleanupPreparation(
          [abortResources, () => feature.onFrameAborted?.(extracted.value)],
          'plan',
        );
        host.setStatus(identity, 'disabled', errorDescriptor(failure));
        continue;
      }
      const prepared =
        nativeWork === undefined
          ? preparePlanResources(
              slot,
              { resources: workResources.flatMap((row) => row.resources), passes: [] },
              createPreparedGraphicsPrepare(transaction),
              gpu,
              (name) => targetInputs.get(name) ?? [],
              input.sceneResources,
            )
          : undefined;
      if (prepared !== undefined && !prepared.ok) throw prepared.error;
      let sharedPrepared: PreparedPlanResources | undefined;
      let scopeResources: ReturnType<typeof createPreparedResourceScopes> | undefined;
      for (const row of workResources) {
        const scope = row.work.scope;
        const viewInput =
          scope === 'frame' ? undefined : inputs.find((view) => view.identity === scope.view);
        const result = results.get(featureScopeKey(scope));
        if (result === undefined) throw new Error('unregistered Feature work scope');
        const effects = new Map<string, PostProcessShaderEntry>();
        for (const resource of row.closure.resources) {
          if (resource.kind !== 'fullscreen-program') continue;
          const { kind: _kind, name, ...entry } = resource;
          effects.set(name, entry);
          if (!effects.has(identity)) effects.set(identity, entry);
        }
        let scoped: PreparedPlanResources;
        if (row.native) {
          const admission = admittedResources?.prepared(scope);
          const localPrepared = preparePlanResources(
            slot,
            { resources: row.resources, passes: [] },
            createPreparedGraphicsPrepare(transaction, true),
            gpu,
            (name) => targetInputs.get(name) ?? [],
            input.sceneResources,
            {
              keys: row.keys,
              ...(sharedPrepared === undefined ? {} : { shared: sharedPrepared }),
              ...(admission === undefined ? {} : { admission }),
            },
          );
          if (!localPrepared.ok) throw localPrepared.error;
          scoped = localPrepared.value;
          if (scope === 'frame') sharedPrepared = scoped;
        } else {
          if (prepared === undefined || !prepared.ok)
            throw new Error('Missing raw Feature preparation');
          if (scopeResources === undefined)
            scopeResources = createPreparedResourceScopes(prepared.value);
          scoped = scopeResources(row.keys);
        }
        const resolver = (viewInput ?? input).createPreparedGraphicsResolver?.({
          featureIdentity: identity,
          order,
          generation: transaction.generation,
          ...(feature.shaderModuleMode === undefined
            ? {}
            : { shaderModuleMode: feature.shaderModuleMode }),
          transaction,
          fullscreenEffects: effects,
          lookup: (reference) => transaction.lookup(reference),
        });
        if (resolver !== undefined) resolvers.push(resolver);
        let projectionPlan = row.closure;
        if (
          row.native &&
          scope !== 'frame' &&
          viewInput?.featureReadOnlyDepthBatchDiagnostic === true &&
          resolver !== undefined &&
          renderFeatureNativeDepthBatchPermission(declared.value)
        ) {
          const readOnlyPrograms = new Set<string>();
          for (const [name, reference] of scoped.graphicsPrograms) {
            const descriptor = transaction.lookup(reference)?.descriptor;
            if (
              descriptor?.kind !== 'pipeline' ||
              descriptor.renderState?.depthWriteEnabled !== false ||
              descriptor.renderState.stencil !== undefined
            )
              continue;
            const current = resolver.resolve(reference);
            if (
              current.ok &&
              current.value.kind === 'pipeline' &&
              current.value.writesDepth === false
            )
              readOnlyPrograms.add(name);
          }
          projectionPlan = {
            ...projectionPlan,
            passes: coalesceNativeReadOnlyDepthPasses(projectionPlan.passes, readOnlyPrograms),
          };
        }
        const projected = projectPlanPasses(
          slot,
          projectionPlan,
          scoped,
          gpu,
          viewInput?.targets ?? [],
          graphicsValidator(identity, transaction, true),
          resolver === undefined
            ? undefined
            : (descriptor, passName) =>
                resolveGraphicsSnapshot(
                  resolver,
                  descriptor,
                  transaction.generation,
                  (name) => {
                    const owned = scoped.buffers.get(name);
                    const borrowed = scoped.preparedGpuResources.get(name);
                    const reference =
                      owned ?? (borrowed?.kind === 'buffer' ? borrowed.reference : undefined);
                    return reference === undefined ? undefined : gpu?.resolveBuffer(reference);
                  },
                  row.native === true,
                  (reference, error) => {
                    if (
                      preparationPendingFeatureIdentity !== undefined ||
                      !requiresPreparation ||
                      !(error instanceof RenderFeaturePreparationFailedError) ||
                      error.detail.reason !== 'pipeline-pending'
                    )
                      return;
                    const item = transaction.lookup(reference);
                    markPreparationPending(identity, 'graphics-pipeline', error, {
                      pass: passName,
                      ...(item?.descriptor?.kind === 'pipeline'
                        ? { shader: item.descriptor.shader }
                        : {}),
                    });
                  },
                ),
        );
        if (!projected.ok) throw projected.error;
        if (
          row.native &&
          scope !== 'frame' &&
          viewInput?.featureReadOnlyDepthBatchDiagnostic === true
        )
          host.recordDepthBatchInspection?.(
            row.closure.passes.length,
            projectionPlan.passes.length,
            projected.value.passes.length,
          );
        if (requiresPreparation && projected.value.passes.length !== projectionPlan.passes.length)
          markPreparationPending(identity, 'plan-projection');
        if (scope === 'frame' && projected.value.passes.length !== row.work.passes.length)
          throw new RenderFeaturePreparationFailedError(
            identity,
            order,
            'frame',
            'pipeline',
            'shared-work',
            'pipeline-pending',
            'next-frame',
          );
        const scopeKey = featureScopeKey(scope);
        const planned: RenderFeaturePlannedFrame = Object.freeze({
          featureIdentity: identity,
          scope,
          generation: transaction.generation,
          signature: row.native
            ? (host.recordNativeExecutionSignature?.(
                identity,
                { ...projected.value, scope: scopeKey },
                scopeKey,
              ) ?? renderFeaturePlanSignature(projectionPlan))
            : (host.recordPlanSignature?.(identity, row.closure, scopeKey) ??
              renderFeaturePlanSignature(row.closure)),
          plan: projectionPlan,
          ...(feature.placement === undefined ? {} : { placement: feature.placement }),
          ...(feature.viewGraph === undefined ? {} : { viewGraph: feature.viewGraph }),
        });
        featurePlans.push(planned);
        projections.push({
          planned,
          projected: { ...projected.value, scope: scopeKey },
          result,
          effects,
          requiresGraphRebuild:
            projected.value.passes.length !== projectionPlan.passes.length ||
            (resolver?.requiresGraphRebuild ?? (resolver?.leases.length ?? 0) > 0) ||
            row.closure.resources.some((resource) => {
              const name = row.keys.get(resource.name);
              return name !== undefined && gpu?.changedResourceNames.has(name);
            }),
        });
      }
      // A held view keeps its committed resources without planning or executing work.
      // Removed views are absent from the roster and retire through the usual fence.
      transaction.retainResources(belongsToHeldView);
      gpu?.retainResources(belongsToHeldView);
      for (const item of transaction.committedItems()) {
        const descriptor = item.descriptor;
        if (
          (descriptor?.kind === 'vertex-data' || descriptor?.kind === 'index-data') &&
          descriptor.buffer !== undefined
        )
          gpu?.resolveBuffer(descriptor.buffer);
      }
      const leases = [...new Set(resolvers.flatMap((resolver) => resolver.leases))];
      const retained = host.retainPreparedGraphics(identity, leases);
      if (!retained.ok) throw retained.error;
      if (leases.length > 0) preparedResourceBatches.push(retained.value);
      // Prewarm declarations do not admit inactive or rejected fullscreen work.
      for (const postProcess of feature.requiredFullscreenPostProcesses ?? []) {
        if (projections.some(({ effects }) => effects.has(postProcess.identity)))
          postProcessIdentities.add(postProcess.identity);
      }
      for (const { planned, projected, result, effects, requiresGraphRebuild } of projections) {
        planExecutionProjections.set(planned, {
          execution: projected,
          ...(nativeWork === undefined ? {} : { nativeSignature: planned.signature }),
        });
        if (
          feature.onFrameSubmitted !== undefined ||
          feature.onSourceFrameSubmitted !== undefined ||
          planned.plan.resources.some(
            (resource) =>
              resource.kind === 'buffer' ||
              resource.kind === 'prepared-gpu-resource' ||
              resource.kind === 'vertex-data' ||
              resource.kind === 'index-data' ||
              resource.kind === 'compute-bindings',
          )
        )
          submissionSensitivePlans.add(planned);
        (result.plans as RenderFeaturePlannedFrame[]).push(planned);
        for (const [key, entry] of effects)
          (result.fullscreenEffects as Map<string, PostProcessShaderEntry>).set(key, entry);
        if (requiresGraphRebuild) {
          preparedResourceKeyPlans.add(planned);
          Object.assign(result, { requiresPreparedResourceKey: true });
        }
      }
      featureHiddenEntityReports.push(...reports);
      let resourcesCommitted = false;
      callbacks.push({
        commitResources: () => {
          if (resourcesCommitted) return;
          const committed = transaction.commit();
          if (!committed.ok) throw committed.error;
          const retired = gpu?.commitFrame() ?? [];
          resourcesCommitted = true;
          if (retired.length > 0) {
            const retained = host.retainPreparedGraphics(identity, retired);
            if (!retained.ok) throw retained.error;
            preparedResourceBatches.push(retained.value);
          }
        },
        abort: () => {
          drainFeatureFinalizers([abortResources, () => feature.onFrameAborted?.(extracted.value)]);
        },
        submit: () => {
          const accepted = projections.filter((row) => submittedWorks.has(row.planned));
          if (accepted.length === 0) {
            drainFeatureFinalizers([
              abortResources,
              () => feature.onFrameAborted?.(extracted.value),
            ]);
            return;
          }
          drainFeatureFinalizers([
            () =>
              feature.onFrameSubmitted?.(extracted.value, {
                works: accepted.map((row) => ({
                  scope: row.planned.scope,
                  passes: row.projected.passes
                    .filter((pass) => pass.enabled !== false)
                    .map((pass) =>
                      pass.graphics?.draws.some((draw) => draw.enabled === false)
                        ? {
                            ...pass,
                            graphics: {
                              ...pass.graphics,
                              draws: pass.graphics.draws.filter((draw) => draw.enabled !== false),
                            },
                          }
                        : pass,
                    ),
                })),
              }),
            publishInspection,
            () => {
              if (accepted.some((row) => row.planned.scope === 'frame')) {
                if (input.publishedFeatures?.some((row) => row.identity === identity))
                  input.onFeatureSourceSubmitted?.(identity, declared.value.sourceFeedback);
                else
                  feature.onSourceFrameSubmitted?.(extracted.value, declared.value.sourceFeedback);
              }
            },
          ]);
        },
      });
      host.setStatus(identity, 'active');
    } catch (error) {
      fail(error);
    }
  }
  // Immutable frame declarations (for example fullscreen shader registrations)
  // are visible in each view without executing shared passes a second time.
  for (const result of results.values()) {
    if (result === shared) continue;
    for (const [key, value] of shared.fullscreenEffects)
      if (!result.fullscreenEffects.has(key))
        (result.fullscreenEffects as Map<string, PostProcessShaderEntry>).set(key, value);
  }
  for (const result of results.values())
    Object.assign(result, {
      ...(preparationPendingFeatureIdentity === undefined
        ? {}
        : {
            preparationPending: true,
            preparationPendingFeatureIdentity,
            preparationPendingReason,
          }),
      postProcessIdentities: Object.freeze([...postProcessIdentities]),
      hiddenEntityReports: mergeHiddenEntityReports([
        ...result.hiddenEntityReports,
        ...featureHiddenEntityReports,
      ]),
    });
  let closed = false;
  return {
    frame: shared,
    views: new Map(
      inputs.map((view) => {
        const result = results.get(featureScopeKey({ view: view.identity }));
        if (result === undefined) throw new Error('Renderer Feature frame omitted a view');
        return [view.identity, result];
      }),
    ),
    preparedResourceBatches,
    commitPreparedResources: () => {
      if (closed) return;
      drainFeatureFinalizers(callbacks.map((callback) => callback.commitResources));
    },
    onSubmitted: () => {
      if (closed) return;
      closed = true;
      drainFeatureFinalizers([
        ...callbacks.map((callback) => callback.commitResources),
        ...callbacks.map((callback) => callback.submit),
      ]);
    },
    onAborted: () => {
      if (closed) return;
      closed = true;
      drainFeatureFinalizers(callbacks.map((callback) => callback.abort));
    },
  };
}

/** Producer failures cannot strand sibling transactions or suppress accepted source receipts. */
function drainFeatureFinalizers(actions: readonly (() => void)[]): void {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      action();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Feature frame finalization failed');
}

function mergeHiddenEntityReports(
  reports: readonly RenderFeatureHiddenEntityReport[],
): readonly RenderFeatureHiddenEntityReport[] {
  const entitiesByWorld = new WeakMap<object, Set<EntityHandle>>();
  const merged: RenderFeatureHiddenEntityReport[] = [];
  for (const report of reports) {
    let entities = entitiesByWorld.get(report.world);
    if (entities === undefined) {
      entities = new Set<EntityHandle>();
      entitiesByWorld.set(report.world, entities);
    }
    if (entities.has(report.entity)) continue;
    entities.add(report.entity);
    merged.push(report);
  }
  return Object.freeze(merged);
}

/**
 * Validate identities before creating typed slots or accepting resources.
 * Registration order is the input order and is never sorted by feature kind.
 */
export function createRenderFeatureHost(
  features: readonly RenderFeature<unknown>[],
  _caps?: Readonly<RhiCaps>,
): Result<RenderFeatureHost, RenderError> {
  const identities = new Map<string, number>();
  for (const [order, feature] of features.entries()) {
    const conflictingOrder = identities.get(feature.identity);
    if (conflictingOrder !== undefined) {
      return err(registrationConflict(feature.identity, order, conflictingOrder));
    }
    identities.set(feature.identity, order);
  }

  const slots: FeatureSlot[] = features.map((feature, order) => ({
    feature,
    order,
    preparedResourceBatches: new Set(),
    preparedStore: createPreparedGraphicsStore(),
    status: 'active',
    latestError: undefined,
  }));
  return ok(new FeatureHostImpl(slots));
}
