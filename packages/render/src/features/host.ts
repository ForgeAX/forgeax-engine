import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
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
import type { CameraSnapshot } from '../render-contract';
import { isSceneDataTarget, type SceneDataTarget } from '../temporal/scene-data';
import { createSceneDataCatalog, type SceneDataCatalog } from '../temporal/scene-data-catalog';
import { featureScopeKey, resolveFeatureWorkResources } from './frame-plan';
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
  RenderFeatureGpuBindingsRef,
  RenderFeatureGpuBufferRef,
  RenderFeatureGpuComputePassDescriptor,
  RenderFeatureGpuPreparedResourceRef,
  RenderFeatureGpuPrepareSession,
  RenderFeatureGpuProgramRef,
  RenderFeatureGpuWorkOwner,
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
  RenderFeaturePlanExecution
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

/** @internal Typed-graph adapter for the host-owned projection of a validated plan. */
export function getRenderFeaturePlanExecutionProjection(
  planned: RenderFeaturePlannedFrame,
): RenderFeaturePlanExecution | undefined {
  return planExecutionProjections.get(planned);
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
  readonly limits?: Readonly<{ maxSampledTexturesPerShaderStage?: number }>;
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
  /** Host-owned signature entry point so accounting remains per feature. */
  readonly recordPlanSignature?: (
    identity: string,
    plan: RenderFeatureWorkPlan,
    scope?: string,
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
): RenderFeatureGraphicsPrepare {
  return {
    preparePipeline: (name, descriptor) => transaction.prepare('pipeline', name, descriptor),
    prepareBindings: (name, descriptor) => transaction.prepare('bindings', name, descriptor),
    prepareVertexData: (name, descriptor) => transaction.prepare('vertex-data', name, descriptor),
    prepareIndexData: (name, descriptor) => transaction.prepare('index-data', name, descriptor),
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
): Result<PreparedGraphicsResolvedSnapshot, RenderError> {
  const resources = new Map<
    object,
    import('../prepare/prepared-graphics-resolver').PreparedGraphicsResolvedResource
  >();
  for (const reference of preparedGraphicsReferences(descriptor)) {
    if (resources.has(reference)) continue;
    const resolved = resolver.resolve(reference);
    if (!resolved.ok) return resolved;
    resources.set(reference, resolved.value);
  }
  return ok({
    generation,
    leases: resolver.leases,
    resolve: (reference) => resources.get(reference),
    ...(resolver.resolveGpuBuffer === undefined
      ? {}
      : { resolveGpuBuffer: resolver.resolveGpuBuffer }),
    ...(resolveGpuResource === undefined ? {} : { resolveGpuResource }),
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

interface PreparedPlanResources {
  readonly computePrograms: ReadonlyMap<string, RenderFeatureGpuProgramRef>;
  readonly graphicsPrograms: ReadonlyMap<string, RenderFeaturePreparedRef<'pipeline'>>;
  readonly buffers: ReadonlyMap<string, RenderFeatureGpuBufferRef>;
  readonly preparedGpuResources: ReadonlyMap<string, RenderFeatureGpuPreparedResourceRef>;
  readonly computeBindings: ReadonlyMap<string, RenderFeatureGpuBindingsRef>;
  readonly graphicsBindings: ReadonlyMap<string, RenderFeaturePreparedRef<'bindings'>>;
  readonly vertexData: ReadonlyMap<string, RenderFeaturePreparedRef<'vertex-data'>>;
  readonly indexData: ReadonlyMap<string, RenderFeaturePreparedRef<'index-data'>>;
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
): Result<PreparedPlanResources, RenderError> {
  const computePrograms = new Map<string, RenderFeatureGpuProgramRef>();
  const graphicsPrograms = new Map<string, RenderFeaturePreparedRef<'pipeline'>>();
  const buffers = new Map<string, RenderFeatureGpuBufferRef>();
  const preparedGpuResources = new Map<string, RenderFeatureGpuPreparedResourceRef>();
  const computeBindings = new Map<string, RenderFeatureGpuBindingsRef>();
  const graphicsBindings = new Map<string, RenderFeaturePreparedRef<'bindings'>>();
  const vertexData = new Map<string, RenderFeaturePreparedRef<'vertex-data'>>();
  const indexData = new Map<string, RenderFeaturePreparedRef<'index-data'>>();
  const byKind = <Kind extends RenderFeatureResourceDeclaration['kind']>(kind: Kind) =>
    plan.resources.filter(
      (resource): resource is Extract<RenderFeatureResourceDeclaration, { readonly kind: Kind }> =>
        resource.kind === kind,
    );

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
      resource.name,
      resource.program,
      resource.preparePipelines,
    );
    if (prepared === undefined) return err(planFailure(slot));
    if (!prepared.ok) return prepared;
    computePrograms.set(resource.name, prepared.value);
  }
  for (const resource of byKind('graphics-program')) {
    const prepared = graphics.preparePipeline(resource.name, resource.program);
    if (!prepared.ok) return prepared;
    graphicsPrograms.set(resource.name, prepared.value);
  }
  for (const resource of byKind('buffer')) {
    const prepared = gpu?.prepareBuffer(resource.name, {
      size: resource.size,
      usage: resource.usage,
      ...(resource.data === undefined ? {} : { data: resource.data }),
    });
    if (prepared === undefined) return err(planFailure(slot));
    if (!prepared.ok) return prepared;
    buffers.set(resource.name, prepared.value);
  }
  for (const resource of byKind('prepared-gpu-resource')) {
    if (gpu === undefined) return err(planFailure(slot));
    if (resource.resource.kind === 'buffer') {
      const prepared = gpu.prepareBufferResource(resource.name, resource.resource.value as Buffer, {
        size: resource.resource.size,
        usage: resource.resource.usage ?? ['uniform'],
      });
      if (!prepared.ok) return prepared;
      preparedGpuResources.set(resource.name, { kind: 'buffer', reference: prepared.value });
      continue;
    }
    if (resource.resource.kind === 'texture-view') {
      const logical =
        resource.logicalTarget === undefined
          ? undefined
          : targetHandle(resource.logicalTarget, targetsForResource(resource.name));
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
        resource.name,
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
    const prepared = gpu.prepareSampler(resource.name, resource.resource.value as Sampler);
    if (!prepared.ok) return prepared;
    preparedGpuResources.set(resource.name, { kind: 'sampler', reference: prepared.value });
  }
  for (const resource of plan.resources) {
    if (!isRenderFeatureSceneResource(resource)) continue;
    if (gpu === undefined || sceneResources === undefined) return err(planFailure(slot));
    const scene = sceneResources.prepare(slot.feature.identity, resource);
    if ('buffer' in scene) {
      const prepared = gpu.prepareBufferResource(resource.name, scene.buffer, {
        size: scene.size,
        usage: ['storage'],
      });
      if (!prepared.ok) return prepared;
      preparedGpuResources.set(resource.name, { kind: 'buffer', reference: prepared.value });
      continue;
    }
    const prepared = gpu.prepareTextureView(resource.name, scene.view, scene.target);
    if (!prepared.ok) return prepared;
    preparedGpuResources.set(resource.name, { kind: 'texture-view', reference: prepared.value });
  }
  for (const resource of byKind('compute-bindings')) {
    const program = computePrograms.get(resource.program);
    const entries = resource.entries.map((entry) => {
      const buffer = buffers.get(entry.resource);
      if (buffer !== undefined) return { binding: entry.binding, buffer } as const;
      const prepared = preparedGpuResources.get(entry.resource);
      return prepared === undefined
        ? undefined
        : ({ binding: entry.binding, resource: prepared } as const);
    });
    if (program === undefined || entries.some((entry) => entry === undefined)) {
      return err(planFailure(slot));
    }
    const prepared = gpu?.prepareBindings(resource.name, {
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
      const target = targetHandle(targetName, targetsForResource(resource.name));
      if (target === undefined || typeof target === 'string') return err(planFailure(slot));
      values[key] = target;
    }
    const prepared = graphics.prepareBindings(resource.name, { pipeline: program, values });
    if (!prepared.ok) return prepared;
    graphicsBindings.set(resource.name, prepared.value);
  }
  for (const resource of byKind('vertex-data')) {
    const descriptor =
      resource.buffer === undefined
        ? { layout: resource.layout, data: resource.data }
        : { layout: resource.layout, buffer: buffers.get(resource.buffer) };
    if ('buffer' in descriptor && descriptor.buffer === undefined) return err(planFailure(slot));
    const prepared = graphics.prepareVertexData(
      resource.name,
      descriptor as import('./prepared-graphics').RenderFeatureVertexDataDescriptor,
    );
    if (!prepared.ok) return prepared;
    vertexData.set(resource.name, prepared.value);
  }
  for (const resource of byKind('index-data')) {
    const descriptor =
      resource.buffer === undefined
        ? { format: resource.format, data: resource.data }
        : { format: resource.format, buffer: buffers.get(resource.buffer) };
    if ('buffer' in descriptor && descriptor.buffer === undefined) return err(planFailure(slot));
    const prepared = graphics.prepareIndexData(
      resource.name,
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
    const resolved = resolveGraphics?.(descriptor);
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
    const cache = this.signatureCacheByFeature.get(identity);
    if (cache !== undefined)
      for (const scope of cache.keys()) if (!scopes.includes(scope)) cache.delete(scope);
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
      signatures: Object.freeze(
        [...this.signatureByFeature.values()]
          .sort((left, right) => left.featureIdentity.localeCompare(right.featureIdentity))
          .map((entry) => Object.freeze({ ...entry })),
      ),
      prepared: Object.freeze({ ...this.preparedInspection }),
    });
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
    for (const [order, remaining] of this.slots.entries()) remaining.order = order;
    this.publishDiagnosticsChanged();
    return firstError === undefined ? ok(undefined) : err(firstError);
  }

  advancePreparedGeneration(): number {
    if (this.disposed) return this.generation;
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
  let preparationPending = false;
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
    try {
      sourceRequiresPreparation = feature.requiresPreparation?.(extracted.value) === true;
    } catch (cause) {
      // A declared readiness guard cannot fail open before plan resources exist.
      preparationPending = true;
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
    const declared = invokeStage(
      slot,
      'plan',
      () =>
        feature.plan(extracted.value, {
          getFeatureShaderSource: input.getFeatureShaderSource,
          resolveAsset:
            input.resolveAsset ??
            ((index, handle) => {
              const world = input.worlds[index];
              return world === undefined
                ? err(new Error(`Missing feature asset source ${index}`))
                : resolveAssetHandle(world, handle);
            }),
          caps: input.caps,
          ...renderMaterialContext(input.caps, input.limits),
          frame: { frameNumber: input.frameNumber },
          generation: transaction.generation,
          views,
          ...(input.materialShaderBindingContract === undefined
            ? {}
            : { materialShaderBindingContract: input.materialShaderBindingContract }),
        }),
      stageEvents,
      errors,
    );
    const resolvers: PreparedGraphicsResolver[] = [];
    const featurePlans: RenderFeaturePlannedFrame[] = [];
    const projections: {
      planned: RenderFeaturePlannedFrame;
      projected: RenderFeaturePlanExecution;
      result: RenderFeatureFrameResult;
      effects: Map<string, PostProcessShaderEntry>;
      requiresGraphRebuild: boolean;
    }[] = [];
    const requiresPreparation =
      sourceRequiresPreparation ||
      (declared.ok &&
        declared.value.work.some((work) =>
          work.resources.some(
            (resource) =>
              (resource.kind === 'graphics-program' &&
                resource.program.preparePipelines === true) ||
              (resource.kind === 'compute-program' && resource.preparePipelines === true),
          ),
        ));
    const fail = (error?: unknown) => {
      if (requiresPreparation) preparationPending = true;
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
      fail();
      continue;
    }
    try {
      publishInspection();
      const workResources = resolveFeatureWorkResources(declared.value.work);
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
        const frozen = freezeRenderFeaturePlan(
          identity,
          row.closure,
          logicalTargets(view?.targets ?? []),
        );
        if (!frozen.ok) throw frozen.error;
        for (const resource of row.resources) targetInputs.set(resource.name, view?.targets ?? []);
      }
      const missing = missingCapability(feature, input.caps);
      if (missing !== undefined && workResources.some((row) => hasActivePlan(row.closure))) {
        if (requiresPreparation) preparationPending = true;
        const failure = new RenderFeatureCapabilityMissingError(identity, order, missing);
        errors.push(failure);
        cleanupPreparation(
          [abortResources, () => feature.onFrameAborted?.(extracted.value)],
          'plan',
        );
        host.setStatus(identity, 'disabled', errorDescriptor(failure));
        continue;
      }
      const prepared = preparePlanResources(
        slot,
        { resources: workResources.flatMap((row) => row.resources), passes: [] },
        createPreparedGraphicsPrepare(transaction),
        gpu,
        (name) => targetInputs.get(name) ?? [],
        input.sceneResources,
      );
      if (!prepared.ok) throw prepared.error;
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
        if (scopeResources === undefined)
          scopeResources = createPreparedResourceScopes(prepared.value);
        const scoped = scopeResources(row.keys);
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
        const projected = projectPlanPasses(
          slot,
          row.closure,
          scoped,
          gpu,
          viewInput?.targets ?? [],
          graphicsValidator(identity, transaction, true),
          resolver === undefined
            ? undefined
            : (descriptor) =>
                resolveGraphicsSnapshot(resolver, descriptor, transaction.generation, (name) => {
                  const owned = scoped.buffers.get(name);
                  const borrowed = scoped.preparedGpuResources.get(name);
                  const reference =
                    owned ?? (borrowed?.kind === 'buffer' ? borrowed.reference : undefined);
                  return reference === undefined ? undefined : gpu?.resolveBuffer(reference);
                }),
        );
        if (!projected.ok) throw projected.error;
        if (requiresPreparation && projected.value.passes.length !== row.closure.passes.length)
          preparationPending = true;
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
          signature:
            host.recordPlanSignature?.(identity, row.closure, scopeKey) ??
            renderFeaturePlanSignature(row.closure),
          plan: row.closure,
          ...(feature.placement === undefined ? {} : { placement: feature.placement }),
        });
        featurePlans.push(planned);
        projections.push({
          planned,
          projected: { ...projected.value, scope: scopeKey },
          result,
          effects,
          requiresGraphRebuild:
            projected.value.passes.length !== row.closure.passes.length ||
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
        planExecutionProjections.set(planned, projected);
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
        if (requiresGraphRebuild) Object.assign(result, { requiresPreparedResourceKey: true });
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
      ...(preparationPending ? { preparationPending: true } : {}),
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
