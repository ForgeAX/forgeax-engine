import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';

import type { EntityHandle } from '@forgeax/engine-ecs';
import type { Buffer, RhiCaps, Sampler, TextureFormat, TextureView } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
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
  type FeatureWorkResources,
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
  isRenderFeatureSceneResource,
  type RenderFeatureLogicalTarget,
  type RenderFeaturePassDeclaration,
  type RenderFeaturePlan,
  type RenderFeaturePlanContext,
  type RenderFeaturePlannedFrame,
  type RenderFeaturePlanSignatureMetrics,
  type RenderFeaturePlanSignatureSnapshot,
  type RenderFeaturePlanView,
  type RenderFeatureResourceDeclaration,
  type RenderFeatureSceneResource,
  type RenderFeatureWork,
  type RenderFeatureWorkPlan,
  rememberRenderFeaturePlanSignature,
  renderFeaturePlanSignature,
  validateRenderFeaturePlan,
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
import { isRenderFeatureTargetHandle, logicalRenderFeatureTargets } from './targets';
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
  diagnostics(): readonly RenderFeatureDiagnostics[];
  /** Subscribe to lifecycle projection changes; unchanged active frames are silent. */
  subscribeDiagnostics(listener: () => void): () => void;
  /** Detached signature and prepared-resource accounting for diagnostics. */
  inspection(): RenderFeatureHostInspection;
  /** Host-owned signature entry point so accounting remains per feature. */
  recordPlanSignature(identity: string, plan: RenderFeatureWorkPlan, scope?: string): string;
  /** Extract, plan and prepare each installed Feature once for the complete Renderer frame. */
  runFrame(inputs: readonly RenderFeatureFrameInput[]): RenderFeatureFrameBatch;
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

type SignatureInspection = {
  -readonly [Key in keyof RenderFeatureHostInspection['signatures'][number]]: RenderFeatureHostInspection['signatures'][number][Key];
};

