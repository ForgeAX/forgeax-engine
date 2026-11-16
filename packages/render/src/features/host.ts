import { type AssetVersion, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';

import type { EntityHandle, World } from '@forgeax/engine-ecs';

import type { Buffer, RhiCaps, Sampler, TextureFormat, TextureView } from '@forgeax/engine-rhi';

import { type Asset, err, ok, type Result } from '@forgeax/engine-types';

import { featureRecordsInCapture } from '../capture/feature-policy';

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

import type {
  CameraSnapshot,
  FrameDomainObservation,
  FramePresentationPendingReason,
  FrameReceipt,
  RenderResult,
} from '../render-contract';

import {
  isSceneDataTarget,
  type SceneDataTarget,
  type StandardSceneSurfaceAdmission,
} from '../temporal/scene-data';

import { createSceneDataCatalog, type SceneDataCatalog } from '../temporal/scene-data-catalog';

import { releaseSharedFeatureGraphHistory } from '../world/feature-graph-systems';

import {
  addRenderFeatureSystem,
  bindRenderFeatureFrame,
  type FeatureSettlementReporter,
  renderFeatureAdmissionProfileWork,
  renderFeaturePlanProfileWork,
  renderFeatureProfileWorkNames,
} from '../world/feature-systems';

import { createRenderWorld } from '../world/render-world';

import {
  type FeatureGraphConformanceTraceState,
  isFeatureGraphConformanceEnabled,
  recordFeatureGraphConformanceEvent,
} from './feature-graph-conformance-trace';

import {
  type FeatureWorkResources,
  featureResourceAllocationScope,
  featureScopeKey,
  NativeFeatureWorkRouting,
  resolveFeatureWorkResources,
} from './frame-plan';

import { fullscreenRenderFeatureDeclaration } from './fullscreen';

import { isOwnedHiddenEntityReports, NO_HIDDEN_ENTITY_REPORTS } from './hidden-entity-reports';

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
  type RenderFeaturePlan,
  type RenderFeaturePlanContext,
  type RenderFeaturePlannedFrame,
  type RenderFeaturePlanSignatureMetrics,
  type RenderFeaturePlanView,
  type RenderFeatureResourceDeclaration,
  type RenderFeatureSceneResource,
  type RenderFeatureWork,
  type RenderFeatureWorkPlan,
  type RenderFeatureWorkScope,
  rememberRenderFeaturePlanSignature,
  renderFeaturePlanSignature,
  validateRenderFeaturePlan,
} from './plan';

import {
  consumeRenderFeatureNativePlan,
  createRenderFeatureNativePlanBuilder,
  isRenderFeatureNativePlan,
  type RenderFeatureGpuBufferRef,
  type RenderFeatureGpuComputePassDescriptor,
  type RenderFeatureGpuPrepareSession,
  type RenderFeatureGpuWorkOwner,
  type RenderFeatureNativeResourceAdmission,
  renderFeatureNativeDepthBatchPermission,
  renderFeatureNativeResourceAdmission,
} from './prepared-gpu-work';

import type {
  RenderFeatureGraphicsPassDescriptor,
  RenderFeatureGraphicsPrepare,
  RenderFeaturePreparedGraphicsState,
} from './prepared-graphics';

import {
  createPreparedGraphicsStore,
  type PreparedGraphicsTransaction,
} from './prepared-graphics-store';

import {
  captureRenderFeatureSource,
  type RenderFeatureSource,
  restoreRenderFeatureSourceFailure,
} from './source';

import {
  createRenderFeatureGraphTextureTarget,
  isRenderFeatureGraphTextureTarget,
  isRenderFeatureTargetHandle,
  logicalRenderFeatureTargets,
} from './targets';

import type { RenderFeatureTextureReference } from './texture-source';

import type {
  RenderFeature,
  RenderFeatureCapabilityKey,
  RenderFeatureCleanupFailure,
  RenderFeatureDiagnostics,
  RenderFeatureErrorDescriptor,
  RenderFeatureExtractContext,
  RenderFeatureHiddenEntityReport,
  RenderFeatureProfileGraphPass,
  RenderFeatureRecoverInput,
  RenderFeatureShaderModuleMode,
  RenderFeatureStatus,
  RenderFeatureSubmission,
  RenderFeatureTargetHandle,
} from './types';

const submissionSensitivePlans = new WeakSet<RenderFeaturePlannedFrame>();

/** A cached command graph must not replay a producer's already-consumed intents. */
export function hasSubmissionSensitiveFeatures(
  plans: readonly RenderFeaturePlannedFrame[],
): boolean {
  return plans.some((plan) => submissionSensitivePlans.has(plan));
}

/** Name routes belong to this exact Host projection, never to borrowed execution records. */
class AcceptedRenderFeatureExecution implements RenderFeaturePlanExecution {
  readonly submission?: 'atomic';
  readonly scope: string;
  readonly featureIdentity: string;
  readonly order: number;
  readonly placement?: import('./types').RenderFeaturePlacement;
  readonly materialTextureTargets: readonly RenderFeatureTargetHandle[];
  readonly passes: readonly RenderFeaturePlanExecutionPass[];
  #passesByName: Map<string, RenderFeaturePlanExecutionPass> | undefined;

  constructor(execution: RenderFeaturePlanExecution, scope: string) {
    if (execution.submission !== undefined) this.submission = execution.submission;
    this.scope = scope;
    this.featureIdentity = execution.featureIdentity;
    this.order = execution.order;
    if (execution.placement !== undefined) this.placement = execution.placement;
    this.materialTextureTargets = Object.freeze([...(execution.materialTextureTargets ?? [])]);
    this.passes = execution.passes;
    for (const pass of this.passes) Object.freeze(pass);
    Object.freeze(this);
  }

