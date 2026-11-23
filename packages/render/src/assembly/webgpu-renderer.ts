import { CloudAdoptionReceipts } from '../cloud/reconstruction/adoption-receipts';
import { retainPipelineView } from '../environment/bindings';
import { editorAssistancePresentation } from '../features/editor-assistance/feature';
import {
  canProjectOpaqueStandardMaterial,
  retainStandardPipelineMaterialLayout,
} from '../pbr-pipeline';
import { defaultMaterialFragmentEntry, defaultMaterialVertexEntry } from '../pipeline-builder';
import { retainPipelinePrimitiveReflection } from '../reflection/primitive-bindings';
import {
  prepareTargetEnvironment,
  type RenderTargetEnvironmentLease,
} from '../targets/environment';
import { deferredPostProcessEntry } from './deferred-post-process-entry';
import { extendedLightingFallbackCandidate } from './extended-lighting-fallback';
import {
  buildFullscreenFeaturePipeline,
  prewarmFullscreenFeatureModules,
} from './fullscreen-feature-preparation';
import { createLevelSourceAccess } from './level-source-access';
import { materialFragmentEntry } from './material-fragment-entry';
import {
  type MaterialPipelineSelection,
  materialLayoutProjections,
  runBuildMaterialShaderPipeline,
  runBuildPipelineContext,
  runGetMaterialShaderPipelineEntryFor,
  runGetMaterialShaderPipelineFor,
  runRememberMaterialUvSetCount,
  runRequestedMaterialVariantSet,
  runSelectMaterialPipelineSource,
  runSelectStandardPbrFallback,
  runSelectUnlitPreparedFallback,
} from './material-pipeline-requests';
import { prepareRenderFrame } from './render-frame';
import { rendererConformanceHost } from './renderer-conformance';
import { runDrawLifecycleError, runDrawReadinessError } from './renderer-draw-admission';
import {
  runCompileMaterialPipeline,
  runDeliverFeatureSourceCompletion,
  runDrawHealthError,
  runDrawRequestError,
  runDrawWorldError,
  runMeshBodyPublished,
  runRetirePreviousWaterFrames,
} from './renderer-frame-operations';
import { createTextureResidencyPreparer } from './texture-residency';
import { createViewportHitRequests } from './viewport-hit-requests';
import { prepareWaterFrameBindingCohorts as prepareWaterFrameBindingCohortsImpl } from './water-frame-cohorts';
import {
  createWaterFrameLayouts,
  runDestroyWaterMaterialFrameEntry,
  runSameWaterMeshDraw as sameWaterMeshDraw,
  runWaterMaterialFrameTargetsMatch as waterMaterialFrameTargetsMatch,
} from './water-frame-layouts';
import { projectGpuPassTimingCapture } from './webgpu-renderer-pass-timing';
// @forgeax/engine-render — WebGPU renderer lifecycle/frame interpreter.
// Runtime selects the backend; structured RHI errors and browser isolation stay intact.