/** Everything one installed Feature owns across frames; uninstall drops it whole. */
interface FeatureSlot {
  readonly feature: RenderFeature<unknown>;
  order: number;
  readonly preparedResourceBatches: Set<RenderFeaturePreparedResourceBatch>;
  readonly preparedStore: PreparedGraphicsStore;
  status: RenderFeatureStatus;
  latestError: RenderFeatureErrorDescriptor | undefined;
  latestInspection?: unknown;
  /** Detached structural evidence of each work scope's last raw plan. */
  readonly planSignatures: Map<
    string,
    { readonly signature: string; readonly snapshot: RenderFeaturePlanSignatureSnapshot }
  >;
  /** Last native execution topology of each work scope. */
  readonly nativeSignatures: Map<
    string,
    { readonly execution: RenderFeaturePlanExecution; readonly signature: string }
  >;
  signatureInspection: SignatureInspection | undefined;
  /** Scene-data catalog of each view for the current prepared generation. */
  readonly sceneData: Map<string, SceneDataCatalog>;
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function createFeatureSlot(feature: RenderFeature<unknown>, order: number): FeatureSlot {
  return {
    feature,
    order,
    preparedResourceBatches: new Set(),
    preparedStore: createPreparedGraphicsStore(),
    status: 'active',
    latestError: undefined,
    planSignatures: new Map(),
    nativeSignatures: new Map(),
    signatureInspection: undefined,
    sceneData: new Map(),
  };
}

/** The installed slot owns its counters; inspection publishes detached snapshots. */
function signatureInspection(slot: FeatureSlot): SignatureInspection {
  slot.signatureInspection ??= {
    featureIdentity: slot.feature.identity,
    calls: 0,
    typedArrayBytes: 0,
    outputChars: 0,
    cpuMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
  return slot.signatureInspection;
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
  // Draw order: pipeline, bindings, vertex data, then index data.
  const resolveReference = (reference: PreparedGraphicsReference): RenderError | undefined => {
    if (resources.has(reference)) return undefined;
    const resolved = resolver.resolve(reference);
    if (!resolved.ok) {
      onResolutionFailure?.(reference, resolved.error);
      return resolved.error;
    }
    resources.set(reference, resolved.value);
    return undefined;
  };
  for (const draw of descriptor.draws) {
    let failed = resolveReference(draw.pipeline);
    for (let index = 0; failed === undefined && index < draw.bindings.length; index++)
      failed = resolveReference(draw.bindings[index] as PreparedGraphicsReference);
    for (let index = 0; failed === undefined && index < draw.vertexData.length; index++)
      failed = resolveReference(
        (draw.vertexData[index] as (typeof draw.vertexData)[number]).resource,
      );
    if (failed === undefined && draw.indexData !== undefined)
      failed = resolveReference(draw.indexData.resource);
    if (failed !== undefined) return err(failed);
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
  fallback: string | undefined | (() => string | undefined),
): TextureFormat | undefined {
  const target = targets.find((candidate) => candidate.name === name);
  return (target?.format ?? (typeof fallback === 'function' ? fallback() : fallback)) as
    | TextureFormat
    | undefined;
}

type PreparedResourceMaps = ReturnType<typeof createPreparedResourceMaps>;
type ResourceOfKind<Kind extends RenderFeatureResourceDeclaration['kind']> = Extract<
  RenderFeatureResourceDeclaration,
  { readonly kind: Kind }
>;

function preparePlanResources(
  slot: FeatureSlot,
  plan: RenderFeatureWorkPlan,
  transaction: PreparedGraphicsTransaction,
  gpu: RenderFeatureGpuPrepareSession | undefined,
  targetsForResource: (name: string) => readonly RenderFeatureTargetHandle[],
  sceneResources: RenderFeatureFrameInput['sceneResources'],
  native?: {
    readonly keys: ReadonlyMap<string, string>;
    readonly shared?: PreparedPlanResources;
    readonly admission?: PreparedPlanResources;
  },
): Result<PreparedPlanResources, RenderError> {
  if (plan.resources.length === 0 && native?.admission === undefined)
    return ok(native?.shared ?? EMPTY_PREPARED_RESOURCES);
  const graphics = createPreparedGraphicsPrepare(
    transaction,
    native === undefined ? undefined : true,
  );
  const maps = createPreparedResourceMaps(
    native?.admission ?? native?.shared,
    native?.admission === undefined ? undefined : native.shared,
    native?.admission !== undefined,
  );
  const ownerName = (name: string): string => native?.keys.get(name) ?? name;
  const buckets = bucketResourcesByKind(plan.resources);
  const byKind = <Kind extends RenderFeatureResourceDeclaration['kind']>(
    kind: Kind,
  ): readonly ResourceOfKind<Kind>[] =>
    (buckets.get(kind) ?? NO_RESOURCES) as readonly ResourceOfKind<Kind>[];

  if (gpu === undefined && planRequiresGpuSession(plan)) return err(planFailure(slot));
  // Lanes run in dependency order: bindings and geometry read the programs,
  // buffers and prepared resources admitted by earlier lanes.
  let failure = prepareComputePrograms(slot, byKind('compute-program'), gpu, ownerName, maps);
  if (failure !== undefined) return err(failure);
  failure = prepareGraphicsPrograms(byKind('graphics-program'), graphics, ownerName, maps);
  if (failure !== undefined) return err(failure);
  failure = prepareBuffers(slot, byKind('buffer'), gpu, ownerName, maps);
  if (failure !== undefined) return err(failure);
  failure = preparePreparedGpuResources(
    slot,
    byKind('prepared-gpu-resource'),
    gpu,
    ownerName,
    targetsForResource,
    maps,
  );
  if (failure !== undefined) return err(failure);
  failure = prepareSceneResources(slot, plan.resources, gpu, sceneResources, ownerName, maps);
  if (failure !== undefined) return err(failure);
  failure = prepareComputeBindings(
    slot,
    byKind('compute-bindings'),
    gpu,
    ownerName,
    native === undefined,
    maps,
  );
  if (failure !== undefined) return err(failure);
  failure = prepareGraphicsBindings(
    slot,
    byKind('graphics-bindings'),
    graphics,
    ownerName,
    targetsForResource,
    maps,
  );
  if (failure !== undefined) return err(failure);
  failure = prepareVertexData(slot, byKind('vertex-data'), graphics, ownerName, maps);
  if (failure !== undefined) return err(failure);
  failure = prepareIndexData(slot, byKind('index-data'), graphics, ownerName, maps);
  if (failure !== undefined) return err(failure);
  return ok({
    computePrograms: maps.computePrograms,
    graphicsPrograms: maps.graphicsPrograms,
    buffers: maps.buffers,
    preparedGpuResources: maps.preparedGpuResources,
    computeBindings: maps.computeBindings,
    graphicsBindings: maps.graphicsBindings,
    vertexData: maps.vertexData,
    indexData: maps.indexData,
  });
}

function bucketResourcesByKind(
  resources: readonly RenderFeatureResourceDeclaration[],
): Map<string, RenderFeatureResourceDeclaration[]> {
  const buckets = new Map<string, RenderFeatureResourceDeclaration[]>();
  for (const resource of resources) {
    const bucket = buckets.get(resource.kind);
    if (bucket === undefined) buckets.set(resource.kind, [resource]);
    else bucket.push(resource);
  }
  return buckets;
}

const NO_RESOURCES: readonly RenderFeatureResourceDeclaration[] = Object.freeze([]);
const NO_TARGET_INPUTS: ReadonlyMap<string, readonly RenderFeatureTargetHandle[]> = new Map();
const EMPTY_PREPARED_RESOURCES: PreparedPlanResources = createPreparedResourceMaps();

/** Does any declaration need the GPU work session rather than graphics preparation alone? */
function planRequiresGpuSession(plan: RenderFeatureWorkPlan): boolean {
  return plan.resources.some(
    (resource) =>
      isRenderFeatureSceneResource(resource) ||
      ['compute-program', 'buffer', 'prepared-gpu-resource', 'compute-bindings'].includes(
        resource.kind,
      ),
  );
}

function prepareComputePrograms(
  slot: FeatureSlot,
  resources: readonly ResourceOfKind<'compute-program'>[],
  gpu: RenderFeatureGpuPrepareSession | undefined,
  ownerName: (name: string) => string,
  maps: PreparedResourceMaps,
): RenderError | undefined {
  for (const resource of resources) {
    const prepared = gpu?.prepareProgram(
      ownerName(resource.name),
      resource.program,
      resource.preparePipelines,
    );
    if (prepared === undefined) return planFailure(slot);
    if (!prepared.ok) return prepared.error;
    maps.computePrograms.set(resource.name, prepared.value);
  }
  return undefined;
}

function prepareGraphicsPrograms(
  resources: readonly ResourceOfKind<'graphics-program'>[],
  graphics: RenderFeatureGraphicsPrepare,
  ownerName: (name: string) => string,
  maps: PreparedResourceMaps,
): RenderError | undefined {
  for (const resource of resources) {
    const prepared = graphics.preparePipeline(ownerName(resource.name), resource.program);
    if (!prepared.ok) return prepared.error;
    maps.graphicsPrograms.set(resource.name, prepared.value);
  }
  return undefined;
}

function prepareBuffers(
  slot: FeatureSlot,
  resources: readonly ResourceOfKind<'buffer'>[],
  gpu: RenderFeatureGpuPrepareSession | undefined,
  ownerName: (name: string) => string,
  maps: PreparedResourceMaps,
): RenderError | undefined {
  for (const resource of resources) {
    // The declaration is the descriptor: size, usage, data and uploads are read
    // in place, so a steady plan allocates no per-buffer descriptor.
    const prepared = gpu?.prepareBuffer(ownerName(resource.name), resource);
    if (prepared === undefined) return planFailure(slot);
    if (!prepared.ok) return prepared.error;
    maps.buffers.set(resource.name, prepared.value);
  }
  return undefined;
}

function preparePreparedGpuResources(
  slot: FeatureSlot,
  resources: readonly ResourceOfKind<'prepared-gpu-resource'>[],
  gpu: RenderFeatureGpuPrepareSession | undefined,
  ownerName: (name: string) => string,
  targetsForResource: (name: string) => readonly RenderFeatureTargetHandle[],
  maps: PreparedResourceMaps,
): RenderError | undefined {
  for (const resource of resources) {
    if (gpu === undefined) return planFailure(slot);
    if (resource.resource.kind === 'buffer') {
      const prepared = gpu.prepareBufferResource(
        ownerName(resource.name),
        resource.resource.value as Buffer,
        {
          size: resource.resource.size,
          usage: resource.resource.usage ?? ['uniform'],
        },
      );
      if (!prepared.ok) return prepared.error;
      maps.preparedGpuResources.set(resource.name, { kind: 'buffer', reference: prepared.value });
      continue;
    }
    if (resource.resource.kind === 'texture-view') {
      const failure = preparePreparedTextureView(
        slot,
        resource,
        resource.resource.value as TextureView | undefined,
        gpu,
        ownerName(resource.name),
        targetsForResource,
        maps,
      );
      if (failure !== undefined) return failure;
      continue;
    }
    const prepared = gpu.prepareSampler(
      ownerName(resource.name),
      resource.resource.value as Sampler,
    );
    if (!prepared.ok) return prepared.error;
    maps.preparedGpuResources.set(resource.name, { kind: 'sampler', reference: prepared.value });
  }
  return undefined;
}

/** Resolve a prepared texture view's optional logical target, then admit the view. */
function preparePreparedTextureView(
  slot: FeatureSlot,
  resource: ResourceOfKind<'prepared-gpu-resource'>,
  view: TextureView | undefined,
  gpu: RenderFeatureGpuPrepareSession,
  owner: string,
  targetsForResource: (name: string) => readonly RenderFeatureTargetHandle[],
  maps: PreparedResourceMaps,
): RenderError | undefined {
  const logical =
    resource.logicalTarget === undefined
      ? undefined
      : targetHandle(resource.logicalTarget, targetsForResource(owner));
  if (
    resource.logicalTarget !== undefined &&
    (logical === undefined ||
      (typeof logical !== 'string' &&
        !isRenderFeatureTargetHandle(logical) &&
        !isSceneDataTarget(logical)))
  ) {
    return planFailure(slot);
  }
  const prepared = gpu.prepareTextureView(owner, view, logical === undefined ? undefined : logical);
  if (!prepared.ok) return prepared.error;
  maps.preparedGpuResources.set(resource.name, {
    kind: 'texture-view',
    reference: prepared.value,
  });
  return undefined;
}

function prepareSceneResources(
  slot: FeatureSlot,
  resources: readonly RenderFeatureResourceDeclaration[],
  gpu: RenderFeatureGpuPrepareSession | undefined,
  sceneResources: RenderFeatureFrameInput['sceneResources'],
  ownerName: (name: string) => string,
  maps: PreparedResourceMaps,
): RenderError | undefined {
  for (const resource of resources) {
    if (!isRenderFeatureSceneResource(resource)) continue;
    if (gpu === undefined || sceneResources === undefined) return planFailure(slot);
    const scene = sceneResources.prepare(slot.feature.identity, resource);
    if ('buffer' in scene) {
      const prepared = gpu.prepareBufferResource(ownerName(resource.name), scene.buffer, {
        size: scene.size,
        usage: ['storage'],
      });
      if (!prepared.ok) return prepared.error;
      maps.preparedGpuResources.set(resource.name, { kind: 'buffer', reference: prepared.value });
      continue;
    }
    const prepared = gpu.prepareTextureView(ownerName(resource.name), scene.view, scene.target);
    if (!prepared.ok) return prepared.error;
    maps.preparedGpuResources.set(resource.name, {
      kind: 'texture-view',
      reference: prepared.value,
    });
  }
  return undefined;
}

function prepareComputeBindings(
  slot: FeatureSlot,
  resources: readonly ResourceOfKind<'compute-bindings'>[],
  gpu: RenderFeatureGpuPrepareSession | undefined,
  ownerName: (name: string) => string,
  resolveEntries: boolean,
  maps: PreparedResourceMaps,
): RenderError | undefined {
  const namedBindingResources = resolveEntries
    ? undefined
    : { buffers: maps.buffers, resources: maps.preparedGpuResources };
  for (const resource of resources) {
    const program = maps.computePrograms.get(resource.program);
    if (namedBindingResources !== undefined) {
      if (program === undefined || gpu === undefined) return planFailure(slot);
      const prepared = gpu.prepareNamedBindings(
        ownerName(resource.name),
        {
          program,
          entries: resource.entries,
        },
        namedBindingResources,
      );
      if (!prepared.ok) return prepared.error;
      maps.computeBindings.set(resource.name, prepared.value);
      continue;
    }
    const entries = resource.entries.map((entry) => resolveComputeBindingEntry(entry, maps));
    if (program === undefined || entries.some((entry) => entry === undefined)) {
      return planFailure(slot);
    }
    const prepared = gpu?.prepareBindings(ownerName(resource.name), {
      program,
      entries: entries as NonNullable<(typeof entries)[number]>[],
    });
    if (prepared === undefined) return planFailure(slot);
    if (!prepared.ok) return prepared.error;
    maps.computeBindings.set(resource.name, prepared.value);
  }
  return undefined;
}

/** Bind an entry to a declared buffer first, else to a prepared GPU resource. */
function resolveComputeBindingEntry(
  entry: ResourceOfKind<'compute-bindings'>['entries'][number],
  maps: PreparedResourceMaps,
) {
  const buffer = maps.buffers.get(entry.resource);
  const range = {
    ...(entry.offset === undefined ? {} : { offset: entry.offset }),
    ...(entry.size === undefined ? {} : { size: entry.size }),
  };
  if (buffer !== undefined) return { binding: entry.binding, buffer, ...range } as const;
  const prepared = maps.preparedGpuResources.get(entry.resource);
  return prepared === undefined
    ? undefined
    : ({ binding: entry.binding, resource: prepared, ...range } as const);
}

function prepareGraphicsBindings(
  slot: FeatureSlot,
  resources: readonly ResourceOfKind<'graphics-bindings'>[],
  graphics: RenderFeatureGraphicsPrepare,
  ownerName: (name: string) => string,
  targetsForResource: (name: string) => readonly RenderFeatureTargetHandle[],
  maps: PreparedResourceMaps,
): RenderError | undefined {
  for (const resource of resources) {
    const program = maps.graphicsPrograms.get(resource.program);
    if (program === undefined) return planFailure(slot);
    // Values pass through unchanged unless logical targets must be bound;
    // a producer's stable values object then stays provable by identity.
    let values: Readonly<Record<string, unknown>> = resource.values;
    if (resource.logicalTargets !== undefined) {
      const bound: Record<string, unknown> = { ...resource.values };
      for (const [key, targetName] of Object.entries(resource.logicalTargets)) {
        const target = targetHandle(targetName, targetsForResource(ownerName(resource.name)));
        if (target === undefined || typeof target === 'string') return planFailure(slot);
        bound[key] = target;
      }
      values = bound;
    }
    const prepared = graphics.prepareBindings(ownerName(resource.name), {
      pipeline: program,
      values,
    });
    if (!prepared.ok) return prepared.error;
    maps.graphicsBindings.set(resource.name, prepared.value);
  }
  return undefined;
}

function prepareVertexData(
  slot: FeatureSlot,
  resources: readonly ResourceOfKind<'vertex-data'>[],
  graphics: RenderFeatureGraphicsPrepare,
  ownerName: (name: string) => string,
  maps: PreparedResourceMaps,
): RenderError | undefined {
  for (const resource of resources) {
    const descriptor =
      resource.buffer === undefined
        ? { layout: resource.layout, data: resource.data }
        : {
            layout: resource.layout,
            buffer: maps.buffers.get(resource.buffer),
            ...(resource.offset === undefined ? {} : { offset: resource.offset }),
            ...(resource.size === undefined ? {} : { size: resource.size }),
          };
    if ('buffer' in descriptor && descriptor.buffer === undefined) return planFailure(slot);
    const prepared = graphics.prepareVertexData(
      ownerName(resource.name),
      descriptor as import('./prepared-graphics').RenderFeatureVertexDataDescriptor,
    );
    if (!prepared.ok) return prepared.error;
    maps.vertexData.set(resource.name, prepared.value);
  }
  return undefined;
}

function prepareIndexData(
  slot: FeatureSlot,
  resources: readonly ResourceOfKind<'index-data'>[],
  graphics: RenderFeatureGraphicsPrepare,
  ownerName: (name: string) => string,
  maps: PreparedResourceMaps,
): RenderError | undefined {
  for (const resource of resources) {
    const descriptor =
      resource.buffer === undefined
        ? { format: resource.format, data: resource.data }
        : {
            format: resource.format,
            buffer: maps.buffers.get(resource.buffer),
            ...(resource.offset === undefined ? {} : { offset: resource.offset }),
            ...(resource.size === undefined ? {} : { size: resource.size }),
          };
    if ('buffer' in descriptor && descriptor.buffer === undefined) return planFailure(slot);
    const prepared = graphics.prepareIndexData(
      ownerName(resource.name),
      descriptor as import('./prepared-graphics').RenderFeatureIndexDataDescriptor,
    );
    if (!prepared.ok) return prepared.error;
    maps.indexData.set(resource.name, prepared.value);
  }
  return undefined;
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
  const logical = logicalRenderFeatureTargets(targets);
  const projected: RenderFeaturePlanExecutionPass[] = [];
  // First declared color format per prepared program, indexed once per plan
  // and only when a pass target lacks its own format.
  let programFormats: Map<unknown, string | undefined> | undefined;
  const programFormat = (program: unknown): string | undefined => {
    if (programFormats === undefined) {
      programFormats = new Map();
      for (const resource of plan.resources) {
        if (resource.kind !== 'graphics-program') continue;
        const reference = prepared.graphicsPrograms.get(resource.name);
        if (!programFormats.has(reference))
          programFormats.set(reference, resource.program.colorFormats[0]);
      }
    }
    return programFormats.get(program);
  };
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
    const fallbackFormat = () =>
      programFormat(prepared.graphicsPrograms.get(pass.draws[0]?.program ?? ''));
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

  runFrame(inputs: readonly RenderFeatureFrameInput[]): RenderFeatureFrameBatch {
    const input = inputs[0];
    if (input === undefined) throw new Error('a Feature frame requires its complete view roster');
    this.beginDepthBatchInspection(
      input.featureReadOnlyDepthBatchDiagnostic === true ? input.frameNumber : undefined,
      input.generation ?? 0,
    );
    const batch = new FeatureFrameBatchBuilder(this, inputs, input);
    for (const slot of this.slots) {
      if (!featureRunsThisFrame(slot, input.caps)) continue;
      const transaction = this.beginPreparedFrame(
        slot.feature.identity,
        input.generation ?? this.generation,
      );
      if (transaction === undefined) continue;
      new FeatureFramePreparation(batch, slot, transaction).run();
    }
    return batch.finish();
  }

  /** Drop signature evidence of scopes the slot's current frame no longer declares. */
  retainPlanScopes(slot: FeatureSlot, scopes: readonly string[]): void {
    retainScopes(slot.planSignatures, scopes);
    retainScopes(slot.nativeSignatures, scopes);
  }

  nativeExecutionSignature(
    slot: FeatureSlot,
    execution: RenderFeaturePlanExecution,
    scope: string,
  ): string {
    const started = now();
    const cache = slot.nativeSignatures;
    const previous = cache.get(scope);
    const hit =
      previous !== undefined &&
      sameRenderFeatureNativeExecutionTopology(previous.execution, execution);
    const signature = hit ? previous.signature : `native-revision-${++this.signatureRevision}`;
    if (!hit) cache.set(scope, { execution, signature });
    const stats = signatureInspection(slot);
    stats.nativeCalls = (stats.nativeCalls ?? 0) + 1;
    stats.cpuMs += now() - started;
    if (hit) stats.cacheHits++;
    else stats.cacheMisses++;
    return signature;
  }

  recordPlanSignature(identity: string, plan: RenderFeatureWorkPlan, scope = 'frame'): string {
    const slot = findSlot(this.slots, identity);
    return slot === undefined
      ? renderFeaturePlanSignature(plan)
      : this.planSignature(slot, plan, scope);
  }

  planSignature(slot: FeatureSlot, plan: RenderFeatureWorkPlan, scope: string): string {
    const started = now();
    const cache = slot.planSignatures;
    const previous = cache.get(scope);
    // Snapshot capture already compares every declaration and returns the prior
    // root when unchanged. A separate whole-plan comparison would revisit the
    // unchanged prefix whenever a later VFX resource or pass changes.
    const snapshot = cloneOwnedRenderFeaturePlanSignatureSnapshot(plan, previous?.snapshot);
    if (previous !== undefined && snapshot === previous.snapshot) {
      const stats = signatureInspection(slot);
      stats.cpuMs += now() - started;
      stats.cacheHits++;
      // The graph validator receives a fresh plan object every frame. Reuse
      // is safe only because it will perform the same exact structural check
      // against this detached snapshot.
      rememberRenderFeaturePlanSignature(plan, previous.signature, previous.snapshot);
      return previous.signature;
    }
    // A changed plan usually mutates a small VFX membership/pass leaf. Keep the
    // previous detached evidence as a sharing source so unchanged subtrees stay
    // immutable; the candidate snapshot is still a fresh root and is revalidated
    // by graph admission. Only the initial observation spells the canonical
    // signature; later changes take a compact monotonic identity.
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
    const stats = signatureInspection(slot);
    stats.calls += metrics.calls;
    stats.typedArrayBytes += metrics.typedArrayBytes;
    stats.outputChars += metrics.outputChars;
    stats.cpuMs += now() - started;
    stats.cacheMisses++;
    return signature;
  }

  inspection(): RenderFeatureHostInspection {
    return Object.freeze({
      ...(this.depthBatchInspection === undefined
        ? {}
        : { featureReadOnlyDepthBatchDiagnostic: Object.freeze({ ...this.depthBatchInspection }) }),
      signatures: Object.freeze(
        this.slots
          .flatMap((slot) =>
            slot.signatureInspection === undefined
              ? []
              : [Object.freeze({ ...slot.signatureInspection })],
          )
          .sort((left, right) => left.featureIdentity.localeCompare(right.featureIdentity)),
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
    this.slots.push(createFeatureSlot(feature, this.slots.length));
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

function retainScopes(cache: Map<string, unknown>, scopes: readonly string[]): void {
  if (cache.size > 0)
    for (const scope of cache.keys()) if (!scopes.includes(scope)) cache.delete(scope);
}

/** Disposed slots never run; disabled slots retry only once a missing capability appears. */
function featureRunsThisFrame(slot: FeatureSlot, caps: Readonly<RhiCaps>): boolean {
  if (slot.status === 'disposed') return false;
  return !(
    slot.status === 'disabled' &&
    (slot.latestError?.code !== 'render-feature-capability-missing' ||
      missingCapability(slot.feature, caps) === undefined)
  );
}

interface FeatureWorkProjection {
  readonly planned: RenderFeaturePlannedFrame;
  readonly projected: RenderFeaturePlanExecution;
  readonly result: RenderFeatureFrameResult;
  readonly effects: ReadonlyMap<string, PostProcessShaderEntry>;
  readonly requiresGraphRebuild: boolean;
}

/** Frame-wide accumulation shared by every Feature in one Renderer frame. */
class FeatureFrameBatchBuilder {
  readonly stageEvents: RenderFeatureStageEvent[] = [];
  readonly errors: RenderError[] = [];
  readonly preparedResourceBatches: RenderFeaturePreparedResourceBatch[] = [];
  readonly submittedWorks = new Set<RenderFeaturePlannedFrame>();
  /** Features that reached the submission barrier, in installation order. */
  readonly prepared: FeatureFramePreparation[] = [];
  readonly views = new Map<string, RenderFeatureFrameResult>();
  readonly postProcessIdentities = new Set<string>();
  readonly featureHiddenEntityReports: RenderFeatureHiddenEntityReport[] = [];
  readonly shared: RenderFeatureFrameResult;
  /** Extraction view projections and material context shared by every Feature this frame. */
  readonly extractViews: readonly ReturnType<typeof extractView>[];
  readonly materialContext: ReturnType<typeof renderMaterialContext>;
  /** Feature-independent part of each view's plan context. */
  readonly planViews: readonly Omit<RenderFeaturePlanView, 'sceneData'>[];
  private readonly heldResourcePrefixes: readonly string[];
  private preparationPendingFeatureIdentity: string | undefined;
  private preparationPendingReason: FramePresentationPendingReason | undefined;

  constructor(
    readonly host: FeatureHostImpl,
    readonly inputs: readonly RenderFeatureFrameInput[],
    readonly input: RenderFeatureFrameInput,
  ) {
    this.shared = this.makeResult();
    for (const view of inputs) {
      if (this.views.has(view.identity)) throw new Error('duplicate render view identity');
      const result = this.makeResult();
      this.views.set(view.identity, result);
      (result.hiddenEntityReports as RenderFeatureHiddenEntityReport[]).push(
        ...(view.hiddenEntityReports ?? []),
      );
    }
    this.extractViews = Object.freeze(inputs.map(extractView));
    this.materialContext = renderMaterialContext(input.caps, input.limits);
    this.planViews = inputs.map((view) =>
      Object.freeze({
        identity: view.identity,
        render: view.render,
        frame: Object.freeze({ frameNumber: input.frameNumber, ...view.frameSize }),
        ...(view.selectedView === undefined ? {} : { selectedView: view.selectedView }),
        targets: logicalRenderFeatureTargets(view.targets ?? []),
      }),
    );
    this.heldResourcePrefixes = inputs
      .filter((view) => !view.render)
      .map((view) => `${JSON.stringify([featureScopeKey({ view: view.identity })]).slice(0, -1)},`);
  }

  viewLogicalTargets(view: RenderFeatureFrameInput): readonly RenderFeatureLogicalTarget[] {
    return (this.planViews[this.inputs.indexOf(view)] as (typeof this.planViews)[number]).targets;
  }

  readonly belongsToHeldView = (name: string): boolean => {
    const prefixes = this.heldResourcePrefixes;
    for (let index = 0; index < prefixes.length; index++)
      if (name.startsWith(prefixes[index] as string)) return true;
    return false;
  };

  get preparationPending(): boolean {
    return this.preparationPendingFeatureIdentity !== undefined;
  }

  private makeResult(): RenderFeatureFrameResult {
    const plans: RenderFeaturePlannedFrame[] = [];
    const submittedWorks = this.submittedWorks;
    const result: RenderFeatureFrameResult = {
      stageEvents: this.stageEvents,
      errors: this.errors,
      plans,
      fullscreenEffects: new Map<string, PostProcessShaderEntry>(),
      hiddenEntityReports: [],
      postProcessIdentities: [],
      preparedResourceBatches: [],
      requiresPreparedResourceKey: false,
      onSubmitted: () => {
        for (const plan of plans) submittedWorks.add(plan);
      },
      onAborted: () => {},
    };
    return result;
  }

  // Capture only at the existing first blocker. Never consult a later inspection
  // or serialize a complete program/plan to explain a receipt.
  markPreparationPending(
    identity: string,
    preparationStage: NonNullable<FramePresentationPendingReason['preparationStage']>,
    error?: unknown,
    graphics?: { readonly pass: string; readonly shader?: string },
  ): void {
    if (this.preparationPendingFeatureIdentity !== undefined) return;
    this.preparationPendingFeatureIdentity = identity;
    const detail = error instanceof RenderFeaturePreparationFailedError ? error.detail : undefined;
    this.preparationPendingReason = Object.freeze({
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
  }

  finish(): RenderFeatureFrameBatch {
    this.shareFrameFullscreenEffects();
    this.publishFrameSummaries();
    const prepared = this.prepared;
    let closed = false;
    return {
      frame: this.shared,
      views: this.views,
      preparedResourceBatches: this.preparedResourceBatches,
      commitPreparedResources: () => {
        if (!closed) drainEach(prepared, (feature) => feature.commitResources());
      },
      onSubmitted: () => {
        if (closed) return;
        closed = true;
        drainEach(
          prepared,
          (feature) => feature.commitResources(),
          (feature) => feature.submit(),
        );
      },
      onAborted: () => {
        if (closed) return;
        closed = true;
        drainEach(prepared, (feature) => feature.abort());
      },
    };
  }

  // Immutable frame declarations (for example fullscreen shader registrations)
  // are visible in each view without executing shared passes a second time.
  private shareFrameFullscreenEffects(): void {
    for (const result of this.views.values()) {
      for (const [key, value] of this.shared.fullscreenEffects)
        if (!result.fullscreenEffects.has(key))
          (result.fullscreenEffects as Map<string, PostProcessShaderEntry>).set(key, value);
    }
  }

  private publishFrameSummaries(): void {
    const identities = Object.freeze([...this.postProcessIdentities]);
    this.publishResultSummary(this.shared, identities);
    for (const result of this.views.values()) this.publishResultSummary(result, identities);
  }

  private publishResultSummary(
    result: RenderFeatureFrameResult,
    identities: readonly string[],
  ): void {
    Object.assign(result, {
      ...(this.preparationPendingFeatureIdentity === undefined
        ? {}
        : {
            preparationPending: true,
            preparationPendingFeatureIdentity: this.preparationPendingFeatureIdentity,
            preparationPendingReason: this.preparationPendingReason,
          }),
      postProcessIdentities: identities,
      hiddenEntityReports: mergeHiddenEntityReports(
        result.hiddenEntityReports,
        this.featureHiddenEntityReports,
      ),
    });
  }
}

/** One Feature's extract → plan → prepare → project pass within a frame batch. */
class FeatureFramePreparation {
  private readonly feature: RenderFeature<unknown>;
  private readonly identity: string;
  private readonly input: RenderFeatureFrameInput;
  private readonly gpu: RenderFeatureGpuPrepareSession | undefined;
  private readonly reports: RenderFeatureHiddenEntityReport[] = [];
  private readonly resolvers: PreparedGraphicsResolver[] = [];
  private readonly projections: FeatureWorkProjection[] = [];
  private nativeAdmissions:
    | Map<RenderFeatureNativeResourceAdmission, ReturnType<typeof createNativeResourceAdmission>>
    | undefined;
  /** Producer frame data, assigned once extraction succeeds. */
  private source: unknown;
  private requiresPreparation = false;
  private nativePlanningOpen = true;
  private nativeWork: readonly RenderFeatureWork[] | undefined;
  private nativeFailure: unknown;
  private admittedResources: ReturnType<typeof createNativeResourceAdmission> | undefined;
  private sharedPrepared: PreparedPlanResources | undefined;
  private scopeResources: ReturnType<typeof createPreparedResourceScopes> | undefined;
  /** The admitted plan; assigned before this preparation joins the submission barrier. */
  private plan!: RenderFeaturePlan;
  private resourcesCommitted = false;

  constructor(
    private readonly batch: FeatureFrameBatchBuilder,
    private readonly slot: FeatureSlot,
    private readonly transaction: PreparedGraphicsTransaction,
  ) {
    const feature = slot.feature;
    this.feature = feature;
    this.identity = feature.identity;
    this.input = batch.input;
    this.gpu = this.input.gpuWork?.beginFeature(
      this.identity,
      this.input.generation ?? 0,
      feature.shaderModuleMode,
    );
  }

  run(): void {
    const extracted = invokeStage(
      this.slot,
      'extract',
      () => this.extract(),
      this.batch.stageEvents,
      this.batch.errors,
    );
    if (!extracted.ok) {
      this.cleanupPreparation([() => this.abortResources()], 'extract');
      this.batch.host.setStatus(this.identity, 'failed', this.slot.latestError);
      return;
    }
    this.source = extracted.value;
    const views = this.planViews();
    let sourceRequiresPreparation: boolean;
    try {
      sourceRequiresPreparation = this.feature.requiresPreparation?.(this.source) === true;
    } catch (cause) {
      this.failSourceGuard(cause);
      return;
    }
    const declared = this.declarePlan(views);
    if (declared.ok) this.consumeNativePlan(declared.value, views);
    const declaredWork = this.nativeWork ?? (declared.ok ? declared.value.work : []);
    const nativeRequiresPreparation = this.verifyNativeAdmissions(declared, declaredWork);
    this.requiresPreparation =
      sourceRequiresPreparation ||
      nativeRequiresPreparation ||
      (declared.ok && workRequestsPipelinePreparation(declaredWork));
    if (!declared.ok) {
      this.fail(
        undefined,
        declared.error,
        declared.error instanceof RenderFeaturePreparationFailedError
          ? nativeRequiresPreparation
            ? 'native-admission'
            : 'resource-preparation'
          : 'source-plan',
      );
      return;
    }
    if (this.nativeFailure !== undefined) {
      this.fail(this.nativeFailure);
      return;
    }
    try {
      this.prepareAndPublish(declared.value, declaredWork);
    } catch (error) {
      this.fail(error);
    }
  }

  private extract(): Result<unknown, RenderError> {
    const input = this.input;
    const published = input.publishedFeatures?.find((row) => row.identity === this.identity);
    if (published !== undefined) return ok(published.data);
    return this.feature.extract({
      worlds: input.worlds,
      owner: input.owner,
      frameNumber: input.frameNumber,
      caps: input.caps,
      ...this.batch.materialContext,
      views: this.batch.extractViews,
      ...(input.visibilitySnapshots === undefined
        ? {}
        : { visibilitySnapshots: input.visibilitySnapshots }),
      reportHiddenEntity: (report) => this.reports.push(report),
    });
  }

  private planViews(): RenderFeaturePlanContext['views'] {
    const inputs = this.batch.inputs;
    const views = this.batch.planViews;
    const planned: RenderFeaturePlanView[] = [];
    for (let index = 0; index < views.length; index++) {
      const view = views[index] as (typeof views)[number];
      planned.push({
        ...view,
        sceneData: (inputs[index] as RenderFeatureFrameInput).sceneData ?? this.sceneData(view),
      });
    }
    return planned;
  }

  /** The view's catalog is fixed for one prepared generation; recreate it only after a cut. */
  private sceneData(view: { readonly identity: string }): SceneDataCatalog {
    const generation = this.transaction.generation;
    const cache = this.slot.sceneData;
    const cached = cache.get(view.identity);
    if (cached?.generation === generation) return cached;
    if (cache.size >= this.batch.inputs.length) cache.clear();
    const created = createSceneDataCatalog({
      featureIdentity: this.identity,
      generation,
      planIdentity: `${this.identity}:${view.identity}:${generation}`,
      rgba16floatRenderable: this.input.caps.rgba16floatRenderable === true,
    });
    cache.set(view.identity, created);
    return created;
  }

  private abortResources(): void {
    drainFeatureFinalizers([
      () => this.transaction.abort(),
      () => {
        const aborted = this.gpu?.abortFrame();
        if (aborted !== undefined && !aborted.ok) this.batch.errors.push(aborted.error);
      },
    ]);
  }

  private abortProducerFrame(): void {
    this.feature.onFrameAborted?.(this.source);
  }

  // A rejected producer must return its failure as data so already prepared
  // siblings still reach the Renderer submission/abort barrier.
  private cleanupPreparation(actions: readonly (() => void)[], stage: 'extract' | 'plan'): void {
    try {
      drainFeatureFinalizers(actions);
    } catch (cause) {
      recordFailure(this.slot, stage, cause, this.batch.errors);
    }
  }

  /** A declared readiness guard cannot fail open before plan resources exist. */
  private failSourceGuard(cause: unknown): void {
    this.batch.markPreparationPending(this.identity, 'source-guard');
    recordFailure(this.slot, 'plan', cause, this.batch.errors);
    this.cleanupPreparation(
      [
        () => this.input.sceneResources?.abortFeature(this.identity),
        () => this.abortResources(),
        () => this.abortProducerFrame(),
      ],
      'plan',
    );
    this.batch.host.setStatus(this.identity, 'failed', this.slot.latestError);
  }

  private fail(
    error?: unknown,
    pendingError: unknown = error,
    stage: NonNullable<FramePresentationPendingReason['preparationStage']> = pendingError instanceof
    RenderFeaturePreparationFailedError
      ? 'resource-preparation'
      : 'plan-projection',
  ): void {
    if (this.requiresPreparation)
      this.batch.markPreparationPending(this.identity, stage, pendingError);
    if (error !== undefined) recordFailure(this.slot, 'plan', error, this.batch.errors);
    this.cleanupPreparation(
      [
        () => this.input.sceneResources?.abortFeature(this.identity),
        () => this.abortResources(),
        ...this.resolvers.map((resolver) => () => {
          const released = resolver.release();
          if (!released.ok) throw released.error;
        }),
        () => this.abortProducerFrame(),
      ],
      'plan',
    );
    this.batch.host.setStatus(this.identity, 'failed', this.slot.latestError);
  }

  private publishInspection(): void {
    const source = this.source;
    if (typeof source === 'object' && source !== null && 'inspection' in source)
      this.slot.latestInspection = (source as { inspection?: unknown }).inspection;
  }

  private declarePlan(
    views: RenderFeaturePlanContext['views'],
  ): Result<RenderFeaturePlan, RenderError> {
    const input = this.input;
    const declared = invokeStage(
      this.slot,
      'plan',
      () =>
        this.feature.plan(this.source, {
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
          ...this.batch.materialContext,
          frame: { frameNumber: input.frameNumber },
          generation: this.transaction.generation,
          createNativePlan: () => this.createNativePlan(views),
          views,
          ...(input.materialShaderBindingContract === undefined
            ? {}
            : { materialShaderBindingContract: input.materialShaderBindingContract }),
        }),
      this.batch.stageEvents,
      this.batch.errors,
    );
    this.nativePlanningOpen = false;
    return declared;
  }

  private createNativePlan(views: RenderFeaturePlanContext['views']) {
    const gpu = this.gpu;
    return createRenderFeatureNativePlanBuilder(
      {
        featureIdentity: this.identity,
        frameNumber: this.input.frameNumber,
        generation: this.transaction.generation,
        transaction: this.transaction,
        views,
      },
      gpu === undefined || missingCapability(this.feature, this.input.caps) !== undefined
        ? undefined
        : () => {
            const retained = createNativeResourceAdmission({
              gpu,
              frame: this.input.frameNumber,
              isActive: () => this.nativePlanningOpen,
              prepare: (resources, keys, inherited) =>
                preparePlanResources(
                  this.slot,
                  { resources, passes: [] },
                  this.transaction,
                  gpu,
                  () => [],
                  this.input.sceneResources,
                  { keys, admission: inherited },
                ),
            });
            this.nativeAdmissions ??= new Map();
            this.nativeAdmissions.set(retained.admission, retained);
            return retained.admission;
          },
    );
  }

  // The private wrapper identity is the protocol. Raw author objects never
  // acquire a new property read (including an unknown `native` accessor).
  private consumeNativePlan(
    plan: RenderFeaturePlan,
    views: RenderFeaturePlanContext['views'],
  ): void {
    if (!isRenderFeatureNativePlan(plan)) return;
    try {
      this.nativeWork = consumeRenderFeatureNativePlan(plan, {
        featureIdentity: this.identity,
        frameNumber: this.input.frameNumber,
        generation: this.transaction.generation,
        transaction: this.transaction,
        views,
      });
      if (this.nativeWork === undefined)
        this.nativeFailure = new Error('Invalid native Feature frame authority');
    } catch (cause) {
      this.nativeFailure = cause;
    }
  }

  /** Did any native admission request preparation? Records scope violations as failure. */
  private verifyNativeAdmissions(
    declared: Result<RenderFeaturePlan, RenderError>,
    declaredWork: readonly RenderFeatureWork[],
  ): boolean {
    const nativeAdmission =
      declared.ok && this.nativeWork !== undefined
        ? renderFeatureNativeResourceAdmission(declared.value)
        : undefined;
    this.admittedResources =
      nativeAdmission === undefined ? undefined : this.nativeAdmissions?.get(nativeAdmission);
    let nativeRequiresPreparation = false;
    if (this.nativeAdmissions === undefined) return false;
    for (const admission of this.nativeAdmissions.values()) {
      nativeRequiresPreparation ||= admission.requestsPreparation();
      for (const scope of admission.usedScopes())
        if (
          admission !== this.admittedResources ||
          !declaredWork.some((work) => featureScopeKey(work.scope) === scope)
        )
          this.nativeFailure = new Error(
            'Native resource admission must finish its exact work scopes',
          );
    }
    return nativeRequiresPreparation;
  }

  private prepareAndPublish(
    plan: RenderFeaturePlan,
    declaredWork: readonly RenderFeatureWork[],
  ): void {
    this.publishInspection();
    const workResources =
      this.nativeWork === undefined
        ? resolveFeatureWorkResources(declaredWork)
        : resolveNativeFeatureWorkResources(this.nativeWork);
    this.batch.host.retainPlanScopes(
      this.slot,
      workResources.map((row) => featureScopeKey(row.work.scope)),
    );
    const targetInputs = this.validateWorkTargets(workResources);
    if (this.disableForMissingCapability(workResources)) return;
    const prepared =
      this.nativeWork === undefined
        ? preparePlanResources(
            this.slot,
            { resources: workResources.flatMap((row) => row.resources), passes: [] },
            this.transaction,
            this.gpu,
            (name) => targetInputs.get(name) ?? [],
            this.input.sceneResources,
          )
        : undefined;
    if (prepared !== undefined && !prepared.ok) throw prepared.error;
    for (const row of workResources) this.projectWorkRow(plan, row, prepared?.value);
    this.retainFrameResources();
    this.admitRequiredPostProcesses();
    this.publishProjections();
    this.batch.featureHiddenEntityReports.push(...this.reports);
    this.plan = plan;
    this.batch.prepared.push(this);
    this.batch.host.setStatus(this.identity, 'active');
  }

  /**
   * Validate each work row's scope and map every raw resource name to its view
   * targets. A native row prepares only its own scoped names, which all read
   * that row's view targets, so native rows validate scopes without a map.
   */
  private validateWorkTargets(
    workResources: readonly FeatureWorkResources[],
  ): ReadonlyMap<string, readonly RenderFeatureTargetHandle[]> {
    if (workResources.length === 0) return NO_TARGET_INPUTS;
    if (this.nativeWork !== undefined) {
      for (const row of workResources) this.workView(row.work);
      return NO_TARGET_INPUTS;
    }
    const targetInputs = new Map<string, readonly RenderFeatureTargetHandle[]>();
    for (const row of workResources) {
      const view = this.workView(row.work);
      const valid = validateRenderFeaturePlan(
        this.identity,
        row.closure,
        view === undefined ? [] : this.batch.viewLogicalTargets(view),
      );
      if (!valid.ok) throw valid.error;
      for (const resource of row.resources) targetInputs.set(resource.name, view?.targets ?? []);
    }
    return targetInputs;
  }

  /** Resolve the view a work row belongs to, rejecting scopes it may not declare. */
  private workView(work: RenderFeatureWork): RenderFeatureFrameInput | undefined {
    const workScope = work.scope;
    if (workScope !== 'frame' && work.resources.some(isRenderFeatureSceneResource))
      throw new Error('Scene inputs belong to frame-scoped work');
    const view =
      workScope === 'frame'
        ? undefined
        : this.batch.inputs.find((candidate) => candidate.identity === workScope.view);
    if (work.scope !== 'frame' && view === undefined)
      throw new Error('Feature work references a missing view');
    if (view?.render === false && work.passes.length > 0)
      throw new Error('held views cannot declare render work');
    return view;
  }

  private disableForMissingCapability(workResources: readonly FeatureWorkResources[]): boolean {
    const missing = missingCapability(this.feature, this.input.caps);
    if (missing === undefined || !workResources.some((row) => hasActivePlan(row.closure)))
      return false;
    if (this.requiresPreparation) this.batch.markPreparationPending(this.identity, 'capability');
    const failure = new RenderFeatureCapabilityMissingError(
      this.identity,
      this.slot.order,
      missing,
    );
    this.batch.errors.push(failure);
    this.cleanupPreparation([() => this.abortResources(), () => this.abortProducerFrame()], 'plan');
    this.batch.host.setStatus(this.identity, 'disabled', errorDescriptor(failure));
    return true;
  }

  private projectWorkRow(
    plan: RenderFeaturePlan,
    row: FeatureWorkResources,
    rawPrepared: PreparedPlanResources | undefined,
  ): void {
    const scope = row.work.scope;
    const viewInput =
      scope === 'frame'
        ? undefined
        : this.batch.inputs.find((view) => view.identity === scope.view);
    const result = scope === 'frame' ? this.batch.shared : this.batch.views.get(scope.view);
    if (result === undefined) throw new Error('unregistered Feature work scope');
    const effects = fullscreenProgramEffects(row.closure, this.identity);
    const scoped = this.scopedResources(row, viewInput?.targets ?? [], rawPrepared);
    const resolveGraphics =
      row.native !== true ||
      row.closure.passes.some((pass) => pass.kind === 'raster' || pass.kind === 'shadow-caster')
        ? (viewInput ?? this.input).createPreparedGraphicsResolver
        : undefined;
    const resolver = resolveGraphics?.({
      featureIdentity: this.identity,
      order: this.slot.order,
      generation: this.transaction.generation,
      ...(this.feature.shaderModuleMode === undefined
        ? {}
        : { shaderModuleMode: this.feature.shaderModuleMode }),
      transaction: this.transaction,
      fullscreenEffects: effects,
      lookup: (reference) => this.transaction.lookup(reference),
    });
    if (resolver !== undefined) this.resolvers.push(resolver);
    const batchesDepth =
      row.native === true &&
      scope !== 'frame' &&
      viewInput?.featureReadOnlyDepthBatchDiagnostic === true;
    const projectionPlan =
      batchesDepth && resolver !== undefined && renderFeatureNativeDepthBatchPermission(plan)
        ? {
            ...row.closure,
            passes: coalesceNativeReadOnlyDepthPasses(
              row.closure.passes,
              readOnlyDepthPrograms(scoped, this.transaction, resolver),
            ),
          }
        : row.closure;
    const projected = projectPlanPasses(
      this.slot,
      projectionPlan,
      scoped,
      this.gpu,
      viewInput?.targets ?? [],
      graphicsValidator(this.identity, this.transaction, true),
      resolver === undefined ? undefined : this.graphicsSnapshotResolver(resolver, scoped, row),
    );
    if (!projected.ok) throw projected.error;
    if (batchesDepth)
      this.batch.host.recordDepthBatchInspection(
        row.closure.passes.length,
        projectionPlan.passes.length,
        projected.value.passes.length,
      );
    this.checkProjectedPasses(row, projectionPlan, projected.value);
    const scopeKey = featureScopeKey(scope);
    const planned = this.plannedFrame(row, projectionPlan, projected.value, scopeKey);
    this.projections.push({
      planned,
      projected: { ...projected.value, scope: scopeKey },
      result,
      effects,
      requiresGraphRebuild: this.requiresGraphRebuild(
        row,
        projectionPlan,
        projected.value,
        resolver,
      ),
    });
  }

  /** Native rows prepare their own namespace; raw rows share one scoped copy of the plan. */
  private scopedResources(
    row: FeatureWorkResources,
    rowTargets: readonly RenderFeatureTargetHandle[],
    rawPrepared: PreparedPlanResources | undefined,
  ): PreparedPlanResources {
    const scope = row.work.scope;
    if (!row.native) {
      if (rawPrepared === undefined) throw new Error('Missing raw Feature preparation');
      // The shared empty projection has no namespace to detach. Still invoke
      // raw graphics resolvers: their callbacks remain observable on empty work.
      if (rawPrepared === EMPTY_PREPARED_RESOURCES) return rawPrepared;
      this.scopeResources ??= createPreparedResourceScopes(rawPrepared);
      return this.scopeResources(row.keys);
    }
    const admission = this.admittedResources?.prepared(scope);
    const localPrepared = preparePlanResources(
      this.slot,
      { resources: row.resources, passes: [] },
      this.transaction,
      this.gpu,
      () => rowTargets,
      this.input.sceneResources,
      {
        keys: row.keys,
        ...(this.sharedPrepared === undefined ? {} : { shared: this.sharedPrepared }),
        ...(admission === undefined ? {} : { admission }),
      },
    );
    if (!localPrepared.ok) throw localPrepared.error;
    if (scope === 'frame') this.sharedPrepared = localPrepared.value;
    return localPrepared.value;
  }

  private graphicsSnapshotResolver(
    resolver: PreparedGraphicsResolver,
    scoped: PreparedPlanResources,
    row: FeatureWorkResources,
  ) {
    const gpu = this.gpu;
    return (
      descriptor: RenderFeatureGraphicsPassDescriptor,
      passName: string,
    ): Result<PreparedGraphicsResolvedSnapshot, RenderError> =>
      resolveGraphicsSnapshot(
        resolver,
        descriptor,
        this.transaction.generation,
        (name) => {
          const owned = scoped.buffers.get(name);
          const borrowed = scoped.preparedGpuResources.get(name);
          const reference = owned ?? (borrowed?.kind === 'buffer' ? borrowed.reference : undefined);
          return reference === undefined ? undefined : gpu?.resolveBuffer(reference);
        },
        row.native === true,
        (reference, error) => this.markPipelinePending(reference, error, passName),
      );
  }

  private markPipelinePending(
    reference: PreparedGraphicsReference,
    error: RenderError,
    passName: string,
  ): void {
    if (
      this.batch.preparationPending ||
      !this.requiresPreparation ||
      !(error instanceof RenderFeaturePreparationFailedError) ||
      error.detail.reason !== 'pipeline-pending'
    )
      return;
    const item = this.transaction.lookup(reference);
    this.batch.markPreparationPending(this.identity, 'graphics-pipeline', error, {
      pass: passName,
      ...(item?.descriptor?.kind === 'pipeline' ? { shader: item.descriptor.shader } : {}),
    });
  }

  private checkProjectedPasses(
    row: FeatureWorkResources,
    projectionPlan: RenderFeatureWorkPlan,
    projected: RenderFeaturePlanExecution,
  ): void {
    if (this.requiresPreparation && projected.passes.length !== projectionPlan.passes.length)
      this.batch.markPreparationPending(this.identity, 'plan-projection');
    if (row.work.scope === 'frame' && projected.passes.length !== row.work.passes.length)
      throw new RenderFeaturePreparationFailedError(
        this.identity,
        this.slot.order,
        'frame',
        'pipeline',
        'shared-work',
        'pipeline-pending',
        'next-frame',
      );
  }

  private plannedFrame(
    row: FeatureWorkResources,
    projectionPlan: RenderFeatureWorkPlan,
    projected: RenderFeaturePlanExecution,
    scopeKey: string,
  ): RenderFeaturePlannedFrame {
    const host = this.batch.host;
    const feature = this.feature;
    return Object.freeze({
      featureIdentity: this.identity,
      scope: row.work.scope,
      generation: this.transaction.generation,
      signature: row.native
        ? host.nativeExecutionSignature(this.slot, { ...projected, scope: scopeKey }, scopeKey)
        : host.planSignature(this.slot, row.closure, scopeKey),
      plan: projectionPlan,
      ...(feature.placement === undefined ? {} : { placement: feature.placement }),
      ...(feature.viewGraph === undefined ? {} : { viewGraph: feature.viewGraph }),
    });
  }

  private requiresGraphRebuild(
    row: FeatureWorkResources,
    projectionPlan: RenderFeatureWorkPlan,
    projected: RenderFeaturePlanExecution,
    resolver: PreparedGraphicsResolver | undefined,
  ): boolean {
    const changed = this.gpu?.changedResourceNames;
    return (
      projected.passes.length !== projectionPlan.passes.length ||
      (resolver?.requiresGraphRebuild ?? (resolver?.leases.length ?? 0) > 0) ||
      (changed !== undefined &&
        changed.size > 0 &&
        row.closure.resources.some((resource) => {
          const name = row.keys.get(resource.name);
          return name !== undefined && changed.has(name);
        }))
    );
  }

  private retainFrameResources(): void {
    // A held view keeps its committed resources without planning or executing work.
    // Removed views are absent from the roster and retire through the usual fence.
    this.transaction.retainResources(this.batch.belongsToHeldView);
    this.gpu?.retainResources(this.batch.belongsToHeldView);
    for (const item of this.transaction.committedItems()) {
      const descriptor = item.descriptor;
      if (
        (descriptor?.kind === 'vertex-data' || descriptor?.kind === 'index-data') &&
        descriptor.buffer !== undefined
      )
        this.gpu?.resolveBuffer(descriptor.buffer);
    }
    if (this.resolvers.length === 0) return;
    const leases = [...new Set(this.resolvers.flatMap((resolver) => resolver.leases))];
    const retained = this.batch.host.retainPreparedGraphics(this.identity, leases);
    if (!retained.ok) throw retained.error;
    if (leases.length > 0) this.batch.preparedResourceBatches.push(retained.value);
  }

  // Prewarm declarations do not admit inactive or rejected fullscreen work.
  private admitRequiredPostProcesses(): void {
    if (this.projections.length === 0) return;
    for (const postProcess of this.feature.requiredFullscreenPostProcesses ?? []) {
      if (this.projections.some(({ effects }) => effects.has(postProcess.identity)))
        this.batch.postProcessIdentities.add(postProcess.identity);
    }
  }

  private publishProjections(): void {
    for (const { planned, projected, result, effects, requiresGraphRebuild } of this.projections) {
      planExecutionProjections.set(planned, {
        execution: projected,
        ...(this.nativeWork === undefined ? {} : { nativeSignature: planned.signature }),
      });
      if (isSubmissionSensitive(this.feature, planned)) submissionSensitivePlans.add(planned);
      (result.plans as RenderFeaturePlannedFrame[]).push(planned);
      for (const [key, entry] of effects)
        (result.fullscreenEffects as Map<string, PostProcessShaderEntry>).set(key, entry);
      if (requiresGraphRebuild) {
        preparedResourceKeyPlans.add(planned);
        Object.assign(result, { requiresPreparedResourceKey: true });
      }
    }
  }

  /** Seal this frame's prepared resources once; queue-retired leases wait for completion. */
  commitResources(): void {
    if (this.resourcesCommitted) return;
    const committed = this.transaction.commit();
    if (!committed.ok) throw committed.error;
    const retired = this.gpu?.commitFrame() ?? [];
    this.resourcesCommitted = true;
    if (retired.length > 0) {
      const retained = this.batch.host.retainPreparedGraphics(this.identity, retired);
      if (!retained.ok) throw retained.error;
      this.batch.preparedResourceBatches.push(retained.value);
    }
  }

  /** Discard this frame's resources and producer frame data. */
  abort(): void {
    drainFeatureFinalizers([() => this.abortResources(), () => this.abortProducerFrame()]);
  }

  /** Producer consumption for the works the submitted graph actually recorded. */
  submit(): void {
    const plan = this.plan;
    let accepted: FeatureWorkProjection[] | undefined;
    for (const row of this.projections)
      if (this.batch.submittedWorks.has(row.planned)) {
        accepted ??= [];
        accepted.push(row);
      }
    if (accepted === undefined) {
      this.abort();
      return;
    }
    drainFeatureFinalizers([
      () =>
        this.feature.onFrameSubmitted?.(this.source, {
          works: accepted.map((row) => ({
            scope: row.planned.scope,
            passes: submittedPasses(row.projected),
          })),
        }),
      () => this.publishInspection(),
      () => {
        if (accepted.some((row) => row.planned.scope === 'frame'))
          this.acknowledgeSourceFrame(plan);
      },
    ]);
  }

  private acknowledgeSourceFrame(plan: RenderFeaturePlan): void {
    if (this.input.publishedFeatures?.some((row) => row.identity === this.identity))
      this.input.onFeatureSourceSubmitted?.(this.identity, plan.sourceFeedback);
    else this.feature.onSourceFrameSubmitted?.(this.source, plan.sourceFeedback);
  }
}

function extractView(view: RenderFeatureFrameInput) {
  return Object.freeze({
    identity: view.identity,
    render: view.render,
    ...(view.selectedCamera === undefined ? {} : { selectedCamera: view.selectedCamera }),
    ...(view.selectedView === undefined ? {} : { selectedView: view.selectedView }),
    ...(view.frame === undefined ? {} : { frame: view.frame }),
    ...(view.frameSize === undefined ? {} : { frameSize: view.frameSize }),
    ...(view.motionBlur === undefined ? {} : { motionBlur: view.motionBlur }),
  });
}

/** Does any declared program ask for pipeline compilation before it is ready? */
function workRequestsPipelinePreparation(works: readonly RenderFeatureWork[]): boolean {
  return works.some((work) =>
    work.resources.some(
      (resource) =>
        (resource.kind === 'graphics-program' && resource.program.preparePipelines === true) ||
        (resource.kind === 'compute-program' && resource.preparePipelines === true),
    ),
  );
}

const NO_FULLSCREEN_EFFECTS: ReadonlyMap<string, PostProcessShaderEntry> = new Map();

function fullscreenProgramEffects(
  plan: RenderFeatureWorkPlan,
  identity: string,
): ReadonlyMap<string, PostProcessShaderEntry> {
  if (plan.resources.length === 0) return NO_FULLSCREEN_EFFECTS;
  const effects = new Map<string, PostProcessShaderEntry>();
  for (const resource of plan.resources) {
    if (resource.kind !== 'fullscreen-program') continue;
    const { kind: _kind, name, ...entry } = resource;
    effects.set(name, entry);
    if (!effects.has(identity)) effects.set(identity, entry);
  }
  return effects;
}

/** Graphics programs whose resolved pipeline never writes depth or stencil. */
function readOnlyDepthPrograms(
  scoped: PreparedPlanResources,
  transaction: PreparedGraphicsTransaction,
  resolver: PreparedGraphicsResolver,
): Set<string> {
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
    if (current.ok && current.value.kind === 'pipeline' && current.value.writesDepth === false)
      readOnlyPrograms.add(name);
  }
  return readOnlyPrograms;
}

/** Plans with producer callbacks or GPU-resident payloads must not be replayed from cache. */
function isSubmissionSensitive(
  feature: RenderFeature<unknown>,
  planned: RenderFeaturePlannedFrame,
): boolean {
  return (
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
  );
}

/** Enabled passes and draws a producer actually had recorded for it. */
function submittedPasses(projected: RenderFeaturePlanExecution) {
  return projected.passes
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
    );
}

/** Producer failures cannot strand sibling transactions or suppress accepted source receipts. */
/** Run each action on every item (one action at a time), then throw all failures together. */
function drainEach<T>(items: readonly T[], ...actions: ((item: T) => void)[]): void {
  let failures: unknown[] | undefined;
  for (const action of actions)
    for (const item of items) {
      try {
        action(item);
      } catch (cause) {
        failures ??= [];
        failures.push(cause);
      }
    }
  if (failures !== undefined)
    throw new AggregateError(failures, 'Feature frame finalization failed');
}

function drainFeatureFinalizers(actions: readonly (() => void)[]): void {
  drainEach(actions, (action) => action());
}

function mergeHiddenEntityReports(
  reports: readonly RenderFeatureHiddenEntityReport[],
  additional: readonly RenderFeatureHiddenEntityReport[],
): readonly RenderFeatureHiddenEntityReport[] {
  if (reports.length === 0 && additional.length === 0) return NO_HIDDEN_ENTITY_REPORTS;
  const entitiesByWorld = new WeakMap<object, Set<EntityHandle>>();
  const merged: RenderFeatureHiddenEntityReport[] = [];
  for (const report of additional.length === 0 ? reports : [...reports, ...additional]) {
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

const NO_HIDDEN_ENTITY_REPORTS: readonly RenderFeatureHiddenEntityReport[] = Object.freeze([]);

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

  return ok(new FeatureHostImpl(features.map(createFeatureSlot)));
}