  static find(
    execution: RenderFeaturePlanExecution,
    name: string,
  ): RenderFeaturePlanExecutionPass | undefined {
    if (!(#passesByName in execution)) return execution.passes.find((pass) => pass.name === name);
    if (execution.#passesByName === undefined) {
      const passes = new Map<string, RenderFeaturePlanExecutionPass>();
      for (const pass of execution.passes) if (!passes.has(pass.name)) passes.set(pass.name, pass);
      execution.#passesByName = passes;
    }
    return execution.#passesByName.get(name);
  }
}

/** Use fixed Host routes or the ordinary live read for custom/borrowed executions. */
export function findRenderFeatureExecutionPass(
  execution: RenderFeaturePlanExecution,
  name: string,
): RenderFeaturePlanExecutionPass | undefined {
  return AcceptedRenderFeatureExecution.find(execution, name);
}

const preparedResourceKeyPlans = new WeakSet<RenderFeaturePlannedFrame>();

/** Physical imports that cannot be retained by a graph across this plan replacement. */
export function renderFeaturePlanRequiresPreparedResourceKey(
  plan: RenderFeaturePlannedFrame,
): boolean {
  return preparedResourceKeyPlans.has(plan);
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

export interface RenderFeatureFrameInput {
  /** @internal Bound to the live Render World only while a nested profile scope is active. */
  readonly beginProfileWork?: (
    work: string,
  ) => import('@forgeax/engine-ecs').ScheduleWorkScope | undefined;
  readonly resolveAsset?: import('./plan').RenderFeaturePlanContext['resolveAsset'];
  readonly sourceFeatures?: readonly RenderFeatureSource[];
  readonly publishedFeatures?: import('../publication/contract').RenderPublication['features'];
  readonly onFeatureSourceSubmitted?: (
    identity: string,
    feedback: unknown,
    submission?: RenderFeatureSubmission,
  ) => void;
  readonly identity: string;
  readonly render: boolean;
  /** Set on capture-face views; Features whose `capture` policy excludes the kind see the view held. */
  readonly captureKind?: import('../capture/feature-policy').CaptureFaceKind;
  readonly resolveResidentTextureView?: import('./plan').RenderFeaturePlanContext['resolveResidentTextureView'];
  readonly graphResources?: import('./types').RenderFeatureGraphResourceState;
  readonly motionBlur?: import('./motion-blur/motion-blur-feature').MotionBlurFeatureInput;
  readonly world: import('@forgeax/engine-ecs').World | undefined;
  readonly frameNumber: number;
  /** @internal RenderSystem-local frame number for focused conformance traces. */
  readonly recordFrameNumber?: number;
  /** @internal Default-off trace state; only target-feature facts are retained. */
  readonly featureGraphConformanceTrace?: FeatureGraphConformanceTraceState;
  /** Renderer-selected display camera forwarded to feature extraction. */
  readonly selectedCamera?: CameraSnapshot;
  readonly selectedView?: import('./types').RenderFeatureExtractView['selectedView'];
  /** Physical render extent for bounded feature dispatch sizing. */
  readonly frameSize?: { readonly width: number; readonly height: number };
  readonly visibilitySnapshot?: import('../extract/visibility').VisibilitySnapshot | undefined;
  /** Immutable extent selected by the same view owner that builds the graph. */
  readonly renderExtent?: import('../pipeline/render-extent').RenderExtent;
  readonly hiddenEntityReports?: readonly RenderFeatureHiddenEntityReport[];
  /** Active-pipeline logical targets available to producer-owned features. */
  readonly targets?: readonly RenderFeatureTargetHandle[];
  /** Optional renderer-owned semantic catalog for the current plan generation. */
  readonly sceneData?: SceneDataCatalog;
  /** Immutable Standard producer admission from the selected record view. */
  readonly surfaceAdmission?: StandardSceneSurfaceAdmission;
  readonly deviceGeneration?: number;
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
        /** Open the Renderer frame's scene-input transaction before any Feature prepares. */
        begin(frameNumber: number): void;
        /** Settle the transaction once the frame's submission was accepted or abandoned. */
        complete(submitted: boolean, completion?: Promise<unknown>): void;
      }
    | undefined;
  readonly createPreparedGraphicsResolver?: (
    input: RenderFeaturePreparedGraphicsResolverInput,
  ) => PreparedGraphicsResolver;
  /** Single renderer-owned GPU preparation owner for all feature sessions. */
  readonly gpuWork?: RenderFeatureGpuWorkOwner;
}

export interface RenderFeaturePreparedGraphicsResolverInput {
  readonly assetVersion?: (
    worldIndex: number,
    handle: number,
    revision: number,
  ) => Asset | undefined;
  readonly featureIdentity: string;
  readonly order: number;
  readonly generation: number;
  readonly viewIdentity?: string;
  readonly frameGeneration?: number;
  readonly deviceGeneration?: number;
  readonly graphicsBindings?: ReadonlyMap<
    string,
    import('./prepared-graphics').RenderFeaturePreparedRef<'bindings'>
  >;
  /** Shader preparation policy selected by the owning feature. */
  readonly shaderModuleMode?: RenderFeatureShaderModuleMode;
  readonly transaction: PreparedGraphicsTransaction;
  readonly fullscreenEffects: ReadonlyMap<string, PostProcessShaderEntry>;
  readonly lookup: (
    reference: import('./prepared-graphics').RenderFeaturePreparedRef,
  ) => import('./prepared-graphics-store').PreparedGraphicsItem | undefined;
}

export interface RenderFeatureHost {
  readonly size: number;
  readonly features: readonly RenderFeature<unknown>[];
  feature(identity: string): RenderFeature<unknown> | undefined;
  readonly preparedGeneration: number;
  captureSource(
    context: RenderFeatureExtractContext & {
      readonly caps: Readonly<RhiCaps>;
    },
  ): readonly RenderFeatureSource[];
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
  /** @internal Current bounded compiled names; aggregation filters scopes without renaming passes. */
  profileGraphPasses(viewScopes: readonly string[]): readonly RenderFeatureProfileGraphPass[];
  /**
   * The Render World holding one `render-feature:<id>` RenderPrepare system
   * per installed Feature, between `render-feature-open` and `render-feature-batch`.
   */
  readonly world: World;
  /** Open one Renderer frame over its complete view roster; Features join it one by one. */
  beginFrame(inputs: readonly RenderFeatureFrameInput[]): RenderFeatureFrameOpen;
  /** Extract, plan and prepare one installed Feature into an open frame. */
  prepareFeature(frame: RenderFeatureFrameOpen, identity: string): void;
  /** Installed, undisposed Features that have not joined an open frame. */
  unjoinedFeatures(frame: RenderFeatureFrameOpen): readonly string[];
  /** Seal an open frame after every participating Feature has joined it. */
  finishFrame(frame: RenderFeatureFrameOpen): RenderFeatureFrameBatch;
  /**
   * Settle a sealed batch whose frame was accepted: seal each Feature's
   * resources and acknowledge exactly the `recorded` plans; a Feature none of
   * whose plans was recorded is aborted. A batch settles once (with this or
   * {@link abortFrame}); every failure is returned, never thrown.
   */
  submitFrame(
    batch: RenderFeatureFrameBatch,
    recorded: ReadonlySet<RenderFeaturePlannedFrame>,
  ): readonly unknown[];
  /** Discard every Feature's resources and producer frame data; returns the failures. */
  abortFrame(batch: RenderFeatureFrameBatch): readonly unknown[];
  deliverFrameReceipt(
    receipt: FrameReceipt,
    observations: (
      identity: string,
    ) => Promise<RenderResult<readonly FrameDomainObservation[], RenderError>>,
  ): void;
  dispose(): Result<void, RenderError>;
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

function releaseFeatureAssetVersionOwners(slot: FeatureSlot): void {
  for (const assets of slot.assetVersionOwners.values())
    for (const owner of assets.values()) owner.version.dispose();
  slot.assetVersionOwners.clear();
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function createFeatureSlot(feature: RenderFeature<unknown>, order: number): FeatureSlot {
  return {
    feature,
    releaseSystem: undefined,
    order,
    preparedResourceBatches: new Set(),
    assetVersionOwners: new Map(),
    preparedStore: createPreparedGraphicsStore(),
    status: 'active',
    latestError: undefined,
    planSignatures: new Map(),
    nativeSignatures: new Map(),
    signatureInspection: undefined,
    sceneData: new Map(),
    sceneDataAdmissionRevisions: new Map(),
    nativeRouting: new NativeFeatureWorkRouting(),
    stageEvents: {},
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

function targetHandle(
  name: string | SceneDataTarget | RenderFeatureTextureReference,
  targets: readonly RenderFeatureTargetHandle[],
):
  | string
  | RenderFeatureTargetHandle
  | SceneDataTarget
  | RenderFeatureTextureReference
  | undefined {
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

const EMPTY_PREPARED_RESOURCES: PreparedPlanResources = createPreparedResourceMaps();

interface FeatureWorkTargetRoster {
  readonly prepared: readonly RenderFeatureTargetHandle[];
  readonly projected: readonly RenderFeatureTargetHandle[];
}

interface FeatureWorkTargetRosters {
  readonly byRow: ReadonlyMap<FeatureWorkResources, FeatureWorkTargetRoster>;
  readonly byResource: ReadonlyMap<string, readonly RenderFeatureTargetHandle[]>;
}

const NO_WORK_TARGET_ROSTERS: FeatureWorkTargetRosters = {
  byRow: new Map(),
  byResource: new Map(),
};

function graphTextureTargets(
  identity: string,
  row: FeatureWorkResources,
): readonly {
  readonly alias: RenderFeatureTargetHandle;
  readonly canonical: RenderFeatureTargetHandle;
}[] {
  return row.closure.resources.flatMap((resource) => {
    if (resource.kind !== 'graph-texture') return [];
    const canonicalName = row.keys.get(resource.name);
    if (canonicalName === undefined) throw new Error('Missing graph texture resource route');
    const ownerScope = row.resourceScopes.get(resource.name);
    if (ownerScope === undefined) throw new Error('Missing graph texture resource scope');
    const input = {
      kind: 'graph-texture' as const,
      producerIdentity: identity,
      format: resource.descriptor.format,
      sampleCount: (resource.descriptor.sampleCount ?? 1) as 1 | 4,
      allocationKey: resource.allocationKey,
      ...(resource.materialSource === undefined ? {} : { materialSource: resource.materialSource }),
      allocationScope: featureResourceAllocationScope(identity, ownerScope),
      descriptor: resource.descriptor,
      ...(resource.view === undefined ? {} : { view: resource.view }),
    };
    return [
      {
        alias: createRenderFeatureGraphTextureTarget({ ...input, name: resource.name }),
        canonical: createRenderFeatureGraphTextureTarget({ ...input, name: canonicalName }),
      },
    ];
  });
}

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
      : typeof resource.logicalTarget === 'object' &&
          resource.logicalTarget.kind === 'feature-texture'
        ? resource.logicalTarget
        : targetHandle(resource.logicalTarget, targetsForResource(owner));
  if (
    resource.logicalTarget !== undefined &&
    (logical === undefined ||
      (typeof logical !== 'string' &&
        !isRenderFeatureTargetHandle(logical) &&
        logical.kind !== 'feature-texture' &&
        !isSceneDataTarget(logical)))
  ) {
    return planFailure(slot);
  }
  const prepared = gpu.prepareTextureView(
    owner,
    view,
    logical === undefined ? undefined : logical,
    resource.acquireResidencyLease,
  );
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

function projectPlanCopyPass(
  slot: FeatureSlot,
  pass: Extract<RenderFeatureWorkPlan['passes'][number], { kind: 'copy' }>,
  prepared: PreparedPlanResources,
  gpu: RenderFeatureGpuPrepareSession | undefined,
  targets: readonly RenderFeatureTargetHandle[],
): Result<RenderFeaturePlanExecutionPass, RenderError> {
  const resolve = (name: string) => {
    const borrowed = prepared.preparedGpuResources.get(name);
    const reference =
      prepared.buffers.get(name) ?? (borrowed?.kind === 'buffer' ? borrowed.reference : undefined);
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
  return ok({
    enabled: pass.enabled,
    featureIdentity: slot.feature.identity,
    order: slot.order,
    name: pass.name,
    resolvedGpuCopies: copies,
    ...(pass.textureReadbacks === undefined
      ? {}
      : {
          textureReadbacks: pass.textureReadbacks.map((readback) => ({
            name: readback.name,
            target: targetHandle(readback.target, targets) as RenderFeatureTargetHandle,
          })),
        }),
  });
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
      const copy = projectPlanCopyPass(slot, pass, prepared, gpu, targets);
      if (!copy.ok) return copy;
      projected.push(copy.value);
      continue;
    }
    if (pass.kind === 'compute') {
      const projectComputePass = () => {
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
        return undefined;
      };
      const projectComputePassFailure = projectComputePass();
      if (projectComputePassFailure !== undefined) return projectComputePassFailure;
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
            ...(pass.depthStencilAttachment.depthClearValue === undefined
              ? {}
              : { depthClearValue: pass.depthStencilAttachment.depthClearValue }),
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
  return ok(finalizePlanExecution(slot, plan, projected));
}

function finalizePlanExecution(
  slot: FeatureSlot,
  plan: RenderFeatureWorkPlan,
  passes: readonly RenderFeaturePlanExecutionPass[],
): RenderFeaturePlanExecution {
  const placement = plan.placement ?? slot.feature.placement;
  return {
    featureIdentity: slot.feature.identity,
    order: slot.order,
    ...(placement === undefined ? {} : { placement }),
    ...(plan.submission === undefined ? {} : { submission: plan.submission }),
    passes: Object.freeze(passes),
  };
}

function invokeStage<T, Owner, Input>(
  slot: FeatureSlot,
  stage: RenderFeatureStageEvent['stage'],
  action: (this: Owner, input: Input) => Result<T, RenderError>,
  owner: Owner,
  input: Input,
  stageEvents: RenderFeatureStageEvent[],
  errors: RenderError[],
): Result<T, RenderError> {
  const identity = slot.feature.identity;
  let event = slot.stageEvents[stage];
  if (event?.featureIdentity !== identity || event.order !== slot.order) {
    event = Object.freeze({ featureIdentity: identity, order: slot.order, stage });
    slot.stageEvents[stage] = event;
  }
  stageEvents.push(event);
  try {
    const result = action.call(owner, input);
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

  constructor(
    private readonly slots: FeatureSlot[],
    readonly world: World,
    private readonly report: FeatureSettlementReporter,
  ) {
    bindRenderFeatureFrame(world, this, report);
    for (const slot of slots)
      slot.releaseSystem = addRenderFeatureSystem(
        world,
        slot.feature.identity,
        slot.feature.profileWorkNames,
      );
  }

  get size(): number {
    return this.slots.length;
  }

  get preparedGeneration(): number {
    return this.generation;
  }

  get features(): readonly RenderFeature<unknown>[] {
    return this.slots.map((slot) => slot.feature);
  }

  feature(identity: string): RenderFeature<unknown> | undefined {
    return this.slots.find((slot) => slot.feature.identity === identity)?.feature;
  }

  captureSource(
    context: RenderFeatureExtractContext & {
      readonly caps: Readonly<RhiCaps>;
    },
  ): readonly RenderFeatureSource[] {
    return this.slots
      .filter((slot) => featureRunsThisFrame(slot, context.caps))
      .map((slot) => captureRenderFeatureSource(slot.feature, context, slot.order));
  }

  profileGraphPasses(viewScopes: readonly string[]): readonly RenderFeatureProfileGraphPass[] {
    if (this.disposed || viewScopes.length === 0) return Object.freeze([]);
    const scopes = Object.freeze([...new Set(viewScopes)]);
    const currentScopes = new Set(scopes);
    const declarations: RenderFeatureProfileGraphPass[] = [];
    const identities = new Set<string>();
    for (const slot of this.slots) {
      if (slot.status === 'disposed') continue;
      const provided = slot.feature.profileGraphPasses?.(scopes) ?? [];
      if (!Array.isArray(provided))
        throw new TypeError(
          `RenderFeature ${slot.feature.identity} returned an invalid profile pass roster`,
        );
      for (const declaration of provided) {
        if (
          !declaration ||
          typeof declaration.view !== 'string' ||
          declaration.view.length === 0 ||
          typeof declaration.name !== 'string' ||
          declaration.name.length === 0 ||
          !['raster', 'compute', 'copy'].includes(declaration.kind)
        )
          throw new TypeError(
            `RenderFeature ${slot.feature.identity} returned an invalid profile pass`,
          );
        if (!currentScopes.has(declaration.view)) continue;
        const key = `${declaration.view}\u0000${declaration.kind}\u0000${declaration.name}`;
        if (identities.has(key)) continue;
        identities.add(key);
        declarations.push(
          Object.freeze({
            view: declaration.view,
            name: declaration.name,
            kind: declaration.kind,
          }),
        );
      }
    }
    return Object.freeze(declarations);
  }

  deliverFrameReceipt(
    receipt: FrameReceipt,
    observations: (
      identity: string,
    ) => Promise<RenderResult<readonly FrameDomainObservation[], RenderError>>,
  ): void {
    const failures = drainEach(
      [...this.slots],
      [
        (slot) => {
          if (slot.status === 'disposed' || slot.feature.onFrameReceipt === undefined) return;
          try {
            slot.feature.onFrameReceipt(receipt, observations(slot.feature.identity));
          } catch (cause) {
            throw this.recordError(
              slot.feature.identity,
              new RenderFeatureStageFailedError(
                slot.feature.identity,
                slot.order,
                'receipt',
                'next-frame',
                cause,
              ),
            );
          }
        },
      ],
    );
    drainEach(failures, [(failure) => this.report(failure as RenderError)]);
  }

  beginFrame(inputs: readonly RenderFeatureFrameInput[]): RenderFeatureFrameOpen {
    const input = inputs[0];
    if (input === undefined) throw new Error('a Feature frame requires its complete view roster');
    this.beginDepthBatchInspection(
      input.featureReadOnlyDepthBatchDiagnostic === true ? input.frameNumber : undefined,
      input.generation ?? 0,
    );
    return new FeatureFrameBatchBuilder(this, inputs, input);
  }

  prepareFeature(frame: RenderFeatureFrameOpen, identity: string): void {
    const slot = findSlot(this.slots, identity);
    if (slot !== undefined) this.prepareSlot(frame, slot);
  }

  unjoinedFeatures(frame: RenderFeatureFrameOpen): readonly string[] {
    const batch = openBatch(frame, this);
    // A disposed Feature's system is gone with it; it no longer joins frames.
    return this.slots
      .filter((slot) => slot.status !== 'disposed' && !batch.joined.has(slot))
      .map((slot) => slot.feature.identity);
  }

  finishFrame(frame: RenderFeatureFrameOpen): RenderFeatureFrameBatch {
    return openBatch(frame, this).finish();
  }

  submitFrame(
    batch: RenderFeatureFrameBatch,
    recorded: ReadonlySet<RenderFeaturePlannedFrame>,
  ): readonly unknown[] {
    const prepared = this.closeBatch(batch);
    if (!Array.isArray(prepared)) return prepared === undefined ? [] : [prepared];
    if (batch.frame.preparationPending === true) return drainEach(prepared, ABORT_FEATURES);
    return drainEach(prepared, [commitFeatureResources, (feature) => feature.submit(recorded)]);
  }

  abortFrame(batch: RenderFeatureFrameBatch): readonly unknown[] {
    const prepared = this.closeBatch(batch);
    if (!Array.isArray(prepared)) return prepared === undefined ? [] : [prepared];
    return drainEach(prepared, ABORT_FEATURES);
  }

  /**
   * The batch's prepared Features the first time it settles; undefined once
   * settled; an error for a batch another host sealed.
   */
  private closeBatch(
    batch: RenderFeatureFrameBatch,
  ): readonly FeatureFramePreparation[] | Error | undefined {
    const builder = sealedBatches.get(batch);
    if (builder === undefined) return undefined;
    if (builder.host !== this)
      return new Error('the Feature frame batch was sealed by another host');
    sealedBatches.delete(batch);
    return builder.prepared;
  }

  private prepareSlot(frame: RenderFeatureFrameOpen, slot: FeatureSlot): void {
    const batch = openBatch(frame, this);
    if (batch.joined.has(slot)) throw new Error('a Feature joins one Renderer frame at most once');
    batch.joined.add(slot);
    if (!featureRunsThisFrame(slot, batch.input.caps)) {
      releaseFeatureAssetVersionOwners(slot);
      return;
    }
    const transaction = this.beginPreparedFrame(
      slot.feature.identity,
      batch.input.generation ?? this.generation,
    );
    if (transaction === undefined) {
      releaseFeatureAssetVersionOwners(slot);
      return;
    }
    new FeatureFramePreparation(batch, slot, transaction).run();
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
    const slot = createFeatureSlot(feature, this.slots.length);
    slot.releaseSystem = addRenderFeatureSystem(
      this.world,
      feature.identity,
      feature.profileWorkNames,
    );
    this.slots.push(slot);
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
    releaseFeatureAssetVersionOwners(slot);
    slot.status = 'disposed';
    this.slots.splice(index, 1);
    slot.releaseSystem?.();
    slot.releaseSystem = undefined;
    if (this.slots.length === 0) releaseSharedFeatureGraphHistory(this.world);
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
    for (const slot of this.slots) releaseFeatureAssetVersionOwners(slot);
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
    releaseSharedFeatureGraphHistory(this.world);

    const retired = this.retirePreparedGraphics();
    const firstError: RenderError | undefined = retired.ok ? undefined : retired.error;
    for (const slot of this.slots) {
      releaseFeatureAssetVersionOwners(slot);
      slot.status = 'disposed';
      slot.releaseSystem?.();
      slot.releaseSystem = undefined;
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
}

/** Sealed batches not yet settled, mapped to the frame that sealed them. */
const sealedBatches = new WeakMap<RenderFeatureFrameBatch, FeatureFrameBatchBuilder>();

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

/** An open Renderer Feature frame; opaque outside its host. */
export interface RenderFeatureFrameOpen {
  readonly inputs: readonly RenderFeatureFrameInput[];
}

function openBatch(frame: RenderFeatureFrameOpen, host: FeatureHostImpl): FeatureFrameBatchBuilder {
  if (!(frame instanceof FeatureFrameBatchBuilder) || frame.host !== host || frame.sealed)
    throw new Error('the Feature frame is not open on this host');
  return frame;
}

/** Frame-wide accumulation shared by every Feature in one Renderer frame. */
class FeatureFrameBatchBuilder implements RenderFeatureFrameOpen {
  /** Slots that already joined this frame; a slot prepares at most once. */
  readonly joined = new Set<FeatureSlot>();
  sealed = false;
  readonly stageEvents: RenderFeatureStageEvent[] = [];
  readonly errors: RenderError[] = [];
  readonly preparedResourceBatches: RenderFeaturePreparedResourceBatch[] = [];
  /** Features that reached the submission barrier, in installation order. */
  readonly prepared: FeatureFramePreparation[] = [];
  readonly preparationFinalizers: (() => void)[] = [];
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
      const result = this.makeResult(view.hiddenEntityReports);
      this.views.set(view.identity, result);
    }
    this.extractViews = Object.freeze(inputs.map(extractView));
    this.materialContext = renderMaterialContext(input.caps, input.limits);
    this.planViews = inputs.map((view) =>
      Object.freeze({
        identity: view.identity,
        render: view.render,
        ...(view.graphResources === undefined ? {} : { graphResources: view.graphResources }),
        frame: Object.freeze({
          frameNumber: input.frameNumber,
          ...view.frameSize,
          ...(view.renderExtent === undefined ? {} : { extent: view.renderExtent }),
          ...(view.frame?.waterFoamMaterials === undefined
            ? {}
            : { waterFoamMaterials: view.frame.waterFoamMaterials }),
        }),
        ...(view.selectedView === undefined ? {} : { selectedView: view.selectedView }),
        targets: logicalRenderFeatureTargets(view.targets ?? []),
        ...(view.motionBlur === undefined ? {} : { motionBlur: view.motionBlur }),
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

  private makeResult(
    reports: readonly RenderFeatureHiddenEntityReport[] = NO_HIDDEN_ENTITY_REPORTS,
  ): RenderFeatureFrameResult {
    const plans: RenderFeaturePlannedFrame[] = [];
    const result: RenderFeatureFrameResult = {
      stageEvents: this.stageEvents,
      errors: this.errors,
      plans,
      fullscreenEffects: new Map<string, PostProcessShaderEntry>(),
      hiddenEntityReports: isOwnedHiddenEntityReports(reports) ? reports : [...reports],
      postProcessIdentities: [],
      preparedResourceBatches: [],
      requiresPreparedResourceKey: false,
    };
    return result;
  }

  // Capture only at the existing first blocker. Never consult a later inspection
  // or serialize a complete program/plan to explain a receipt.
  markPreparationPending(
    identity: string,
    preparationStage: NonNullable<FramePresentationPendingReason['preparationStage']>,
    error?: unknown,
    context?: {
      readonly pass?: string;
      readonly shader?: string;
      readonly resource?: string;
      readonly operation?: string;
      readonly reason?: string;
    },
  ): void {
    if (this.preparationPendingFeatureIdentity !== undefined) return;
    this.preparationPendingFeatureIdentity = identity;
    const detail = error instanceof RenderFeaturePreparationFailedError ? error.detail : undefined;
    const resource = detail?.resourceName ?? context?.resource;
    const operation = detail?.operation ?? context?.operation;
    const reason = detail?.reason ?? context?.reason;
    this.preparationPendingReason = Object.freeze({
      code: 'feature-preparation',
      featureIdentity: identity.slice(0, 256),
      preparationStage,
      ...(resource === undefined ? {} : { resource: resource.slice(0, 256) }),
      ...(operation === undefined ? {} : { operation: operation.slice(0, 64) }),
      ...(reason === undefined ? {} : { reason: reason.slice(0, 128) }),
      ...(context?.pass === undefined ? {} : { pass: context.pass.slice(0, 256) }),
      ...(context?.shader === undefined ? {} : { shader: context.shader.slice(0, 256) }),
    });
  }

  markSourcePreparationPending(
    identity: string,
    pending: { readonly resource: string; readonly reason: string },
  ): void {
    this.markPreparationPending(identity, 'source-plan', undefined, {
      resource: pending.resource,
      operation: 'resolve-source',
      reason: pending.reason,
    });
  }

  finish(): RenderFeatureFrameBatch {
    this.sealed = true;
    try {
      this.shareFrameFullscreenEffects();
      this.publishFrameSummaries();
      const readbacks = frameFeatureTextureReadbacks([this.shared, ...this.views.values()]);
      Object.assign(this.shared, { featureTextureReadbacks: readbacks });
      for (const result of this.views.values())
        Object.assign(result, { featureTextureReadbacks: readbacks });
      const batch: RenderFeatureFrameBatch = {
        frame: this.shared,
        views: this.views,
        preparedResourceBatches: this.preparedResourceBatches,
      };
      sealedBatches.set(batch, this);
      return batch;
    } finally {
      for (const finalize of this.preparationFinalizers.splice(0)) finalize();
    }
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
  private readonly assetVersions = new Map<
    string,
    {
      readonly handle: number;
      readonly revision: number;
      readonly contentRevision?: number;
      readonly value: Asset;
    }
  >();
  private readonly assetVersionBatches: RenderFeaturePreparedResourceBatch[] = [];
  private readonly assetVersionPinTouches = new Set<FeatureAssetVersionOwner>();
  private pendingGraphicsPipelineError: RenderFeaturePreparationFailedError | undefined;
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
    try {
      this.prepare();
    } finally {
      this.releaseUnreferencedAssetVersionOwners();
    }
  }

  private prepare(): void {
    const extracted = invokeStage(
      this.slot,
      'extract',
      this.extract,
      this,
      undefined,
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
      sourceRequiresPreparation =
        this.postScopeEnabled('frame') && this.feature.requiresPreparation?.(this.source) === true;
    } catch (cause) {
      this.failSourceGuard(cause);
      return;
    }
    this.requiresPreparation = sourceRequiresPreparation;
    const planScope = this.beginProfileWork(renderFeaturePlanProfileWork(this.identity));
    let declared: Result<RenderFeaturePlan, RenderError>;
    try {
      declared = this.declarePlan(views);
    } finally {
      planScope?.end();
    }
    if (declared.ok && declared.value.pendingSource !== undefined) {
      this.deferSourcePlan(declared.value);
      return;
    }
    if (declared.ok) this.consumeNativePlan(declared.value, views);
    const declaredWork = this.admittedPostWork(
      this.nativeWork ?? (declared.ok ? declared.value.work : []),
    );
    if (this.nativeWork !== undefined) this.nativeWork = declaredWork;
    if (isFeatureGraphConformanceEnabled(this.input.featureGraphConformanceTrace, this.identity)) {
      this.recordConformanceEvent('host-plan-declared', {
        planFrameNumber: this.input.frameNumber,
        planSucceeded: declared.ok,
        workCount: declaredWork.length,
        workScopes: declaredWork.map((work) => featureScopeKey(work.scope)),
        passNames: declaredWork.flatMap((work) => work.passes.map((pass) => pass.name)),
        declaredDispatchCount: declaredWork.reduce(
          (total, work) =>
            total +
            work.passes.reduce(
              (count, pass) => count + (pass.kind === 'compute' ? pass.dispatches.length : 0),
              0,
            ),
          0,
        ),
      });
    }
    const nativeAdmissionScope = this.beginProfileWork(
      renderFeatureAdmissionProfileWork(this.identity),
    );
    let nativeRequiresPreparation: boolean;
    try {
      nativeRequiresPreparation = this.verifyNativeAdmissions(declared, declaredWork);
    } finally {
      nativeAdmissionScope?.end();
    }
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
    if (input.sourceFeatures !== undefined) {
      const captured = input.sourceFeatures.find((row) => row.identity === this.identity);
      if (captured !== undefined) {
        for (const report of captured.hiddenEntities) this.reports.push(report);
        for (const version of captured.assetVersions ?? [])
          this.referenceAssetVersion(0, version.handle, version).unwrap();
        return captured.result;
      }
      return err(
        new RenderFeatureStageFailedError(
          this.identity,
          this.slot.order,
          'extract',
          'next-frame',
          new Error('The feature was not captured by this source frame'),
        ),
      );
    }
    const published = input.publishedFeatures?.find((row) => row.identity === this.identity);
    if (published !== undefined) {
      for (const report of published.hiddenEntities ?? NO_HIDDEN_ENTITY_REPORTS)
        this.reports.push(report);
      return published.failure === undefined
        ? ok(published.data)
        : err(restoreRenderFeatureSourceFailure(published.failure));
    }
    if (input.publishedFeatures !== undefined && Object.hasOwn(this.feature, 'inactiveSourceData'))
      return ok(this.feature.inactiveSourceData);
    if (input.world === undefined)
      return err(
        new RenderFeatureStageFailedError(
          this.identity,
          this.slot.order,
          'extract',
          'next-frame',
          new Error('Feature extraction requires its local source World or published data'),
        ),
      );
    return this.feature.extract({
      world: input.world,
      frameNumber: input.frameNumber,
      caps: input.caps,
      ...this.batch.materialContext,
      views: this.admittedViews(this.batch.extractViews),
      ...(input.visibilitySnapshot === undefined
        ? {}
        : { visibilitySnapshot: input.visibilitySnapshot }),
      referenceAssetVersion: (version) => {
        this.referenceAssetVersion(0, version.handle, version).unwrap();
      },
      reportError: (error) => this.batch.errors.push(error),
      ...(input.beginProfileWork === undefined ? {} : { beginProfileWork: input.beginProfileWork }),
      reportHiddenEntity: (report) => this.reports.push(report),
    });
  }

  private beginProfileWork(work: string) {
    const begin = this.input.beginProfileWork;
    if (
      begin === undefined ||
      (!renderFeatureProfileWorkNames(this.identity).includes(work) &&
        !this.feature.profileWorkNames?.includes(work))
    )
      return undefined;
    return begin(work);
  }

  private referenceAssetVersion(
    worldIndex: number,
    handle: number,
    captured?: Readonly<{ revision: number; value: Asset }>,
  ) {
    const key = `${worldIndex}:${handle}${captured === undefined ? '' : `:${captured.revision}`}`;
    const retained = this.assetVersions.get(key);
    if (retained !== undefined) return ok(retained);
    if (captured !== undefined) {
      const version = { handle, ...captured };
      this.assetVersions.set(key, version);
      return ok(version);
    }
    const world = this.input.world;
    const owner = world?.assets;
    if (world === undefined || owner === undefined)
      return err(new Error(`Missing feature asset source ${worldIndex}`));
    const records = runtimeAssets(owner);
    let frameVersion: AssetVersion<Asset>;
    let ownerVersion: AssetVersion<Asset> | undefined;
    const byHandle = this.slot.assetVersionOwners.get(world);
    const previous = byHandle?.get(handle);
    let contentRevision: number | undefined;
    if (
      previous !== undefined &&
      previous.assetOwner === owner &&
      previous.records === records &&
      previous.version.matchesCurrent()
    ) {
      this.assetVersionPinTouches.add(previous);
      frameVersion = previous.version.retain();
      contentRevision = previous.contentRevision;
    } else {
      if (previous !== undefined) {
        previous.version.dispose();
        byHandle?.delete(handle);
      }
      const pinned = records.pin<Asset>(handle);
      if (!pinned.ok) return pinned;
      frameVersion = pinned.value;
      ownerVersion = pinned.value.retain();
      const currentRevision = records.version(handle);
      if (currentRevision.ok) contentRevision = currentRevision.value;
    }
    const version = {
      ...frameVersion,
      ...(contentRevision === undefined ? {} : { contentRevision }),
    };
    const batch = this.batch.host.retainPreparedGraphics(this.identity, [
      {
        release: () => {
          version.dispose();
          return ok(undefined);
        },
      },
    ]);
    if (!batch.ok) {
      frameVersion.dispose();
      ownerVersion?.dispose();
      return batch;
    }
    if (ownerVersion !== undefined) {
      let owners = this.slot.assetVersionOwners.get(world);
      if (owners === undefined) {
        owners = new Map();
        this.slot.assetVersionOwners.set(world, owners);
      }
      const retainedOwner: FeatureAssetVersionOwner = {
        assetOwner: owner,
        records,
        version: ownerVersion,
        ...(contentRevision === undefined ? {} : { contentRevision }),
      };
      owners.set(handle, retainedOwner);
      this.assetVersionPinTouches.add(retainedOwner);
    }
    this.assetVersions.set(key, version);
    this.assetVersions.set(`${worldIndex}:${handle}:${frameVersion.revision}`, version);
    this.assetVersionBatches.push(batch.value);
    this.batch.preparedResourceBatches.push(batch.value);
    return ok(version);
  }

  private releaseUnreferencedAssetVersionOwners(): void {
    for (const [world, owners] of this.slot.assetVersionOwners) {
      const currentOwner = this.input.world === world ? world.assets : undefined;
      for (const [handle, owner] of owners) {
        if (currentOwner === owner.assetOwner && this.assetVersionPinTouches.has(owner)) continue;
        owner.version.dispose();
        owners.delete(handle);
      }
      if (owners.size === 0) this.slot.assetVersionOwners.delete(world);
    }
  }

  /** Whether this Feature's `capture` policy admits the view; capture-face views it excludes are never shown to it. */
  private admitsView(view: RenderFeatureFrameInput): boolean {
    return (
      view.captureKind === undefined ||
      featureRecordsInCapture(this.feature.capture, view.captureKind)
    );
  }

  private admittedViews<V>(views: readonly V[]): readonly V[] {
    const inputs = this.batch.inputs;
    return views.filter((_, index) => this.admitsView(inputs[index] as RenderFeatureFrameInput));
  }

  private planViews(): RenderFeaturePlanContext['views'] {
    const inputs = this.batch.inputs;
    const views = this.batch.planViews;
    const planned: RenderFeaturePlanView[] = [];
    for (let index = 0; index < views.length; index++) {
      if (!this.admitsView(inputs[index] as RenderFeatureFrameInput)) continue;
      const view = views[index] as (typeof views)[number];
      planned.push({
        ...view,
        render: view.render && this.postScopeEnabled({ view: view.identity }),
        sceneData:
          (inputs[index] as RenderFeatureFrameInput).sceneData ??
          this.sceneData(
            view,
            (inputs[index] as RenderFeatureFrameInput).surfaceAdmission,
            (inputs[index] as RenderFeatureFrameInput).deviceGeneration,
          ),
      });
    }
    return planned;
  }

  private postScopeEnabled(scope: RenderFeatureWorkScope): boolean {
    if (this.feature.placement === 'scene') return true;
    if (scope === 'frame')
      return this.batch.inputs.some(
        (view) => view.render && view.selectedCamera?.postProcessing !== false,
      );
    const view = this.batch.inputs.find((candidate) => candidate.identity === scope.view);
    return view?.selectedCamera?.postProcessing !== false;
  }

  /** Drop a view's complete GPU chain while retaining its source-selection receipt. */
  private admittedPostWork(work: readonly RenderFeatureWork[]): readonly RenderFeatureWork[] {
    if (this.feature.placement === 'scene' || work.every((row) => this.postScopeEnabled(row.scope)))
      return work;
    return work.flatMap((row): readonly RenderFeatureWork[] =>
      this.postScopeEnabled(row.scope)
        ? [row]
        : row.waterView === undefined
          ? []
          : [{ scope: row.scope, waterView: row.waterView, resources: [], passes: [] }],
    );
  }

  /** The view's catalog is fixed for one prepared generation; recreate it only after a cut. */
  private sceneData(
    view: { readonly identity: string },
    surfaceAdmission: StandardSceneSurfaceAdmission | undefined,
    deviceGeneration: number | undefined,
  ): SceneDataCatalog {
    const generation = this.transaction.generation;
    const cache = this.slot.sceneData;
    const cached = cache.get(view.identity);
    if (
      cached?.generation === generation &&
      cached.surfaceAdmissionIdentity === surfaceAdmission?.identity &&
      cached.deviceGeneration === (deviceGeneration ?? 0)
    )
      return cached;
    if (cache.size >= this.batch.inputs.length) cache.clear();
    const previousAdmission = this.slot.sceneDataAdmissionRevisions.get(view.identity);
    const admissionIdentity = surfaceAdmission?.identity;
    const revision =
      previousAdmission === undefined
        ? admissionIdentity === undefined
          ? 0
          : 1
        : previousAdmission.identity === admissionIdentity
          ? previousAdmission.revision
          : previousAdmission.revision + 1;
    this.slot.sceneDataAdmissionRevisions.set(view.identity, {
      identity: admissionIdentity,
      revision,
    });
    const created = createSceneDataCatalog({
      featureIdentity: this.identity,
      viewIdentity: view.identity,
      deviceGeneration: deviceGeneration ?? 0,
      generation,
      planIdentity: `${this.identity}:${view.identity}:${generation}`,
      rgba16floatRenderable: this.input.caps.rgba16floatRenderable === true,
      ...(surfaceAdmission === undefined ? {} : { surfaceAdmission }),
      ...(surfaceAdmission === undefined ? {} : { surfaceAdmissionRevision: revision }),
    });
    cache.set(view.identity, created);
    return created;
  }

  private static readonly abortResourceActions = [
    (frame: FeatureFramePreparation) => {
      for (const batch of frame.assetVersionBatches) {
        const released = batch.release();
        if (!released.ok) frame.batch.errors.push(released.error);
      }
      frame.assetVersionBatches.length = 0;
      frame.assetVersions.clear();
    },
    (frame: FeatureFramePreparation) => {
      frame.transaction.abort();
    },
    (frame: FeatureFramePreparation) => {
      const aborted = frame.gpu?.abortFrame();
      if (aborted !== undefined && !aborted.ok) frame.batch.errors.push(aborted.error);
    },
  ];

  private abortResources(): void {
    drainFeatureActions(this, FeatureFramePreparation.abortResourceActions, undefined);
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

  private deferSourcePlan(
    plan: Extract<RenderFeaturePlan, { readonly pendingSource: object }>,
  ): void {
    const pending = plan.pendingSource;
    if (
      pending === null ||
      typeof pending !== 'object' ||
      !Array.isArray(plan.work) ||
      plan.work.length !== 0 ||
      'native' in plan ||
      'sourceFeedback' in plan ||
      this.nativeAdmissions !== undefined ||
      typeof pending.resource !== 'string' ||
      typeof pending.reason !== 'string'
    ) {
      this.fail(
        new RenderFeatureStageFailedError(this.identity, this.slot.order, 'plan', 'next-frame', {
          expected: 'a pending source plan with empty work and no native work or source feedback',
        }),
      );
      return;
    }
    this.requiresPreparation = true;
    if (this.disableForMissingCapability([], true)) return;
    this.publishInspection();
    this.batch.markSourcePreparationPending(this.identity, pending);
    this.batch.preparationFinalizers.push(() =>
      this.cleanupPreparation(
        [
          () => this.input.sceneResources?.abortFeature(this.identity),
          () => this.abortResources(),
          () => this.abortProducerFrame(),
        ],
        'plan',
      ),
    );
    this.batch.host.setStatus(this.identity, 'active');
  }

  private fail(
    error?: unknown,
    pendingError: unknown = error,
    stage: NonNullable<FramePresentationPendingReason['preparationStage']> = pendingError instanceof
    RenderFeaturePreparationFailedError
      ? 'resource-preparation'
      : 'plan-projection',
  ): void {
    const retryablePreparation = isRetryableGpuPreparationFailure(pendingError);
    const failure =
      pendingError !== null && typeof pendingError === 'object'
        ? (pendingError as { readonly code?: unknown; readonly message?: unknown })
        : undefined;
    this.recordConformanceEvent('host-plan-failed', {
      planFrameNumber: this.input.frameNumber,
      stage,
      errorCode: typeof failure?.code === 'string' ? failure.code : null,
      message: typeof failure?.message === 'string' ? failure.message : null,
    });
    if (this.requiresPreparation || retryablePreparation)
      this.batch.markPreparationPending(this.identity, stage, pendingError);
    if (error !== undefined && !retryablePreparation)
      recordFailure(this.slot, 'plan', error, this.batch.errors);
    const abort = () =>
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
    // Later consumers still inspect this frame's producer inputs while preparing.
    // Settle its complete transaction before the pending frame can reach recording.
    if (retryablePreparation) this.batch.preparationFinalizers.push(abort);
    else abort();
    this.batch.host.setStatus(
      this.identity,
      retryablePreparation ? 'active' : 'failed',
      retryablePreparation ? undefined : this.slot.latestError,
    );
  }

  private publishInspection(): void {
    const source = this.source;
    if (typeof source === 'object' && source !== null && 'inspection' in source)
      this.slot.latestInspection = (source as { inspection?: unknown }).inspection;
  }

  private declarePlan(
    views: RenderFeaturePlanContext['views'],
  ): Result<RenderFeaturePlan, RenderError> {
    const declared = invokeStage(
      this.slot,
      'plan',
      this.planSource,
      this,
      views,
      this.batch.stageEvents,
      this.batch.errors,
    );
    this.nativePlanningOpen = false;
    return declared;
  }

  private planSource(
    views: RenderFeaturePlanContext['views'],
  ): Result<RenderFeaturePlan, RenderError> {
    const input = this.input;
    return this.feature.plan(this.source, {
      getFeatureShaderSource: input.getFeatureShaderSource,
      resolveAsset: (handle, revision) => {
        const captured =
          revision === undefined ? undefined : this.assetVersions.get(`0:${handle}:${revision}`);
        if (captured !== undefined) return ok(captured.value);
        if (input.resolveAsset !== undefined) return input.resolveAsset(handle, revision);
        if (revision === undefined) {
          const version = this.referenceAssetVersion(0, handle);
          return version.ok ? ok(version.value.value) : version;
        }
        const world = input.world;
        return world === undefined
          ? err(new Error('Missing feature asset source'))
          : runtimeAssets(world.assets).resolveAsset(handle, revision);
      },
      ...(input.resolveResidentTextureView === undefined
        ? {}
        : { resolveResidentTextureView: input.resolveResidentTextureView }),
      caps: input.caps,
      ...(input.limits === undefined ? {} : { limits: input.limits }),
      ...this.batch.materialContext,
      frame: { frameNumber: input.frameNumber },
      ...(input.deviceGeneration === undefined ? {} : { deviceGeneration: input.deviceGeneration }),
      generation: this.transaction.generation,
      createNativePlan: () => this.createNativePlan(views),
      views,
      ...(input.beginProfileWork === undefined ? {} : { beginProfileWork: input.beginProfileWork }),
      ...(input.materialShaderBindingContract === undefined
        ? {}
        : { materialShaderBindingContract: input.materialShaderBindingContract }),
    });
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
              isScopeActive: (scope) => this.postScopeEnabled(scope),
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
        : this.slot.nativeRouting.resolve(this.nativeWork);
    this.batch.host.retainPlanScopes(
      this.slot,
      workResources.map((row) => featureScopeKey(row.work.scope)),
    );
    const targetRosters = this.validateWorkTargets(workResources);
    if (this.disableForMissingCapability(workResources)) return;
    const prepared =
      this.nativeWork === undefined
        ? preparePlanResources(
            this.slot,
            { resources: workResources.flatMap((row) => row.resources), passes: [] },
            this.transaction,
            this.gpu,
            (name) => targetRosters.byResource.get(name) ?? [],
            this.input.sceneResources,
          )
        : undefined;
    if (prepared !== undefined && !prepared.ok) throw prepared.error;
    for (const row of workResources) {
      const targets = targetRosters.byRow.get(row);
      if (targets === undefined) throw new Error('Missing Feature work target roster');
      this.projectWorkRow(plan, row, prepared?.value, targets);
    }
    this.retainFrameResources();
    this.admitRequiredPostProcesses();
    this.publishProjections(plan);
    this.batch.featureHiddenEntityReports.push(...this.reports);
    this.plan = plan;
    this.batch.prepared.push(this);
    this.batch.host.setStatus(this.identity, 'active');
  }

  /** Build the single target roster used by declaration checks, preparation and projection. */
  private validateWorkTargets(
    workResources: readonly FeatureWorkResources[],
  ): FeatureWorkTargetRosters {
    if (workResources.length === 0) return NO_WORK_TARGET_ROSTERS;
    const byRow = new Map<FeatureWorkResources, FeatureWorkTargetRoster>();
    const byResource = new Map<string, readonly RenderFeatureTargetHandle[]>();
    for (const row of workResources) {
      const view = this.workView(row.work);
      const graphTargets = graphTextureTargets(this.identity, row);
      const projected = [...(view?.targets ?? []), ...graphTargets.map((targets) => targets.alias)];
      const prepared = [
        ...(view?.targets ?? []),
        ...graphTargets.flatMap(({ alias, canonical }) => [alias, canonical]),
      ];
      byRow.set(row, { prepared, projected });
      if (this.nativeWork === undefined) {
        const valid = validateRenderFeaturePlan(
          this.identity,
          row.closure,
          logicalRenderFeatureTargets(projected),
        );
        if (!valid.ok) throw valid.error;
        for (const resource of row.resources) byResource.set(resource.name, prepared);
      }
    }
    return { byRow, byResource };
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

  private disableForMissingCapability(
    workResources: readonly FeatureWorkResources[],
    sourcePending = false,
  ): boolean {
    const missing = missingCapability(this.feature, this.input.caps);
    if (
      missing === undefined ||
      (!sourcePending && !workResources.some((row) => hasActivePlan(row.closure)))
    )
      return false;
    // This device cannot prepare the work, so presentation does not wait for it:
    // the frame presents without the disabled feature, and the error reports once
    // per transition into that state instead of on every frame.
    const reported =
      this.slot.status === 'disabled' &&
      this.slot.latestError?.code === 'render-feature-capability-missing' &&
      this.slot.latestError.detail.capability === missing;
    const failure = new RenderFeatureCapabilityMissingError(
      this.identity,
      this.slot.order,
      missing,
    );
    this.recordConformanceEvent('host-plan-failed', {
      planFrameNumber: this.input.frameNumber,
      reason: 'missing-capability',
      errorCode: failure.code,
      capability: missing,
    });
    if (!reported) this.batch.errors.push(failure);
    this.cleanupPreparation([() => this.abortResources(), () => this.abortProducerFrame()], 'plan');
    this.batch.host.setStatus(this.identity, 'disabled', errorDescriptor(failure));
    return true;
  }

  private projectWorkRow(
    plan: RenderFeaturePlan,
    row: FeatureWorkResources,
    rawPrepared: PreparedPlanResources | undefined,
    targetRoster: FeatureWorkTargetRoster,
  ): void {
    const scope = row.work.scope;
    const viewInput =
      scope === 'frame'
        ? undefined
        : this.batch.inputs.find((view) => view.identity === scope.view);
    const result = scope === 'frame' ? this.batch.shared : this.batch.views.get(scope.view);
    if (result === undefined) throw new Error('unregistered Feature work scope');
    const effects = fullscreenProgramEffects(
      row.closure,
      fullscreenRenderFeatureDeclaration(this.feature)?.identity,
    );
    const scoped = this.scopedResources(row, targetRoster.prepared, rawPrepared);
    const resolveGraphics =
      row.native !== true ||
      row.closure.passes.some((pass) => pass.kind === 'raster' || pass.kind === 'shadow-caster')
        ? (viewInput ?? this.input).createPreparedGraphicsResolver
        : undefined;
    const resolver = resolveGraphics?.({
      featureIdentity: this.identity,
      order: this.slot.order,
      generation: this.transaction.generation,
      ...(viewInput === undefined ? {} : { viewIdentity: viewInput.identity }),
      frameGeneration: this.input.frameNumber,
      deviceGeneration: this.input.deviceGeneration ?? 0,
      graphicsBindings: scoped.graphicsBindings,
      ...(this.feature.shaderModuleMode === undefined
        ? {}
        : { shaderModuleMode: this.feature.shaderModuleMode }),
      transaction: this.transaction,
      fullscreenEffects: effects,
      lookup: (reference) => this.transaction.lookup(reference),
      assetVersion: (worldIndex, handle, revision) =>
        this.assetVersions.get(`${worldIndex}:${handle}:${revision}`)?.value,
    });
    if (resolver !== undefined) this.resolvers.push(resolver);
    const batchesDepth =
      row.native === true &&
      scope !== 'frame' &&
      viewInput?.featureReadOnlyDepthBatchDiagnostic === true;
    const projectionPlan = this.batchDepthPlan(plan, row, scoped, resolver, batchesDepth);
    const projected = projectPlanPasses(
      this.slot,
      projectionPlan,
      scoped,
      this.gpu,
      targetRoster.projected,
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
    // A pipeline may still be warming while a drawless clear is already
    // resolvable. Never expose that partial atomic work to graph admission.
    if (
      projectionPlan.submission === 'atomic' &&
      projected.value.passes.length !== projectionPlan.passes.length
    )
      return;
    const publishProjectedWork = () => {
      const scopeKey = featureScopeKey(scope);
      const execution = new AcceptedRenderFeatureExecution(
        {
          ...projected.value,
          materialTextureTargets: targetRoster.projected.filter(
            (target) => isRenderFeatureGraphTextureTarget(target) && target.materialSource === true,
          ),
          ...((row.work.placement ?? this.feature.placement) === undefined
            ? {}
            : { placement: row.work.placement ?? this.feature.placement }),
        },
        scopeKey,
      );
      const planned = this.plannedFrame(row, projectionPlan, execution, scopeKey);
      this.projections.push({
        planned,
        projected: execution,
        result,
        effects,
        requiresGraphRebuild: this.requiresGraphRebuild(row, projectionPlan, execution, resolver),
      });
    };
    publishProjectedWork();
  }

  private batchDepthPlan(
    plan: RenderFeaturePlan,
    row: FeatureWorkResources,
    scoped: PreparedPlanResources,
    resolver: PreparedGraphicsResolver | undefined,
    batchesDepth: boolean,
  ): RenderFeatureWorkPlan {
    return batchesDepth && resolver !== undefined && renderFeatureNativeDepthBatchPermission(plan)
      ? {
          ...row.closure,
          passes: coalesceNativeReadOnlyDepthPasses(
            row.closure.passes,
            readOnlyDepthPrograms(scoped, this.transaction, resolver),
          ),
        }
      : row.closure;
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
      error instanceof RenderFeaturePreparationFailedError &&
      error.detail.resourceKind === 'pipeline' &&
      error.detail.reason === 'pipeline-pending'
    )
      this.pendingGraphicsPipelineError ??= error;
    if (
      this.batch.preparationPending ||
      !this.requiresPreparation ||
      !(error instanceof RenderFeaturePreparationFailedError) ||
      error.detail.resourceKind !== 'pipeline' ||
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
    if (this.requiresPreparation && projected.passes.length !== projectionPlan.passes.length) {
      const pending =
        this.pendingGraphicsPipelineError ??
        new RenderFeaturePreparationFailedError(
          this.identity,
          this.slot.order,
          'resolve',
          'pipeline',
          row.work.passes.find(
            (pass) => !projected.passes.some((candidate) => candidate.name === pass.name),
          )?.name ?? 'projected-work',
          'pipeline-pending',
          'next-frame',
        );
      this.batch.markPreparationPending(this.identity, 'graphics-pipeline', pending);
      throw pending;
    }
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
      ...((row.work.placement ?? feature.placement) === undefined
        ? {}
        : { placement: row.work.placement ?? feature.placement }),
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

  // Only the standalone factory declares implicit post work; other entries prewarm resources.
  private admitRequiredPostProcesses(): void {
    if (this.projections.length === 0) return;
    const declaration = fullscreenRenderFeatureDeclaration(this.feature);
    if (
      declaration !== undefined &&
      this.projections.some(({ effects }) => effects.has(declaration.identity))
    )
      this.batch.postProcessIdentities.add(declaration.identity);
  }

  private publishProjections(sourcePlan: RenderFeaturePlan): void {
    for (const { planned, projected, result, effects, requiresGraphRebuild } of this.projections) {
      planExecutionProjections.set(planned, {
        execution: projected,
        ...(this.nativeWork === undefined ? {} : { nativeSignature: planned.signature }),
      });
      if (isSubmissionSensitive(this.feature, planned, sourcePlan))
        submissionSensitivePlans.add(planned);
      (result.plans as RenderFeaturePlannedFrame[]).push(planned);
      if (
        isFeatureGraphConformanceEnabled(this.input.featureGraphConformanceTrace, this.identity)
      ) {
        this.recordConformanceEvent('host-plan-published', {
          planFrameNumber: this.input.frameNumber,
          scope: featureScopeKey(planned.scope),
          generation: planned.generation,
          placement: planned.placement ?? 'post',
          signature: planned.signature,
          passNames: projected.passes.map((pass) => pass.name),
          resolvedDispatchCount: projected.passes.reduce(
            (count, pass) => count + (pass.resolvedGpuCompute?.dispatches.length ?? 0),
            0,
          ),
        });
      }
      for (const [key, entry] of effects)
        (result.fullscreenEffects as Map<string, PostProcessShaderEntry>).set(key, entry);
      if (requiresGraphRebuild) {
        preparedResourceKeyPlans.add(planned);
        Object.assign(result, { requiresPreparedResourceKey: true });
      }
    }
  }

  private recordConformanceEvent(
    stage: 'host-plan-declared' | 'host-plan-published' | 'host-plan-failed',
    details: Readonly<
      Record<
        string,
        string | number | boolean | null | readonly (string | number | boolean | null)[]
      >
    >,
  ): void {
    const trace = this.input.featureGraphConformanceTrace;
    if (trace === undefined || trace.featureIdentity !== this.identity) return;
    recordFeatureGraphConformanceEvent(trace, {
      recordFrameNumber: this.input.recordFrameNumber ?? this.input.frameNumber,
      featureIdentity: this.identity,
      stage,
      details,
    });
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

  private static readonly abortActions = [
    (frame: FeatureFramePreparation) => frame.abortResources(),
    (frame: FeatureFramePreparation) => frame.abortProducerFrame(),
  ];
  private static readonly submitActions = [
    (frame: FeatureFramePreparation, accepted: readonly FeatureWorkProjection[]) =>
      frame.submitReceipt(accepted),
    (frame: FeatureFramePreparation) => frame.publishInspection(),
    (frame: FeatureFramePreparation, accepted: readonly FeatureWorkProjection[]) =>
      frame.acknowledgeAcceptedSource(accepted),
  ];

  /** Discard this frame's resources and producer frame data. */
  abort(): void {
    drainFeatureActions(this, FeatureFramePreparation.abortActions, undefined);
  }

  /** Producer consumption for the works the submitted graphs actually recorded. */
  submit(recorded: ReadonlySet<RenderFeaturePlannedFrame>): void {
    let accepted: FeatureWorkProjection[] | undefined;
    for (const row of this.projections)
      if (recorded.has(row.planned)) {
        accepted ??= [];
        accepted.push(row);
      }
    if (accepted === undefined) {
      this.abort();
      return;
    }
    drainFeatureActions(this, FeatureFramePreparation.submitActions, accepted);
  }

  private submitReceipt(accepted: readonly FeatureWorkProjection[]): void {
    this.feature.onFrameSubmitted?.(this.source, {
      works: accepted.map((row) => ({
        scope: row.planned.scope,
        passes: submittedPasses(row.projected),
      })),
    });
  }

  private acknowledgeAcceptedSource(accepted: readonly FeatureWorkProjection[]): void {
    if (accepted.length > 0) this.acknowledgeSourceFrame(this.plan, sourceSubmission(accepted));
  }

  private acknowledgeSourceFrame(
    plan: RenderFeaturePlan,
    submission: RenderFeatureSubmission,
  ): void {
    if (this.input.publishedFeatures?.some((row) => row.identity === this.identity))
      this.input.onFeatureSourceSubmitted?.(this.identity, plan.sourceFeedback, submission);
    else this.feature.onSourceFrameSubmitted?.(this.source, plan.sourceFeedback, submission);
  }
}

function sourceSubmission(accepted: readonly FeatureWorkProjection[]): RenderFeatureSubmission {
  return {
    works: accepted.map((row) => ({
      scope: row.planned.scope === 'frame' ? 'frame' : { view: row.planned.scope.view },
      passes: submittedPasses(row.projected).map((pass) => ({
        name: pass.name,
        ...(pass.shadowCaster === true ? { shadowCaster: true as const } : {}),
        ...(pass.graphics === undefined
          ? {}
          : { graphics: { draws: pass.graphics.draws.map((draw) => ({ kind: draw.kind })) } }),
        ...(pass.resolvedGpuCompute === undefined
          ? {}
          : { resolvedGpuComputeDispatchCount: pass.resolvedGpuCompute.dispatches.length }),
      })),
    })),
  };
}

function extractView(view: RenderFeatureFrameInput) {
  return Object.freeze({
    identity: view.identity,
    render: view.render,
    ...(view.graphResources === undefined ? {} : { graphResources: view.graphResources }),
    ...(view.selectedCamera === undefined ? {} : { selectedCamera: view.selectedCamera }),
    ...(view.selectedView === undefined ? {} : { selectedView: view.selectedView }),
    ...(view.frame === undefined ? {} : { frame: view.frame }),
    ...(view.frameSize === undefined ? {} : { frameSize: view.frameSize }),
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

function isRetryableGpuPreparationFailure(
  error: unknown,
): error is RenderFeaturePreparationFailedError {
  if (
    !(error instanceof RenderFeaturePreparationFailedError) ||
    error.detail.recovery !== 'next-frame'
  )
    return false;
  return (
    error.detail.operation === 'prepare-gpu-program' ||
    (error.detail.operation === 'resolve' &&
      error.detail.resourceKind === 'pipeline' &&
      error.detail.reason === 'pipeline-pending')
  );
}

const NO_FULLSCREEN_EFFECTS: ReadonlyMap<string, PostProcessShaderEntry> = new Map();

function fullscreenProgramEffects(
  plan: RenderFeatureWorkPlan,
  standaloneIdentity: string | undefined,
): ReadonlyMap<string, PostProcessShaderEntry> {
  if (plan.resources.length === 0) return NO_FULLSCREEN_EFFECTS;
  const effects = new Map<string, PostProcessShaderEntry>();
  for (const resource of plan.resources) {
    if (resource.kind !== 'fullscreen-program') continue;
    const { kind: _kind, name, ...entry } = resource;
    effects.set(name, entry);
    if (standaloneIdentity !== undefined && !effects.has(standaloneIdentity))
      effects.set(standaloneIdentity, entry);
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

/** Only declared submission intents or resident payloads forbid cached graph replay. */
function isSubmissionSensitive(
  feature: RenderFeature<unknown>,
  planned: RenderFeaturePlannedFrame,
  sourcePlan: RenderFeaturePlan,
): boolean {
  const submissionIntent =
    planned.plan.passes.length > 0 ||
    planned.plan.resources.length > 0 ||
    sourcePlan.sourceFeedback !== undefined;
  return (
    (submissionIntent &&
      (feature.onFrameSubmitted !== undefined ||
        feature.onSourceFrameSubmitted !== undefined ||
        feature.onSourceFrameCompleted !== undefined)) ||
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

/**
 * Producer failures cannot strand sibling transactions or suppress accepted
 * source receipts: run each action on every item (one action at a time) and
 * return every failure.
 */
const NO_FINALIZER_FAILURES: readonly unknown[] = Object.freeze([]);

const commitFeatureResources = (feature: FeatureFramePreparation): void =>
  feature.commitResources();

const ABORT_FEATURES = [(feature: FeatureFramePreparation): void => feature.abort()];

const INVOKE_FINALIZER = [(action: () => void): void => action()];

function drainEach<T>(
  items: readonly T[],
  actions: readonly ((item: T) => void)[],
): readonly unknown[] {
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
  return failures ?? NO_FINALIZER_FAILURES;
}

/** Shared runners receive this exact frame; no reusable callback captures mutable authority. */
function drainFeatureActions<T, Input>(
  owner: T,
  actions: readonly ((owner: T, input: Input) => void)[],
  input: Input,
): void {
  let failures: unknown[] | undefined;
  for (const action of actions) {
    try {
      action(owner, input);
    } catch (cause) {
      failures ??= [];
      failures.push(cause);
    }
  }
  if (failures !== undefined)
    throw new AggregateError(failures, 'Feature frame finalization failed');
}

/** One Feature's finalizers: every one runs, then their failures throw together. */
function drainFeatureFinalizers(actions: readonly (() => void)[]): void {
  const failures = drainEach(actions, INVOKE_FINALIZER);
  if (failures.length > 0) throw new AggregateError(failures, 'Feature frame finalization failed');
}

function mergeHiddenEntityReports(
  reports: readonly RenderFeatureHiddenEntityReport[],
  additional: readonly RenderFeatureHiddenEntityReport[],
): readonly RenderFeatureHiddenEntityReport[] {
  if (reports.length === 0 && additional.length === 0) return NO_HIDDEN_ENTITY_REPORTS;
  if (additional.length === 0 && isOwnedHiddenEntityReports(reports)) return reports;
  const entities = new Set<EntityHandle>();
  const merged: RenderFeatureHiddenEntityReport[] = [];
  for (const report of additional.length === 0 ? reports : [...reports, ...additional]) {
    if (entities.has(report.entity)) continue;
    entities.add(report.entity);
    merged.push(report);
  }
  return Object.freeze(merged);
}

/**
 * Validate identities before creating typed slots or accepting resources.
 * Registration order is the input order and is never sorted by feature kind.
 * `report` receives the failures of the frame settlement systems; a Renderer
 * forwards them to its error listeners.
 */
export function createRenderFeatureHost(
  features: readonly RenderFeature<unknown>[],
  world: World = createRenderWorld(),
  report: FeatureSettlementReporter = () => {},
): Result<RenderFeatureHost, RenderError> {
  const identities = new Map<string, number>();
  for (const [order, feature] of features.entries()) {
    const conflictingOrder = identities.get(feature.identity);
    if (conflictingOrder !== undefined) {
      return err(registrationConflict(feature.identity, order, conflictingOrder));
    }
    identities.set(feature.identity, order);
  }

  return ok(new FeatureHostImpl(features.map(createFeatureSlot), world, report));
}

import {
  type FeatureAssetVersionOwner,
  type FeatureSlot,
  frameFeatureTextureReadbacks,
  graphicsValidator,
  planExecutionProjections,
  planFailure,
  projectDraw,
  type RenderFeatureFrameResult,
  type RenderFeaturePlanExecution,
  type RenderFeaturePlanExecutionPass,
  type RenderFeaturePreparedResourceBatch,
  type RenderFeatureStageEvent,
  resolveGraphicsSnapshot,
  type SignatureInspection,
} from './graphics-projection';

export {
  getRenderFeaturePlanExecutionProjection,
  type RenderFeatureFrameResult,
  type RenderFeaturePlanExecution,
  type RenderFeaturePlanExecutionPass,
  type RenderFeaturePreparedResourceBatch,
  type RenderFeatureStageEvent,
} from './graphics-projection';