import {
  AssetRegistry,
  adaptDynamicTextureDevice,
  DynamicTextureStore,
} from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { createRenderReadLease, type RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { VertexLayoutProjection } from '@forgeax/engine-geometry';
import type { ProfileFrameToken } from '@forgeax/engine-profiler';
import type {
  BindGroupLayout,
  RenderPipeline,
  Result,
  RhiCanvasTarget,
  RhiDevice,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { err, ok, probeMultisampleRenderCapability, RhiError } from '@forgeax/engine-rhi';
import type { PipelineGroup2Contract } from '@forgeax/engine-shader';
import {
  type MaterialShaderEntry,
  type MaterialShaderManifestEntry,
  type RegisteredMaterialShaderEntry,
  ShaderCatalog,
  TONEMAP_PARAMS_LAYOUT,
} from '@forgeax/engine-shader';
import type {
  MaterialRenderState,
  PassKind,
  PrimitiveTopology,
  ShaderEntryPointReads,
  VertexAttributeMap,
} from '@forgeax/engine-types';
import { shaderSourceForDescriptor } from '@forgeax/engine-types';
import { ProjectedDecalInvalidError } from '../decals/component';
import { InstanceProjectionStore } from '../instances';
import {
  isOutputColorSpace,
  OUTPUT_COLOR_SPACES,
  type OutputColorSpace,
} from '../output-color-space';
import { projectPointShadowInspection } from '../point-shadow-inspection';
import { type PublishedRenderFrameInput, RenderPublicationError } from '../publication/contract';
import { SurfaceDynamicInputReceiver } from '../publication/dynamic-input';
import { captureMeshPipelinePreparation } from '../publication/mesh-pipeline-preparation';
import { preparePublicationGeometry } from '../publication/prepare-geometry';
import { type PreparedRenderPublication, RenderPublicationReceiver } from '../publication/receiver';
import { candidateMaterialPipelineRequests } from '../record/candidate-pipeline-preparation';
import { activeRenderProfileSession } from '../record/profile-session';
import {
  configureSurface,
  type MaterialShaderPipelineEntry,
  type PipelinePreparationCompletion,
  type RenderSystemInternals,
  runProfiledRenderPhase,
  selectSwapChainFormat,
} from '../record/render-context';
import { isFrameObservationDomain } from '../render-contract';
import { registerRenderSourceSystems } from '../scene/source-systems';
import { captureSurfaceDynamicInput, surfaceDynamicInputOf } from '../surface/frame-source';
import { createTerrainReceiptOwner } from '../terrain/submitted.js';
import { prepareVolumePrograms } from '../volume/programs';
import { isOwnedWaterMeshAdmissionUploadClosure } from '../water/mesh-source-admission';
import {
  WATER_INFO_FEATURE_IDENTITY,
  waterInfoFramePublicationForRenderer,
} from '../water/water-info-feature';
import {
  selectWaterMaterialFrameTargets,
  waterMaterialEntryPointsUseWaterInfo,
} from '../water/wave-material';
import { debugOverlayHolderOf, debugOverlayInspectionField } from '../world/debug-overlay-systems';
import {
  createRenderWorld,
  pinRenderProfileSession,
  publishSurfaceDynamicInput,
  renderSubmission,
} from '../world/render-world';
import { retireAfterSubmission } from '../world/submission-systems';
import { installSurfaceUi, RenderSurfaceUiInput, type SurfaceUiInput } from '../world/surface-ui';
import { createCameraViews } from './camera-views';
import { inspectDeviceCapabilities } from './device-feature-admission';
import { drainFramePreparation, type FramePreparation } from './frame-recording';
import { createMaterialLayoutCache } from './material/layout-cache';
import {
  materialPipelineRequestCompletion,
  materialPipelineRequestPending,
} from './material/pipeline-preparation-readiness';
import type {
  MaterialPipelineRequestCache,
  materialPipelineRequestFacts,
  PendingMaterialPipelineRequest,
} from './material/pipeline-request-cache';
import {
  type PreparedRenderPipelineOwner,
  preparedRenderPipelineOwner,
} from './material/prepared-pipeline-owner';
import { resolveFeatureShaderSource } from './material-shader-policy';
import {
  createPublishedMeshResidencyHost,
  inspectPublishedMeshResidency,
  reservePublishedMeshTransfer,
} from './published-mesh-residency';
import { captureShadowWorkload } from './shadow-workload';
import { createUiCompositor } from './ui-compositor';

export type { MaterialShaderManifestEntry } from '@forgeax/engine-shader';

import { adoptBackendDevice, DeviceScope } from '../device/device-scope';
import { GpuResidencyCache } from '../device/gpu-residency';
import { createEngineMetrics } from '../engine-metrics';
import { RecoverError, type RecoverFailure } from '../errors/recover';
import {
  CameraViewInvalidError,
  FrameReceiptStaleError,
  type RenderError,
  RendererContractFailureError,
  type RendererOperationCause,
  RendererOperationError,
  RenderFeatureCapabilityMissingError,
  RenderFeatureStageFailedError,
} from '../errors/render';
import { withBuiltinRenderFeatures } from '../features/builtins';
import { registerDepthOfFieldBuiltins } from '../features/depth-of-field/depth-of-field-assembly';
import { createRenderFeatureHost } from '../features/host';
import type { RenderFeature, RenderFeatureShaderModuleMode } from '../features/types';
import {
  type PostProcessShaderEntry,
  postProcessShaderModuleLabel,
} from '../fullscreen-post-process-pass';
import { SKIN_MATERIAL_SHADER_ID } from '../pbr-pipeline';
import { createRenderProfileSelection } from '../pipeline/render-profile-selection';
import { registerSingleLayerMediumBuiltins } from '../pipeline/single-layer-medium-passes';
import { standardPipeline } from '../pipeline/standard-pipeline';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import { type PipelineSpec, PipelineSpecError } from '../pipeline-spec';
import {
  createExtendedLightingState,
  projectExtendedLightingInspection,
  promoteExtendedLightingCandidate,
} from '../prepare/extended-lighting/state';
import type { FrameObservationOptions } from '../record/frame';
import { finalizeRenderPassCpuIdentityCapture } from '../record/frame-targets';
import type { GpuPassTimingError } from '../record/gpu-pass-timing/errors.js';
import {
  DEFAULT_GPU_PASS_TIMING_OPTIONS,
  type GpuPassTimingCapture,
  type GpuPassTimingObservation,
  type GpuPassTimingSession,
  prepareGpuPassTimingSession,
} from '../record/gpu-pass-timing/index.js';
import { GpuTimingCapture, type VolumeTimingObservation } from '../record/gpu-timing';
import type { RecoveryPostProcessResources, RecoveryRootBundle } from '../recovery/types';
import type {
  AtmosphereShaderSources,
  DepthPyramidShaderSources,
  DrawOptions,
  FrameObservationDomain,
  FrameReceipt,
  HealthSnapshot,
  RendererErrorListener,
  RendererLostListener,
  RendererOptions,
  RenderFrameInput,
  RenderInspection,
  RenderProfile,
  RenderResult,
  RenderWorldLease,
  SsrShaderSources,
  VolumetricFogShaderSources,
} from '../render-contract';
import {
  STANDARD_OUTPUT_TRANSFORM_FEATURE_ID,
  STANDARD_OUTPUT_V2_FEATURE_ID,
} from '../render-contract';
import {
  attachGpuPassTimingSession,
  createRendererState,
  type PipelineState,
  type RendererState,
} from '../render-system';
import { recordFailureError } from '../render-system-record-attempt';
import { createGpuPassTimingObservationStore, observeGpuPassTimingDisabled } from '../renderer.js';
import { postSpawnResolveJoints } from '../scene-instances/post-spawn-resolve-joints';
import type { RenderTarget } from '../targets/contracts';
import {
  observeViewFrame,
  viewAutoExposure,
  viewBarrelDistortion,
  viewGraphGeneration,
  viewGraphInfo,
  viewMeshMaterialBindings,
  viewRenderScene,
  viewStandardLut,
} from '../view-inspection';
import { viewOwnerOf } from '../world/view-settlement';
import { registerAnalyticFogPostProcess } from './analytic-fog-registration';
import type { RhiBackendPack } from './backend-contract';
import { inspectBarrelDistortion } from './barrel-distortion-inspection';
import type { RendererHostBundlerOptions } from './bundler-contract';
import {
  captureDrawOwnerProfileFrame,
  type DrawRequest,
  frameDrawOptions,
  frameDrawRequest,
  publicationDrawOptions,
  publicationDrawRequest,
  withFeatureSourceFeedback,
} from './draw-frame-input';
import { captureMaterialDraws } from './draw-observation';
import { createRendererDynamicGeometryController } from './dynamic-geometry-host';
import { createExternalTextureHost } from './external-texture-host';
import { registerFxaaPostProcess } from './fxaa-registration';
import type { RendererAssemblyImplementation } from './host-contract';
import type { LodObservationCaptureValidity } from './lod-observation';
import {
  hasPackedTangentFrame,
  isEngineOwnedMaterialShader,
  resolveCompiledMaterialGroup2Contract,
  resolveMaterialPipelineVertexEntry,
  resolveRendererMaterialShaderArtifact,
} from './material/pipeline-helpers';
import {
  invokeDeviceCreateShaderModule,
  type LayoutKind,
  makeShaderDeviceAdapter,
  prepareMaterialShaders,
  resolveCachedMaterialShaderVariant,
  type ShaderDeviceAdapterInternal,
  viewAndSceneDepthLayoutEntries,
} from './material-shader-policy';
import { registerMotionBlurPostProcess } from './motion-blur-registration';
import {
  createRecoveryFailureLocation,
  type RecoveryFailureLocation,
  recoveryAttemptFailure,
} from './recovery/failure-location';
import { type GenerationPublication, publishGeneration } from './recovery/generation';
import {
  createRendererPipelineCacheState,
  createRendererRecovery,
  type RendererCandidateState,
  type RendererGeneration,
  type RendererPipelineCacheState,
  type RendererRecovery,
  type RendererShaderState,
} from './recovery/renderer-recover';
import {
  collectRequiredFullscreenPostProcesses,
  registerStandardPostProcessBuiltins,
} from './render-feature-post-processes';
import { createRenderTargetHost } from './render-target-host';
import { freezeRenderProfile, structuredRendererCause } from './renderer-facade';
import { projectRendererFeatureInspection } from './renderer-feature-inspection';
import {
  type ContinuationTerminator,
  completeFrameFailure,
  createContinuationTerminator,
  inspectFrameCompletionContinuations,
  observeFrameCompletionStages,
  type PendingFrameCompletion,
  raceFrameContinuation,
  settleFrameCompletion,
} from './renderer-frame-transaction';
import {
  ensureContextConfigured,
  initializationDeviceLoss,
  rendererInitializationError,
  rendererInitializationPipelineError,
  wrapDisposeError,
} from './renderer-helpers';
import {
  createPipelineLibraryCollection,
  exportPipelineLibraryForInspection,
  inspectionSelects,
  projectRecoveryEvidenceInspection,
  projectRendererInspectionState,
  projectRendererOutputFields,
  projectRendererOutputInspectionFromSurface,
  projectRendererPipelineLibraryInspection,
  projectRenderViewInspection,
} from './renderer-inspection';
import {
  createRecoveryContinuation,
  createRecoveryDeadline,
  createSingleFlight,
  type RecoveryPhase,
} from './renderer-lifecycle';

export type { RecoveryFailureLocation } from './recovery/failure-location';

import { ADMIT_EVERY_VARIANT } from './shader-prewarm-policy';
import {
  buildReadyWebGPU,
  prepareBackgroundPipelineLibrary,
  prepareDevicePipelineLibrary,
} from './webgpu-ready';
import { HDR_COLOR_ATTACHMENT_FORMAT } from './webgpu-ready-contract';
import {
  tryCreateRendererFromBackend as tryCreateRendererFromBackendBootstrap,
  type WebGPURendererInternals,
} from './webgpu-renderer-bootstrap';
import type { MaterialPipelineSource, WebGPUOutcome } from './webgpu-renderer-contract';
import {
  createRendererReceiptObservers,
  projectReceiptColorObservations,
  type RendererReceiptLodCaptureState,
} from './webgpu-renderer-observation';
import {
  beginObservationFrame,
  createRendererObservationCaptureOwner,
  submittedFramePresentation,
} from './webgpu-renderer-observation-owner';

export * from './webgpu-renderer-exports';

/** Bundler injection and construction from the selected backend pack. */
export async function tryCreateRendererFromBackend(
  canvas: RhiCanvasTarget,
  options: RendererOptions | undefined,
  pack: RhiBackendPack,
  bundler: RendererHostBundlerOptions | undefined,
): Promise<WebGPUOutcome> {
  return tryCreateRendererFromBackendBootstrap(canvas, options, pack, bundler, makeWebGPURenderer);
}

async function makeWebGPURenderer(
  internals: WebGPURendererInternals,
): Promise<RendererAssemblyImplementation> {
  let disposed = false;
  const observeTiming = observeGpuPassTimingDisabled;
  const frameContinuations = new Map<ContinuationTerminator, PendingFrameCompletion>();
  type RecoveryInspection = RenderInspection['recovery'];
  let recoveryAttempt = 0;
  let recoveryStaleLossEvents = 0;
  let recoveryInspection: RecoveryInspection = Object.freeze({
    phase: null,
    fromGeneration: 0,
    candidateGeneration: 0,
    attempt: 0,
    elapsedMs: 0,
    lastOutcome: 'none',
    rehydratedRoots: 0,
    staleLossEvents: 0,
  });
  const updateRecoveryInspection = (
    patch: Partial<RecoveryInspection>,
    clearFailureLocation = false,
  ): void => {
    const next = { ...recoveryInspection, ...patch, staleLossEvents: recoveryStaleLossEvents };
    if (clearFailureLocation) {
      delete next.failedOwner;
      delete next.failedResourceKind;
    }
    recoveryInspection = Object.freeze(next);
  };
  internals.generationState.onStaleLoss = () => {
    recoveryStaleLossEvents = Math.min(Number.MAX_SAFE_INTEGER, recoveryStaleLossEvents + 1);
    updateRecoveryInspection({});
  };
  let renderTargetDevice = internals.device;
  let renderTargetGeneration = 0;
  let cameraViewsForTargetPromotion: ReturnType<typeof createCameraViews> | undefined;
  // One Render World per Renderer: its view entities share every scene row,
  // and each installed Feature prepares there as its own system.
  const renderWorld = createRenderWorld();
  const cloudAdoption = new CloudAdoptionReceipts(
    (generation) =>
      !disposed &&
      generation === activeDeviceScope.generation &&
      internals.healthRegistry.getLastSnapshot().reason === 'alive',
  );
  const featureHostResult = createRenderFeatureHost(
    withBuiltinRenderFeatures(
      internals.options?.features ?? [],
      internals.device.caps,
      (frame, view, adoption) => cloudAdoption.record(frame, view, adoption),
    ),
    renderWorld,
    internals.errorRegistry.fire.bind(internals.errorRegistry),
  );
  if (!featureHostResult.ok) throw featureHostResult.error;
  internals.featureHost = featureHostResult.value;
  let rendererRecovery: RendererRecovery | undefined;
  const recoveryFlight = createSingleFlight<Result<void, RecoverFailure>>(async () => {
    if (disposed) return err(new RecoverError('recover-not-needed'));
    if (internals.healthRegistry.getLastSnapshot().reason !== 'device-lost') {
      return err(new RecoverError('recover-not-needed'));
    }
    const attempt = ++recoveryAttempt;
    const deadline = createRecoveryDeadline(Date.now());
    const fromGeneration = activeDeviceScope.generation;
    const candidateGeneration = fromGeneration + 1;
    let recoveryFailurePhase: RecoveryPhase = 'quiesce';
    updateRecoveryInspection(
      {
        phase: 'quiesce',
        fromGeneration,
        candidateGeneration,
        attempt,
        elapsedMs: 0,
        lastOutcome: 'none',
        rehydratedRoots: 0,
      },
      true,
    );
    const setRecoveryPhase = (phase: RecoveryPhase): void => {
      if (phase !== 'cleanup') recoveryFailurePhase = phase;
      updateRecoveryInspection({ phase, elapsedMs: deadline.elapsed(Date.now()) });
    };
    let candidateCleanup = (): void => undefined;
    const continuation = createRecoveryContinuation(deadline, () => candidateCleanup());
    const deadlineExpired = (phase: RecoveryPhase): boolean => {
      if (continuation.isValid(phase, Date.now())) return false;
      continuation.abandon(Date.now());
      continuation.cleanupOnce();
      return true;
    };
    let recoveryFailureLocation: RecoveryFailureLocation | undefined;
    let result: Result<void, RecoverFailure>;
    try {
      const recovery = rendererRecovery;
      if (recovery === undefined) {
        return err(new RecoverError('recover-device-unavailable'));
      }
      result = await recovery.recoverOnce(
        deadline,
        deadlineExpired,
        (cleanup) => {
          candidateCleanup = cleanup;
        },
        continuation,
        setRecoveryPhase,
        (count) => updateRecoveryInspection({ rehydratedRoots: count }),
        (failure) => {
          recoveryFailureLocation = failure;
        },
      );
      if (result.ok && ui !== undefined) await ui.owner.recover(internals.device);
    } catch (cause) {
      recoveryFailureLocation ??= createRecoveryFailureLocation('compile-graph', cause);
      candidateCleanup();
      result = err(new RecoverError('recover-device-unavailable'));
    }
    if (result.ok) {
      updateRecoveryInspection(
        {
          phase: null,
          fromGeneration,
          candidateGeneration: activeDeviceScope.generation,
          elapsedMs: deadline.elapsed(Date.now()),
          lastOutcome: 'succeeded',
        },
        true,
      );
      startBackgroundPipelineLibrary();
      return result;
    }
    if (result.error.code === 'recover-not-needed' && !disposed) {
      updateRecoveryInspection(
        { phase: null, elapsedMs: deadline.elapsed(Date.now()), lastOutcome: 'none' },
        true,
      );
      return result;
    }
    const outcome = disposed ? 'disposed' : 'failed';
    const failureLocation = outcome === 'disposed' ? undefined : recoveryFailureLocation;
    const failurePhase =
      outcome === 'disposed' ? 'cleanup' : (failureLocation?.phase ?? recoveryFailurePhase);
    const failure = recoveryAttemptFailure({
      outcome,
      failureLocation,
      failurePhase,
      fromGeneration,
      candidateGeneration,
      attempt,
      elapsedMs: deadline.elapsed(Date.now()),
      rehydratedRoots: recoveryInspection.rehydratedRoots,
      staleLossEvents: recoveryStaleLossEvents,
      error: result.error,
      receipt: activeDeviceScope._receipt(),
    });
    updateRecoveryInspection(
      {
        phase: null,
        elapsedMs: failure.detail.elapsedMs,
        lastOutcome: outcome,
        rehydratedRoots: 0,
      },
      false,
    );
    return err(failure);
  });
  // Keep producer-declared shader identities live across the renderer
  // lifetime. Features can be installed after boot (the public late-install
  // seam used by asset-driven hosts), so a recovery rebuild must include their
  // modules in the same prewarm set as boot. A boot-only snapshot would let the
  // first recovered frame observe a cold async shader adapter and emit a
  // spurious prepared-pipeline failure before the next-frame retry succeeds.
  const requiredMaterialShaderSet = new Set(
    featureHostResult.value.features.flatMap((feature) => feature.requiredMaterialShaders ?? []),
  );
  let requiredMaterialShaders = Object.freeze([...requiredMaterialShaderSet]);
  let requiredFullscreenPostProcesses = Object.freeze(
    collectRequiredFullscreenPostProcesses(featureHostResult.value.features),
  );
  // Lazy ShaderCatalog instance (plan-strategy section S-10 / D-R10 / OQ-5
  // close): constructed on first access; subsequent accesses return the
  // same instance. Recovery owns a second, candidate-only state object while
  // the active state continues serving frames. The two states are swapped
  // only by the synchronous generation publication boundary below; no
  // recovery await can expose a partially rebuilt adapter or catalog.
  let activeDeviceScope = DeviceScope.create(0, 'renderer');
  adoptBackendDevice(activeDeviceScope, internals.device, internals.pack.disposeDevice);
  let candidateBuildState: RendererCandidateState | undefined;
  let activeShaderState: RendererShaderState = {
    device: internals.device,
    shaderInstance: null,
    sharedShaderModuleAdapter: null,
    sharedImmediateShaderModuleAdapter: null,
  };
  let candidateShaderState: RendererShaderState | undefined;
  const getShaderModuleAdapter = (
    mode: 'validated' | 'immediate' = 'validated',
  ): ShaderDeviceAdapterInternal => {
    const state = candidateShaderState ?? activeShaderState;
    const slot =
      mode === 'validated' ? 'sharedShaderModuleAdapter' : 'sharedImmediateShaderModuleAdapter';
    let adapter = state[slot];
    if (adapter === null) {
      adapter = makeShaderDeviceAdapter(
        state.device,
        internals.errorRegistry,
        internals.pack.createShaderModule,
        internals.pack.createShaderModuleImmediate,
        mode,
        mode === 'immediate'
          ? (key, source) => state.sharedShaderModuleAdapter?.completedModule(key, source)
          : undefined,
      );
      state[slot] = adapter;
      (candidateBuildState?.scope ?? activeDeviceScope)._adopt('shader', adapter, (value) =>
        value.dispose(),
      );
    }
    return adapter;
  };
  // RenderSystem retains this factory across recovery. Module requests select
  // the current adapter synchronously; volume preparation resolves all modules
  // before its first await and shares this exact factory with live recording.
  const peekShaderModule = (
    descriptor: Parameters<ShaderDeviceAdapterInternal['createShaderModule']>[0],
    mode: 'validated' | 'immediate',
  ) => {
    if (descriptor.label === undefined) return undefined;
    const state = candidateShaderState ?? activeShaderState;
    const adapter =
      mode === 'validated'
        ? state.sharedShaderModuleAdapter
        : state.sharedImmediateShaderModuleAdapter;
    return adapter?.completedModule(
      descriptor.label,
      shaderSourceForDescriptor(descriptor) ?? descriptor.code,
    );
  };
  const renderShaderModuleFactory = {
    createShaderModule: (
      descriptor: Parameters<ShaderDeviceAdapterInternal['createShaderModule']>[0],
    ) => getShaderModuleAdapter().createShaderModule(descriptor),
    isPending: (error: Parameters<ShaderDeviceAdapterInternal['isPending']>[0]) =>
      getShaderModuleAdapter().isPending(error),
    peekShaderModule: (
      descriptor: Parameters<ShaderDeviceAdapterInternal['createShaderModule']>[0],
    ) => peekShaderModule(descriptor, 'validated'),
    pendingShaderModuleCompletion: (signal: RhiError) =>
      (candidateShaderState ?? activeShaderState).sharedShaderModuleAdapter?.pendingCompletion(
        signal,
      ),
  };
  const featureShaderScopes = new WeakMap<RenderFeature<unknown>, DeviceScope>();
  const getShader = (): ShaderCatalog => {
    const state = candidateShaderState ?? activeShaderState;
    if (state.shaderInstance === null) {
      const activeCatalog =
        activeShaderState.shaderInstance ?? internals.bundler?.admittedShaderCatalog;
      // Reuse validated manifest CPU rows; candidate preparation selects variants.
      // feat-20260608-create-app-param-surface-trim / M2 / D-2 q5-A:
      // shaderManifestUrl moved to BundlerOptions (third arg). The fallback
      // literal '/shaders/manifest.json' stays here so the LO 1.1
      // hello-window zero-config takeoff path keeps working without an
      // bundler injection. The 'shaderManifestUrl' in (...) check preserves
      // the zero-entry opt-in: explicitly passing
      // `bundler: { shaderManifestUrl: undefined }` retains the
      // old "no manifest fetched" mode used by tests / camera-only worlds.
      state.shaderInstance =
        activeCatalog !== undefined
          ? activeCatalog.forkForDevice(getShaderModuleAdapter())
          : new ShaderCatalog({
              device: getShaderModuleAdapter(),
              ...(internals.bundler?.prepareShaderProgramCompiler === undefined
                ? {}
                : {
                    prepareProgramCompiler: internals.bundler.prepareShaderProgramCompiler,
                  }),
              ...(internals.bundler?.readShaderManifest === undefined
                ? {}
                : {
                    readText: internals.bundler.readShaderManifest,
                  }),
              manifestUrl:
                internals.bundler !== undefined && 'shaderManifestUrl' in internals.bundler
                  ? internals.bundler.shaderManifestUrl
                  : '/shaders/manifest.json',
            });
    }
    return state.shaderInstance;
  };
  const shaderCatalog = getShader();
  const assets = new AssetRegistry({
    shaderRegistry: shaderCatalog,
    importTransport: internals.importTransport,
    postSpawnHook: postSpawnResolveJoints,
    ...(internals.options?.assetBudgetBytes === undefined
      ? {}
      : { limits: { maxBytes: internals.options.assetBudgetBytes } }),
  });
  // feat-20260601-device/gpu-residency-extraction M1: the GPU residency layer
  // lives in a standalone store; `assets` keeps the CPU POD registry only.
  let gpuStore = new GpuResidencyCache(internals.options?.tasks, {
    textureMipSkip: internals.options?.textureMipSkip,
  });
  // feat-20260623-world-space-video-asset M4 / w16 (D-3): transient per-frame
  // video texture store, fully independent of gpuStore (AC-08). Configured with
  // the device alongside gpuStore below; threaded into the record stage via the
  // RenderSystemRuntime so a `videoTextureFields` material field uploads its
  // frame here instead of entering the static ensureResident cache.
  let dynamicTextureStore = new DynamicTextureStore();
  const targetEnvironments = new Set<RenderTargetEnvironmentLease>();
  const releaseTargetEnvironments = () => {
    for (const environment of targetEnvironments) environment.release();
  };
  const renderTargetHost = createRenderTargetHost({
    onError: (error) => internals.errorRegistry.fire(error),
    rendererId: Symbol('renderer'),
    getGeneration: () => renderTargetGeneration,
    getDevice: () => renderTargetDevice,
    canPromoteTarget: (target: RenderTarget) =>
      cameraViewsForTargetPromotion?.isCubeCapturePending(target) !== true,
  });
  const externalTextureHost = createExternalTextureHost({
    getDevice: () => internals.device,
    getGeneration: () => activeDeviceScope.generation,
    isDeviceLost: () => internals.healthRegistry.getLastSnapshot().reason === 'device-lost',
    getDynamicTextureStore: () => dynamicTextureStore,
    onError: (error) => internals.errorRegistry.fire(error),
  });
  // Published rows are prepared once at acceptance, for every view.
  const publicationInstances =
    internals.options?.publicationSource === undefined ? undefined : new InstanceProjectionStore();
  const surfaceInputReceiver = new SurfaceDynamicInputReceiver();
  const publicationReceiver =
    internals.options?.publicationSource === undefined || publicationInstances === undefined
      ? undefined
      : new RenderPublicationReceiver(
          internals.options.publicationSource,
          renderTargetHost,
          (prepared) =>
            preparePublicationGeometry(
              prepared,
              renderInternals.assets,
              publicationInstances,
              renderInternals.device.caps.storageBuffer
                ? renderInternals.getMaterialShaderArtifact
                : undefined,
            ),
          renderWorld,
          internals.options.dynamicGeometryMeshBudgetBytes,
        );
  // feat-20260527-sprite-nineslice M4 / w16 (D-5): detached host-owned
  // EngineMetrics counter reaches the record stage via `RenderSystemRuntime.metrics`.
  // (`nineslice.scale-too-small`, `nineslice.tile-needs-repeat-sampler`) bump
  // counters through the owning service (charter P3 machine-readable signals
  // over a per-frame console.warn flood). Each renderer assembly owns its own
  // counter Map (D-5 candidate 1 isolation); Renderer does not expose it.
  const metrics = createEngineMetrics();
  let extendedLightingState = createExtendedLightingState(activeDeviceScope.generation);
  const gpuPassTimingOptions = internals.options?.gpuPassTiming;
  const timingRetentionFrames =
    gpuPassTimingOptions?.retentionFrames !== undefined &&
    Number.isInteger(gpuPassTimingOptions.retentionFrames) &&
    gpuPassTimingOptions.retentionFrames >= 1 &&
    gpuPassTimingOptions.retentionFrames <= 8
      ? gpuPassTimingOptions.retentionFrames
      : DEFAULT_GPU_PASS_TIMING_OPTIONS.retentionFrames;
  let gpuPassTimingSession: GpuPassTimingSession | undefined;
  let gpuPassTimingUnavailable: GpuPassTimingObservation | undefined;
  const timingObservationStore =
    gpuPassTimingOptions === undefined
      ? undefined
      : createGpuPassTimingObservationStore({
          retentionFrames: timingRetentionFrames,
          currentDeviceGeneration: () => activeDeviceScope.generation,
        });
  const retireGpuPassTimingSession = (): void => {
    const retired = gpuPassTimingSession;
    gpuPassTimingSession = undefined;
    retired?.dispose();
  };
  const failedGpuPassTimingObservation = (error: GpuPassTimingError): GpuPassTimingObservation => {
    const latestKnownGood = timingObservationStore?.inspect().latestKnownGood;
    return {
      status: 'failed',
      error,
      ...(latestKnownGood === undefined ? {} : { latestKnownGood }),
    };
  };
  const prepareGpuPassTimingState = (device: RhiDevice) =>
    prepareGpuPassTimingSession(
      device,
      gpuPassTimingOptions,
      gpuPassTimingOptions === undefined ? undefined : getShaderModuleAdapter('immediate'),
    );
  ({ gpuPassTimingSession, gpuPassTimingUnavailable } = prepareGpuPassTimingState(
    internals.device,
  ));
  // feat-20260629 M4: per-material-shader UV set count from naga vertex
  // @location reflection. Populated during prepareMaterialShaders from
  // MaterialShaderManifestEntry.uvSetCount. Read by getMaterialShaderPipeline
  // to auto-fill shaderUvSetCount for clamp-to-last alias.
  let materialShaderUvSetCounts = new Map<string, number>();
  // feat-20260527-sprite-nineslice M4 / w18 prep (D-9): hand the same
  // EngineMetrics instance to AssetRegistry so register-time soft-warns
  // (sliceMode=1 + sampler.addressMode !== 'repeat') bump
  // 'nineslice.tile-needs-repeat-sampler' on the SAME counter the runtime
  // reads.
  assets.setMetrics(metrics);
  // feat-20260707 M5 / w33 (D-11 + D-8): project the RhiCaps three-way
  // compression triple into the codec-facing `TranscodeCaps` and wire it into
  // the registry so the texture / equirect Basis arms can pick a transcode
  // target. One-line projection; the loader stays a pure consumer of declared ctx input (Pipeline Isolation).
  assets.setTranscodeCaps({
    bc: internals.device.caps.textureCompressionBc,
    etc2: internals.device.caps.textureCompressionEtc2,
    astc: internals.device.caps.textureCompressionAstc,
  });
  // M1 (bug-20260601-hello-tonemap-material-register D-1/D-2): prepare
  // engine-shipped material shaders (cap gate + manifest load + registration)
  // so they are available in ShaderCatalog before `register<MaterialAsset>`.
  // Failures throw structured RhiError / ShaderError through `createRenderer`.
  // Graphics/UI boot has no dependency on the game shader manifest. The same
  // surface, device and frame transaction remain active during scene loading.
  const uiFormats = selectSwapChainFormat(
    internals.device.caps.storageBuffer,
    (internals.device as unknown as { readonly surfaceViewFormats?: boolean }).surfaceViewFormats ??
      internals.device.caps.backendKind !== 'wgpu-webgl2',
  );
  const ui =
    internals.options?.ui === undefined
      ? undefined
      : installSurfaceUi(
          renderWorld,
          await createUiCompositor({
            source: internals.options.ui,
            device: internals.device,
            format: uiFormats.storage,
            // UI textures retire through the Renderer's one submission lifecycle.
            retire: (owner, release) =>
              retireAfterSubmission(renderWorld, {
                generation: activeDeviceScope.generation,
                queue: owner.queue,
                release,
              }),
            createShaderModule: async (device, source) => {
              const module = await (
                internals.pack.createShaderModule ?? invokeDeviceCreateShaderModule
              )(device, {
                code: source,
                label: 'screen-ui-composite',
              });
              if (!module.ok) throw module.error;
              return module.value;
            },
          }),
          uiFormats.storage,
        );
  if (ui !== undefined) {
    const configured = configureSurface(
      internals.context,
      internals.device,
      uiFormats.storage,
      uiFormats.view,
      internals.outputColorSpace.requested,
    );
    if (!configured.ok) {
      ui.owner.dispose();
      throw configured.error;
    }
    internals.outputColorSpace.report = configured.value;
  }
  // MaterialAsset per-slot texCoord: the built-in standard PBR + skin shaders
  // unconditionally declare all eight supported UV sets so they can honor
  // per-slot coordinate selection. Their vertex layout must therefore always
  // carry the declared UV slots or CreateRenderPipeline rejects the module.
  // in VertexState"). `materialShaderUvSetCounts` is the SSOT both PSO paths read
  // (buildPipelineContext + getMaterialShaderPipeline) to drive the clamp-to-last
  // alias; naga reflection can be stale for engine-shipped modules, so the
  // count is asserted explicitly. Missing mesh sets are clamp-to-last aliases.
  const packShaderFactory = internals.pack.createShaderModule;
  gpuStore.configureGpuDevice(internals.device, packShaderFactory, internals.device.caps);
  gpuStore.configureIblDevice(
    internals.device,
    internals.pack.createShaderModule === undefined
      ? undefined
      : (
          (createShaderModule) => (device, descriptor) =>
            createShaderModule(device, descriptor)
        )(internals.pack.createShaderModule),
  );
  gpuStore.bindDeviceScope(activeDeviceScope);
  // feat-20260623-world-space-video-asset M4 / w16 (D-3): wire the same device
  // into the transient video texture store (createTexture / createTextureView /
  // destroyTexture / queue.copyExternalImageToTexture all live on RhiDevice).
  dynamicTextureStore.configureGpuDevice(adaptDynamicTextureDevice(internals.device));
  // D-S3: Renderer.initialization three-step strict-serial Promise. Kicked off
  // synchronously here so `await renderer.initialization` is the AI-user-facing
  // barrier; failure is structured and goes through Promise reject (no
  // throw, no silent skip — charter proposition 4 explicit failure).
  let pipelineState: PipelineState | null = null;
  const generationPublication: GenerationPublication<RendererGeneration | undefined> = {
    current: undefined,
  };
  const publishRendererGeneration = (candidate: RendererGeneration): void => {
    publishGeneration(generationPublication, candidate, (value) => value.scope.isAlive());
    activeDeviceScope = candidate.scope;
    dynamicGeometry.invalidateGeneration(activeDeviceScope.generation);
    internals.generationState.current = activeDeviceScope.generation;
    pipelineState = candidate.pipeline;
    const bindings = candidate.producerBindings;
    const previousTimingSession = gpuPassTimingSession;
    gpuPassTimingSession = bindings.gpuPassTimingSession;
    gpuPassTimingUnavailable = bindings.gpuPassTimingUnavailable;
    attachGpuPassTimingSession(internals, gpuPassTimingSession);
    internals.gpuPassTimingCapture = undefined;
    internals.gpuPassTimingSubmittedWork = undefined;
    internals.gpuPassTimingBeginReason = undefined;
    internals.gpuPassTimingDeviceGeneration = undefined;
    previousTimingSession?.dispose();
    gpuStore = bindings.gpuStore;
    dynamicTextureStore = bindings.dynamicTextureStore;
    activeShaderState = bindings.shaderState;
    activePipelineCacheState = bindings.pipelineCacheState;
    materialShaderUvSetCounts = bindings.materialShaderUvSetCounts;
    emptyPostProcessBgl = bindings.emptyPostProcessBgl;
    if (bindings.growMeshSsbo === undefined) delete internals.growMeshSsbo;
    else internals.growMeshSsbo = bindings.growMeshSsbo;
    if (bindings.meshSsboState === undefined) delete internals.meshSsboState;
    else internals.meshSsboState = bindings.meshSsboState;
    gpuStore.bindDeviceScope(activeDeviceScope);
  };
  let readySettled = false;
  let activePipelineCacheState = createRendererPipelineCacheState();
  const materialShaderPipelineSelections = new WeakMap<object, MaterialPipelineSelection>();
  // Variant keys include device capability axes; this manifest-identity cache
  // remains shared across the renderer's recovery candidates.
  const materialShaderVariantResolutionCache =
    activePipelineCacheState.materialShaderVariantResolutionCache;
  let candidatePipelineCacheState: RendererPipelineCacheState | undefined;
  let candidateMaterialShaderUvSetCounts: Map<string, number> | undefined;
  let emptyPostProcessBgl: BindGroupLayout | null = null;
  let candidateEmptyPostProcessBgl: BindGroupLayout | null | undefined;
  const currentPipelineCacheState = (): RendererPipelineCacheState =>
    candidatePipelineCacheState ?? activePipelineCacheState;
  const currentPipelineState = (): PipelineState | null =>
    candidateBuildState === undefined ? pipelineState : candidateBuildState.pipelineState;
  const currentBuildDevice = (): RhiDevice => candidateBuildState?.device ?? internals.device;
  const currentMaterialShaderUvSetCounts = (): Map<string, number> =>
    candidateMaterialShaderUvSetCounts ?? materialShaderUvSetCounts;
  const currentEmptyPostProcessBgl = (): BindGroupLayout | null =>
    candidateEmptyPostProcessBgl === undefined ? emptyPostProcessBgl : candidateEmptyPostProcessBgl;
  const {
    getMaterialShaderBindingContract,
    getOrBuildPreparedStoragePipelineLayout,
    getOrBuildGroup0MaterialLayout,
    getOrBuildViewOnlyMaterialPipelineLayout,
    getOrBuildViewAndSceneDepthMaterialPipelineLayout,
    getOrBuildGroup0ResourceLayout,
    getOrBuildPreparedMaterialPipelineLayout,
    getOrBuildPerShaderMaterialLayout,
    getParamSchema,
    getMaterialBindGroupLayout,
    lookupMaterialBindGroupLayout,
  } = createMaterialLayoutCache({
    currentPipelineCacheState,
    currentPipelineState,
    currentBuildDevice,
    getShader,
    viewAndSceneDepthLayoutEntries: () =>
      viewAndSceneDepthLayoutEntries(currentPipelineState()?.atmosphereAvailable === true),
    reportError: (error) => internals.errorRegistry.fire(error),
  });
  const resolveCachedMaterialShaderVariantSet = (
    requestedVariantSet: string | undefined,
    manifestEntry: MaterialShaderManifestEntry | undefined,
  ): string | undefined => {
    // Keep lazy PSO resolution aligned with buildReadyWebGPU's sampled-texture gate.
    const device = currentBuildDevice();
    return resolveCachedMaterialShaderVariant(
      materialShaderVariantResolutionCache,
      requestedVariantSet,
      manifestEntry,
      device,
    );
  };
  const promotePipelineExtendedLighting = (state: PipelineState, scope: DeviceScope): void => {
    const candidate = extendedLightingFallbackCandidate(state, scope);
    extendedLightingState = promoteExtendedLightingCandidate(extendedLightingState, candidate);
  };
  let tonemapRegistered = false,
    fxaaRegistered = false;
  let temporalPostProcessesRegistered = false,
    depthOfFieldRegistered = false;
  // Boot warms every device-reachable variant; a recovery candidate rebuilds
  // only modules the lost generation drew with, inside the recovery deadline.
  const drewWithModule = (label: string): boolean =>
    activeShaderState.sharedShaderModuleAdapter?.hasModule(label) === true ||
    activeShaderState.sharedImmediateShaderModuleAdapter?.hasModule(label) === true;
  const buildPipeline = async (
    scope: DeviceScope = activeDeviceScope,
    device: RhiDevice = currentBuildDevice(),
    residencyStore: GpuResidencyCache = gpuStore,
  ): Promise<PipelineState> => {
    const buildState = candidateBuildState;
    const registry = getShader();
    const pipelineCache = currentPipelineCacheState().materialShaderPipelineCache;
    const shaderAdapter = getShaderModuleAdapter();
    const immediateAdapter = getShaderModuleAdapter('immediate');
    const buildIsCurrent = () => scope.isAlive() && candidateBuildState === buildState;
    const ensureBuildAlive = () => {
      if (!buildIsCurrent())
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'pipeline preparation keeps its device generation',
          hint: 'discard the retired preparation and retry on the current Renderer',
        });
    };
    if (internals.options?.pipelineLibrary !== undefined)
      await prepareDevicePipelineLibrary(
        device,
        internals.options.pipelineLibrary,
        registry,
        scope.ref('pipeline', {}).value,
      );
    ensureBuildAlive();
    const seededModules = new Map<string, ShaderModule>();
    scope._adopt('shader', seededModules, (modules) => modules.clear());
    return buildReadyWebGPU(
      device,
      scope,
      () => {
        ensureBuildAlive();
        return registry;
      },
      residencyStore,
      internals.pack.createShaderModule,
      internals.pack.createShaderModuleImmediate,
      internals.errorRegistry,
      buildState === undefined
        ? requiredMaterialShaders
        : [
            ...new Set([...requiredMaterialShaders, ...registry.materialShaderIdentifiers()]),
          ].filter(
            // Material publication installs all cooked alternatives, including
            // optional outputs the active device never compiled. Recover only
            // successfully used modules plus explicitly required feature inputs.
            (id) =>
              requiredMaterialShaders.includes(id) ||
              (!isEngineOwnedMaterialShader(id) && drewWithModule(`module-${id}`)),
          ),
      materialShaderUvSetCounts.get('forgeax::default-standard-pbr') ?? 0,
      requiredFullscreenPostProcesses,
      (hook, state) => {
        ensureBuildAlive();
        if (buildState !== undefined) {
          buildState.growMeshSsbo = hook;
          buildState.meshSsboState = state;
        } else {
          internals.growMeshSsbo = hook;
          internals.meshSsboState = state;
        }
      },
      (label, module, source) => {
        ensureBuildAlive();
        seededModules.set(label, module);
        shaderAdapter.seedModule(label, module, source);
        immediateAdapter.seedModule(label, module, source);
      },
      (key, pso, group2Contract) => {
        ensureBuildAlive();
        if (!pipelineCache.has(key)) {
          pipelineCache.set(key, pso);
        }
        materialShaderPipelineSelections.set(pso as object, { contract: group2Contract });
      },
      (source: string, nativeSource?: () => string) => {
        ensureBuildAlive();
        if (buildState !== undefined || tonemapRegistered) return;
        renderSystem.registerBuiltinPostProcess(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, {
          source,
          params: {
            byteSize: TONEMAP_PARAMS_LAYOUT.byteSize,
            defaultValue: new Uint8Array(TONEMAP_PARAMS_LAYOUT.byteSize),
          },
          reads: ['hdrColor'],
        });
        if (nativeSource !== undefined)
          renderSystem.registerBuiltinPostProcess(
            STANDARD_OUTPUT_V2_FEATURE_ID,
            deferredPostProcessEntry({}, nativeSource),
          );
        tonemapRegistered = true;
      },
      (source: string) => {
        ensureBuildAlive();
        fxaaRegistered = registerFxaaPostProcess(renderSystem, source, fxaaRegistered);
      },
      (source: string | (() => string)) => {
        ensureBuildAlive();
        registerAnalyticFogPostProcess(renderSystem, source, buildState !== undefined);
      },
      (entries: { readonly motionBlur?: () => string; readonly taaResolve?: () => string }) => {
        ensureBuildAlive();
        if (buildState !== undefined || temporalPostProcessesRegistered) return;
        if (entries.motionBlur !== undefined) {
          registerMotionBlurPostProcess(renderSystem, entries.motionBlur);
        }
        if (entries.taaResolve !== undefined) {
          renderSystem.registerBuiltinPostProcess(
            'forgeax.taa-resolve',
            deferredPostProcessEntry(
              {
                params: { byteSize: 16, defaultValue: new Uint8Array(16) },
                reads: [
                  'scene-color',
                  'scene-temporal',
                  'taa-history-color',
                  'taa-history-temporal',
                ],
              },
              entries.taaResolve,
            ),
          );
        }
        temporalPostProcessesRegistered = true;
      },
      (entries: {
        readonly singleSample?: string | (() => string);
        readonly multisampled?: string | (() => string);
      }) => {
        ensureBuildAlive();
        if (buildState !== undefined || depthOfFieldRegistered) return;
        registerDepthOfFieldBuiltins(renderSystem, entries);
        depthOfFieldRegistered = true;
      },
      async (sources: VolumetricFogShaderSources) => {
        ensureBuildAlive();
        await prepareVolumePrograms(
          {
            device,
            deviceScope: scope,
            shaderModuleFactory: renderShaderModuleFactory,
            isCurrent: buildIsCurrent,
          },
          sources,
          HDR_COLOR_ATTACHMENT_FORMAT,
        );
        ensureBuildAlive();
        internals.volumetricFogShaders = sources;
      },
      (sources: SsrShaderSources | undefined, pyramid: DepthPyramidShaderSources) => {
        ensureBuildAlive();
        internals.ssrShaders = sources;
        internals.depthPyramidShaders = pyramid;
      },
      (sources: AtmosphereShaderSources) => {
        ensureBuildAlive();
        internals.atmosphereShaders = sources;
      },
      (sources) => {
        ensureBuildAlive();
        internals.standardSceneShaders = sources;
      },
      buildState === undefined ? ADMIT_EVERY_VARIANT : drewWithModule,
      activeProfile.outputContract,
    ).then(async (state) => {
      // draw() is synchronous. Complete the opt-in capability probe before
      // publishing readiness, including when rebuilding a lost device.
      ensureBuildAlive();
      await renderSystem.initializeSsr(device);
      if (device.caps.backendKind === 'wgpu-webgl2')
        await probeMultisampleRenderCapability(
          device,
          (descriptor) => getShaderModuleAdapter('immediate').createShaderModule(descriptor),
          activeDeviceScope.generation,
        );
      ensureBuildAlive();
      return state;
    });
  };
  const pipelineLibraryCollection = createPipelineLibraryCollection(currentBuildDevice);
  let backgroundPipelineLibraryState: RenderInspection['backgroundPipelineLibraryState'];
  let backgroundPipelineLibraryRun = 0;
  // Started after first readiness and again on each recovered device, never
  // awaited. A replaced device starts with an empty library, so the same
  // manifest is replayed on the same background lane; only the latest run
  // publishes its state.
  const startBackgroundPipelineLibrary = (): void => {
    const manifest = internals.options?.backgroundPipelineLibrary;
    if (manifest === undefined || internals.device.pipelineLibrary === undefined) return;
    const device = internals.device;
    const run = ++backgroundPipelineLibraryRun;
    backgroundPipelineLibraryState = 'running';
    void prepareBackgroundPipelineLibrary(
      device,
      manifest,
      getShader,
      () => !disposed && internals.device === device,
      (cause) => {
        if (run !== backgroundPipelineLibraryRun) return;
        backgroundPipelineLibraryState = 'failed';
        console.warn(
          '[forgeax/render] background pipeline library preparation failed; affected pipelines compile on first use',
          cause,
        );
      },
      activeDeviceScope.ref('pipeline', {}).value,
      internals.options?.backgroundPipelineLibraryConcurrency,
    ).then(() => {
      if (run === backgroundPipelineLibraryRun && backgroundPipelineLibraryState === 'running')
        backgroundPipelineLibraryState =
          !disposed && internals.device === device ? 'done' : 'failed';
    });
  };
  const ready: Promise<Result<void, RhiError>> = Promise.resolve()
    .then(async () => {
      await prepareMaterialShaders(internals.device, getShader, materialShaderUvSetCounts);
      if (disposed) throw new Error('Renderer disposed during scene preparation');
      materialShaderUvSetCounts.set('forgeax::default-standard-pbr', 8);
      materialShaderUvSetCounts.set(SKIN_MATERIAL_SHADER_ID, 8);
      return buildPipeline();
    })
    .then(
      (state): Result<void, RhiError> => {
        if (disposed)
          return err(
            rendererInitializationError(new Error('Renderer disposed during scene preparation')),
          );
        pipelineState = state;
        promotePipelineExtendedLighting(state, activeDeviceScope);
        readySettled = true;
        startBackgroundPipelineLibrary();
        return ok(undefined);
      },
      (e: unknown): Result<void, RhiError> => {
        readySettled = true;
        // A device lost during preparation settles in-flight work with whatever
        // the interrupted step reports. The device loss is the cause.
        const lost = initializationDeviceLoss(
          e,
          internals.healthRegistry.getLastSnapshot(),
          disposed,
        );
        if (lost !== undefined) return err(lost);
        if (e instanceof RhiError && e.code !== 'device-lost') return err(e);
        if (e instanceof PipelineSpecError) return err(rendererInitializationPipelineError(e));
        return err(rendererInitializationError(e));
      },
    );
  const waterMaterialFrameEntries = new Map<
    object,
    Parameters<typeof prepareWaterFrameBindingCohortsImpl>[12]
  >();
  const waterMaterialFrameSamplers = new WeakMap<object, import('@forgeax/engine-rhi').Sampler>();
  const waterInfoFeature = (): object | undefined =>
    internals.featureHost?.features.find(
      (feature) => feature.identity === WATER_INFO_FEATURE_IDENTITY,
    );
  const waterMaterialBuffers = (
    bindings: import('../water/wave-material').WaterMaterialFrameGpuBuffers,
  ) => [
    bindings.bodyDataBuffer,
    bindings.waveDataBuffer,
    bindings.drawDataBuffer,
    bindings.waterInfoDescriptorBuffer,
    bindings.waterMeshInstanceBuffer,
    bindings.bakedDescriptorBuffer,
    bindings.bakedSamplesBuffer,
  ];
  const destroyWaterMaterialFrameEntry = (
    device: RhiDevice,
    entry: {
      lifetime: 'active' | 'retiring' | 'destroyed';
      readonly deviceGeneration: number;
      readonly bindings: ReadonlyMap<
        string,
        import('../water/wave-material').WaterMaterialFrameBindings
      >;
      readonly retiredBuffers: readonly (readonly import('@forgeax/engine-rhi').Buffer[])[];
    },
  ): void => {
    runDestroyWaterMaterialFrameEntry(internals, waterMaterialBuffers, device, entry);
  };
  const destroyWaterMaterialFrameEntries = (device: RhiDevice): void => {
    const entries = waterMaterialFrameEntries.get(device as object);
    if (entries === undefined) return;
    for (const entry of entries.values()) destroyWaterMaterialFrameEntry(device, entry);
    entries.clear();
    waterMaterialFrameEntries.delete(device as object);
  };
  const { waterMaterialFrameLayout, waterWavesPipelineLayout } = createWaterFrameLayouts(
    internals,
    currentBuildDevice,
  );
  const buildPipelineContext = (
    variantSet?: string,
    materialShaderId?: string,
    group2Contract: PipelineGroup2Contract = 'mesh',
    // Skin layouts derive their vertex ABI from the shared attribute projection.
    meshAttributes?: VertexAttributeMap,
    vertexLayout?: string,
    vertexLayoutProjection?: VertexLayoutProjection,
    shaderModuleMode?: RenderFeatureShaderModuleMode,
    layoutKindOverride?: LayoutKind,
    particleInputLanes?: number,
    waterInfoFormat?: 'rgba16float' | 'rgba32float',
    programIdentity?: string,
    entryPoints?: readonly ShaderEntryPointReads[],
    waterSystemInputs = false,
    preparedStorageBindings = false,
    projectOpaqueLayout = false,
    projections?: import('./material-pipeline-requests').MaterialLayoutProjections,
  ) => {
    return runBuildPipelineContext(
      getShader,
      currentPipelineState,
      waterWavesPipelineLayout,
      currentMaterialShaderUvSetCounts,
      currentBuildDevice,
      internals,
      getShaderModuleAdapter,
      getOrBuildPerShaderMaterialLayout,
      getMaterialShaderBindingContract,
      getOrBuildGroup0MaterialLayout,
      getOrBuildGroup0ResourceLayout,
      getOrBuildViewOnlyMaterialPipelineLayout,
      getOrBuildViewAndSceneDepthMaterialPipelineLayout,
      getOrBuildPreparedMaterialPipelineLayout,
      getOrBuildPreparedStoragePipelineLayout,
      variantSet,
      materialShaderId,
      group2Contract,
      meshAttributes,
      vertexLayout,
      vertexLayoutProjection,
      shaderModuleMode,
      layoutKindOverride,
      particleInputLanes,
      waterInfoFormat,
      programIdentity,
      entryPoints,
      waterSystemInputs,
      preparedStorageBindings,
      projectOpaqueLayout,
      projections,
    );
  };
  /**
   * Builds a pipeline for the given entry, caches it keyed by cacheKey,
   * and returns it. Returns null on build failure (firing errorRegistry
   * for non-transient errors).
   */
  const preparedPipelineOwners = new WeakMap<
    RendererPipelineCacheState,
    PreparedRenderPipelineOwner
  >();
  const resolvePipelineEntryProgram = (entry: MaterialShaderEntry) =>
    (entry as Partial<RegisteredMaterialShaderEntry>).program ??
    getShader().materialProgram(entry.sourceReference ?? entry.source);
  const buildAndCachePipeline = (
    cacheKey: string,
    entry: MaterialShaderEntry,
    label: string,
    moduleLabel: string,
    isHdr: boolean,
    attachments: PipelineSpec['attachments'],
    renderState: MaterialRenderState | undefined,
    topology: PrimitiveTopology | undefined,
    stripIndexFormat: 'uint16' | 'uint32' | undefined,
    // feat-20260609 M4.5 / w37 (D-10): thread variantSet to the layout selector
    // so HDRP-variant PSOs build with `hdrpPbrPipelineLayout` (7-slot group(2))
    // and URP-variant PSOs build with `pbrPipelineLayout` (1-slot group(2)).
    variantSet?: string,
    passKind: PassKind = 'forward',
    // bug-20260611-skin-pipeline-layout: thread materialShaderId so
    // buildPipelineContext can derive `LayoutKind === 'pbr-skin'` and pick
    // the 2-entry mesh-array BGL chain.
    materialShaderId?: string,
    // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
    // pass the per-mesh `VertexAttributeMap` so the pbr-skin path's
    // vertex buffer layout flows from the SSOT `deriveVertexBufferLayout`
    // (vertex-attribute-layout.ts) instead of a parallel hardcoded copy.
    // Undefined falls into the synthetic 6-key sentinel inside
    // `buildPipelineContext` (key-presence-only); non-skin layoutKinds
    // ignore this parameter entirely.
    meshAttributes?: VertexAttributeMap,
    // Sample count follows camera attachments and participates in PSO identity.
    // Storage views retain their non-sRGB format. A null target is colorless.
    vertexLayout?: string,
    vertexLayoutProjection?: VertexLayoutProjection,
    shaderModuleMode?: RenderFeatureShaderModuleMode,
    layoutKindOverride?: LayoutKind,
    vertexEntryPoint?: string,
    vertexEntry?: string,
    authoredFragmentEntry?: string | null,
    particleInputLanes?: number,
    coverageOnly = false,
    constants?: Readonly<Record<string, number>>,
    pipelinePreparation = false,
    waterInfoFormat?: 'rgba16float' | 'rgba32float',
    preparedStorageBindings = false,
    projectSurfaceResources = false,
  ): RenderPipeline | null => {
    const program = resolvePipelineEntryProgram(entry);
    const usesWaterResources = entry.receipt?.systemInputs?.water === 'water-frame/3';
    const requiresWaterInfo =
      usesWaterResources && waterMaterialEntryPointsUseWaterInfo(program.entryPoints);
    if (usesWaterResources && requiresWaterInfo && waterInfoFormat === undefined) {
      reportMaterialPipelineFailure(
        cacheKey,
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'the selected Water program has a prepared WaterInfo texture format',
          hint: 'prepare the generation-qualified Water frame before requesting its pipeline',
        }),
      );
      return null;
    }
    const group2Contract = resolveCompiledMaterialGroup2Contract(
      program.group2,
      layoutKindOverride,
      materialShaderId,
      variantSet,
    );
    const resolvedVertexEntry = resolveMaterialPipelineVertexEntry(
      layoutKindOverride,
      vertexEntryPoint,
      vertexEntry,
      hasPackedTangentFrame(vertexLayoutProjection),
    );
    const fragmentEntry = materialFragmentEntry(
      authoredFragmentEntry,
      isHdr,
      passKind,
      materialShaderId,
    );
    const reflectedVertex = resolvedVertexEntry ?? defaultMaterialVertexEntry(passKind);
    const reflectedFragment =
      fragmentEntry === undefined ? defaultMaterialFragmentEntry(passKind) : fragmentEntry;
    const ctx = buildPipelineContext(
      variantSet,
      materialShaderId,
      group2Contract,
      meshAttributes,
      vertexLayout,
      vertexLayoutProjection,
      shaderModuleMode,
      layoutKindOverride,
      particleInputLanes,
      usesWaterResources ? waterInfoFormat : undefined,
      program.identity,
      program.entryPoints,
      usesWaterResources,
      preparedStorageBindings,
      canProjectOpaqueStandardMaterial(program.entryPoints, resolvedVertexEntry, fragmentEntry),
      materialLayoutProjections(
        program.entryPoints,
        reflectedVertex,
        reflectedFragment,
        projectSurfaceResources || passKind === 'deferred',
      ),
    );
    if (ctx === null) return null;
    const cache = currentPipelineCacheState();
    const prepareCompiledPipelineOwner = (
      ctx: NonNullable<ReturnType<typeof buildPipelineContext>>,
    ) => {
      const prepared =
        pipelinePreparation && ctx.device.createRenderPipelineAsync !== undefined
          ? preparedRenderPipelineOwner(
              preparedPipelineOwners,
              cache,
              ctx.device,
              candidateBuildState?.scope ?? activeDeviceScope,
              () => pipelineRequests.delete(cache),
            )
          : undefined;
      return prepared;
    };
    const prepared = prepareCompiledPipelineOwner(ctx);

    const currentState = currentPipelineState();
    if (currentState === null) return null;
    const ldrColorFormat = attachments.colorFormats[0] ?? currentState.colorAttachmentFormat;
    // Public view clipping is dynamic coverage even on opaque casters, so the
    // caller decides: `null` arrives only when no coverage source can discard
    // (see shadowCasterDepthOnly); otherwise the producer's fragment stage stays.
    const preparedSource = program.sourceReference;
    const compileMaterialPipeline = (ctx: NonNullable<ReturnType<typeof buildPipelineContext>>) => {
      return runCompileMaterialPipeline(
        cacheKey,
        entry,
        prepared,
        preparedSource,
        isHdr,
        ldrColorFormat,
        attachments,
        renderState,
        coverageOnly,
        constants,
        label,
        moduleLabel,
        topology,
        stripIndexFormat,
        resolvedVertexEntry,
        fragmentEntry,
        passKind,
        {
          ...ctx,
          stockStandardVertexProgram: materialShaderId === 'forgeax::default-standard-pbr',
        },
      );
    };
    const built = compileMaterialPipeline(ctx);
    if (!built.ok) {
      if (
        materialPipelineRequestPending(built, prepared, activeShaderState, candidateShaderState)
      ) {
        candidatePipelinePending?.(
          materialPipelineRequestCompletion(
            built.error,
            cacheKey,
            prepared,
            activeShaderState,
            candidateShaderState,
          ),
        );
      } else if (candidatePipelineErrorScope) throw built.error;
      reportMaterialPipelineFailure(cacheKey, built.error);
      return null;
    }
    retainStandardPipelineMaterialLayout(built.value, ctx.standardMaterialLayoutIndex);
    retainPipelineView(built.value, ctx.standardViewLayout);
    retainPipelinePrimitiveReflection(built.value, ctx.primitiveReflectionLayout);
    currentPipelineCacheState().materialShaderPipelineCache.set(cacheKey, built.value);
    materialShaderPipelineSelections.set(built.value as object, {
      contract: group2Contract,
      ...(ctx.waterGroup2Layout === undefined ? {} : { waterLayout: ctx.waterGroup2Layout }),
      ...(entry.receipt === undefined || materialShaderId === undefined
        ? {}
        : { selected: { material: materialShaderId, program, receipt: entry.receipt } }),
    });
    return built.value;
  };
  // A descriptor rejection (e.g. the mesh layout lacks a vertex input the
  // material reads) is a fact of this (material, mesh layout) key: report it
  // once and skip its draws without rebuilding every frame.
  const reportMaterialPipelineFailure = (cacheKey: string, error: RhiError): void => {
    if (error.code === 'rhi-descriptor-invalid')
      currentPipelineCacheState().rejectedMaterialPipelineKeys.add(cacheKey);
    if (error.code !== 'rhi-not-available') internals.errorRegistry.fire(error);
  };
  const materialPipelineBuildable = (cacheKey: string): boolean =>
    pipelineState !== null &&
    !currentPipelineCacheState().rejectedMaterialPipelineKeys.has(cacheKey);
  let candidatePipelineErrorScope = false;
  let candidatePipelinePending:
    | ((completion: PipelinePreparationCompletion | undefined) => void)
    | undefined;
  const withPipelinePreparationErrors = (
    action: () => void,
    onPending?: (completion: PipelinePreparationCompletion | undefined) => void,
  ): void => {
    const previous = candidatePipelineErrorScope;
    const previousPending = candidatePipelinePending;
    candidatePipelineErrorScope = true;
    candidatePipelinePending = onPending ?? previousPending;
    try {
      action();
    } finally {
      candidatePipelineErrorScope = previous;
      candidatePipelinePending = previousPending;
    }
  };
  const prepareMaterialProgram = (id: string): boolean => {
    const ready = getShader().prepareMaterialArtifact(id, candidatePipelinePending);
    if (!ready.ok) throw ready.error;
    return ready.value;
  };
  const buildMaterialShaderPipeline = (
    materialShaderId: string,
    isHdr: boolean,
    renderState?: MaterialRenderState,
    topology?: PrimitiveTopology,
    indexFormat?: 'uint16' | 'uint32',
    variantSet?: string,
    passKind: PassKind = 'forward',
    meshAttributes?: VertexAttributeMap,
    // Camera sample count belongs to both the immutable PSO key and descriptor.
    sampleCount: number = 1,
    // feat-20260625-refactor-sprite-as-transparent-mesh R2 fix-up: LDR-color
    // override for sub-passes that write to a non-default attachment view.
    // The LDR sprite split sub-pass writes through the storage (non-sRGB)
    // view of the swap-chain texture; the encoder's beginRenderPass
    // colorFormats uses `pipelineState.format` (storage), so the PSO must
    // build with the same non-sRGB format or WebGPU rejects SetPipeline
    // with "Attachment state ... not compatible". Pre-w14 the dedicated
    // `forgeax::default-sprite` SPEC_CONST entries (deleted) baked this
    // mapping into SPRITE_ATTACHMENTS_LDR_S1/S4; the generic lazy build
    // path that replaced them defaults to `colorAttachmentFormat` (the
    // sRGB view used by the geometry pass), so transparent-split callers
    // must override. Threaded into both the cache key (via the spec's
    // `attachments.colorFormats`) and the actual PSO descriptor. Null
    // explicitly requests no color attachment; undefined uses pass defaults.
    colorFormatOverride?: GPUTextureFormat | null,
    // feat-20260629-multi-uv-set-support m3-w5: shader-declared UV set count,
    // forwarded to PipelineSpec.geometry.shaderUvSetCount for clamp-to-last
    // alias. Undefined = fallback to mesh-provided count (no clamping).
    // m4-w3: auto-filled from naga reflection when caller passes undefined.
    shaderUvSetCount?: number,
    // Prepared graphics passes use `null` to request an explicit color-only
    // pipeline; omitted preserves the material forward depth default.
    depthFormatOverride?: GPUTextureFormat | null,
    vertexLayout?: string,
    vertexLayoutProjection?: VertexLayoutProjection,
    shaderModuleMode: RenderFeatureShaderModuleMode = 'validated',
    layoutKindOverride?: LayoutKind,
    vertexEntryPoint?: string,
    additionalColorFormats?: readonly GPUTextureFormat[],
    vertexEntry?: string,
    fragmentEntry?: string | null,
    particleInputLanes?: number,
    constants?: Readonly<Record<string, number>>,
    waterInfoFormat?: 'rgba16float' | 'rgba32float',
    preparedStorageBindings = false,
    pipelinePreparation = false,
  ): RenderPipeline | null => {
    return runBuildMaterialShaderPipeline(
      currentPipelineState,
      internals,
      assets,
      getShader,
      rememberMaterialUvSetCount,
      requestedMaterialVariantSet,
      pipelineRequests,
      currentPipelineCacheState,
      currentBuildDevice,
      preparedPipelineOwners,
      materialPipelineBuildable,
      prepareMaterialProgram,
      candidatePipelinePending,
      selectMaterialPipelineSource,
      buildAndCachePipeline,
      getOrBuildPreparedStoragePipelineLayout,
      pipelineLibraryCollection.recordForCurrentDevice(),
      materialShaderId,
      isHdr,
      renderState,
      topology,
      indexFormat,
      variantSet,
      passKind,
      meshAttributes,
      sampleCount,
      colorFormatOverride,
      shaderUvSetCount,
      depthFormatOverride,
      vertexLayout,
      vertexLayoutProjection,
      shaderModuleMode,
      layoutKindOverride,
      vertexEntryPoint,
      additionalColorFormats,
      vertexEntry,
      fragmentEntry,
      particleInputLanes,
      constants,
      waterInfoFormat,
      preparedStorageBindings,
      pipelinePreparation,
    );
  };
  // feat-20260629 M4: auto-fill shaderUvSetCount from naga reflection
  // (stored in materialShaderUvSetCounts during prepareMaterialShaders).
  const rememberMaterialUvSetCount = (
    pipelineShaderId: string,
    materialShaderEntry: ReturnType<ShaderCatalog['findMaterialArtifact']>,
  ): number | undefined => {
    return runRememberMaterialUvSetCount(
      currentMaterialShaderUvSetCounts,
      pipelineShaderId,
      materialShaderEntry,
    );
  };
  // Sprite's omitted request is the boot-selected default artifact. The
  // explicit empty key remains the PER_INSTANCE_REGION=true request used by
  // SpriteInstances, so only that path is capability-rewritten here.
  const requestedMaterialVariantSet = (
    variantSet: string | undefined,
    pipelineShaderId: string,
    manifestEntry: MaterialShaderManifestEntry | undefined,
  ): string | undefined => {
    return runRequestedMaterialVariantSet(
      resolveCachedMaterialShaderVariantSet,
      variantSet,
      pipelineShaderId,
      manifestEntry,
    );
  };
  /**
   * Choose the program a material PSO compiles: the registered shader (with
   * its manifest variant), or, when the id is not registered, the engine
   * unlit or standard-PBR fallback. `null` keeps a missing shader retryable.
   */
  const selectMaterialPipelineSource = (
    pipelineShaderId: string,
    effectiveVariantSet: string | undefined,
    isHdr: boolean,
    passKind: PassKind,
    renderState: MaterialRenderState | undefined,
    depthFormatOverride: GPUTextureFormat | null | undefined,
    vertexLayout: string | undefined,
    surfaceProgram?: Pick<RegisteredMaterialShaderEntry, 'program' | 'receipt'>,
  ): MaterialPipelineSource | null => {
    return runSelectMaterialPipelineSource(
      getShader,
      selectUnlitPreparedFallback,
      selectStandardPbrFallback,
      currentBuildDevice,
      pipelineShaderId,
      effectiveVariantSet,
      isHdr,
      passKind,
      renderState,
      depthFormatOverride,
      vertexLayout,
      surfaceProgram,
    );
  };
  // bug-20260527-renderstate-pipeline-dispatch-gap D-3: an unregistered id
  // without renderState builds against the engine unlit module.
  const selectUnlitPreparedFallback = (
    pipelineShaderId: string,
    depthFormatOverride: GPUTextureFormat | null | undefined,
    vertexLayout: string | undefined,
  ) => {
    return runSelectUnlitPreparedFallback(
      getShader,
      pipelineShaderId,
      depthFormatOverride,
      vertexLayout,
    );
  };
  // An unregistered id with renderState builds a renderState variant of the
  // engine-shipped standard PBR program.
  const selectStandardPbrFallback = (
    pipelineShaderId: string,
    effectiveVariantSet: string | undefined,
    isHdr: boolean,
  ) => {
    return runSelectStandardPbrFallback(
      getShader,
      currentBuildDevice,
      pipelineShaderId,
      effectiveVariantSet,
      isHdr,
    );
  };
  const pipelineRequests = new WeakMap<
    RendererPipelineCacheState,
    MaterialPipelineRequestCache<RenderPipeline | PendingMaterialPipelineRequest>
  >();
  const pipelineRequestScratch: Parameters<typeof materialPipelineRequestFacts>[1] = [];
  // Array form: per-draw callers pass their argument list without re-spreading.
  const getMaterialShaderPipelineFor = (
    args: Parameters<typeof buildMaterialShaderPipeline>,
    lookupOnly = false,
  ): RenderPipeline | null => {
    return runGetMaterialShaderPipelineFor(
      buildMaterialShaderPipeline,
      getShader,
      assets,
      internals,
      currentPipelineCacheState,
      pipelineRequests,
      pipelineRequestScratch,
      currentMaterialShaderUvSetCounts,
      currentPipelineState,
      currentBuildDevice,
      preparedPipelineOwners,
      args,
      lookupOnly,
      requestedMaterialVariantSet,
      candidatePipelinePending !== undefined,
    );
  };
  const getMaterialShaderPipeline = (
    ...args: Parameters<typeof buildMaterialShaderPipeline>
  ): RenderPipeline | null => getMaterialShaderPipelineFor(args);
  let activeProfile = freezeRenderProfile(
    internals.options?.standardProfile ?? DEFAULT_STANDARD_PROFILE,
  );
  const selectProfile = createRenderProfileSelection();
  const selectedProfile = (device = internals.device) =>
    selectProfile.select(activeProfile, device);
  // Recovery prewarm and live draws must select the same material ABI.
  const getMaterialShaderArtifact: NonNullable<
    RenderSystemInternals['getMaterialShaderArtifact']
  > = (materialShaderId, options = {}) =>
    resolveRendererMaterialShaderArtifact(
      materialShaderId,
      getShader(),
      pipelineState?.gpuDrivenPbrPrograms,
      typeof options === 'boolean' || activeProfile.visibleSurface !== true
        ? options
        : { ...options, visibleSurface: options.pass !== 'shadow' && options.pass !== 'depth' },
      prepareMaterialProgram,
    );
  const pipelineEntries = new WeakMap<object, MaterialShaderPipelineEntry[]>();
  const getMaterialShaderPipelineEntryFor = (
    args: Parameters<typeof buildMaterialShaderPipeline>,
    lookupOnly = false,
  ) => {
    return runGetMaterialShaderPipelineEntryFor(
      buildMaterialShaderPipeline,
      getMaterialShaderPipelineFor,
      getMaterialShaderArtifact,
      materialShaderPipelineSelections,
      pipelineEntries,
      args,
      lookupOnly,
    );
  };
  const getMaterialShaderPipelineEntry = (...args: Parameters<typeof getMaterialShaderPipeline>) =>
    getMaterialShaderPipelineEntryFor(args);
  const {
    prepareMaterialShaderPipeline,
    prepareMaterialShaderPipelineEntry,
    lookupMaterialShaderPipeline,
    lookupMaterialShaderPipelineEntry,
  } = candidateMaterialPipelineRequests(
    getMaterialShaderPipelineFor,
    getMaterialShaderPipelineEntryFor,
  );
  // Post-process modules share the async shader adapter: pending compilation
  // returns null; subsequent frames consume the cached pipeline. Group 0 is
  // reserved for View, group 1 holds inputs; vs_main/fs_main draw a fullscreen
  // triangle into the requested color formats.
  const buildPostProcessPipeline = (
    entry: PostProcessShaderEntry,
    bgl: BindGroupLayout,
    colorFormats: readonly GPUTextureFormat[],
    label: string,
  ): RenderPipeline | null =>
    buildFullscreenFeaturePipeline(entry, bgl, colorFormats, label, {
      device: currentBuildDevice(),
      modules: getShaderModuleAdapter(),
      errorRegistry: internals.errorRegistry,
      viewLayout: currentPipelineState()?.viewBindGroupLayout,
      emptyLayout: currentEmptyPostProcessBgl(),
      publishEmptyLayout: (layout) => {
        if (candidateBuildState !== undefined) {
          candidateBuildState.emptyPostProcessBgl = layout;
          candidateEmptyPostProcessBgl = layout;
        } else emptyPostProcessBgl = layout;
      },
    });
  const viewportHits = createViewportHitRequests({
    warmup: internals.options?.viewportHitWarmup === true,
    device: () => internals.device,
    generation: () => activeDeviceScope.generation,
    shader: async (device, code) =>
      (
        await (internals.pack.createShaderModule ?? invokeDeviceCreateShaderModule)(device, {
          label: 'viewport-hit-proxy',
          code,
        })
      ).unwrap(),
    trackMeshes: (completion) => gpuStore.trackMeshSubmission(completion),
  });
  const renderInternals: RenderSystemInternals = {
    viewportHits,
    options: internals.options,
    get presentationOutput() {
      return ui?.owner.output;
    },
    renderWorld,
    ...(publicationInstances === undefined ? {} : { instanceCollections: publicationInstances }),
    get canvas() {
      return internals.canvas;
    },
    get shaderRegistry() {
      return getShader();
    },
    get build() {
      return internals.bundler?.build;
    },
    ssrIdentity: internals.options?.ssrIdentity,
    captureReflectionFallbackReadback: internals.options?.captureReflectionFallbackReadback,
    shadowWorkload: internals.options?.shadowWorkload,
    get requestedStandardProfile() {
      return activeProfile;
    },
    get standardProfile() {
      return selectedProfile(currentBuildDevice());
    },
    standardPipeline: internals.options?.pipeline ?? standardPipeline,
    get featureHost() {
      return internals.featureHost;
    },
    setFeatureHost: (host) => {
      internals.featureHost = host;
    },
    shaderModuleFactory: renderShaderModuleFactory,
    immediateShaderModuleFactory: {
      createShaderModule: (descriptor) =>
        getShaderModuleAdapter('immediate').createShaderModule(descriptor),
      isPending: (error) => getShaderModuleAdapter('immediate').isPending(error),
      peekShaderModule: (descriptor) => peekShaderModule(descriptor, 'immediate'),
      pendingShaderModuleCompletion: (signal) =>
        (
          candidateShaderState ?? activeShaderState
        ).sharedImmediateShaderModuleAdapter?.pendingCompletion(signal),
    },
    profiler: internals.options?.profiler,
    // Keep device/context getters live so recovery swaps are observed by the
    // record stage without reconstructing the RendererState.
    get device() {
      return internals.device;
    },
    get resolvePipelineReference() {
      return internals.pack.instrumentation?.resolvePipelineReference;
    },
    get beforeSubmit() {
      return internals.pack.instrumentation?.beforeSubmit;
    },
    createShaderModule: (device, descriptor) =>
      internals.pack.createShaderModule === undefined
        ? Promise.resolve(invokeDeviceCreateShaderModule(device, descriptor))
        : internals.pack.createShaderModule(device, descriptor),
    get deviceScope() {
      return activeDeviceScope;
    },
    prepareSceneAddressCapacity: (scene, extent, current, capture) =>
      cameraViews.prepareAddressCapacity(scene, extent, current, capture),
    prepareSceneInputBindings: (scene, input, tables) =>
      cameraViews.prepareInputBindings(scene, input, tables),
    ...(internals.pack.instrumentation?.resolveSurfaceDevice === undefined
      ? {}
      : { resolveSurfaceDevice: internals.pack.instrumentation.resolveSurfaceDevice }),
    outputColorSpace: internals.outputColorSpace,
    // The graph records receipt-bound color observations through the same
    // renderer-owned capture bridge consumed after queue submission. Keep the
    // identity and demand live on internals so recovery and per-frame graph
    // rebuilds observe the current device without reconstructing RendererState.
    get deviceGeneration() {
      return activeDeviceScope.generation;
    },
    getWaterMaterialFramePublication: (viewIdentity, frameGeneration, deviceGeneration) => {
      const feature = waterInfoFeature();
      return feature === undefined
        ? undefined
        : waterInfoFramePublicationForRenderer(
            feature,
            viewIdentity,
            frameGeneration,
            deviceGeneration,
          );
    },
    getWaterMaterialFrameBindings: (input) => {
      const device = internals.device;
      const feature = waterInfoFeature();
      if (feature === undefined) return undefined;
      const publication =
        input.waterInfoPublication ??
        waterInfoFramePublicationForRenderer(
          feature,
          input.viewIdentity,
          input.frameGeneration,
          input.deviceGeneration,
        );
      if (publication === undefined || pipelineState === null) return undefined;
      const waterInfoTextureViews = new Map<string, TextureView>();
      const capturePublishedWaterTextureViews = () => {
        for (const target of publication.targets) {
          const view = input.waterInfoTextureViews.get(target.targetName);
          if (view !== undefined) waterInfoTextureViews.set(target.targetName, view);
        }
      };
      capturePublishedWaterTextureViews();
      const owner = device as object;
      let entries = waterMaterialFrameEntries.get(owner);
      if (entries === undefined) {
        entries = new Map();
        waterMaterialFrameEntries.set(owner, entries);
      }
      const key = JSON.stringify([
        input.viewIdentity,
        input.deviceGeneration,
        input.frameGeneration,
      ]);
      const retirePreviousWaterFrames = (
        entries: NonNullable<ReturnType<typeof waterMaterialFrameEntries.get>>,
      ) => {
        return runRetirePreviousWaterFrames(
          key,
          input,
          renderWorld,
          device,
          internals,
          destroyWaterMaterialFrameEntry,
          entries,
        );
      };
      retirePreviousWaterFrames(entries);
      const cached = entries.get(key);
      const reuseOwnedWaterFrameBindings = () => {
        if (
          cached !== undefined &&
          input.waterMeshDrawsOwned === true &&
          isOwnedWaterMeshAdmissionUploadClosure(input.waterMeshDraws) &&
          cached.publication === publication &&
          cached.waterMeshDrawUploads === input.waterMeshDraws &&
          cached.pipelineState === pipelineState &&
          cached.viewOriginM[0] === input.viewOriginM[0] &&
          cached.viewOriginM[1] === input.viewOriginM[1] &&
          cached.viewOriginM[2] === input.viewOriginM[2] &&
          waterMaterialFrameTargetsMatch(cached.bindings, waterInfoTextureViews)
        )
          return cached.bindings;
        return undefined;
      };
      const ownedBindings = reuseOwnedWaterFrameBindings();
      if (ownedBindings !== undefined) return ownedBindings;
      // Preserve the frame's accumulated draw union for ordinary subset consumers.
      // A changed owned closure still goes through the live per-key conflict check below.
      const waterMeshDraws = new Map(cached?.waterMeshDraws);
      const publishedBodyKeys = new Set(publication.waveUploadPlan.bodyIndices.keys());
      const meshBodyPublished = (bodyKey: string): boolean => {
        return runMeshBodyPublished(publication, publishedBodyKeys, waterInfoTextureViews, bodyKey);
      };
      // Independent fixed/Baked Body inputs do not authorize tiled WaterMesh ranges.
      const admittedWaterMeshDraws = input.waterMeshDraws.filter(
        (draw) =>
          meshBodyPublished(draw.bodyGuid) &&
          draw.transitionTargets.every((target) => meshBodyPublished(target.bodyGuid)),
      );
      try {
        for (const draw of admittedWaterMeshDraws) {
          const previous = waterMeshDraws.get(draw.drawKey);
          if (previous !== undefined && !sameWaterMeshDraw(previous, draw))
            throw new RangeError(
              `WaterMesh draw ${draw.drawKey} changed contents within one view frame`,
            );
          waterMeshDraws.set(draw.drawKey, draw);
        }
      } catch (cause) {
        internals.errorRegistry.fire(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'stable WaterMesh draw records for one view frame',
            hint: 'publish the complete immutable owner/bucket draw set before recording the first pass',
            detail: {
              error: {
                code: 'water-material-frame-draw-set-invalid',
                message: cause instanceof Error ? cause.message : String(cause),
              },
            },
          }),
        );
        return undefined;
      }
      const matchCompleteWaterDrawSet = () => {
        const drawSetComplete =
          cached !== undefined &&
          cached.publication === publication &&
          cached.pipelineState === pipelineState &&
          cached.viewOriginM[0] === input.viewOriginM[0] &&
          cached.viewOriginM[1] === input.viewOriginM[1] &&
          cached.viewOriginM[2] === input.viewOriginM[2] &&
          admittedWaterMeshDraws.every((draw) => cached.waterMeshDraws.has(draw.drawKey));
        return drawSetComplete;
      };
      const drawSetComplete = matchCompleteWaterDrawSet();
      const cachedBindings =
        cached === undefined
          ? undefined
          : selectWaterMaterialFrameTargets(cached.bindings, waterInfoTextureViews);
      if (drawSetComplete && cachedBindings !== undefined)
        return cachedBindings.size === 0 ? undefined : cachedBindings;
      const prepareWaterFrameBindingCohorts = (
        entries: NonNullable<ReturnType<typeof waterMaterialFrameEntries.get>>,
        pipelineState: PipelineState,
      ) => {
        return prepareWaterFrameBindingCohortsImpl(
          publication,
          internals,
          owner,
          waterMaterialFrameSamplers,
          device,
          waterInfoTextureViews,
          waterMeshDraws,
          input,
          waterMaterialBuffers,
          waterMaterialFrameLayout,
          key,
          cached,
          entries,
          pipelineState,
        );
      };
      return prepareWaterFrameBindingCohorts(entries, pipelineState);
    },
    get observationFrameId() {
      return internals.observationFrameId;
    },
    get observationGraphGeneration() {
      return internals.observationGraphGeneration;
    },
    set observationGraphGeneration(generation: number | undefined) {
      internals.observationGraphGeneration = generation;
    },
    get observationCaptureOwner() {
      return internals.observationCaptureOwner;
    },
    get observationCaptureDomains() {
      return internals.observationCaptureDomains;
    },
    invalidateShaderModule: (label: string) => {
      // Empty plans retire targets/bindings. Installed features retain shader
      // readiness until uninstall or device retirement so reactivation is immediate.
      if (
        requiredFullscreenPostProcesses.some(
          (entry) => postProcessShaderModuleLabel(entry) === label,
        )
      )
        return;
      activeShaderState.sharedShaderModuleAdapter?.invalidateModule(label);
    },
    get context() {
      return internals.context;
    },
    get debugOverlay() {
      return internals.debugOverlay;
    },
    // feat-20260608-create-app-param-surface-trim / M1 / AC-02: clearColor
    // is no longer threaded through createRendererState; the record stage
    // reads `camera.clearColor` straight from the Camera SoA column
    // (array<f32,4>, feat-20260709 M3).
    getPipelineState: () => pipelineState,
    get standardClusterAbi() {
      return pipelineState?.standardClusterAbi;
    },
    assets,
    get gpuStore() {
      return gpuStore;
    },
    get dynamicTextureStore() {
      return dynamicTextureStore;
    },
    errorRegistry: internals.errorRegistry,
    healthRegistry: internals.healthRegistry,
    getMaterialPipelineRequestInspection: () => {
      const requests = pipelineRequests.get(currentPipelineCacheState());
      return {
        hits: requests?.hits ?? 0,
        misses: requests?.misses ?? 0,
        keyCharacters: requests?.keyCharacters ?? 0,
      };
    },
    getMaterialShaderPipeline,
    getMaterialShaderPipelineEntry,
    prepareMaterialShaderPipeline,
    prepareMaterialShaderPipelineEntry,
    lookupMaterialShaderPipeline,
    lookupMaterialShaderPipelineEntry,
    withPipelinePreparationErrors,
    getMaterialShaderBindingContract: getMaterialShaderBindingContract,
    getFeatureShaderSource: (identifier) =>
      resolveFeatureShaderSource(getShader(), internals.device, identifier),
    getMaterialShaderArtifact,
    getParamSchema,
    getMaterialBindGroupLayout,
    lookupMaterialBindGroupLayout,
    metrics,
    // createRendererState wraps this in a per-RendererState cache + the public
    // getPostProcessPipeline lookup the dispatcher reads at frame time.
    buildPostProcessPipeline,
    // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M3 / T-M3-04:
    // forward the grow hook + state via getter closures — buildReadyWebGPU
    // sets `internals.growMeshSsbo` / `internals.meshSsboState` after this
    // factory call, so the record stage reads them through the closures
    // (read at frame time, when ready has already settled).
    get growMeshSsbo() {
      return internals.growMeshSsbo;
    },
    get meshSsboState() {
      return internals.meshSsboState;
    },
    get gpuPassTimingSession() {
      return (
        internals as WebGPURendererInternals & {
          gpuPassTimingSession?: GpuPassTimingSession | undefined;
        }
      ).gpuPassTimingSession;
    },
    set gpuPassTimingSession(session: GpuPassTimingSession | undefined) {
      (
        internals as WebGPURendererInternals & {
          gpuPassTimingSession?: GpuPassTimingSession | undefined;
        }
      ).gpuPassTimingSession = session;
    },
    get gpuPassTimingCapture() {
      return (
        internals as WebGPURendererInternals & {
          gpuPassTimingCapture?: GpuPassTimingCapture | undefined;
        }
      ).gpuPassTimingCapture;
    },
    set gpuPassTimingCapture(capture: GpuPassTimingCapture | undefined) {
      (
        internals as WebGPURendererInternals & {
          gpuPassTimingCapture?: GpuPassTimingCapture | undefined;
        }
      ).gpuPassTimingCapture = capture;
    },
    get renderPassCpuIdentityCapture() {
      return internals.renderPassCpuIdentityCapture;
    },
    set renderPassCpuIdentityCapture(capture: WebGPURendererInternals['renderPassCpuIdentityCapture']) {
      internals.renderPassCpuIdentityCapture = capture;
    },
    get gpuPassTimingSubmittedWork() {
      return internals.gpuPassTimingSubmittedWork;
    },
    set gpuPassTimingSubmittedWork(completion: Promise<void> | undefined) {
      internals.gpuPassTimingSubmittedWork = completion;
    },
    get gpuPassTimingDeviceGeneration() {
      return internals.gpuPassTimingDeviceGeneration;
    },
    set gpuPassTimingDeviceGeneration(generation: number | undefined) {
      internals.gpuPassTimingDeviceGeneration = generation;
    },
    get gpuPassTimingBeginReason() {
      return (
        internals as WebGPURendererInternals & {
          gpuPassTimingBeginReason?: GpuPassTimingError | undefined;
        }
      ).gpuPassTimingBeginReason;
    },
    set gpuPassTimingBeginReason(reason: GpuPassTimingError | undefined) {
      (
        internals as WebGPURendererInternals & {
          gpuPassTimingBeginReason?: GpuPassTimingError | undefined;
        }
      ).gpuPassTimingBeginReason = reason;
    },
    getRenderTargetPhysical: (target) => renderTargetHost.getPhysicalTarget(target),
    ownedRenderTargets: renderTargetHost,
    markRenderTargetSubmitted: (target, physical) =>
      renderTargetHost.markTargetSubmitted(target, physical),
    resolveRenderTargetTextureSource: (source) =>
      renderTargetHost.resolveRenderTargetTextureSource(source),
    externalTextures: externalTextureHost,
    encodeRenderTargetReadbacks: (encoder, written) =>
      renderTargetHost.encodePendingReadbacks(encoder, written),
    encodeFramebufferSnapshots: (encoder, source) =>
      renderTargetHost.encodeFramebufferSnapshots(encoder, source),
    get volumetricFogShaders() {
      return internals.volumetricFogShaders;
    },
    // Readiness-prewarmed SSR sources stay visible through the live internals seam.
    get ssrShaders() {
      return internals.ssrShaders;
    },
    get depthPyramidShaders() {
      return internals.depthPyramidShaders;
    },
    get standardSceneShaders() {
      return internals.standardSceneShaders;
    },
    get atmosphereShaders() {
      return internals.atmosphereShaders;
    },
  };
  const renderSystem: RendererState = createRendererState(renderInternals);
  const primaryOwner = viewOwnerOf(renderInternals);
  let uiOnlyFrame = false;
  if (ui !== undefined) renderInternals.deferFinalDisplayObservation = true;
  const cameraViews = createCameraViews(
    renderInternals,
    internals.options?.maxRenderShortSide,
    () => publicationReceiver?.borrowAcceptedDemand(),
  );
  internals.lossObserver.current = (detail) => {
    renderInternals.submittedPassNames = [];
    for (const continuation of frameContinuations.keys())
      continuation.terminate({ code: 'device-lost', detail });
  };
  cameraViewsForTargetPromotion = cameraViews;
  attachGpuPassTimingSession(internals, gpuPassTimingSession);
  registerSingleLayerMediumBuiltins(renderSystem);
  registerStandardPostProcessBuiltins(renderSystem);
  // The Standard pipeline is the sole built-in graph owner. Feature plans are
  // projected into that graph directly; no second post-process registry is
  // installed for fullscreen producers.
  cameraViews.configureStandard(undefined);
  renderSystem.restorePostProcessResources();
  const attachedWorlds = new Set<World>();
  const attachedLeases = new Map<RenderReadLease, World>();
  const { lifecycle: dynamicGeometry, host: dynamicGeometryHost } =
    createRendererDynamicGeometryController(
      {
        attachedWorlds,
        getGpuStore: () => gpuStore,
        currentGeneration: () => activeDeviceScope.generation,
        renderSystem: cameraViews,
        capturePipelinePreparation: (input) =>
          captureMeshPipelinePreparation({
            ...input,
            assets,
            capabilities: internals.device.caps,
            limits: internals.device.limits,
          }),
        prepareCandidatePipelines: (input, signal) =>
          cameraViews.prepareCandidatePipelines(input, signal),
      },
      internals.options?.dynamicGeometryMeshBudgetBytes,
    );
  const transformReleases = new Map<World, () => void>();
  let frameId = 0;
  let latestPublicationRevision = 0;
  // Caller-owned receipts remain observable; Renderer does not retain every submitted receipt.
  const issuedReceipts = new WeakSet<FrameReceipt>();
  const receiptTimings = new WeakMap<FrameReceipt, Promise<VolumeTimingObservation>>();
  let latestReceipt: FrameReceipt | undefined;
  let latestLodObservation: RendererReceiptLodCaptureState | undefined;
  let pendingObservationDomains: readonly FrameObservationDomain[] | undefined;
  const observationOwner = createRendererObservationCaptureOwner((error) => {
    internals.errorRegistry.fire(error);
  }, internals.options?.featureTextureReadbackBudgetBytes);
  const {
    observationCaptureOwner,
    stats: observationStats,
    receiptObservationBuffers,
    disposeOwnedObservationCaptures,
    disposeReceiptObservationCaptures,
  } = observationOwner;
  Object.assign(internals, { observationCaptureOwner });
  const staleObservationReceipt = (receipt: FrameReceipt): FrameReceiptStaleError | undefined =>
    disposed ||
    !issuedReceipts.has(receipt) ||
    internals.healthRegistry.getLastSnapshot().reason === 'device-lost' ||
    receipt.deviceGeneration !== activeDeviceScope.generation ||
    receipt.backendId !== internals.device.caps.backendKind
      ? new FrameReceiptStaleError({
          frameId: receipt.frameId,
          receiptGeneration: receipt.deviceGeneration,
          currentGeneration: activeDeviceScope.generation,
        })
      : undefined;
  const lodObservationValidity = (
    captureState: NonNullable<typeof latestLodObservation>,
    receipt: FrameReceipt,
  ): LodObservationCaptureValidity => ({
    isLatest: () =>
      latestLodObservation === captureState &&
      latestReceipt === receipt &&
      staleObservationReceipt(receipt) === undefined,
    isViewCurrent: (view) =>
      captureState.capture !== undefined &&
      cameraViews.isLodObservationViewCurrent(captureState.capture, view),
    isSourceAttached: (lease) => {
      if (lease.kind === 'publication')
        return (
          !disposed &&
          publicationReceiver?.acceptedRevision === lease.revision &&
          lease.resources.revision === lease.revision
        );
      const world = attachedLeases.get(lease.lease);
      return (
        world !== undefined &&
        world.identity === lease.worldIdentity &&
        lease.lease.worldIdentity === lease.worldIdentity &&
        lease.lease.generation === lease.generation
      );
    },
  });
  const terrainReceipts = createTerrainReceiptOwner(
    (receipt) => staleObservationReceipt(receipt) === undefined,
  );
  Object.defineProperty(internals, 'observationGraphGeneration', {
    configurable: true,
    get: () => observationOwner.expectedGraphGeneration,
    set: (generation: number | undefined) => {
      observationOwner.expectedGraphGeneration = generation;
    },
  });
  let surfaceReleased = false;
  let preparationActive = false;
  const preparationRejected = () =>
    err(
      new RendererContractFailureError(
        'draw',
        'one active Renderer preparation operation without interleaved resource mutation',
      ),
    );
  /** Frame input shape and publication/local-lease route admission. */
  const drawRequestError = (
    frameRequest: RenderFrameInput | undefined,
    publicationRequest: PublishedRenderFrameInput | undefined,
  ): RenderError | undefined =>
    runDrawRequestError(ui, publicationReceiver, frameRequest, publicationRequest);
  /** The attached source lease is the sole local frame authority. */
  const drawWorldError = (
    world: World | undefined,
    request: RenderFrameInput | undefined,
  ): RenderError | undefined => runDrawWorldError(dynamicGeometryHost, world, request);
  // feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M5 / w21
  // (plan-strategy D-1, D-8): post-dispose the renderer is dead. AI users
  // observing `rhi-not-available` know to rebuild the renderer; the same
  // existing closed-union member covers every lifecycle admission below.
  const drawLifecycleError = (): RhiError | undefined =>
    runDrawLifecycleError(
      () => disposed,
      () => surfaceReleased,
      internals,
      drawHealthError,
      drawReadinessError,
    );
  // Health owns admission for the legacy Host entry as well as the public
  // Renderer. The initiating failure was already reported; do not fire it
  // again for every attempted frame while the Host chooses recovery/rebuild.
  const drawHealthError = (): RhiError | undefined => runDrawHealthError(internals);
  // Screen UI may present before scene readiness; otherwise an unsettled or
  // rejected initialization fires onError and skips the frame (charter
  // propositions 4 and 9: explicit failure, the AI user owns the retry).
  const drawReadinessError = (): RhiError | undefined =>
    runDrawReadinessError(
      ui,
      () => readySettled,
      () => pipelineState,
      internals,
    );
  function* prepareDraw(
    request: DrawRequest,
    isCurrent?: () => boolean,
  ): FramePreparation<Result<void | FrameReceipt, RhiError | RenderError>> {
    const publicationRequest = publicationDrawRequest(request);
    const frameRequest = frameDrawRequest(request);
    const requestError = drawRequestError(frameRequest, publicationRequest);
    if (requestError !== undefined) return err(requestError);
    const world =
      frameRequest === undefined || frameRequest.source === null
        ? undefined
        : attachedLeases.get(frameRequest.source);
    const readLease = frameRequest?.source ?? undefined;
    const worldError = drawWorldError(world, frameRequest);
    if (worldError !== undefined) return err(worldError);
    const drawOptions =
      frameRequest === undefined
        ? publicationDrawOptions(publicationRequest as PublishedRenderFrameInput)
        : frameDrawOptions(frameRequest);
    const requestedProfileFrame = captureDrawOwnerProfileFrame(drawOptions);
    const activeProfileSession = activeRenderProfileSession(
      undefined,
      renderWorld,
      internals.options?.profiler,
    );
    const profileFrame =
      requestedProfileFrame !== undefined &&
      activeProfileSession?.captureId === requestedProfileFrame.captureId
        ? requestedProfileFrame
        : undefined;
    const lifecycleError = drawLifecycleError();
    if (lifecycleError !== undefined) return err(lifecycleError);
    // Configure context lazily on first draw (D-S1 single-point exemption)
    // through the RHI device scope.
    const contextConfigured =
      pipelineState === null
        ? ok(undefined)
        : ensureContextConfigured(internals, pipelineState, internals.errorRegistry);
    if (!contextConfigured.ok) return contextConfigured;
    // w24 — facade-level try/catch produces Result.err on unexpected throw
    // (D-P6 dual-channel preserved: per-stage RhiError continues to fan out
    // through onError separately; the facade Result is the synchronous
    // summary AI users can ignore or branch on).
    try {
      return yield* submitDrawFrame(
        world,
        readLease,
        drawOptions,
        profileFrame,
        frameRequest,
        publicationRequest,
        isCurrent,
      );
    } catch (cause) {
      internals.renderPassCpuIdentityCapture = undefined;
      return drawFailure(cause);
    } finally {
      // Native video pixels have been consumed by synchronous queue copy calls.
      // Release them on every success/failure path, including direct publication users.
      publicationReceiver?.releaseVideoFrames();
    }
  }
  function submitViewportHitFrame(
    receipt: FrameReceipt,
    world: World | undefined,
    publicationRequest: PublishedRenderFrameInput | undefined,
  ): void {
    if (viewportHits.collecting) {
      const owner = cameraViews.currentOwner;
      viewportHits.submit(
        receipt,
        owner.frameState,
        world?.identity,
        publicationRequest?.publication.revision,
        publicationRequest?.displayFrameId,
      );
    }
  }

  function* submitDrawFrame(
    world: World | undefined,
    readLease: RenderReadLease | undefined,
    drawOptions: DrawOptions,
    profileFrame: ProfileFrameToken | undefined,
    frameRequest: RenderFrameInput | undefined,
    publicationRequest: PublishedRenderFrameInput | undefined,
    isCurrent: (() => boolean) | undefined,
  ): FramePreparation<Result<void | FrameReceipt, RhiError | RenderError>> {
    const frameInputPresent = () => frameRequest !== undefined || publicationRequest !== undefined;
    const isFrameRequest = frameInputPresent();
    let publication:
      | {
          readonly publication: PreparedRenderPublication;
          readonly receiver: RenderPublicationReceiver;
        }
      | undefined;
    if (publicationRequest !== undefined && publicationReceiver !== undefined) {
      const accepted = publicationReceiver.accept(publicationRequest.publication, assets);
      if (!accepted.ok) return accepted;
      publication = {
        publication: withFeatureSourceFeedback(accepted.value, publicationRequest),
        receiver: publicationReceiver,
      };
    }
    const restoreFrameSurfaceInput = () => {
      const directSurfaceInput = world === undefined ? undefined : surfaceDynamicInputOf(world);
      const capturedSurfaceInput =
        directSurfaceInput === undefined
          ? undefined
          : captureSurfaceDynamicInput(directSurfaceInput, world?.identity);
      if (capturedSurfaceInput !== undefined && !capturedSurfaceInput.ok)
        return err(
          new RenderPublicationError({
            reason: 'shape',
            subject: capturedSurfaceInput.error.message,
          }),
        );
      if (
        publication !== undefined ||
        directSurfaceInput !== undefined ||
        surfaceInputReceiver.active
      ) {
        const restored = surfaceInputReceiver.restore(
          publication === undefined
            ? capturedSurfaceInput?.value
            : publication.publication.packet.surfaceDynamicInputs?.[0],
          activeDeviceScope.generation,
          publication?.publication.resources.identity,
        );
        if (!restored.ok)
          return err(
            new RenderPublicationError({ reason: 'shape', subject: restored.error.message }),
          );
        publishSurfaceDynamicInput(renderWorld, restored.value);
        if (publication !== undefined)
          publicationRequest?.onPublicationAccepted?.(publication.publication.packet);
      }

      return undefined;
    };
    const surfaceFailure = restoreFrameSurfaceInput();
    if (surfaceFailure !== undefined) return surfaceFailure;
    renderTargetHost.beginFrame();
    externalTextureHost.beginFrame();
    const selectFrameTimingRequest = () => {
      const timingRequested =
        isFrameRequest &&
        (profileFrame !== undefined || internals.options?.captureGpuTimings === true);
      return timingRequested;
    };
    const timingRequested = selectFrameTimingRequest();
    const volumeTimingCapture = createVolumeTimingCapture(timingRequested);
    if (isFrameRequest)
      beginObservationFrame(
        internals,
        renderWorld,
        frameId + 1,
        activeDeviceScope.generation,
        pendingObservationDomains,
        profileFrame,
      );
    const profileSession = activeRenderProfileSession(
      undefined,
      renderWorld,
      internals.options?.profiler,
    );
    const uiFrameId =
      profileSession === undefined
        ? stageScreenUi(frameRequest?.source === null, drawOptions)
        : runProfiledRenderPhase(profileSession, 'stage-inputs', () =>
            stageScreenUi(frameRequest?.source === null, drawOptions),
          );
    viewportHits.discardFrame();
    const submitted = uiOnlyFrame
      ? yield* prepareRenderFrame({
          world: renderWorld,
          device: internals.device,
          frameId: uiFrameId,
          rendererInternals: renderInternals,
          isCurrent,
          shared: true,
        })
      : yield* cameraViews.prepareSubmission(
          world,
          drawOptions,
          readLease,
          volumeTimingCapture,
          publication,
          isCurrent,
        );
    const observationFrameNumber = internals.observationFrameId;
    internals.observationFrameId = undefined;
    internals.observationCaptureDomains = undefined;
    internals.gpuPassTimingDeviceGeneration = undefined;
    if (!submitted) {
      cloudAdoption.discard();
      return err(unsubmittedFrameError(volumeTimingCapture, observationFrameNumber));
    }
    internals.gpuPassTimingSubmittedWork = undefined;
    const reflectionFallbackCompletion = uiOnlyFrame
      ? undefined
      : cameraViews.currentOwner.frameState.reflectionFallbackCompletion;
    const receiptFrameId = isFrameRequest ? ++frameId : undefined;
    // The receipt, frame credit and generation fence read the one published submission.
    const {
      completion: queueCompletion,
      creditCompletion: unheldQueueCompletion,
      generation: receiptGeneration,
    } = renderSubmission(renderWorld);
    if (queueCompletion === undefined)
      throw new Error('A submitted frame publishes its GPU completion to its Render World');
    watchQueueCompletion(queueCompletion, receiptFrameId, receiptGeneration);
    gpuStore.trackMeshSubmission(queueCompletion);
    internals.pack.instrumentation?.onFrameBoundary?.();
    if (receiptFrameId === undefined) {
      cloudAdoption.reset();
      const cleanupFailure = disposeOwnedObservationCaptures(
        observationOwner.discardFrame(uiFrameId),
      );
      renderTargetHost.onFrameSubmitted(
        queueCompletion.then(() => ({ ok: true, value: undefined }) as const),
      );
      if (cleanupFailure !== undefined) return err(cleanupFailure);
      return ok(undefined);
    }
    const receipt =
      profileSession === undefined
        ? issueFrameReceipt(
            receiptFrameId,
            receiptGeneration,
            queueCompletion,
            reflectionFallbackCompletion,
            unheldQueueCompletion,
            profileFrame,
            publicationRequest?.onFeatureSourceCompleted,
          )
        : runProfiledRenderPhase(profileSession, 'submission/receipt-issue', () =>
            issueFrameReceipt(
              receiptFrameId,
              receiptGeneration,
              queueCompletion,
              reflectionFallbackCompletion,
              unheldQueueCompletion,
              profileFrame,
              publicationRequest?.onFeatureSourceCompleted,
            ),
          );
    submitViewportHitFrame(receipt, world, publicationRequest);
    if (timingRequested && gpuPassTimingOptions === undefined) {
      receiptTimings.set(
        receipt,
        volumeTimingCapture?.observation() ??
          Promise.resolve({
            status: 'unavailable',
            reason: 'timestamp capture is unavailable on this device',
          }),
      );
    }
    issuedReceipts.add(receipt);
    terrainReceipts.register(receipt, uiOnlyFrame ? [] : cameraViews.terrainSections());
    if (!uiOnlyFrame)
      dynamicGeometryHost.publishDynamicGeometry(receipt, world, frameRequest?.fixedStep);
    cameraViews.recordClusterWorkReceiptForConformance({
      observationFrameId: receipt.frameId,
      publicReceiptFrameId: receipt.frameId,
      deviceGeneration: receipt.deviceGeneration,
      presentation: receipt.presentation,
      completed: receipt.completed,
    });
    return ok(receipt);
  }
  const createVolumeTimingCapture = (timingRequested: boolean): GpuTimingCapture | undefined => {
    if (!timingRequested || gpuPassTimingOptions !== undefined) return undefined;
    const createdTiming = GpuTimingCapture.create(internals.device);
    return createdTiming.ok ? createdTiming.value : undefined;
  };
  /** Select a UI-only frame when no scene can draw, then publish its immutable preparation inputs. */
  const stageScreenUi = (sceneAbsent: boolean, drawOptions: DrawOptions): number => {
    const frame = internals.observationFrameId ?? 0;
    uiOnlyFrame = ui !== undefined && (sceneAbsent || !readySettled || pipelineState === null);
    if (ui === undefined) return frame;
    renderWorld.insertResource<SurfaceUiInput>(RenderSurfaceUiInput, {
      frame,
      sampleTimeMs: (drawOptions.sampleTimeSeconds ?? 0) * 1000,
      width: internals.canvas.width,
      height: internals.canvas.height,
      colorSpace: internals.outputColorSpace.report.effective,
      captureEncodedOutput:
        uiFormats.storage === uiFormats.view &&
        pendingObservationDomains?.includes('final-display') === true,
    });
    return frame;
  };
  const unsubmittedFrameError = (
    volumeTimingCapture: GpuTimingCapture | undefined,
    frameNumber: number | undefined,
  ): RhiError | RenderError => {
    internals.renderPassCpuIdentityCapture = undefined;
    const cleanupFailure = disposeOwnedObservationCaptures(
      observationOwner.discardFrame(frameNumber),
    );
    volumeTimingCapture?.discard();
    if (cleanupFailure !== undefined) return cleanupFailure;
    const invalidMotionBlur = cameraViews.currentOwner.recorded.motionBlurInvalidParams;
    if (invalidMotionBlur !== undefined) return invalidMotionBlur;
    return new RendererContractFailureError(
      'draw',
      'the Standard render owner did not submit a command buffer; inspect Renderer error events and recover the owning frame path',
    );
  };
  // Submission succeeded, so a rejected completion leaves this generation's
  // GPU work unconfirmed. Do not retire the device scope here: a completion
  // failure is not proof of device loss. Health and continuations own admission.
  const watchQueueCompletion = (
    queueCompletion: Promise<unknown>,
    receiptFrameId: number | undefined,
    receiptGeneration: number,
  ): void => {
    void Promise.resolve(queueCompletion).catch((cause: unknown) => {
      if (
        disposed ||
        receiptGeneration !== activeDeviceScope.generation ||
        internals.healthRegistry.getLastSnapshot().reason !== 'alive'
      )
        return;
      const failure = completeFrameFailure(receiptFrameId, receiptGeneration, cause, { cause });
      // Seal the first cause before a health listener can dispose/rebuild.
      for (const [continuation, pending] of frameContinuations) {
        if (pending.deviceGeneration === receiptGeneration)
          continuation.terminate({ code: 'internal-fault', detail: failure });
      }
      internals.healthRegistry.fire({
        reason: 'internal-fault',
        recoverable: false,
        detail: {
          message: 'submitted queue completion failed; dispose and recreate this Renderer',
        },
      });
      internals.errorRegistry.fire(failure);
    });
  };
  const receiptEditorAssistance = (
    presentation: FrameReceipt['presentation'],
    frameId: number,
    deviceGeneration: number,
  ) => {
    return presentation !== 'ready' || uiOnlyFrame
      ? undefined
      : editorAssistancePresentation(featureHostResult.value)?.bindReceipt(
          renderSubmission(renderWorld).frame,
          { frameId, deviceGeneration },
        );
  };
  const pendingFramePreparations = (presentation: FrameReceipt['presentation']) => {
    const shaderState = candidateShaderState ?? activeShaderState;
    return presentation === 'ready'
      ? []
      : [
          internals.device.pipelineLibrary?.pendingRuntimeCompilation?.(),
          gpuStore.pendingCubemapCompletion(),
          preparedPipelineOwners.get(currentPipelineCacheState())?.pendingCompletion(),
          shaderState.shaderInstance?.pendingTemplatePreparations(),
          shaderState.shaderInstance?.pendingMaterialPreparations(),
          shaderState.sharedShaderModuleAdapter?.pendingCompletion(),
          shaderState.sharedImmediateShaderModuleAdapter?.pendingCompletion(),
        ].filter((value) => value !== undefined);
  };
  /** Publish the receipt of a submitted frame with its completion and observations. */
  const issueFrameReceipt = (
    receiptFrameId: number,
    receiptGeneration: number,
    queueCompletion: Promise<unknown>,
    reflectionFallbackCompletion: Promise<unknown> | undefined,
    unheldQueueCompletion?: Promise<unknown>,
    profileFrame?: ProfileFrameToken,
    onFeatureSourceCompleted?: import('../publication/contract').PublishedRenderFrameInput['onFeatureSourceCompleted'],
  ): FrameReceipt => {
    const passIdentityCapture = internals.renderPassCpuIdentityCapture;
    finalizeRenderPassCpuIdentityCapture({
      identityCapture: passIdentityCapture,
      passTimingCapture: internals.gpuPassTimingCapture,
      receiptFrameId,
    });
    internals.renderPassCpuIdentityCapture = undefined;
    const completion = settleFrameCompletion(
      receiptFrameId,
      receiptGeneration,
      queueCompletion,
      reflectionFallbackCompletion,
    );
    const continuation = createContinuationTerminator();
    const { presentation, presentationPendingReason } = submittedFramePresentation(
      uiOnlyFrame,
      cameraViews,
    );
    frameContinuations.set(continuation, {
      frameId: receiptFrameId,
      deviceGeneration: receiptGeneration,
      presentation,
      stages: observeFrameCompletionStages(queueCompletion, reflectionFallbackCompletion),
    });
    let gpuSettled = false;
    let preparationSettled = false;
    let preparationCompleted: FrameReceipt['preparationCompleted'];
    const completed: FrameReceipt['completed'] = raceFrameContinuation(
      completion,
      continuation,
      receiptFrameId,
      receiptGeneration,
    ).finally(() => {
      gpuSettled = true;
      if (preparationCompleted === undefined || preparationSettled)
        frameContinuations.delete(continuation);
    });
    const preparations = pendingFramePreparations(presentation);
    preparationCompleted =
      preparations.length === 0 && !presentationPendingReason?.code.includes('pipeline-preparation')
        ? undefined
        : raceFrameContinuation(
            Promise.all(preparations).then(
              (results) => {
                const failed = results.find((result) => !result.ok);
                return failed !== undefined && !failed.ok
                  ? err(completeFrameFailure(receiptFrameId, receiptGeneration, failed.error))
                  : ok(undefined);
              },
              (cause: unknown) =>
                err(completeFrameFailure(receiptFrameId, receiptGeneration, cause)),
            ),
            continuation,
            receiptFrameId,
            receiptGeneration,
          ).finally(() => {
            preparationSettled = true;
            if (gpuSettled) frameContinuations.delete(continuation);
          });
    const creditCompleted: FrameReceipt['creditCompleted'] =
      unheldQueueCompletion === undefined
        ? undefined
        : raceFrameContinuation(
            // Reflection fallback settlement consumes the held queue fence and
            // belongs to `completed`; credit follows the GPU work alone.
            settleFrameCompletion(
              receiptFrameId,
              receiptGeneration,
              unheldQueueCompletion,
              undefined,
            ),
            continuation,
            receiptFrameId,
            receiptGeneration,
          );
    const captureFrameReceiptObservations = () => {
      const captureFrame = observationCaptureOwner.consume(receiptFrameId);
      const { captures } = captureFrame;
      const observationDomains =
        pendingObservationDomains === undefined && captures.length === 0
          ? undefined
          : Object.freeze([...new Set(captures.map((capture) => capture.domain))]);
      pendingObservationDomains = undefined;
      const receiptGraphGeneration =
        internals.observationGraphGeneration ??
        (uiOnlyFrame ? 0 : viewGraphGeneration(cameraViews.currentOwner));
      return { captureFrame, captures, observationDomains, receiptGraphGeneration };
    };
    const { captureFrame, captures, observationDomains, receiptGraphGeneration } =
      captureFrameReceiptObservations();
    const editorAssistance = receiptEditorAssistance(
      presentation,
      receiptFrameId,
      receiptGeneration,
    );
    const configurationRevision = uiOnlyFrame ? undefined : cameraViews.configurationRevision;
    const createSubmittedFrameReceipt = () => {
      const receipt = Object.freeze({
        ...(editorAssistance === undefined ? {} : { editorAssistance }),
        frameId: receiptFrameId,
        ...(configurationRevision === undefined ? {} : { configurationRevision }),
        ...(profileFrame === undefined ? {} : { profileFrame }),
        ...(profileFrame === undefined || passIdentityCapture === undefined
          ? {}
          : {
              renderPassCpuIdentities: Object.freeze([...passIdentityCapture.entries]),
              renderPassCpuIdentitiesComplete: passIdentityCapture.complete,
            }),
        deviceGeneration: receiptGeneration,
        presentation,
        ...(presentationPendingReason === undefined ? {} : { presentationPendingReason }),
        ...(observationDomains === undefined ? {} : { observationDomains }),
        backendId: internals.device.caps.backendKind,
        graphGeneration: receiptGraphGeneration,
        ...(uiOnlyFrame ||
        cameraViews.active ||
        primaryOwner.frameState.lastSuccessfulBarrelDistortion === undefined
          ? {}
          : { barrelDistortion: primaryOwner.frameState.lastSuccessfulBarrelDistortion }),
        completed,
        ...(preparationCompleted === undefined ? {} : { preparationCompleted }),
        ...(creditCompleted === undefined ? {} : { creditCompleted }),
        ...(internals.options?.shadowWorkload !== true
          ? {}
          : {
              shadowWorkload: captureShadowWorkload(
                {
                  frameId: receiptFrameId,
                  deviceGeneration: receiptGeneration,
                  graphGeneration: receiptGraphGeneration,
                },
                cameraViews.lastLodObservationCapture,
                uiOnlyFrame,
              ),
            }),
      });
      return receipt;
    };
    const receipt = createSubmittedFrameReceipt();
    cloudAdoption.observe(
      uiOnlyFrame ? undefined : renderInternals.rendererFrameNumber,
      renderSubmission(renderWorld).accepted,
      receipt,
    );
    renderTargetHost.onFrameSubmitted(completed, receipt);
    latestReceipt = receipt;
    latestPublicationRevision = publicationReceiver?.acceptedRevision ?? 0;
    latestLodObservation = {
      receipt,
      capture: cameraViews.lastLodObservationCapture,
      draws: captureMaterialDraws(cameraViews.lastLodObservationCapture),
    };
    const readCaptures =
      captures.length > 0
        ? observationOwner.registerReceiptReads(receipt, captureFrame)
        : undefined;
    const deliverFeatureSourceCompletion = () => {
      return runDeliverFeatureSourceCompletion(
        onFeatureSourceCompleted,
        observationCaptureOwner,
        receipt,
        completed,
        readCaptures,
        internals,
      );
    };
    deliverFeatureSourceCompletion();
    internals.featureHost?.deliverFrameReceipt(receipt, (identity) =>
      (async () => {
        const completion = await completed;
        if (!completion.ok) return completion;
        if (readCaptures === undefined) return ok([]);
        const read = await readCaptures();
        if (!read.ok) return read;
        const own = read.value.captures.filter(
          ({ capture }) => capture.featureTexture?.featureIdentity === identity,
        );
        if (own.length === 0) return ok([]);
        return projectReceiptColorObservations(
          receipt,
          own,
          ['feature-texture'],
          internals.device.caps.backendKind,
          read.value.graphGenerations,
        );
      })(),
    );
    timingObservationStore?.register(receipt, gpuPassTimingSource());
    return receipt;
  };

  const gpuPassTimingSource = (): (() => Promise<GpuPassTimingObservation>) | undefined => {
    const passTimingCapture = uiOnlyFrame ? undefined : internals.gpuPassTimingCapture;
    if (passTimingCapture !== undefined)
      return () => projectGpuPassTimingCapture(passTimingCapture, failedGpuPassTimingObservation);
    const timingBeginReason = uiOnlyFrame ? undefined : internals.gpuPassTimingBeginReason;
    if (gpuPassTimingUnavailable === undefined && timingBeginReason === undefined) return undefined;
    return async (): Promise<GpuPassTimingObservation> =>
      gpuPassTimingUnavailable ??
      failedGpuPassTimingObservation(timingBeginReason as GpuPassTimingError);
  };
  const drawFailure = (cause: unknown): Result<never, RhiError | RenderError> => {
    const frameNumber = internals.observationFrameId;
    internals.observationFrameId = undefined;
    internals.observationCaptureDomains = undefined;
    internals.gpuPassTimingDeviceGeneration = undefined;
    const cleanupFailure = disposeOwnedObservationCaptures(
      observationOwner.discardFrame(frameNumber),
    );
    if (cleanupFailure !== undefined) return err(cleanupFailure);
    if (cause instanceof RendererOperationError) return err(cause);
    if (cause instanceof CameraViewInvalidError) return err(cause);
    if (cause instanceof ProjectedDecalInvalidError) return err(cause);
    const e = recordFailureError(cause);
    internals.errorRegistry.fire(e);
    return err(e);
  };
  const receiptObservers = createRendererReceiptObservers(
    {
      staleObservationReceipt,
      gpuPassTimingOptions,
      timingObservationStore,
      observeTiming,
      currentGeneration: () => activeDeviceScope.generation,
      backendKind: () => internals.device.caps.backendKind,
      observationOwner,
      latestLodObservation: () => latestLodObservation,
      latestReceipt: () => latestReceipt,
      lodObservationValidity,
      renderTargetHost,
      receiptTimings,
      isCaptureGenerationCurrent: () => internals.pack.instrumentation?.isCaptureGenerationCurrent,
    },
    () => cameraViews.currentOwner,
  );
  const renderer: RendererAssemblyImplementation = {
    setSurfaceDynamicInput(frame) {
      publishSurfaceDynamicInput(renderWorld, frame);
    },
    attach(world: World): RenderResult<RenderWorldLease, RenderError> {
      if (publicationReceiver !== undefined)
        return err(
          new RenderPublicationError({
            reason: 'identity',
            subject: 'publication Renderer has no World attachment',
          }),
        );
      const attached = this.attachScene(world);
      if (!attached.ok) {
        return err(new RendererContractFailureError('attach', attached.error.hint));
      }
      const lease = createRenderReadLease(world);
      const disposeRead = lease.dispose;
      lease.dispose = () => {
        disposeRead();
        if (attachedLeases.delete(lease) && ![...attachedLeases.values()].includes(world))
          this.detachScene(world);
      };
      attachedLeases.set(lease, world);
      return ok(lease);
    },
    ...dynamicGeometryHost,
    prepareTextureResidency: createTextureResidencyPreparer(
      attachedWorlds,
      () => gpuStore,
      () => internals.device,
    ),
    reservePublishedMeshTransfer: (bytes) =>
      reservePublishedMeshTransfer(publicationReceiver, bytes),
    preparePublishedMeshResidency: createPublishedMeshResidencyHost({
      assets,
      prepareCandidatePipelines: (input, signal) =>
        cameraViews.prepareCandidatePipelines(input, signal),
      receiver: publicationReceiver,
      getGpuStore: () => gpuStore,
      currentGeneration: () => activeDeviceScope.generation,
      completeUploads: () => {
        const failure = drawHealthError();
        if (failure !== undefined) throw failure;
        const generation = activeDeviceScope.generation;
        const completed = internals.device.queue.onSubmittedWorkDone();
        watchQueueCompletion(completed, undefined, generation);
        return completed;
      },
      isCurrentFrame: (receipt) =>
        !uiOnlyFrame &&
        latestReceipt === receipt &&
        publicationReceiver?.acceptedRevision === latestPublicationRevision,
      recordStageLane: (resources, entity, handle) =>
        cameraViews.dynamicGeometryRecordStageLane(resources, entity, handle),
    }),
    prepareRenderTargetEnvironment: (target, faces) =>
      prepareTargetEnvironment({
        target,
        faces,
        targets: renderTargetHost,
        device: internals.device,
        scope: activeDeviceScope,
        factory: internals.pack.createShaderModule,
        environments: targetEnvironments,
      }),
    createRenderTarget: (descriptor) => renderTargetHost.createRenderTarget(descriptor),
    resizeRenderTarget: (target, descriptor) =>
      renderTargetHost.resizeRenderTarget(target, descriptor),
    createRenderTargetTextureSource: (target, options) =>
      renderTargetHost.createRenderTargetTextureSource(target, options),
    requestTargetReadback: (target, request) =>
      renderTargetHost.requestTargetReadback(target, request),
    requestFramebufferSnapshot: (target, request) =>
      renderTargetHost.requestFramebufferSnapshot(target, request),
    destroyRenderTarget: (target) => renderTargetHost.destroyRenderTarget(target),
    importTexture: (input) => externalTextureHost.importTexture(input),
    requestViewportHit: (request, signal) =>
      disposed || surfaceReleased
        ? Promise.resolve({ kind: 'unavailable', reason: 'renderer' })
        : viewportHits.request(request, signal),
    nativeDevice: () => externalTextureHost.nativeDevice(),
    setProfile(profile: RenderProfile): RenderResult<void, RenderError> {
      if (
        activeProfile.configurationRevision !== undefined &&
        profile?.configurationRevision === undefined
      )
        return err(
          new RendererOperationError('frame-input-invalid', {
            operation: 'set-profile',
            cause: new RendererContractFailureError(
              'draw',
              'Use App.configuration for a managed Renderer; constructor policy cannot bypass its revision',
            ),
          }),
        );
      const invalid = selectProfile.validate(profile, internals.device);
      if (invalid !== undefined) {
        return err(
          new RendererOperationError('frame-input-invalid', {
            operation: 'set-profile',
            cause: new RendererContractFailureError('draw', invalid),
          }),
        );
      }
      const previous = activeProfile;
      activeProfile = freezeRenderProfile(profile);
      try {
        cameraViews.configureStandard(undefined);
        return ok(undefined);
      } catch (cause) {
        activeProfile = previous;
        try {
          cameraViews.configureStandard(undefined);
        } catch {
          // The original structured profile failure remains authoritative.
        }
        return err(
          new RendererOperationError('graph-build-failed', {
            operation: 'set-profile',
            cause: structuredRendererCause(cause, 'set-profile'),
          }),
        );
      }
    },
    setOutputColorSpace(colorSpace: OutputColorSpace): RenderResult<void, RenderError> {
      if (!isOutputColorSpace(colorSpace)) {
        return err(
          new RendererOperationError('frame-input-invalid', {
            operation: 'set-output-color-space',
            cause: {
              code: 'output-color-space-invalid',
              expected: `one of ${OUTPUT_COLOR_SPACES.join(' | ')}`,
              hint: "pass 'srgb' or 'display-p3'",
              detail: { received: String(colorSpace) },
            },
          }),
        );
      }
      const state = internals.outputColorSpace;
      if (state.requested === colorSpace) return ok(undefined);
      state.requested = colorSpace;
      if (pipelineState !== null) pipelineState.perPassResources.configured = false;
      return ok(undefined);
    },
    inspectLodOcclusion() {
      const inspected = cameraViews.currentOwner;
      return {
        lodOcclusion: inspected.lod.cell?.value(),
        gpuDriven: inspected.gpuDriven.inspect(inspected.skin.paletteUploadBytes),
      };
    },
    bounds: (world, entity) => (disposed ? undefined : cameraViews.bounds(world, entity)),
    currentDeviceGeneration: () => activeDeviceScope.generation,
    inspect(options): RenderInspection {
      const library = internals.device.pipelineLibrary;
      pipelineLibraryCollection.update(
        options?.pipelineLibraryCollection,
        internals.device,
        activeDeviceScope,
      );
      const exported = exportPipelineLibraryForInspection(library, options);
      const inspected = cameraViews.currentOwner;
      const fields = options?.fields;
      const want = (...names: readonly (keyof RenderInspection)[]) =>
        inspectionSelects(fields, ...names);
      const health = internals.healthRegistry.getLastSnapshot();
      const deviceLost = health.reason === 'device-lost';
      const state = projectRendererInspectionState(
        disposed,
        deviceLost,
        health.reason === 'internal-fault' || (!readySettled && ui === undefined),
      );
      const pointShadow = want('pointShadow')
        ? projectPointShadowInspection(
            inspected.frameState.submittedInspection,
            getShader().materialShaderManifestEntries(),
          )
        : undefined;
      const generation = activeDeviceScope.generation;
      const inspectDeviceFields = () => ({
        ...(want('profile') ? { profile: selectedProfile() } : {}),
        ...(want('capabilities', 'limits', 'deviceInfo')
          ? inspectDeviceCapabilities(internals.device, generation, want('deviceInfo'))
          : {}),
        ...(want('frame')
          ? {
              frame: inspectFrameCompletionContinuations(frameId, generation, frameContinuations),
            }
          : {}),
        ...(want('barrelDistortion')
          ? {
              barrelDistortion: inspectBarrelDistortion(
                disposed,
                deviceLost,
                surfaceReleased,
                frameId,
                generation,
                viewBarrelDistortion(inspected),
              ),
            }
          : {}),
        ...(want('features', 'featureDiagnostics', 'featureHost', 'cloudLayer')
          ? projectRendererFeatureInspection(
              internals.featureHost,
              health.reason === 'alive' && !disposed
                ? (view) => cloudAdoption.read(view, generation)
                : undefined,
              fields,
            )
          : {}),
        ...projectRenderViewInspection(inspected, deviceLost, fields),
        ...(want('dynamicGeometry') ? { dynamicGeometry: dynamicGeometry.inspect() } : {}),
        ...(want('meshResidency')
          ? { meshResidency: inspectPublishedMeshResidency(publicationReceiver, gpuStore) }
          : {}),
        ...(want('textureGeneration')
          ? { textureGeneration: gpuStore.inspectTextureGenerators() }
          : {}),
        ...(want('extendedLighting')
          ? { extendedLighting: projectExtendedLightingInspection(extendedLightingState) }
          : {}),
      });
      const inspection = {
        ...(want('debugOverlay') ? debugOverlayInspectionField(renderWorld) : {}),
        ...(fields?.some((field) => field === 'shaderTemplates') === true
          ? { shaderTemplates: getShader().programTemplateInspection({ includePrograms: true }) }
          : {}),
        ...pipelineLibraryCollection.inspect(fields, internals.device, generation),
        ...projectRendererPipelineLibraryInspection(
          library,
          options,
          () => pipelineLibraryCollection.active(internals.device),
          backgroundPipelineLibraryState,
          exported,
        ),
        state,
        ...(want('views') ? { views: cameraViews.inspect() } : {}),
        ...(want('recovery') ? { recovery: recoveryInspection } : {}),
        ...(want('surface') ? { surface: surfaceReleased ? 'released' : 'available' } : {}),
        ...inspectDeviceFields(),
        ...(pointShadow === undefined ? {} : { pointShadow: Object.freeze({ ...pointShadow }) }),
        ...(want('perFramePassNames')
          ? { perFramePassNames: Object.freeze([...cameraViews.perFramePassNames]) }
          : {}),
        ...(want('recoveryEvidence')
          ? {
              recoveryEvidence: projectRecoveryEvidenceInspection(
                inspected,
                deviceLost,
                frameId,
                latestReceipt?.deviceGeneration,
              ),
            }
          : {}),
        ...(want('output', 'observation')
          ? projectRendererOutputFields({
              outputInspection: projectRendererOutputInspectionFromSurface({
                graph: deviceLost ? undefined : viewGraphInfo(inspected),
                surfaceReleased,
                pipelineState,
                rgba16floatRenderable: internals.device.caps.rgba16floatRenderable,
                colorSpace: internals.outputColorSpace.report,
                autoExposure: viewAutoExposure(inspected),
                standardLut: viewStandardLut(inspected),
                presentationProof: internals.context?.presentationProof,
              }),
              rgba16floatRenderable: internals.device.caps.rgba16floatRenderable,
              frameId,
              antialias: inspected.frameState.lastSuccessfulCameraAntialias,
              resourceStats: observationStats,
            })
          : {}),
      } as RenderInspection;
      return Object.freeze(
        options?.fields === undefined
          ? inspection
          : Object.fromEntries(options.fields.map((field) => [field, inspection[field]])),
      ) as RenderInspection;
    },
    get device(): RhiDevice {
      return internals.device;
    },
    // Keep engine-owned shader consumers on the exact backend pack selected
    // for this renderer. Importing a backend adapter again from a
    // feature glue module can produce a second bundled module instance whose
    // RAW_DEVICE_MAP does not contain this opaque RhiDevice handle.
    _internal_createShaderModule:
      internals.pack.createShaderModule ??
      ((device, desc) => invokeDeviceCreateShaderModule(device, desc)),
    _internal_setRenderOverlay(overlay) {
      if (overlay === undefined) {
        delete internals.debugOverlay;
      } else {
        internals.debugOverlay = overlay;
      }
    },
    assetRegistry: assets,
    initialization: ready,
    attachScene(world: World): Result<void, RhiError> {
      if (disposed) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'renderer not disposed before attaching a World',
            hint: 'rebuild the renderer before attaching another World',
          }),
        );
      }
      if (attachedWorlds.has(world)) return ok(undefined);
      if (attachedWorlds.size !== 0)
        return err(
          new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: 'one active source World per Renderer',
            hint: 'Release the current source leases before attaching another World.',
          }),
        );
      try {
        transformReleases.set(world, registerRenderSourceSystems(world));
        attachedWorlds.add(world);
        return ok(undefined);
      } catch (cause) {
        const error = new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'renderer.attach(world) installs derived-state systems once',
          hint: 'inspect the World schedule registration or derived-state system failure',
          detail: {
            error: {
              code: 'unknown',
              message: cause instanceof Error ? cause.message : String(cause),
              ...(cause instanceof Error ? { name: cause.name } : {}),
            },
          },
        });
        internals.errorRegistry.fire(error);
        return err(error);
      }
    },
    levelSourceAccess: createLevelSourceAccess({
      assets,
      publicationReceiver,
      composition: () => renderInternals.sceneComposition,
      available: (world, lease) =>
        !disposed && attachedLeases.get(lease) === world && attachedWorlds.has(world),
      prepareViews: (group, current) => cameraViews.prepareInitialSourceViews(group, current),
    }),
    detachScene(world: World): void {
      if (!attachedWorlds.delete(world)) return;
      dynamicGeometryHost.invalidateDynamicGeometryWorld(world);
      for (const [lease, leaseWorld] of attachedLeases) {
        if (leaseWorld === world) lease.dispose();
      }
      renderSystem.detachScene(world);
      cameraViews.detach(world);
      transformReleases.get(world)?.();
      transformReleases.delete(world);
    },
    observeCurrentFrame(options: FrameObservationOptions) {
      return observeViewFrame(cameraViews.currentOwner, options);
    },
    requestObservation(
      domains: readonly FrameObservationDomain[],
    ): RenderResult<void, RenderError> {
      if (disposed) {
        return err(
          new RendererOperationError('renderer-state-invalid', {
            operation: 'request-observation',
            state: 'disposed',
          }),
        );
      }
      if (
        !Array.isArray(domains) ||
        domains.length === 0 ||
        domains.some((domain) => !isFrameObservationDomain(domain)) ||
        new Set(domains).size !== domains.length
      ) {
        return err(
          new RendererOperationError('frame-input-invalid', {
            operation: 'request-observation',
            cause: new RendererContractFailureError(
              'request-observation',
              'domains must be a non-empty set of supported observation domains',
            ),
          }),
        );
      }
      if (domains.includes('visible-surface') && activeProfile.visibleSurface !== true) {
        return err(
          new RendererContractFailureError(
            'request-observation',
            'enable the Standard visibleSurface profile before arming its observation',
          ),
        );
      }
      if (receiptObservationBuffers.size >= 4) {
        return err(
          new RendererContractFailureError(
            'request-observation',
            'four unread frame observations are retained; observe their receipts before requesting another',
          ),
        );
      }
      pendingObservationDomains = Object.freeze([...domains]);
      return ok(undefined);
    },
    ...rendererConformanceHost(cameraViews),
    get frustumStats() {
      return cameraViews.currentOwner.recorded.frustum;
    },
    get visibilityStats() {
      return cameraViews.currentOwner.recorded.visibility;
    },
    get renderScene() {
      return viewRenderScene(cameraViews.currentOwner);
    },
    get meshMaterialBindings() {
      return viewMeshMaterialBindings(cameraViews.currentOwner);
    },
    get perFramePassNames() {
      return cameraViews.perFramePassNames;
    },
    get bindGroupCounts() {
      return cameraViews.currentOwner.recorded.bindGroups;
    },
    configureStandard(config) {
      cameraViews.configureStandard(config);
    },
    renderFeatureDiagnostics() {
      return internals.featureHost?.diagnostics() ?? [];
    },
    async installRenderFeature(
      feature: RenderFeature<unknown>,
    ): Promise<RenderResult<void, RenderError>> {
      if (disposed || candidateShaderState !== undefined) {
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'extract', 'registration'),
        );
      }
      const host = internals.featureHost;
      if (host === undefined) {
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'extract', 'registration'),
        );
      }
      const missingCapability = feature.requiredCapabilities?.find(
        (capability) => internals.device.caps[capability] !== true,
      );
      if (missingCapability !== undefined) {
        return err(
          new RenderFeatureCapabilityMissingError(feature.identity, host.size, missingCapability),
        );
      }
      let nextRequiredFullscreenPostProcesses: typeof requiredFullscreenPostProcesses;
      try {
        nextRequiredFullscreenPostProcesses = collectRequiredFullscreenPostProcesses([
          ...host.features,
          feature,
        ]);
      } catch (cause) {
        const conflict =
          cause instanceof RhiError
            ? cause
            : new RhiError({
                code: 'internal-error',
                expected: 'fullscreen feature declarations are internally consistent',
                hint: 'repair the conflicting fullscreen identity/source declarations',
              });
        internals.errorRegistry.fire(conflict);
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'prepare', 'registration'),
        );
      }
      const featureScope = activeDeviceScope;
      const featureDevice = internals.device;
      const featureCatalog = getShader();
      const featureAdapter = getShaderModuleAdapter();
      const generationIsCurrent = () =>
        !disposed &&
        featureScope.isAlive() &&
        featureScope === activeDeviceScope &&
        candidateShaderState === undefined;
      const warmupScope = featureScope.createChild('render-feature-shaders');
      const modules = new Map<string, ShaderModule>();
      warmupScope._adopt('shader', modules, (retained) => retained.clear());
      const retain = (label: string, module: ShaderModule) => {
        if (warmupScope.isAlive()) modules.set(label, module);
      };
      let committed = false;
      try {
        const fullscreenPrewarm = await prewarmFullscreenFeatureModules(
          internals,
          feature,
          featureDevice,
          featureAdapter,
          retain,
          generationIsCurrent,
        );
        if (!fullscreenPrewarm.ok || !generationIsCurrent()) {
          return err(
            new RenderFeatureStageFailedError(feature.identity, -1, 'prepare', 'registration'),
          );
        }
        for (const materialShaderId of feature.requiredMaterialShaders ?? []) {
          const lookup = featureCatalog.findMaterialArtifact(materialShaderId);
          if (!lookup.ok) {
            const error = new RhiError({
              code: 'shader-compile-failed',
              expected: `declared render feature material shader '${materialShaderId}' is present in the loaded manifest`,
              hint: `add material shader '${materialShaderId}' to the shader manifest or remove it from the feature declaration`,
            });
            internals.errorRegistry.fire(error);
            return err(
              new RenderFeatureStageFailedError(feature.identity, -1, 'prepare', 'registration'),
            );
          }
          const label = `module-${materialShaderId}`;
          const descriptor = lookup.value.program.sourceReference.descriptor(label);
          const moduleResult = internals.pack.createShaderModule
            ? await internals.pack.createShaderModule(featureDevice, descriptor)
            : await invokeDeviceCreateShaderModule(featureDevice, descriptor);
          if (!moduleResult.ok) {
            internals.errorRegistry.fire(moduleResult.error);
            return err(
              new RenderFeatureStageFailedError(feature.identity, -1, 'prepare', 'registration'),
            );
          }
          if (!generationIsCurrent())
            return err(
              new RenderFeatureStageFailedError(feature.identity, -1, 'prepare', 'registration'),
            );
          retain(label, moduleResult.value);
          featureAdapter.seedModule(
            label,
            moduleResult.value,
            lookup.value.program.sourceReference,
          );
        }
        const installed = host.install(feature);
        if (!installed.ok) return installed;
        if (installed.ok) {
          featureShaderScopes.get(feature)?.dispose();
          featureShaderScopes.set(feature, warmupScope);
          committed = true;
          for (const materialShaderId of feature.requiredMaterialShaders ?? []) {
            requiredMaterialShaderSet.add(materialShaderId);
          }
          requiredMaterialShaders = Object.freeze([...requiredMaterialShaderSet]);
          requiredFullscreenPostProcesses = nextRequiredFullscreenPostProcesses;
          cameraViews.reset();
        }
        return installed;
      } finally {
        if (!committed) warmupScope.dispose();
      }
    },
    async uninstallRenderFeature(
      feature: RenderFeature<unknown>,
    ): Promise<RenderResult<void, RenderError>> {
      const host = internals.featureHost;
      if (disposed || host === undefined) {
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'dispose', 'registration'),
        );
      }
      try {
        await internals.device.queue.onSubmittedWorkDone();
      } catch {
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'dispose', 'registration'),
        );
      }
      const removed = host.uninstall(feature);
      if (removed.ok) {
        featureShaderScopes.get(feature)?.dispose();
        featureShaderScopes.delete(feature);
        requiredMaterialShaderSet.clear();
        for (const remaining of host.features) {
          for (const materialShaderId of remaining.requiredMaterialShaders ?? []) {
            requiredMaterialShaderSet.add(materialShaderId);
          }
        }
        requiredMaterialShaders = Object.freeze([...requiredMaterialShaderSet]);
        requiredFullscreenPostProcesses = collectRequiredFullscreenPostProcesses(host.features);
        cameraViews.reset();
      }
      return removed;
    },
    drawFrame(request: RenderFrameInput): RenderResult<FrameReceipt, RhiError | RenderError> {
      const result = this.draw(request);
      if (!result.ok) return result;
      return result.value === undefined
        ? err(
            new RendererContractFailureError(
              'draw',
              'the lease-bound draw path must return a FrameReceipt after submit',
            ),
          )
        : ok(result.value);
    },
    draw(
      request: RenderFrameInput | PublishedRenderFrameInput,
    ): Result<void | FrameReceipt, RhiError | RenderError> {
      if (preparationActive) return preparationRejected();
      preparationActive = true;
      let restoreProfileSessionPin: (() => void) | undefined;
      try {
        const profiler = internals.options?.profiler;
        if (profiler !== undefined)
          restoreProfileSessionPin = pinRenderProfileSession(renderWorld, profiler.activeSession());
        return drainFramePreparation(prepareDraw(request));
      } finally {
        restoreProfileSessionPin?.();
        preparationActive = false;
      }
    },
    async drawFrameScheduled(request, schedule) {
      if (preparationActive) return preparationRejected();
      preparationActive = true;
      let ownsProfileSessionPin = false;
      let restoreProfileSessionPin: (() => void) | undefined;
      try {
        const scope = activeDeviceScope;
        const device = internals.device;
        const generation = scope.generation;
        const width = internals.canvas.width;
        const height = internals.canvas.height;
        const { source, epoch, revision } = request.publication;
        const current = () =>
          !disposed &&
          !surfaceReleased &&
          !schedule.signal?.aborted &&
          activeDeviceScope === scope &&
          internals.device === device &&
          scope.generation === generation &&
          internals.healthRegistry.getLastSnapshot().reason === 'alive' &&
          internals.canvas.width === width &&
          internals.canvas.height === height &&
          request.publication.source === source &&
          request.publication.epoch === epoch &&
          request.publication.revision === revision &&
          (publicationReceiver?.acceptedRevision ?? revision) === revision &&
          (schedule.isCurrent?.() ?? true);
        // A pre-cancelled operation must not even admit its publication.
        if (schedule.signal?.aborted || schedule.isCurrent?.() === false)
          return preparationRejected();
        const profiler = internals.options?.profiler;
        if (profiler !== undefined) {
          restoreProfileSessionPin = pinRenderProfileSession(renderWorld, profiler.activeSession());
          ownsProfileSessionPin = true;
        }
        const operation = prepareDraw(request, current);
        let settled = false;
        try {
          let next = operation.next();
          while (!next.done) {
            try {
              if (!schedule.signal?.aborted) {
                let cancel = () => {};
                try {
                  const cancelled = new Promise<void>((resolve) => {
                    cancel = resolve;
                  });
                  schedule.signal?.addEventListener('abort', cancel, { once: true });
                  await Promise.race([schedule.checkpoint(), cancelled]);
                } finally {
                  schedule.signal?.removeEventListener('abort', cancel);
                }
              }
              next = operation.next();
            } catch (cause) {
              next = operation.throw(cause);
            }
          }
          settled = true;
          const result = next.value;
          if (!result.ok) return result;
          return result.value === undefined ? preparationRejected() : ok(result.value);
        } finally {
          // Abnormal driver exit must enter the existing catch/abort cleanup,
          // including receipt-bound timing and observation candidates.
          if (!settled) {
            try {
              operation.throw(
                new RendererContractFailureError('draw', 'scheduled preparation cancelled'),
              );
            } catch {
              /* The original failure remains the caller's authority. */
            }
          }
        }
      } finally {
        if (ownsProfileSessionPin) {
          restoreProfileSessionPin?.();
        }
        preparationActive = false;
      }
    },
    ...receiptObservers,
    releaseSurface(): Result<void, RhiError> {
      if (surfaceReleased) return ok(undefined);
      if (disposed) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'live renderer before releasing its surface',
            hint: 'create a new Renderer; disposed renderers are terminal',
          }),
        );
      }
      try {
        internals.context.unconfigure();
        if (pipelineState !== null) pipelineState.perPassResources.configured = false;
        surfaceReleased = true;
        viewportHits.invalidate();
        return ok(undefined);
      } catch (cause) {
        return err(wrapDisposeError(cause, 'context.unconfigure'));
      }
    },
    restoreSurface(): Result<void, RhiError> {
      if (!surfaceReleased) return ok(undefined);
      if (disposed) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'live renderer before restoring its surface',
            hint: 'create a new Renderer; disposed renderers are terminal',
          }),
        );
      }
      surfaceReleased = false;
      return ok(undefined);
    },
    /**
     * Terminal, best-effort retirement of renderer-owned resources and listeners.
     * Latch disposal before releasing anything so re-entrant calls short-circuit.
     * Each guarded failure reaches error listeners without halting later cleanup;
     * the executable order below owns the cascade. Backend lifetime owns raw-device
     * destruction. See Renderer.dispose in the package contract.
     */
    dispose(): RenderResult<void, RenderError> {
      if (preparationActive) return preparationRejected();
      if (disposed) return ok(undefined);
      disposed = true;
      viewportHits.invalidate();
      terrainReceipts.clear();
      // A live backend's unresolved loss promise must not retain this renderer.
      internals.lossObserver.current = null;
      delete internals.generationState.onStaleLoss;
      cameraViews.dispose();
      debugOverlayHolderOf(renderWorld)?.residency.dispose();
      retireGpuPassTimingSession();
      internals.gpuPassTimingCapture = undefined;
      internals.gpuPassTimingSubmittedWork = undefined;
      for (const world of attachedWorlds) dynamicGeometryHost.invalidateDynamicGeometryWorld(world);
      dynamicGeometry.dispose();
      publicationReceiver?.dispose();
      surfaceInputReceiver.dispose();
      publicationInstances?.dispose();
      for (const continuation of frameContinuations.keys()) {
        continuation.terminate({ code: 'disposed' });
      }
      const cleanupFailures: RendererOperationCause[] = [];
      try {
        ui?.owner.dispose();
      } catch (cause) {
        const error = wrapDisposeError(cause, 'ui.dispose');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      const observationCleanupFailure = disposeReceiptObservationCaptures();
      if (observationCleanupFailure !== undefined) {
        cleanupFailures.push(observationCleanupFailure);
      }
      for (const world of attachedWorlds) {
        try {
          transformReleases.get(world)?.();
          transformReleases.delete(world);
        } catch (cause) {
          const error = wrapDisposeError(cause, 'world.removeSystem(renderDerived)');
          cleanupFailures.push(error);
          internals.errorRegistry.fire(error);
        }
      }
      attachedWorlds.clear();
      for (const lease of attachedLeases.keys()) {
        try {
          lease.dispose();
        } catch (cause) {
          const error = wrapDisposeError(cause, 'read-lease.dispose');
          cleanupFailures.push(error);
          internals.errorRegistry.fire(error);
        }
      }
      attachedLeases.clear();
      // Release the current swap-chain image before destroying a resource
      // wrappers that may share its underlying device allocation. The wgpu
      // WebGL2 surface owns an explicit SurfaceTexture; leaving this until
      // after the resource sweep lets wasm drop it against a dead Surface.
      if (!surfaceReleased) {
        try {
          internals.context.unconfigure();
        } catch (cause) {
          const error = wrapDisposeError(cause, 'context.unconfigure');
          cleanupFailures.push(error);
          internals.errorRegistry.fire(error);
        }
      }
      externalTextureHost.dispose();
      try {
        releaseTargetEnvironments();
        renderTargetHost.dispose();
      } catch (cause) {
        const error = wrapDisposeError(cause, 'renderTargetHost.dispose');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      // Step 2: release every Buffer / Texture handle owned by the runtime
      // GPU residency layer (feat-20260601-device/gpu-residency-extraction).
      for (const [owner, store] of Object.entries({ dynamicTextureStore, gpuStore })) {
        try {
          store.destroyAll();
        } catch (cause) {
          const error = wrapDisposeError(cause, `${owner}.destroyAll`);
          cleanupFailures.push(error);
          internals.errorRegistry.fire(error);
        }
      }
      // Step 3: drain the per-frame render-graph pool + the per-entity
      // instanceBuffers GPU storage cache. Both walks live on the
      // RendererState closure (frameState is closure-private).
      try {
        primaryOwner.disposeFrameState();
      } catch (cause) {
        const error = wrapDisposeError(cause, 'viewOwner.disposeFrameState');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      try {
        renderSystem.releaseProfilerCatalog();
      } catch (cause) {
        const error = wrapDisposeError(cause, 'renderSystem.releaseProfilerCatalog');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      // Step 4: release feature-owned resources and invoke feature disposal
      // hooks after render-graph state has been drained. The host is already
      // idempotent, and its structured cleanup detail is preserved by the
      // error registry when a feature cleanup fails.
      try {
        const featureDispose = internals.featureHost?.dispose();
        if (featureDispose !== undefined && !featureDispose.ok) {
          cleanupFailures.push(featureDispose.error);
          internals.errorRegistry.fire(featureDispose.error);
        }
      } catch (cause) {
        const error = wrapDisposeError(cause, 'featureHost.dispose');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      // This Registry is created by this host. Borrowed World asset owners
      // remain with their callers; only the host's own content retires here.
      try {
        assets.dispose();
      } catch (cause) {
        const error = wrapDisposeError(cause, 'assets.dispose');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      // Retire assembly-owned device resources only after the surface and
      // renderer-owned GPU pools have been released. The wgpu WebGL2 surface
      // still needs a live device while `unconfigure()` presents its pending
      // image; disposing the scope first lets wasm finalizers race that
      // presentation and can surface a parking_lot panic in WebKit.
      try {
        destroyWaterMaterialFrameEntries(internals.device);
        activeDeviceScope.dispose();
      } catch (cause) {
        const error = wrapDisposeError(cause, 'activeDeviceScope.dispose');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      // Step 5: the IBL cache is keyed by the retired DeviceScope generation.
      // It is no longer reachable through the active renderer scope, while
      // the device teardown owns the child GPU handles.
      // Step 6: detach the listener registries so a post-dispose error
      // event (race with the spec layer) does not fan out to user-supplied
      // listeners (charter P3 explicit failure: post-dispose the renderer
      // is dead, no observable side-effects). Performed last so steps 1-5
      // can still surface failures through `errorRegistry.fire`.
      try {
        internals.lostRegistry.clear();
        internals.errorRegistry.clear();
        internals.healthRegistry.clear();
      } catch (cause) {
        cleanupFailures.push(structuredRendererCause(cause, 'listenerRegistry.clear'));
      }
      return cleanupFailures.length === 0
        ? ok(undefined)
        : err(
            new RendererOperationError('cleanup-failed', {
              operation: 'dispose',
              causes: Object.freeze(cleanupFailures),
            }),
          );
    },
    onError(listener: RendererErrorListener): () => void {
      return internals.errorRegistry.add(listener);
    },
    subscribeHostEvents(listener) {
      const offError = internals.errorRegistry.add((error) => {
        listener(Object.freeze({ kind: 'error', error }));
      });
      const offHealth = internals.healthRegistry.add((health) => {
        listener(Object.freeze({ kind: 'health', health }));
      });
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        offError();
        offHealth();
      };
    },
    onLost(listener: RendererLostListener): () => void {
      return internals.lostRegistry.add(listener);
    },
    health(): HealthSnapshot {
      return internals.healthRegistry.getLastSnapshot();
    },
    recover(): Promise<Result<void, RecoverFailure>> {
      if (preparationActive)
        return Promise.resolve(err(new RecoverError('recover-device-unavailable')));
      const observationCleanupFailure = disposeReceiptObservationCaptures();
      if (observationCleanupFailure !== undefined) {
        return Promise.resolve(err(new RecoverError('recover-device-unavailable')));
      }
      return recoveryFlight.run();
    },
  };
  /**
   * Publish a fully prepared generation and retire the previous owner set.
   *
   * This is deliberately synchronous: all candidate state is complete before
   * entering the function, and no callback or await is allowed between the
   * active-reference swap and the old-generation retirement. The candidate
   * carries its own shader adapters, pipeline caches, stores, hooks, and
   * post-process handles; a failed build never reaches this boundary.
   */
  const publishAndRetireRendererGeneration = (
    candidate: RendererGeneration,
    candidatePostProcessResources: RecoveryPostProcessResources,
    recoveryRootBundle: RecoveryRootBundle,
    canvas: RhiCanvasTarget,
  ): void => {
    if (!candidate.scope.isAlive()) {
      throw new Error('Renderer generation candidate is not publishable.');
    }
    const previous = generationPublication.current;
    const previousBindings = previous?.producerBindings;
    const previousGpuStore = previousBindings?.gpuStore ?? gpuStore;
    const previousDynamicTextureStore =
      previousBindings?.dynamicTextureStore ?? dynamicTextureStore;
    const previousScope = previous?.scope ?? activeDeviceScope;
    // This is the first line of the synchronous publication boundary. The
    // candidate was already compiled and its setup work completed; now shed
    // lost-device RendererState owners before installing the candidate state.
    renderSystem.resetForRecover(previous?.pipeline, candidate.device);
    // Candidate readiness is the first point where the target owner may shed
    // old physical handles. Keep its device getter pinned to the old device,
    // but advance its generation so active targets enter their rebuild state;
    // this call is inside the same synchronous publication boundary.
    renderTargetGeneration = candidate.scope.generation;
    renderTargetHost.recover();
    externalTextureHost.recover();
    // GPUCanvasContext is canvas-owned rather than generation-owned: the
    // candidate and previous RHI wrappers address the same underlying
    // context. Detach the previous configuration first, then configure the
    // candidate again after that detach. Otherwise the old wrapper's
    // unconfigure() can silently revoke the candidate's configuration while
    // candidate.perPassResources.configured still says true, producing a
    // submitted-but-black recovery frame.
    const previousContext = previous?.context ?? internals.context;
    candidate.pipeline.perPassResources.configured = false;
    previousContext.unconfigure();
    const configured = ensureContextConfigured(
      internals,
      candidate.pipeline,
      internals.errorRegistry,
      candidate.context,
      candidate.device,
    );
    if (!configured.ok) throw configured.error;
    internals.canvas = canvas;
    internals.device = candidate.device;
    internals.context = candidate.context;
    viewportHits.invalidate();
    publishRendererGeneration(candidate);
    renderTargetDevice = candidate.device;
    // Arm the first-frame guard before any publication code can resolve a
    // fallback pipeline or residency entry. Candidate preparation populated
    // these caches already; a miss here is a hard recovery failure, not an
    // opportunity to hide cold work inside the first visible frame.
    renderSystem.publishRecoveryPostProcessResources(candidatePostProcessResources);
    candidate.pipeline.perPassResources.commitBloomResources?.();
    recoveryRootBundle.publish();
    // RendererState owns frame/feature GPU state; the generation bindings own
    // residency stores; DeviceScope owns the remaining lifecycle roots. Their
    // retirement is intentionally centralized and ordered after publication.
    previousGpuStore.destroyAll();
    previousDynamicTextureStore.destroyAll();
    destroyWaterMaterialFrameEntries(previous?.device ?? internals.device);
    previousScope.retire();
  };
  rendererRecovery = createRendererRecovery({
    isDisposed: () => disposed,
    internals,
    getActiveDeviceScope: () => activeDeviceScope,
    getActiveShaderState: () => activeShaderState,
    getMaterialShaderUvSetCounts: () => materialShaderUvSetCounts,
    prepareGpuPassTimingState,
    getCandidateBuildState: () => candidateBuildState,
    setCandidateBuildState(state) {
      candidateBuildState = state;
    },
    getCandidateShaderState: () => candidateShaderState,
    setCandidateShaderState(state) {
      candidateShaderState = state;
    },
    getCandidatePipelineCacheState: () => candidatePipelineCacheState,
    setCandidatePipelineCacheState(state) {
      candidatePipelineCacheState = state;
    },
    getCandidateMaterialShaderUvSetCounts: () => candidateMaterialShaderUvSetCounts,
    setCandidateMaterialShaderUvSetCounts(state) {
      candidateMaterialShaderUvSetCounts = state;
    },
    setCandidateEmptyPostProcessBgl(layout) {
      candidateEmptyPostProcessBgl = layout;
    },
    getShader,
    buildPipeline,
    renderSystem,
    createRecoveryFailureLocation,
    publishAndRetireRendererGeneration,
  });
  return renderer;
}
