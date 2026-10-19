// @forgeax/engine-render — WebGPU renderer lifecycle/frame interpreter.
// Runtime selects the backend; structured RHI errors and browser isolation stay intact.
import {
  AssetRegistry,
  adaptDynamicTextureDevice,
  DynamicTextureStore,
} from '@forgeax/engine-assets-runtime';
import { audioLoader } from '@forgeax/engine-audio-webaudio';
import type { World } from '@forgeax/engine-ecs';
import { createRenderReadLease, type RenderReadLease } from '@forgeax/engine-ecs/projection';
import {
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  type VertexLayoutProjection,
} from '@forgeax/engine-geometry';
import type {
  BindGroupLayout,
  RenderPipeline,
  Result,
  RhiCanvasTarget,
  RhiDevice,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError, validateDrawArgs } from '@forgeax/engine-rhi';
import type { PipelineGroup2Contract } from '@forgeax/engine-shader';
import {
  findVariantByKey,
  type MaterialShaderEntry,
  type MaterialShaderManifestEntry,
  materialShaderSourceEquals,
  ShaderCatalog,
  TONEMAP_PARAMS_LAYOUT,
} from '@forgeax/engine-shader';
import type {
  MaterialRenderState,
  PassKind,
  PrimitiveTopology,
  VertexAttributeMap,
} from '@forgeax/engine-types';
import { isStripTopology } from '@forgeax/engine-types';
import { ProjectedDecalInvalidError } from '../decals/component';
import { unavailableGeometry } from '../geometry-observation';
import {
  isOutputColorSpace,
  OUTPUT_COLOR_SPACES,
  type OutputColorSpace,
} from '../output-color-space';
import {
  materialShadersSamplePointShadows,
  projectPointShadowInspection,
} from '../point-shadow-inspection';
import { type PublishedRenderFrameInput, RenderPublicationError } from '../publication/contract';
import { captureMeshPipelinePreparation } from '../publication/mesh-pipeline-preparation';
import { type PreparedRenderPublication, RenderPublicationReceiver } from '../publication/receiver';
import { encodeFrameObservationCapture } from '../record/observation-capture';
import {
  configureSurface,
  type RenderSystemInternals,
  selectSwapChainFormat,
} from '../record/render-context';
import { isFrameObservationDomain } from '../render-contract';
import { registerRenderSourceSystems } from '../scene/source-systems';
import { createTerrainReceiptOwner } from '../terrain/submitted.js';
import { prepareVolumePrograms } from '../volume/programs';
import { createCameraViews } from './camera-views';
import { inspectDeviceCapabilities } from './device-feature-admission';
import {
  drainFramePreparation,
  type FramePreparation,
  type FrameRecording,
  prepareFrameSubmission,
} from './frame-recording';
import { createMaterialLayoutCache } from './material/layout-cache';
import {
  MaterialPipelineRequestCache,
  materialPipelineRequestFacts,
} from './material/pipeline-request-cache';
import {
  type PreparedRenderPipelineOwner,
  preparedRenderPipelineOwner,
} from './material/prepared-pipeline-owner';
import { resolveFeatureShaderSource } from './material-shader-policy';
import { createPublishedMeshResidencyHost } from './published-mesh-residency';
import { createUiCompositor } from './ui-compositor';

export type { MaterialShaderManifestEntry } from '@forgeax/engine-shader';

import { adoptBackendDevice, DeviceScope } from '../device/device-scope';
import { GpuResidencyCache } from '../device/gpu-residency';
import { createEngineMetrics } from '../engine-metrics';
import { createRecoveryFailedError, RecoverError, type RecoverFailure } from '../errors/recover';
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
import {
  dofInspection,
  registerDepthOfFieldBuiltins,
} from '../features/depth-of-field/depth-of-field-assembly';
import { createRenderFeatureHost } from '../features/host';
import { motionBlurDrawOptions } from '../features/motion-blur/motion-blur-runtime';
import { RENDER_FEATURE_VERTEX_LAYOUTS } from '../features/prepared-graphics';
import type { RenderFeature, RenderFeatureShaderModuleMode } from '../features/types';
import {
  type PostProcessShaderEntry,
  postProcessShaderModuleLabel,
} from '../fullscreen-post-process-pass';
import { type BloomInspection, emptyBloomInspection } from '../inspection-types';
import { isCanonicalStandardPbrMaterialShader, SKIN_MATERIAL_SHADER_ID } from '../pbr-pipeline';
import { registerSingleLayerMediumBuiltins } from '../pipeline/single-layer-medium-passes';
import { standardPipeline } from '../pipeline/standard-pipeline';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import { buildPipelineForMaterialShader } from '../pipeline-builder';
import {
  cacheKeyOf,
  colorFormatsForPassKind,
  type PipelineSpec,
  PipelineSpecError,
  passKindPolicyTable,
} from '../pipeline-spec';
import type { ExtendedLightingResourceCandidate } from '../prepare/extended-lighting/resources';
import {
  COOKIE_MATRIX_BYTES,
  COOKIE_SLICE_MIP_CHAIN_BYTES,
  EXTENDED_LIGHTING_TOPOLOGY,
  IES_SLICE_HEIGHT,
  IES_SLICE_WIDTH,
} from '../prepare/extended-lighting/resources';
import {
  createExtendedLightingState,
  projectExtendedLightingInspection,
  promoteExtendedLightingCandidate,
} from '../prepare/extended-lighting/state';
import type { FrameObservationOptions } from '../record/frame';
import type { GpuPassTimingReason } from '../record/gpu-pass-timing/errors.js';
import {
  DEFAULT_GPU_PASS_TIMING_OPTIONS,
  type GpuPassTimingCapture,
  type GpuPassTimingObservation,
  type GpuPassTimingSession,
  prepareGpuPassTimingSession,
} from '../record/gpu-pass-timing/index.js';
import { GpuTimingCapture, type VolumeTimingObservation } from '../record/gpu-timing';
import { declaredFragmentEntry, materialProgramSource } from '../record/standard-opaque-entry';
import type {
  AtmosphereShaderSources,
  DepthPyramidShaderSources,
  DrawOwnerOptions,
  FrameObservationDomain,
  FrameObservationRequest,
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
import { FXAA_POST_PROCESS_ID, STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from '../render-contract';
import {
  attachGpuPassTimingSession,
  createRenderSystem,
  type PipelineState,
  type RecoveryGraphCandidate,
  type RecoveryPostProcessResources,
  type RecoveryRootBundle,
  type RenderSystem,
} from '../render-system';
import { createGpuPassTimingObservationStore, observeGpuPassTimingDisabled } from '../renderer.js';
import { postSpawnResolveJoints } from '../scene-instances/post-spawn-resolve-joints';
import type { RenderTarget } from '../targets/contracts';
import { registerAnalyticFogPostProcess } from './analytic-fog-registration';
import type { RhiBackendPack } from './backend-contract';
import { inspectBarrelDistortion } from './barrel-distortion-inspection';
import type { BundlerOptions } from './bundler-contract';
import { rejectZeroCanvasSize } from './canvas-draw-guard';
import { captureMaterialDraws } from './draw-observation';
import { createRendererDynamicGeometryController } from './dynamic-geometry-host';
import { createExternalTextureHost } from './external-texture-host';
import { registerFxaaPostProcess } from './fxaa-registration';
import type { RendererAssemblyImplementation } from './host-contract';
import {
  type LodObservationCaptureValidity,
  lodObservationCaptureFailure,
} from './lod-observation';
import {
  findStandardPbrEntry,
  isEngineOwnedMaterialShader,
  resolveMaterialPipelineGroup2Contract,
  resolveMaterialPipelineShaderId,
  resolveMaterialPipelineVertexEntry,
  resolveRendererMaterialShaderArtifact,
} from './material/pipeline-helpers';
import {
  allowsUnlitPreparedFallback,
  invokeDeviceCreateShaderModule,
  type LayoutKind,
  makeShaderDeviceAdapter,
  normalizeMaterialShaderVariantSet,
  prepareLowLimitMaterialShaderEntry,
  prepareMaterialShaders,
  requiresPreparedMaterialShader,
  resolveCachedMaterialShaderVariant,
  resolveMaterialShaderBackendArtifactKey,
  resolveMaterialShaderVertexInputContract,
  type ShaderDeviceAdapterInternal,
  selectPipelineLayoutForVariant,
  viewAndSceneDepthLayoutEntries,
} from './material-shader-policy';
import { registerMotionBlurPostProcess } from './motion-blur-registration';
import {
  createRecoveryFailureLocation,
  type RecoveryFailureLocation,
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
  withBuiltinRenderFeatures,
} from './render-feature-post-processes';
import { createRenderTargetHost } from './render-target-host';
import {
  freezeRenderProfile,
  structuredRendererCause,
  validateRenderProfile,
} from './renderer-facade';
import { projectRendererFeatureInspection } from './renderer-feature-inspection';
import {
  type ContinuationTerminator,
  createContinuationTerminator,
  guardFrameCompletion,
  inspectFrameCompletionContinuations,
  observeFrameCompletionStages,
  type PendingFrameCompletion,
} from './renderer-frame-transaction';
import {
  ensureContextConfigured,
  rendererInitializationError,
  rendererInitializationPipelineError,
  wrapDisposeError,
} from './renderer-helpers';
import { projectRendererOutputInspectionFromSurface } from './renderer-inspection';
import {
  createRecoveryContinuation,
  createRecoveryDeadline,
  createSingleFlight,
  type RecoveryPhase,
} from './renderer-lifecycle';
import { derivedPhysicsFrameError, dynamicGeometryFrameError } from './webgpu-renderer-guards';

export type { RecoveryFailureLocation } from './recovery/failure-location';

import { ADMIT_EVERY_VARIANT } from './shader-prewarm-policy';
import { buildReadyWebGPU, prepareDevicePipelineLibrary } from './webgpu-ready';
import { DEPTH_TEXTURE_FORMAT, HDR_COLOR_ATTACHMENT_FORMAT } from './webgpu-ready-contract';
import {
  tryCreateWebGPURenderer as tryCreateWebGPURendererBootstrap,
  type WebGPURendererInternals,
} from './webgpu-renderer-bootstrap';
import type { WebGPUOutcome } from './webgpu-renderer-contract';
import {
  observeRendererReceipt,
  type RendererReceiptLodCaptureState,
} from './webgpu-renderer-observation';
import {
  createRendererObservationCaptureOwner,
  type ObservationCaptureRead,
} from './webgpu-renderer-observation-owner';
import {
  isPreparedMaterialVertexLayout,
  PREPARED_INSTANCE_VERTEX_ATTRS,
  PREPARED_MATERIAL_INSTANCE_VERTEX_ATTRS,
  particleMaterialInputVertexBuffers,
  resolveWebGPUVertexBufferLayouts,
} from './webgpu-vertex-layouts';

export type { BundlerOptions } from './bundler-contract';
export type {
  LayoutKind,
  MaterialShaderBindingContract,
  MaterialShaderVertexInputContract,
} from './material-shader-policy';
export {
  allowsUnlitPreparedFallback,
  isSharedMaterialUserRegionCompatible,
  normalizeMaterialShaderVariantSet,
  requiresPreparedMaterialShader,
  resolveMaterialShaderBackendArtifactKey,
  resolveMaterialShaderBindingContract,
  resolveMaterialShaderUvSetCount,
  resolveMaterialShaderVariantSet,
  resolveMaterialShaderVertexInputContract,
  selectNoColorPbrVariant,
  selectPipelineLayoutForVariant,
  stripCloudShadowBindingsForLowLimit,
} from './material-shader-policy';
export {
  createMeshSsboGrowController,
  deriveStorageBufferCeiling,
  INITIAL_MESH_SSBO_SLOT_COUNT,
  type MeshSsboBufferWrapper,
  type MeshSsboGrowController,
  type MeshSsboGrowControllerInit,
  type MeshSsboGrowDevice,
  type MeshSsboGrowErrorRegistry,
  type MeshSsboGrowResult,
  type MeshSsboState,
  requireMeshSsboBuffer,
} from './mesh-ssbo-grow';
export { exposeRenderer } from './renderer-facade';
export {
  selectGpuDrivenSceneIndexVariant,
  selectHdrpPbrPrewarmVariants,
  selectProbePrewarmVariants,
  selectSkinPrewarmVariants,
  selectStandardPbrTransmissionPrewarmVariants,
} from './shader-prewarm-policy';
export type { WebGPUOutcome, WebGPURendererInternals } from './webgpu-renderer-contract';
export { disposeObservationCaptureSet } from './webgpu-renderer-observation';

/** Bundler injection and the WebGPU renderer construction entry points. */
export async function tryCreateWebGPURenderer(
  canvas: RhiCanvasTarget,
  options: RendererOptions | undefined,
  pack: RhiBackendPack,
  bundler: BundlerOptions | undefined,
): Promise<WebGPUOutcome> {
  return tryCreateWebGPURendererBootstrap(canvas, options, pack, bundler, makeWebGPURenderer);
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
  let renderSystemForTargetPromotion: RenderSystem | undefined;
  let cameraViewsForTargetPromotion:
    | { readonly active: boolean; isCubeCapturePending(target: RenderTarget): boolean }
    | undefined;
  const featureHostResult = createRenderFeatureHost(
    withBuiltinRenderFeatures(internals.options?.features ?? []),
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
      if (result.ok && ui !== undefined) await ui.recover(internals.device);
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
    const isAcquisitionPhase = (phase: RecoveryPhase): boolean =>
      phase === 'acquire-adapter' || phase === 'acquire-device';
    const retryable =
      outcome === 'failed' && (failureLocation?.retryable ?? isAcquisitionPhase(failurePhase));
    const failure = createRecoveryFailedError({
      phase: failurePhase,
      oldGeneration: fromGeneration,
      candidateGeneration,
      attempt,
      elapsedMs: deadline.elapsed(Date.now()),
      retryable,
      guidance:
        outcome === 'disposed'
          ? 'rebuild-renderer'
          : (failureLocation?.guidance ?? (retryable ? 'retry' : 'repair-owner')),
      owner: outcome === 'disposed' ? 'renderer' : (failureLocation?.owner ?? 'renderer'),
      resourceKind:
        outcome === 'disposed' ? 'surface' : (failureLocation?.resourceKind ?? 'pipeline'),
      lastOutcome: outcome,
      rehydratedRoots: recoveryInspection.rehydratedRoots,
      staleLossEvents: recoveryStaleLossEvents,
      cause: outcome === 'disposed' ? result.error : (failureLocation?.cause ?? result.error),
      cleanupFailures: [],
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
  let activeShaderState: RendererShaderState = {
    device: internals.device,
    shaderInstance: null,
    sharedShaderModuleAdapter: null,
    sharedImmediateShaderModuleAdapter: null,
  };
  let candidateShaderState: RendererShaderState | undefined;
  const getShaderModuleAdapter = (): ShaderDeviceAdapterInternal => {
    const state = candidateShaderState ?? activeShaderState;
    if (state.sharedShaderModuleAdapter === null) {
      state.sharedShaderModuleAdapter = makeShaderDeviceAdapter(
        state.device,
        internals.errorRegistry,
        internals.pack.createShaderModule,
        internals.pack.createShaderModuleImmediate,
      );
    }
    return state.sharedShaderModuleAdapter;
  };
  // The loading and live volume owners share the exact factory identity;
  // the adapter is still selected at call time for recovery candidates.
  const renderShaderModuleFactory = {
    createShaderModule: (
      descriptor: Parameters<ShaderDeviceAdapterInternal['createShaderModule']>[0],
    ) => getShaderModuleAdapter().createShaderModule(descriptor),
  };
  const getImmediateShaderModuleAdapter = (): ShaderDeviceAdapterInternal => {
    const state = candidateShaderState ?? activeShaderState;
    if (state.sharedImmediateShaderModuleAdapter === null) {
      state.sharedImmediateShaderModuleAdapter = makeShaderDeviceAdapter(
        state.device,
        internals.errorRegistry,
        internals.pack.createShaderModule,
        internals.pack.createShaderModuleImmediate,
        'immediate',
      );
    }
    return state.sharedImmediateShaderModuleAdapter;
  };
  const prewarmFullscreenFeatureModules = async (
    feature: RenderFeature<unknown>,
  ): Promise<Result<void, RhiError>> => {
    for (const postProcess of feature.requiredFullscreenPostProcesses ?? []) {
      const label = postProcessShaderModuleLabel(postProcess.source);
      const shaderResult = internals.pack.createShaderModule
        ? await internals.pack.createShaderModule(internals.device, {
            code: postProcess.source,
            label,
          })
        : await invokeDeviceCreateShaderModule(internals.device, {
            code: postProcess.source,
            label,
          });
      if (!shaderResult.ok) {
        internals.errorRegistry.fire(shaderResult.error);
        return err(shaderResult.error);
      }
      getShaderModuleAdapter().seedModule(label, shaderResult.value);
    }
    return ok(undefined);
  };
  const getShader = (): ShaderCatalog => {
    const state = candidateShaderState ?? activeShaderState;
    if (state.shaderInstance === null) {
      const activeCatalog = activeShaderState.shaderInstance;
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
        state === candidateShaderState && activeCatalog !== null
          ? activeCatalog.forkForDevice(getShaderModuleAdapter())
          : new ShaderCatalog({
              device: getShaderModuleAdapter(),
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
  const assets = new AssetRegistry(
    shaderCatalog,
    internals.importTransport,
    [audioLoader],
    postSpawnResolveJoints,
  );
  // feat-20260601-device/gpu-residency-extraction M1: the GPU residency layer
  // lives in a standalone store; `assets` keeps the CPU POD registry only.
  let gpuStore = new GpuResidencyCache();
  let activeDeviceScope = DeviceScope.create(0, 'renderer');
  adoptBackendDevice(activeDeviceScope, internals.device, internals.pack.disposeDevice);
  // feat-20260623-world-space-video-asset M4 / w16 (D-3): transient per-frame
  // video texture store, fully independent of gpuStore (AC-08). Configured with
  // the device alongside gpuStore below; threaded into the record stage via the
  // RenderSystemRuntime so a `videoTextureFields` material field uploads its
  // frame here instead of entering the static ensureResident cache.
  let dynamicTextureStore = new DynamicTextureStore();
  const renderTargetHost = createRenderTargetHost({
    onError: (error) => internals.errorRegistry.fire(error),
    rendererId: Symbol('renderer'),
    getGeneration: () => renderTargetGeneration,
    getDevice: () => renderTargetDevice,
    canPromoteTarget: (target: RenderTarget) =>
      (cameraViewsForTargetPromotion?.active
        ? cameraViewsForTargetPromotion.isCubeCapturePending(target)
        : renderSystemForTargetPromotion?.isCubeCapturePending(target)) !== true,
  });
  const externalTextureHost = createExternalTextureHost({
    getDevice: () => internals.device,
    getGeneration: () => activeDeviceScope.generation,
    isDeviceLost: () => internals.healthRegistry.getLastSnapshot().reason === 'device-lost',
    getDynamicTextureStore: () => dynamicTextureStore,
    onError: (error) => internals.errorRegistry.fire(error),
  });
  const publicationReceiver =
    internals.options?.publicationSource === undefined
      ? undefined
      : new RenderPublicationReceiver(internals.options.publicationSource, renderTargetHost);
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
  const failedGpuPassTimingObservation = (error: GpuPassTimingReason): GpuPassTimingObservation => {
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
      gpuPassTimingOptions === undefined ? undefined : getImmediateShaderModuleAdapter(),
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
      : await createUiCompositor({
          source: internals.options.ui,
          device: internals.device,
          format: uiFormats.storage,
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
        });
  if (ui !== undefined) {
    const configured = configureSurface(
      internals.context,
      internals.device,
      uiFormats.storage,
      uiFormats.view,
      internals.outputColorSpace.requested,
    );
    if (!configured.ok) {
      ui.dispose();
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
  // feat-20260601-device/gpu-residency-extraction M1 (D-3 / D-8): device +
  // shader-module factory + cube-POD register relay are wired onto the store
  // together. feat-20260614 M8 (D-15 / D-17): `registerCube` is the wire-layer
  // closure `(world, pod) => world.allocSharedRef('EquirectAsset', pod)` --
  // the runtime-minted cube POD lands in the draw-time world's user-tier
  // SharedRefStore (the AssetRegistry owns no handles). feat-20260630 M2 / w11:
  // the retired cube-texture asset kind is gone; the relay mints an EquirectAsset
  // shared ref as the cubemap GPU residency's identity token.
  gpuStore.configureGpuDevice(
    internals.device,
    internals.pack.createShaderModule,
    (world, pod, source) => {
      // The accepted equirect identity already owns this renderer-local GPU projection.
      if ('resolveAsset' in world) return ok(source);
      const handle = world.allocSharedRef('EquirectAsset', pod);
      return ok(handle);
    },
    internals.device.caps,
  );
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
    internals.gpuPassTimingFrameIdentity = undefined;
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
  const materialShaderPipelineGroup2Contracts = new WeakMap<object, PipelineGroup2Contract>();
  // Variant keys include device capability axes; this manifest-identity cache
  // remains shared across the renderer's recovery candidates.
  const materialShaderVariantResolutionCache =
    activePipelineCacheState.materialShaderVariantResolutionCache;
  let candidatePipelineCacheState: RendererPipelineCacheState | undefined;
  let candidateMaterialShaderUvSetCounts: Map<string, number> | undefined;
  let emptyPostProcessBgl: BindGroupLayout | null = null;
  let candidateEmptyPostProcessBgl: BindGroupLayout | null | undefined;
  let candidateBuildState: RendererCandidateState | undefined;
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
    getOrBuildGroup0MaterialLayout,
    getOrBuildViewOnlyMaterialPipelineLayout,
    getOrBuildViewAndSceneDepthMaterialPipelineLayout,
    getOrBuildGroup0ResourceLayout,
    getOrBuildPreparedMaterialPipelineLayout,
    getOrBuildPerShaderMaterialLayout,
    getParamSchema,
    getMaterialBindGroupLayout,
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
    if (
      state.extendedLightingAvailable !== true ||
      state.iesProfileTexture === undefined ||
      state.cookieTexture === undefined ||
      state.cookieMatrixBuffer === undefined ||
      state.iesProfileTextureView === undefined ||
      state.cookieTextureView === undefined ||
      state.ltcLambertTextureView === undefined ||
      state.ltcGgxTextureView === undefined
    ) {
      return;
    }
    const candidate: ExtendedLightingResourceCandidate = {
      topology: EXTENDED_LIGHTING_TOPOLOGY,
      generation: scope.generation,
      scope,
      iesSliceCount: 0,
      cookieSliceCount: 0,
      cookieMatrices: 0,
      sampler: state.defaultSampler,
      iesTexture: state.iesProfileTexture,
      cookieTexture: state.cookieTexture,
      cookieMatrixBuffer: state.cookieMatrixBuffer,
      descriptorBytes:
        IES_SLICE_WIDTH * IES_SLICE_HEIGHT * 2 * 32 +
        COOKIE_SLICE_MIP_CHAIN_BYTES * 32 +
        COOKIE_MATRIX_BYTES,
      uploadCount: 5,
    };
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
    if (internals.options?.pipelineLibrary !== undefined)
      await prepareDevicePipelineLibrary(device, internals.options.pipelineLibrary, getShader());
    return buildReadyWebGPU(
      device,
      scope,
      getShader,
      residencyStore,
      internals.pack.createShaderModule,
      internals.pack.createShaderModuleImmediate,
      internals.errorRegistry,
      candidateBuildState === undefined
        ? requiredMaterialShaders
        : [
            ...new Set([...requiredMaterialShaders, ...getShader().materialShaderIdentifiers()]),
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
        if (candidateBuildState !== undefined) {
          candidateBuildState.growMeshSsbo = hook;
          candidateBuildState.meshSsboState = state;
        } else {
          internals.growMeshSsbo = hook;
          internals.meshSsboState = state;
        }
      },
      (label, module) => {
        getShaderModuleAdapter().seedModule(label, module);
        getImmediateShaderModuleAdapter().seedModule(label, module);
      },
      (key, pso, group2Contract) => {
        const pipelineCache = currentPipelineCacheState().materialShaderPipelineCache;
        if (!pipelineCache.has(key)) {
          pipelineCache.set(key, pso);
        }
        materialShaderPipelineGroup2Contracts.set(pso as object, group2Contract);
      },
      (source: string) => {
        if (candidateBuildState !== undefined || tonemapRegistered) return;
        renderSystem.registerBuiltinPostProcess(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, {
          source,
          params: {
            byteSize: TONEMAP_PARAMS_LAYOUT.byteSize,
            defaultValue: new Uint8Array(TONEMAP_PARAMS_LAYOUT.byteSize),
          },
          reads: ['hdrColor'],
        });
        tonemapRegistered = true;
      },
      (source: string) => {
        fxaaRegistered = registerFxaaPostProcess(renderSystem, source, fxaaRegistered);
      },
      (source: string) =>
        registerAnalyticFogPostProcess(renderSystem, source, candidateBuildState !== undefined),
      (entries: { readonly motionBlur?: string; readonly taaResolve?: string }) => {
        if (candidateBuildState !== undefined || temporalPostProcessesRegistered) return;
        if (entries.motionBlur !== undefined) {
          registerMotionBlurPostProcess(renderSystem, entries.motionBlur);
        }
        if (entries.taaResolve !== undefined) {
          renderSystem.registerBuiltinPostProcess('forgeax.taa-resolve', {
            source: entries.taaResolve,
            params: { byteSize: 16, defaultValue: new Uint8Array(16) },
            reads: ['scene-color', 'scene-temporal', 'taa-history-color', 'taa-history-temporal'],
          });
        }
        temporalPostProcessesRegistered = true;
      },
      (entries: { readonly singleSample?: string; readonly multisampled?: string }) => {
        if (candidateBuildState !== undefined || depthOfFieldRegistered) return;
        registerDepthOfFieldBuiltins(renderSystem, entries);
        depthOfFieldRegistered = true;
      },
      async (sources: VolumetricFogShaderSources) => {
        await prepareVolumePrograms(
          { device, deviceScope: scope, shaderModuleFactory: renderShaderModuleFactory },
          sources,
          HDR_COLOR_ATTACHMENT_FORMAT,
        );
        internals.volumetricFogShaders = sources;
      },
      (sources: SsrShaderSources, pyramid: DepthPyramidShaderSources) => {
        internals.ssrShaders = sources;
        internals.depthPyramidShaders = pyramid;
      },
      (sources: AtmosphereShaderSources) => {
        internals.atmosphereShaders = sources;
      },
      (sources) => {
        internals.standardDeferredShaders = sources;
      },
      candidateBuildState === undefined ? ADMIT_EVERY_VARIANT : drewWithModule,
    ).then(async (state) => {
      // draw() is synchronous. Complete the opt-in capability probe before
      // publishing readiness, including when rebuilding a lost device.
      await renderSystem.initializeSsr(device);
      return state;
    });
  };
  const ready: Promise<Result<void, RhiError>> = Promise.resolve()
    .then(async () => {
      await prepareMaterialShaders(internals.device, getShader, assets, materialShaderUvSetCounts);
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
        return ok(undefined);
      },
      (e: unknown): Result<void, RhiError> => {
        readySettled = true;
        if (e instanceof RhiError) return err(e);
        if (e instanceof PipelineSpecError) return err(rendererInitializationPipelineError(e));
        return err(rendererInitializationError(e));
      },
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
  ) => {
    const contractLayoutKind: LayoutKind =
      group2Contract === 'cluster'
        ? 'hdrp-pbr'
        : group2Contract === 'skin-cluster'
          ? 'hdrp-skin'
          : group2Contract === 'skin'
            ? 'pbr-skin'
            : 'pbr';
    const layoutKind = layoutKindOverride ?? contractLayoutKind;
    const gpuClustered =
      (layoutKind === 'gpu-driven-pbr' || layoutKind === 'gpu-driven-skin') &&
      (group2Contract === 'cluster' || group2Contract === 'skin-cluster');
    const usesSharedBootMaterialLayout =
      !gpuClustered &&
      materialShaderId !== undefined &&
      isEngineOwnedMaterialShader(materialShaderId);
    // Built-in layouts are assembled at boot; authored layouts must not bypass
    // the HDRP group(2) selector or bind the URP mesh BGL to a cluster PSO.
    const perShaderLayout =
      !usesSharedBootMaterialLayout && materialShaderId !== undefined
        ? getOrBuildPerShaderMaterialLayout(materialShaderId, undefined, layoutKind, gpuClustered)
        : null;
    // Authored shaders retain their own material schema and selected mesh
    // layout, including skin. Built-in IDs keep their boot-time layout.
    const bindingContract =
      materialShaderId === undefined
        ? 'render-material'
        : getMaterialShaderBindingContract(materialShaderId).bindings;
    const group0Layout = bindingContract === 'group-0' ? getOrBuildGroup0MaterialLayout() : null;
    const group0ResourceLayout =
      bindingContract === 'group-0-resource' && materialShaderId !== undefined
        ? getOrBuildGroup0ResourceLayout(materialShaderId)
        : null;
    const viewOnlyLayout =
      bindingContract === 'view-only' ? getOrBuildViewOnlyMaterialPipelineLayout() : null;
    const viewAndSceneDepthLayout =
      bindingContract === 'view-and-scene-depth'
        ? getOrBuildViewAndSceneDepthMaterialPipelineLayout()
        : null;
    const preparedMaterialLayout =
      (bindingContract === 'render-material' ||
        bindingContract === 'render-material-with-scene-depth' ||
        bindingContract === 'render-material-and-scene-depth') &&
      materialShaderId !== undefined &&
      isPreparedMaterialVertexLayout(vertexLayout)
        ? getOrBuildPreparedMaterialPipelineLayout(materialShaderId, group2Contract === 'cluster')
        : null;
    const materialShaderEntry =
      materialShaderId === undefined
        ? undefined
        : getShader().findMaterialArtifact(materialShaderId);
    const vertexInputContract = materialShaderEntry?.ok
      ? resolveMaterialShaderVertexInputContract(materialShaderEntry.value.program)
      : 'render-material';
    const currentState = currentPipelineState();
    const pipelineLayout =
      group0Layout !== null
        ? group0Layout.pipelineLayout
        : group0ResourceLayout !== null
          ? group0ResourceLayout.pipelineLayout
          : viewOnlyLayout !== null
            ? viewOnlyLayout
            : viewAndSceneDepthLayout !== null
              ? viewAndSceneDepthLayout
              : preparedMaterialLayout !== null
                ? preparedMaterialLayout
                : perShaderLayout !== null
                  ? perShaderLayout.pipelineLayout
                  : selectPipelineLayoutForVariant(currentState, variantSet, layoutKind);
    if (pipelineLayout === null) return null;
    const currentMaterialUvSetCounts = currentMaterialShaderUvSetCounts();
    const resolvedUvSetCount =
      materialShaderId === undefined
        ? undefined
        : (currentMaterialUvSetCounts.get(materialShaderId) ??
          (materialShaderEntry?.ok ? materialShaderEntry.value.program.uvSetCount : undefined));
    const vertexBuffers = resolveWebGPUVertexBufferLayouts({
      vertexInputContract,
      vertexLayout,
      vertexLayoutProjection,
      resolvedUvSetCount,
      layoutKind,
      meshAttributes,
      particleInputLanes,
    });
    return {
      device: currentBuildDevice(),
      shaderModuleFactory:
        shaderModuleMode === 'immediate' ||
        (internals.pack.createShaderModuleImmediate !== undefined &&
          isCanonicalStandardPbrMaterialShader(materialShaderId))
          ? getImmediateShaderModuleAdapter()
          : getShaderModuleAdapter(),
      pipelineLayout,
      vertexBuffers,
      ...(layoutKind === 'pbr-skin' ||
      layoutKind === 'gpu-driven-skin' ||
      layoutKind === 'gpu-driven-cluster-skin'
        ? { layoutKind }
        : {}),
    };
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
  const buildAndCachePipeline = (
    cacheKey: string,
    entry: MaterialShaderEntry,
    label: string,
    moduleLabel: string,
    isHdr: boolean,
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
    // bug-20260615 M2 / m2-1: sampleCount drives the multisample descriptor
    // field in buildPipelineForMaterialShader — it is a CAMERA fact (per-frame
    // antialias setting), not a material renderState value. Default 1 preserves
    // byte-identity of every existing pre-M2 cache slot + descriptor.
    sampleCount: number = 1,
    // Transparent split passes use the swap-chain storage view. Preserve its
    // explicit non-sRGB format in both the PSO key and descriptor; HDR and
    // depth-only passes select their own attachment formats.
    colorFormatOverride?: GPUTextureFormat,
    // Prepared graphics passes use `null` to request an explicit color-only
    // pipeline; omitted preserves the material forward depth default.
    depthFormatOverride?: GPUTextureFormat | null,
    vertexLayout?: string,
    vertexLayoutProjection?: VertexLayoutProjection,
    shaderModuleMode?: RenderFeatureShaderModuleMode,
    layoutKindOverride?: LayoutKind,
    vertexEntryPoint?: string,
    additionalColorFormats?: readonly GPUTextureFormat[],
    vertexEntry?: string,
    authoredFragmentEntry?: string,
    particleInputLanes?: number,
    coverageOnly = false,
    constants?: Readonly<Record<string, number>>,
    pipelinePreparation = false,
  ): RenderPipeline | null => {
    const declaredGroup2Contract = resolveMaterialPipelineGroup2Contract(
      getShader().materialProgram(entry.source).group2,
      layoutKindOverride,
    );
    const group2Contract =
      declaredGroup2Contract === 'mesh' &&
      (materialShaderId === 'forgeax::vfx-render.particles.mesh' ||
        materialShaderId === 'forgeax::vfx-render.particles.mesh-inputs') &&
      (variantSet === '' || variantSet?.includes('CLUSTER_FORWARD_AVAILABLE=true') === true)
        ? 'cluster'
        : declaredGroup2Contract;
    const resolvedVertexEntry = resolveMaterialPipelineVertexEntry(
      layoutKindOverride,
      vertexEntryPoint,
      vertexEntry,
    );
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
    );
    if (ctx === null) return null;
    const cache = currentPipelineCacheState();
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

    const currentState = currentPipelineState();
    if (currentState === null) return null;
    const ldrColorFormat = colorFormatOverride ?? currentState.colorAttachmentFormat;
    const fragmentEntry: string | undefined =
      authoredFragmentEntry ??
      (isHdr &&
      passKind === 'forward' &&
      (materialShaderId === 'forgeax::sprite' || materialShaderId === 'forgeax::sprite-lit')
        ? 'fs_main_hdr'
        : undefined);
    // Public view clipping is dynamic coverage even on opaque casters.
    // Preserve the producer's fragment stage so depth and color agree.
    const built =
      prepared?.lookup(cacheKey, entry.source, ctx.pipelineLayout) ??
      buildPipelineForMaterialShader(
        cacheKey,
        // The catalog entry is projected into the material-shader entry shape.
        entry,
        {
          ...ctx,
          createRenderPipeline:
            prepared === undefined
              ? undefined
              : (descriptor) => prepared.request(cacheKey, entry.source, descriptor),
          colorFormat: isHdr ? HDR_COLOR_ATTACHMENT_FORMAT : ldrColorFormat,
          colorFormats:
            additionalColorFormats === undefined
              ? undefined
              : [
                  renderState?.outputs?.[0]?.format ??
                    (isHdr ? HDR_COLOR_ATTACHMENT_FORMAT : ldrColorFormat),
                  ...additionalColorFormats,
                ],
          depthFormat:
            depthFormatOverride === null
              ? undefined
              : passKindPolicyTable[passKind]?.shape === 'depth-only'
                ? (depthFormatOverride ?? 'depth32float')
                : (depthFormatOverride ?? DEPTH_TEXTURE_FORMAT),
          coverageOnly,
          ...(constants === undefined ? {} : { constants }),
          label,
          // feat-20260604 w16-b: the shader-MODULE cache identity. Stable across
          // per variant. See PipelineBuilderContext.moduleLabel.
          moduleLabel,
        },
        renderState,
        // w8/w15: pack topology (+ stripIndexFormat) into the builder's geometry
        // param. Strip topologies bake stripIndexFormat into the immutable PSO
        // (WebGPU spec: only valid for line-strip / triangle-strip). The record
        // stage (w9 + w15) threads each mesh's topology + indexFormat here; when
        // the caller omits stripIndexFormat we fall back to 'uint32' (the engine
        // procedural index width: createBoxGeometry etc. emit Uint32 indices).
        topology !== undefined
          ? {
              topology,
              ...(isStripTopology(topology)
                ? { stripIndexFormat: stripIndexFormat ?? ('uint32' as const) }
                : {}),
            }
          : undefined,
        resolvedVertexEntry,
        fragmentEntry,
        undefined, // defines — none
        passKind,
        sampleCount,
      );
    if (!built.ok) {
      if (candidatePipelineErrorScope && prepared?.isPending(built) !== true) throw built.error;
      if (built.error.code !== 'rhi-not-available') {
        internals.errorRegistry.fire(built.error);
      }
      return null;
    }
    currentPipelineCacheState().materialShaderPipelineCache.set(cacheKey, built.value);
    materialShaderPipelineGroup2Contracts.set(built.value as object, group2Contract);
    return built.value;
  };
  let candidatePipelineErrorScope = false;
  const withPipelinePreparationErrors = (action: () => void): void => {
    const previous = candidatePipelineErrorScope;
    candidatePipelineErrorScope = true;
    try {
      action();
    } finally {
      candidatePipelineErrorScope = previous;
    }
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
    // `attachments.colorFormats`) and the actual PSO descriptor. Ignored
    // for `isHdr=true` (HDR sub-pass uses rgba16float) and
    // `passKind='shadow-caster'` (depth-only, no color attachment).
    colorFormatOverride?: GPUTextureFormat,
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
    fragmentEntry?: string,
    particleInputLanes?: number,
    constants?: Readonly<Record<string, number>>,
    pipelinePreparation = false,
  ): RenderPipeline | null => {
    const coverageOnly =
      passKind === 'temporal' && variantSet?.split('+').includes('COVERAGE_ONLY=true') === true;
    // WebGL2 is a downlevel backend even when the record stage asks for the
    // native-capability variant string. Resolve the variant axes at this
    // shared PSO seam so the shader source, BGL layout, and cache key agree on
    // the actual device capabilities. Without this, WebGL2 can build a
    // storage-buffer PSO around a uniform-buffer shader and only reject it at
    // queue submit as an invalid RenderPipeline.
    const currentState = currentPipelineState();
    const ldrColorFormat: GPUTextureFormat =
      colorFormatOverride ??
      (currentState !== null ? currentState.colorAttachmentFormat : 'bgra8unorm-srgb');
    // feat-20260629 M4: auto-fill shaderUvSetCount from naga reflection
    // (stored in materialShaderUvSetCounts during prepareMaterialShaders).
    const materialShaderIdForPass = resolveMaterialPipelineShaderId(materialShaderId, passKind);
    const pipelineShaderId = resolveMaterialShaderBackendArtifactKey(
      materialShaderIdForPass,
      internals.device.caps.backendKind,
      assets.getMaterialArtifact(materialShaderIdForPass),
    );
    const materialShaderEntry = getShader().findMaterialArtifact(pipelineShaderId);
    const materialShaderSource = materialProgramSource(materialShaderEntry);
    // Programs that predate fs_opaque keep their default forward entry.
    fragmentEntry = declaredFragmentEntry(fragmentEntry, materialShaderSource);
    const currentMaterialUvSetCounts = currentMaterialShaderUvSetCounts();
    const materialUvSetCount =
      currentMaterialUvSetCounts.get(pipelineShaderId) ??
      (materialShaderEntry.ok ? materialShaderEntry.value.program.uvSetCount : undefined);
    if (materialUvSetCount !== undefined) {
      currentMaterialUvSetCounts.set(pipelineShaderId, materialUvSetCount);
    }
    const resolvedUvSetCount = shaderUvSetCount ?? materialUvSetCount;
    const manifestEntry = getShader().materialShaderManifestEntry(pipelineShaderId);
    // Sprite's omitted request is the boot-selected default artifact. The
    // explicit empty key remains the PER_INSTANCE_REGION=true request used by
    // SpriteInstances, so only that path is capability-rewritten here.
    const resolvedVariantSet =
      variantSet === undefined &&
      (pipelineShaderId === 'forgeax::sprite' || pipelineShaderId === 'forgeax::sprite-lit')
        ? undefined
        : resolveCachedMaterialShaderVariantSet(variantSet, manifestEntry);
    // The record stage composes capability axes; plain custom shaders retain
    // only manifest-declared axes so '' cannot select an HDRP mesh layout.
    // Builtin forgeax:: shaders keep the compatibility request
    // when a reduced test/legacy manifest omits variant metadata.
    // A single-source manifest entry must stay on its canonical module key;
    // otherwise a synthesized capability axis races the prewarmed module.
    let effectiveVariantSet = normalizeMaterialShaderVariantSet(resolvedVariantSet, manifestEntry);
    // A published artifact is already backend-specific; no manifest means no synthesized key.
    if (manifestEntry === undefined) effectiveVariantSet = undefined;
    if (
      vertexLayoutProjection === undefined &&
      manifestEntry?.variants.some((variant) => 'VERTEX_COLOR_AVAILABLE' in variant.defines)
    ) {
      if (effectiveVariantSet === '') {
        const noColorVariant = manifestEntry.variants.find(
          (variant) =>
            variant.defines.VERTEX_COLOR_AVAILABLE === false &&
            Object.entries(variant.defines).every(
              ([axis, value]) => axis === 'VERTEX_COLOR_AVAILABLE' || value === true,
            ),
        );
        effectiveVariantSet = noColorVariant?.definesKey ?? 'VERTEX_COLOR_AVAILABLE=false';
      } else {
        effectiveVariantSet = effectiveVariantSet?.replace(
          'VERTEX_COLOR_AVAILABLE=true',
          'VERTEX_COLOR_AVAILABLE=false',
        );
      }
    }
    if (
      manifestEntry !== undefined &&
      !pipelineShaderId.startsWith('forgeax::') &&
      effectiveVariantSet !== undefined &&
      effectiveVariantSet !== ''
    ) {
      const declaredAxes = new Set<string>();
      for (const variant of manifestEntry.variants) {
        for (const axis of Object.keys(variant.defines)) declaredAxes.add(axis);
      }
      const filteredVariantParts = effectiveVariantSet
        .split('+')
        .filter((part) => declaredAxes.has(part.slice(0, part.indexOf('='))))
        .sort();
      effectiveVariantSet =
        filteredVariantParts.length === 0 ? undefined : filteredVariantParts.join('+');
    }
    const colorFormat: GPUTextureFormat =
      renderState?.outputs?.[0]?.format ?? (isHdr ? 'rgba16float' : ldrColorFormat);
    additionalColorFormats ??= renderState?.outputs?.slice(1).map((output) => output.format);
    const isDepthOnlyPass = passKindPolicyTable[passKind]?.shape === 'depth-only';
    const resolvedVertexEntry = vertexEntry ?? vertexEntryPoint;
    const inputVertexBuffers = particleMaterialInputVertexBuffers(vertexLayout, particleInputLanes);
    const spec: PipelineSpec = {
      shader: {
        id: pipelineShaderId,
        passKind,
        variantSet: effectiveVariantSet,
        ...(resolvedVertexEntry === undefined ? {} : { vertexEntry: resolvedVertexEntry }),
        ...(fragmentEntry === undefined ? {} : { fragmentEntry }),
        ...(constants === undefined ? {} : { constants }),
      },
      attachments: {
        colorFormats:
          additionalColorFormats === undefined
            ? colorFormatsForPassKind(passKind, colorFormat)
            : [colorFormat, ...additionalColorFormats],
        depthFormat: isDepthOnlyPass
          ? (depthFormatOverride ?? 'depth32float')
          : depthFormatOverride === null
            ? undefined
            : (depthFormatOverride ?? 'depth32float-stencil8'),
        sampleCount: (sampleCount === 4 ? 4 : 1) as 1 | 4,
      },
      geometry: {
        topology: topology ?? 'triangle-list',
        stripIndexFormat: indexFormat,
        vertexLayout:
          meshAttributes ??
          (vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.positionSizeColorInstance
            ? PREPARED_INSTANCE_VERTEX_ATTRS
            : isPreparedMaterialVertexLayout(vertexLayout)
              ? PREPARED_MATERIAL_INSTANCE_VERTEX_ATTRS
              : DEFAULT_VERTEX_ATTRIBUTE_MAP),
        // Thread the shader-declared count whenever it is greater than one.
        // Built-in PBR reserves all eight supported UV inputs; single-UV meshes
        // remain byte-stable because missing sets are clamp-to-last aliases.
        ...(resolvedUvSetCount !== undefined && resolvedUvSetCount > 1
          ? { shaderUvSetCount: resolvedUvSetCount }
          : {}),
        ...(vertexLayoutProjection === undefined ? {} : { vertexLayoutProjection }),
        ...(inputVertexBuffers === undefined ? {} : { vertexBuffers: inputVertexBuffers }),
      },
      renderState,
    };
    const cacheKey = `${cacheKeyOf(spec)}|vertex:${resolvedVertexEntry ?? 'vs_main'}`;
    const requestCounter = pipelineRequests.get(currentPipelineCacheState());
    if (requestCounter !== undefined) requestCounter.keyCharacters += cacheKey.length;
    const cached = currentPipelineCacheState().materialShaderPipelineCache.get(cacheKey);
    const prepare =
      currentBuildDevice().createRenderPipelineAsync !== undefined &&
      (pipelinePreparation ||
        preparedPipelineOwners.get(currentPipelineCacheState())?.has(cacheKey) === true);
    if (cached !== undefined && !prepare) return cached;
    if (pipelineState === null) return null;
    const lookup = getShader().findMaterialArtifact(pipelineShaderId);
    if (!lookup.ok) {
      if (requiresPreparedMaterialShader(vertexLayout)) {
        // Only a registered shader can be warming up. Preserve a permanent
        // lookup failure instead of turning it into an endless pending PSO.
        throw lookup.error;
      }
      // bug-20260527-renderstate-pipeline-dispatch-gap D-3:
      // fallback path parity -- when renderState is defined and the
      // shader id is not registered, build a renderState-variant of
      // the standard pipeline from the engine-shipped PBR entry.
      if (
        renderState === undefined &&
        !allowsUnlitPreparedFallback(depthFormatOverride, vertexLayout, pipelineShaderId)
      ) {
        // A prepared feature declares the vertex layout it owns. Falling back
        // to default-unlit here would pair that data with the unlit shader's
        // position/normal/uv/tangent inputs and let WebGPU reject the
        // pipeline at validation time. Keep the missing shader retryable and
        // preserve the declared input contract instead.
        return null;
      }
      if (renderState === undefined) {
        const unlitLookup = getShader().findMaterialArtifact('forgeax::default-unlit');
        if (!unlitLookup.ok) return null;
        return buildAndCachePipeline(
          cacheKey,
          unlitLookup.value,
          `pbr-pipeline-prepared-${pipelineShaderId}`,
          // Reuse the eagerly compiled engine unlit module. The adapter cache
          // is seeded under this label during renderer readiness; a new label
          // would keep color-only prepared passes in perpetual warm-up.
          'unlit',
          isHdr,
          undefined,
          topology,
          indexFormat,
          effectiveVariantSet,
          passKind,
          'forgeax::default-unlit',
          meshAttributes,
          sampleCount,
          colorFormatOverride,
          depthFormatOverride,
          vertexLayout,
          vertexLayoutProjection,
          shaderModuleMode,
          layoutKindOverride,
          vertexEntryPoint,
          additionalColorFormats,
          undefined,
          undefined,
          undefined,
          coverageOnly,
          constants,
          prepare,
        );
      }
      const pbrEntry = findStandardPbrEntry(getShader(), currentBuildDevice(), effectiveVariantSet);
      if (pbrEntry === undefined) return null;
      // Reuse readiness only for byte-identical WGSL. A fallback can select a
      // different capability variant, so one shared fallback label is unsafe.
      const preparedVariant = [...getShader().materialShaderManifestEntries()]
        .find((entry) => entry.identifier === 'forgeax::default-standard-pbr')
        ?.variants.find((variant) => materialShaderSourceEquals(variant, pbrEntry.wgsl));
      const fallbackModuleLabel =
        preparedVariant === undefined
          ? `module-fallback-pbr#${getShader().materialProgram(pbrEntry.wgsl).identity}`
          : `module-forgeax::default-standard-pbr#${preparedVariant.definesKey}`;
      return buildAndCachePipeline(
        cacheKey,
        { source: pbrEntry.wgsl, paramSchema: [] },
        `pbr-pipeline-fallback-${pipelineShaderId}${isHdr ? '-hdr' : ''}`,
        fallbackModuleLabel,
        isHdr,
        renderState,
        topology,
        indexFormat,
        // M4.5 / w37 (D-10): the fallback path also threads variantSet so the
        // layout selector picks HDRP layout when an HDRP caller falls into
        // this branch (registered shader id missing).
        effectiveVariantSet,
        // feat-20260609 / T-002: passKind threaded through the fallback path
        // for parity with the main path; default 'forward' keeps every prior
        // fallback caller byte-identical.
        passKind,
        // bug-20260611-skin-pipeline-layout: passing materialShaderId here is
        // intentional even on the fallback (registered-id-missing) branch --
        // a missing skin shader registration should not silently pick the
        // wrong BGL chain. With LayoutKind='pbr-skin' the selector returns
        // null when pbrSkinPipelineLayout is null (charter P3 explicit fail).
        //
        // MaterialAsset per-slot texCoord: this branch always compiles the
        // selected built-in PBR source (`pbrEntry.wgsl`), whose
        // vertex stage declares all eight UV inputs. The vertex-buffer layout
        // therefore has to be the PBR layout with all declared slots present,
        // not the caller shader's -- e.g. a transparent sprite / sprite-lit
        // material lands here with meshAttributes carrying only uv0, so the
        // sprite id would resolve a 48-byte 4-attribute layout and the PBR
        // module would reject a missing UV slot. Pass the built-in PBR id for
        // layout resolution so buildPipelineContext derives the layout that
        // matches the compiled module. Skin keeps its
        // own id so the pbr-skin fail-fast (null layout) is preserved.
        pipelineShaderId === SKIN_MATERIAL_SHADER_ID
          ? pipelineShaderId
          : 'forgeax::default-standard-pbr',
        // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
        // forward meshAttributes through the fallback path so the pbr-skin
        // layout chain reads from the deriveVertexBufferLayout SSOT here too.
        meshAttributes,
        sampleCount,
        colorFormatOverride,
        depthFormatOverride,
        vertexLayout,
        vertexLayoutProjection,
        shaderModuleMode,
        layoutKindOverride,
        vertexEntryPoint,
        additionalColorFormats,
        undefined,
        undefined,
        undefined,
        coverageOnly,
        constants,
        prepare,
      );
    }
    // feat-20260609 M4 / w31: resolve variant WGSL from manifest when
    // variantSet is non-empty. The boot-time registered shader (from
    // `installMaterialArtifact` at line ~2473) carries the default (all-true)
    // variant's WGSL. For URP callers that want a different variant
    // (e.g. STORAGE_BUFFER_AVAILABLE=true without CLUSTER_FORWARD_AVAILABLE),
    // we look up the manifest entry, find the matching variant, and
    // substitute its composedWgsl into the PSO build path. The pipeline
    // layout itself is built by buildPbrPipelineLayouts (M3 / w12).
    // When variantSet is empty/undefined, the boot-time registered entry
    // (which is the all-true default) is used verbatim — backward compat.
    let shaderEntry = lookup.value;
    // M4.5 / w38 (D-11): `variantSet === ''` is canonical all-true (HDRP
    // path) and MUST hit the manifest variant lookup -- treat it as a
    // first-class variant request, not a falsy "no variant" signal.
    // Use `!== undefined` so the empty-string case enters the lookup.
    if (effectiveVariantSet !== undefined) {
      const registry = getShader();
      for (const msEntry of registry.materialShaderManifestEntries()) {
        if (msEntry.identifier === pipelineShaderId) {
          const variant = findVariantByKey(msEntry, effectiveVariantSet);
          if (variant) {
            // M3 / w12-w13: variant substitution carries the same source +
            // paramSchema as the boot-registered entry; the binding layout
            // is no longer carried on MaterialShaderEntry (deleted in
            // w13) — buildPbrPipelineLayouts is the BGL SSOT and reads
            // derive(paramSchema).bglEntries on demand.
            shaderEntry = {
              source: variant.composedWgsl,
              program: registry.materialProgram(variant.composedWgsl),
              paramSchema: lookup.value.paramSchema,
              paramSchemaProjection: lookup.value.paramSchemaProjection,
            };
          }
          break;
        }
      }
    }
    shaderEntry = prepareLowLimitMaterialShaderEntry(
      shaderEntry,
      currentBuildDevice().limits.maxSampledTexturesPerShaderStage,
    );
    shaderEntry = { ...shaderEntry, program: getShader().materialProgram(shaderEntry.source) };
    // feat-20260609 M4 / R3-fixup: append `-${passKind}` to the PSO label so
    // GPU debug captures (and the shadow-caster branch in the builder)
    // make the cache variant visible. The fallback path above keeps the
    // pre-existing fallback-* label shape (no shadow-caster fallback
    // exists today; the only shadow caller registers shadowCaster directly).
    const passKindLabelSegment = passKind === 'forward' ? '' : `-${passKind}`;
    return buildAndCachePipeline(
      cacheKey,
      shaderEntry,
      `pbr-pipeline-${pipelineShaderId}${isHdr ? '-hdr' : ''}${passKindLabelSegment}`,
      // feat-20260609 M4 / w31: when variantSet is non-empty, the module identity
      // includes the variant key so URP (STORAGE_BUFFER_AVAILABLE=true) and HDRP
      // (CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true) variants
      // compile as separate shader modules (they have different WGSL sources).
      // When variantSet is empty/undefined, the module identity stays pre-M4
      // backward-compatible for all PSOs of the default variant.
      // M4.5 / w38 (D-11): same `!== undefined` discipline as the cache
      // key -- `''` (canonical all-true) gets its own module-label slot,
      // distinct from the no-variant path. Trailing `#` for the empty
      // case is intentional (parallel to the cache key's `:variant:`
      // empty-tail segment); module identity stays a function of the
      // exact variantSet string.
      effectiveVariantSet !== undefined
        ? `module-${pipelineShaderId}#${effectiveVariantSet}`
        : `module-${pipelineShaderId}`,
      isHdr,
      renderState,
      topology,
      indexFormat,
      // M4.5 / w37 (D-10): main path threads variantSet so HDRP-variant PSO
      // builds against `hdrpPbrPipelineLayout` (7-slot group(2) BGL) and URP
      // builds against `pbrPipelineLayout` (1-slot group(2) BGL).
      effectiveVariantSet,
      // feat-20260609 / T-002: passKind selects createRenderPipeline
      // attachment shape (forward color+DS vs shadow-caster depth32float
      // no-color). Orthogonal to variantSet (which selects the BGL chain).
      passKind,
      // bug-20260611-skin-pipeline-layout: thread the registered materialShaderId
      // so buildPipelineContext can resolve LayoutKind='pbr-skin' for the skin
      // shader (2-entry mesh-array BGL).
      pipelineShaderId,
      // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
      // forward meshAttributes so the pbr-skin path's vertex buffer layout
      // is derived via the SSOT (deriveVertexBufferLayout). For URP/HDRP
      // callers (and for a caller passing undefined) the synthetic 6-key
      // sentinel inside buildPipelineContext keeps the layout deterministic.
      meshAttributes,
      sampleCount,
      colorFormatOverride,
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
      coverageOnly,
      constants,
      prepare,
    );
  };
  const pipelineRequests = new WeakMap<
    RendererPipelineCacheState,
    MaterialPipelineRequestCache<RenderPipeline>
  >();
  const getMaterialShaderPipeline = (
    ...args: Parameters<typeof buildMaterialShaderPipeline>
  ): RenderPipeline | null => {
    const registry = getShader();
    const shaderId = resolveMaterialPipelineShaderId(args[0], args[6] ?? 'forward');
    const asset = assets.getMaterialArtifact(shaderId);
    const artifactId = resolveMaterialShaderBackendArtifactKey(
      shaderId,
      internals.device.caps.backendKind,
      asset,
    );
    const artifact = registry.findMaterialArtifact(artifactId);
    // Missing artifacts and pending pipelines remain retryable.
    if (!artifact.ok) return buildMaterialShaderPipeline(...args);
    const owner = currentPipelineCacheState();
    let requests = pipelineRequests.get(owner);
    if (requests === undefined) {
      requests = new MaterialPipelineRequestCache(512, 6);
      pipelineRequests.set(owner, requests);
    }
    const facts = materialPipelineRequestFacts(args);
    facts.push(args[22] === true);
    facts.push(
      currentMaterialShaderUvSetCounts().get(artifactId),
      registry,
      artifact.value,
      registry.materialShaderManifestEntry(artifactId),
      asset,
      currentPipelineState(),
      currentBuildDevice(),
    );
    const cached = requests.get(facts);
    if (cached !== undefined) return cached;
    const pipeline = buildMaterialShaderPipeline(...args);
    if (pipeline !== null) requests.set(facts, pipeline);
    return pipeline;
  };
  let activeProfile = freezeRenderProfile(
    internals.options?.standardProfile ?? DEFAULT_STANDARD_PROFILE,
  );
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
    );
  const getMaterialShaderPipelineEntry = (
    ...args: Parameters<typeof getMaterialShaderPipeline>
  ) => {
    const pipeline = getMaterialShaderPipeline(...args);
    if (pipeline === null) return null;
    const materialShaderId = args[0];
    const variantSet = args[5];
    const passKind = args[6] ?? 'forward';
    const vertexLayoutProjection = args[13];
    const layoutKind = args[15];
    const sceneIndexAddress =
      layoutKind === 'gpu-driven-pbr' ||
      layoutKind === 'gpu-driven-skin' ||
      layoutKind === 'gpu-driven-cluster-pbr' ||
      layoutKind === 'gpu-driven-cluster-skin';
    const artifact = getMaterialShaderArtifact(materialShaderId, {
      ...(vertexLayoutProjection === undefined
        ? {}
        : {
            vertexColorAvailable: vertexLayoutProjection.attributes.some(
              (attribute) => attribute.key === 'color',
            ),
          }),
      ...(layoutKind === 'pbr-skin' ||
      layoutKind === 'gpu-driven-skin' ||
      layoutKind === 'gpu-driven-cluster-skin'
        ? { deformation: 'skin' as const }
        : {}),
      ...(variantSet === undefined ? {} : { variantSet }),
      address: sceneIndexAddress ? 'scene-index' : 'direct',
      pass: passKind === 'shadow-caster' ? 'shadow' : 'forward',
    });
    return {
      pipeline,
      group2Contract:
        materialShaderPipelineGroup2Contracts.get(pipeline as object) ?? ('mesh' as const),
      ...(artifact?.receipt === undefined
        ? {}
        : {
            receipt: {
              identity: artifact.receipt.receiptIdentity,
              generation: artifact.receipt.generation,
            },
          }),
    };
  };
  const prepareMaterialShaderPipeline = (
    ...args: Parameters<NonNullable<RenderSystemInternals['getMaterialShaderPipeline']>>
  ) => {
    const request: Parameters<typeof buildMaterialShaderPipeline> = [...args];
    request[22] = true;
    return getMaterialShaderPipeline(...request);
  };
  const prepareMaterialShaderPipelineEntry = (
    ...args: Parameters<NonNullable<RenderSystemInternals['getMaterialShaderPipelineEntry']>>
  ) => {
    const request: Parameters<typeof buildMaterialShaderPipeline> = [...args];
    request[22] = true;
    return getMaterialShaderPipelineEntry(...request);
  };
  // Post-process modules share the async shader adapter: pending compilation
  // returns null; subsequent frames consume the cached pipeline. Group 0 is
  // reserved for View, group 1 holds inputs; vs_main/fs_main draw a fullscreen
  // triangle into the requested color formats.
  const buildPostProcessPipeline = (
    entry: PostProcessShaderEntry,
    bgl: BindGroupLayout,
    colorFormats: readonly GPUTextureFormat[],
    label: string,
  ): RenderPipeline | null => {
    const isFxaaPipeline = label.startsWith(`post-process-${FXAA_POST_PROCESS_ID}-pso-`);
    const moduleFactory = getShaderModuleAdapter();
    const moduleResult = moduleFactory.createShaderModule({
      code: entry.source,
      label: postProcessShaderModuleLabel(entry.source),
    });
    if (!moduleResult.ok) {
      // 'rhi-not-available' = async compile in flight: caller falls back one frame.
      // Other codes are real failures: surface through the error registry so AI
      // users see a structured RhiError instead of a silent black screen (charter P3).
      if (moduleResult.error.code !== 'rhi-not-available') {
        internals.errorRegistry.fire(moduleResult.error);
      }
      return null;
    }
    if (!isFxaaPipeline && entry.usesView !== true && currentEmptyPostProcessBgl() === null) {
      const bglRes = currentBuildDevice().createBindGroupLayout({ entries: [] });
      if (!bglRes.ok) {
        internals.errorRegistry.fire(bglRes.error);
        return null;
      }
      if (candidateBuildState !== undefined) {
        candidateBuildState.emptyPostProcessBgl = bglRes.value;
        candidateEmptyPostProcessBgl = bglRes.value;
      } else {
        emptyPostProcessBgl = bglRes.value;
      }
    }
    const viewLayout =
      entry.usesView === true ? currentPipelineState()?.viewBindGroupLayout : undefined;
    const group0Layout = viewLayout ?? currentEmptyPostProcessBgl();
    if (group0Layout === null || group0Layout === undefined) {
      internals.errorRegistry.fire(
        new Error('fullscreen post-process View layout is unavailable') as never,
      );
      return null;
    }
    const layoutRes = currentBuildDevice().createPipelineLayout({
      label: `${label}-layout`,
      bindGroupLayouts: isFxaaPipeline ? [bgl] : [group0Layout as BindGroupLayout, bgl],
    });
    if (!layoutRes.ok) {
      internals.errorRegistry.fire(layoutRes.error);
      return null;
    }
    const pipelineRes = currentBuildDevice().createRenderPipeline({
      label,
      layout: layoutRes.value,
      vertex: {
        module: moduleResult.value,
        entryPoint: 'vs_main',
        buffers: [],
      },
      fragment: {
        module: moduleResult.value,
        // The typed graph reuses the composed tonemap module for separate
        // linear-LDR and final-encoding passes.  Preserve the selected entry
        // point; forcing fs_main encodes the linear-LDR intermediate a second
        // time and breaks the Three.js stage contract.
        entryPoint: entry.fragmentEntryPoint ?? 'fs_main',
        targets: colorFormats.map((format) => ({ format })),
      },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: undefined,
      multisample: undefined,
    });
    if (!pipelineRes.ok) {
      internals.errorRegistry.fire(pipelineRes.error);
      return null;
    }
    return pipelineRes.value;
  };
  const renderInternals: RenderSystemInternals = {
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
    get standardProfile() {
      return activeProfile;
    },
    standardPipeline: internals.options?.pipeline ?? standardPipeline,
    get featureHost() {
      return internals.featureHost;
    },
    setFeatureHost: (host) => {
      internals.featureHost = host;
    },
    // Resolve the adapter at call time so recovered devices get fresh modules.
    shaderModuleFactory: renderShaderModuleFactory,
    immediateShaderModuleFactory: {
      createShaderModule: (descriptor) =>
        getImmediateShaderModuleAdapter().createShaderModule(descriptor),
    },
    profiler: internals.options?.profiler,
    // Keep device/context getters live so recovery swaps are observed by the
    // record stage without reconstructing the RenderSystem.
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
    ...(internals.pack.instrumentation?.resolveSurfaceDevice === undefined
      ? {}
      : { resolveSurfaceDevice: internals.pack.instrumentation.resolveSurfaceDevice }),
    outputColorSpace: internals.outputColorSpace,
    // The graph records receipt-bound color observations through the same
    // renderer-owned capture bridge consumed after queue submission. Keep the
    // identity and demand live on internals so recovery and per-frame graph
    // rebuilds observe the current device without reconstructing RenderSystem.
    get deviceGeneration() {
      return activeDeviceScope.generation;
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
          (entry) => postProcessShaderModuleLabel(entry.source) === label,
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
    // is no longer threaded through createRenderSystem; the record stage
    // reads `camera.clearColor` straight from the Camera SoA column
    // (array<f32,4>, feat-20260709 M3).
    getPipelineState: () => pipelineState,
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
    withPipelinePreparationErrors,
    getMaterialShaderBindingContract: getMaterialShaderBindingContract,
    getFeatureShaderSource: (identifier) =>
      resolveFeatureShaderSource(getShader(), internals.device, identifier),
    getMaterialShaderArtifact,
    getParamSchema,
    getMaterialBindGroupLayout,
    metrics,
    // createRenderSystem wraps this in a per-RenderSystem cache + the public
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
    get gpuPassTimingSubmittedWork() {
      return internals.gpuPassTimingSubmittedWork;
    },
    set gpuPassTimingSubmittedWork(completion: Promise<void> | undefined) {
      internals.gpuPassTimingSubmittedWork = completion;
    },
    get gpuPassTimingFrameIdentity() {
      return (
        internals as WebGPURendererInternals & {
          gpuPassTimingFrameIdentity?:
            | import('../record/gpu-pass-timing/session.js').GpuPassTimingFrameIdentity
            | undefined;
        }
      ).gpuPassTimingFrameIdentity;
    },
    set gpuPassTimingFrameIdentity(identity:
      | import('../record/gpu-pass-timing/session.js').GpuPassTimingFrameIdentity
      | undefined,) {
      (
        internals as WebGPURendererInternals & {
          gpuPassTimingFrameIdentity?:
            | import('../record/gpu-pass-timing/session.js').GpuPassTimingFrameIdentity
            | undefined;
        }
      ).gpuPassTimingFrameIdentity = identity;
    },
    get gpuPassTimingBeginReason() {
      return (
        internals as WebGPURendererInternals & {
          gpuPassTimingBeginReason?: GpuPassTimingReason | undefined;
        }
      ).gpuPassTimingBeginReason;
    },
    set gpuPassTimingBeginReason(reason: GpuPassTimingReason | undefined) {
      (
        internals as WebGPURendererInternals & {
          gpuPassTimingBeginReason?: GpuPassTimingReason | undefined;
        }
      ).gpuPassTimingBeginReason = reason;
    },
    getRenderTargetPhysical: (target) => renderTargetHost.getPhysicalTarget(target),
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
    get standardDeferredShaders() {
      return internals.standardDeferredShaders;
    },
    get atmosphereShaders() {
      return internals.atmosphereShaders;
    },
  };
  const renderSystem: RenderSystem = createRenderSystem(renderInternals);
  let uiOnlyFrame = false;
  if (ui !== undefined) {
    Object.defineProperty(renderInternals, 'presentationOutput', {
      configurable: true,
      enumerable: true,
      get: () => ui.output,
    });
    renderInternals.deferFinalDisplayObservation = true;
    renderInternals.encodePresentation = (encoder) => {
      const output = internals.context.getCurrentTexture();
      if (!output.ok) throw output.error;
      ui.encode(encoder, output.value);
      renderInternals.framePassNames?.push('screen-ui-composite');
      if (ui.output !== undefined) renderInternals.framePassNames?.push('screen-ui-present');
      encodeFrameObservationCapture(
        {
          device: internals.device,
          deviceGeneration: activeDeviceScope.generation,
          outputColorSpace: internals.outputColorSpace,
          observationCaptureOwner: renderInternals.observationCaptureOwner,
          observationCaptureDomains: internals.observationCaptureDomains,
          observationFrameId: internals.observationFrameId,
          observationGraphGeneration: internals.observationGraphGeneration,
        },
        encoder,
        {
          texture: ui.output ?? output.value,
          format: uiFormats.storage,
          domain: 'final-display',
          width: internals.canvas.width,
          height: internals.canvas.height,
          frameNumber: internals.observationFrameId ?? 0,
          graphGeneration: ui.generation,
        },
      );
      internals.observationGraphGeneration = ui.generation;
    };
  }
  const cameraViews = createCameraViews(renderInternals, renderSystem);
  internals.lossObserver.current = (detail) => {
    renderInternals.submittedPassNames = [];
    for (const continuation of frameContinuations.keys())
      continuation.terminate({ code: 'device-lost', detail });
  };
  cameraViewsForTargetPromotion = cameraViews;
  attachGpuPassTimingSession(internals, gpuPassTimingSession);
  renderSystemForTargetPromotion = renderSystem;
  registerSingleLayerMediumBuiltins(renderSystem);
  // The Standard pipeline is the sole built-in graph owner. Feature plans are
  // projected into that graph directly; no second post-process registry is
  // installed for fullscreen producers.
  renderSystem.configureStandard(undefined);
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
  });
  const {
    observationCaptureOwner,
    stats: observationStats,
    receiptObservationCaptures,
    receiptObservationBuffers,
    disposeObservationCaptures,
    disposeOwnedObservationCaptures,
    readObservationCapture,
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
    isLeaseAttached: (lease) => {
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
  function* prepareDraw(
    worldsOrRequest: readonly World[] | RenderFrameInput | PublishedRenderFrameInput,
    options?: DrawOwnerOptions,
    isCurrent?: () => boolean,
  ): FramePreparation<Result<void | FrameReceipt, RhiError | RenderError>> {
    const isFrameRequest = !Array.isArray(worldsOrRequest);
    const publicationRequest =
      isFrameRequest && 'publication' in worldsOrRequest
        ? (worldsOrRequest as PublishedRenderFrameInput)
        : undefined;
    const frameRequest =
      isFrameRequest && publicationRequest === undefined
        ? (worldsOrRequest as RenderFrameInput)
        : undefined;
    const sceneAbsent = frameRequest?.camera === null;
    if (
      sceneAbsent &&
      (frameRequest.leases.length !== 0 || frameRequest.environment !== null || ui === undefined)
    ) {
      return err(
        new RendererOperationError('frame-input-invalid', {
          operation: 'draw',
          cause: new RendererContractFailureError(
            'draw',
            'a scene-free frame requires empty leases, null camera/environment and configured screen UI',
          ),
        }),
      );
    }
    let publication: PreparedRenderPublication | undefined;
    if (publicationRequest !== undefined) {
      if (publicationReceiver === undefined)
        return err(
          new RenderPublicationError({
            reason: 'identity',
            subject: 'RendererOptions.publicationSource',
          }),
        );
    } else if (publicationReceiver !== undefined && !sceneAbsent) {
      return err(
        new RenderPublicationError({
          reason: 'identity',
          subject: 'a publication-bound renderer cannot consume local World leases',
        }),
      );
    }
    const worlds: readonly World[] =
      frameRequest !== undefined
        ? frameRequest.leases
            .map((lease) => attachedLeases.get(lease))
            .filter((world): world is World => world !== undefined)
        : publicationRequest === undefined
          ? (worldsOrRequest as readonly World[])
          : [];
    const localLeases = worlds.map(
      (world) => [...attachedLeases].reverse().find(([, source]) => source === world)?.[0],
    );
    const readLeases: readonly RenderReadLease[] | undefined =
      frameRequest?.leases ??
      (localLeases.every((lease): lease is RenderReadLease => lease !== undefined)
        ? localLeases
        : undefined);
    const physicsFrameError = derivedPhysicsFrameError(worlds);
    if (physicsFrameError !== undefined) return err(physicsFrameError);
    const geometryFrameError = dynamicGeometryFrameError(worlds, (world) =>
      dynamicGeometryHost.dynamicGeometryFault(world),
    );
    if (geometryFrameError !== undefined) return err(geometryFrameError);
    if (frameRequest !== undefined && worlds.length !== frameRequest.leases.length) {
      return err(
        new RendererOperationError('world-lease-invalid', {
          operation: 'draw',
          cause: new RendererContractFailureError(
            'draw',
            'every RenderFrameInput lease must be attached to this Renderer',
          ),
        }),
      );
    }
    const cameraOwner =
      frameRequest?.camera == null ? -1 : frameRequest.leases.indexOf(frameRequest.camera.lease);
    const resourceOwner =
      frameRequest?.environment == null
        ? -1
        : frameRequest.leases.indexOf(frameRequest.environment.lease);
    if (frameRequest !== undefined && !sceneAbsent && (cameraOwner < 0 || resourceOwner < 0)) {
      return err(
        new RendererOperationError('frame-input-invalid', {
          operation: 'draw',
          cause: new RendererContractFailureError(
            'draw',
            cameraOwner < 0
              ? 'camera lease must be present in RenderFrameInput.leases'
              : 'environment lease must be present in RenderFrameInput.leases',
          ),
        }),
      );
    }
    const drawOptions: DrawOwnerOptions =
      frameRequest !== undefined
        ? {
            cameraOwner,
            resourceOwner,
            ...(frameRequest.camera?.entityKey === undefined
              ? {}
              : { cameraEntityKey: frameRequest.camera.entityKey }),
            ...motionBlurDrawOptions(frameRequest),
            ...(frameRequest.profileFrame === undefined
              ? {}
              : { profileFrame: frameRequest.profileFrame }),
            ...(frameRequest.geometryObservation === true
              ? { geometryObservation: true as const }
              : {}),
            ...(frameRequest.geometryLane === undefined
              ? {}
              : { geometryLane: frameRequest.geometryLane }),
          }
        : publicationRequest === undefined
          ? (options ?? { cameraOwner: 0, resourceOwner: 0 })
          : {
              cameraOwner: 0,
              resourceOwner: 0,
              sampleTimeSeconds: publicationRequest.publication.sampleTimeSeconds,
              temporalReset: publicationRequest.publication.temporalReset,
              ...(publicationRequest.geometryObservation === true
                ? {
                    geometryObservation: true as const,
                    ...(publicationRequest.geometryObservationSourceWorldIdentity === undefined
                      ? {}
                      : {
                          geometryObservationSourceWorldIdentity:
                            publicationRequest.geometryObservationSourceWorldIdentity,
                        }),
                  }
                : {}),
              ...(publicationRequest.geometryLane === undefined
                ? {}
                : { geometryLane: publicationRequest.geometryLane }),
            };
    // feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M5 / w21
    // (plan-strategy D-1, D-8): post-dispose the renderer is dead. AI
    // users observing `result.ok === false && err.code === 'rhi-not-
    // available'` know to rebuild the renderer (mirrors the "ready not
    // settled" + "pipelineState null" fail-fast paths below; reuses the
    // existing closed-union member, no new ErrorCode introduced).
    if (disposed) {
      const e = new RhiError({
        code: 'rhi-not-available',
        expected:
          'renderer not disposed before calling renderer.draw(worlds, { cameraOwner, resourceOwner })',
        hint: 'renderer.dispose() flipped the lifecycle latch; rebuild via createRenderer / Engine.create',
      });
      internals.errorRegistry.fire(e);
      return err(e);
    }
    if (surfaceReleased) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'renderer surface restored before drawing',
          hint: 'call renderer.restoreSurface() after the temporary surface owner stops',
        }),
      );
    }
    const canvasSizeError = rejectZeroCanvasSize(internals.canvas.width, internals.canvas.height);
    if (canvasSizeError !== undefined) return err(canvasSizeError);
    // Health owns admission for the legacy Host entry as well as the public
    // Renderer. The initiating failure was already reported; do not fire it
    // again for every attempted frame while the Host chooses recovery/rebuild.
    const health = internals.healthRegistry.getLastSnapshot();
    if (health.reason !== 'alive') {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'renderer generation is healthy before submitting another frame',
          hint:
            health.reason === 'device-lost'
              ? 'call renderer.recover() after a host-chosen delay; camera holds previous frame'
              : 'dispose and recreate the faulted Renderer; submitted GPU completion is unknown',
        }),
      );
    }
    // D-S4: ready not settled => fire onError + skip frame. Uses
    // 'rhi-not-available' (closed union placeholder semantics; charter
    // proposition 4 explicit failure - AI users observe through onError
    // and decide whether to retry).
    if (!readySettled && ui === undefined) {
      const e = new RhiError({
        code: 'rhi-not-available',
        expected:
          'await renderer.initialization before calling renderer.draw(worlds, { cameraOwner, resourceOwner })',
        hint: 'await renderer.initialization resolves once the manifest / pipeline / asset upload chain completes',
      });
      internals.errorRegistry.fire(e);
      return err(e);
    }
    // pipeline build rejected: ready Promise has already surfaced the
    // structured error to AI users through `await renderer.initialization`. Skip
    // to keep draw(world) idempotent; a transient retry next frame is
    // the responsibility of the AI user (charter proposition 9).
    if (pipelineState === null && ui === undefined) {
      const e = new RhiError({
        code: 'rhi-not-available',
        expected: 'pipelineState built during Renderer.initialization',
        hint: 'await renderer.initialization resolved successfully; rebuild renderer or fix the upstream RhiError',
      });
      internals.errorRegistry.fire(e);
      return err(e);
    }
    // feat-20260708-composited-multi-world-rendering M3 / D-5: draw-args
    // entry validation runs before each extract or context configuration.
    // Empty worlds / owner out of range returns a structured Result.err
    // (never silent, charter P3) without touching GPU state. The two codes
    // are non-exclusive: an empty array short-circuits to empty-worlds. The
    // check is defensive against JS callers passing a non-array despite the
    // compile-time World[] type (red-window migration safety).
    const worldCount =
      publicationRequest === undefined ? (Array.isArray(worlds) ? worlds.length : 0) : 1;
    if (!sceneAbsent && worldCount === 0 && internals.device.caps.backendKind === 'null') {
      return ok(undefined);
    }
    // Validate both owner indices (cameraOwner before resourceOwner, first
    // offender wins). The empty object only protects the JS boundary; it is
    // rejected by the same validation and never becomes another draw shape.
    const drawOwners = drawOptions;
    const argsCheck = sceneAbsent ? ok(undefined) : validateDrawArgs(worldCount, drawOwners);
    if (!argsCheck.ok) {
      internals.errorRegistry.fire(argsCheck.error);
      return argsCheck;
    }
    // Configure context lazily on first draw (D-S1 single-point
    // exemption): GPUCanvasContext.configure({device}) needs a raw
    // The canvas context is configured through the RHI device scope.
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
      if (publicationRequest !== undefined && publicationReceiver !== undefined) {
        const accepted = publicationReceiver.accept(publicationRequest.publication, assets);
        if (!accepted.ok) return accepted;
        publication = {
          ...accepted.value,
          ...(publicationRequest.onFeatureSourceSubmitted === undefined
            ? {}
            : {
                onFeatureSourceSubmitted: publicationRequest.onFeatureSourceSubmitted,
              }),
        };
      }
      renderTargetHost.beginFrame();
      externalTextureHost.beginFrame();

      const timingHost = internals;
      const timingRequested =
        isFrameRequest &&
        (frameRequest?.profileFrame !== undefined || internals.options?.captureGpuTimings === true);
      let volumeTimingCapture: GpuTimingCapture | undefined;
      const volumeTimingUnavailableReason = timingRequested
        ? 'timestamp capture is unavailable on this device'
        : 'timestamp capture was not requested for this frame';
      if (timingRequested && gpuPassTimingOptions === undefined) {
        const createdTiming = GpuTimingCapture.create(internals.device);
        if (createdTiming.ok) volumeTimingCapture = createdTiming.value;
      }
      if (isFrameRequest) {
        timingHost.observationFrameId = frameId + 1;
        timingHost.observationGraphGeneration = undefined;
        timingHost.observationCaptureDomains = pendingObservationDomains;
        timingHost.gpuPassTimingFrameIdentity = {
          frameId: frameId + 1,
          deviceGeneration: activeDeviceScope.generation,
          graphGeneration: 0,
        };
      }
      uiOnlyFrame = ui !== undefined && (sceneAbsent || !readySettled || pipelineState === null);
      ui?.prepare(
        (drawOptions.sampleTimeSeconds ?? 0) * 1000,
        internals.canvas.width,
        internals.canvas.height,
        uiOnlyFrame,
        internals.outputColorSpace.report.effective,
        uiFormats.storage === uiFormats.view &&
          pendingObservationDomains?.includes('final-display') === true,
      );
      const recordUi = function* (): FrameRecording {
        const encoded = internals.device.createCommandEncoder({ label: 'screen-ui-frame' });
        if (!encoded.ok) throw encoded.error;
        const generation = activeDeviceScope.generation;
        const submitted = yield {
          encoder: encoded.value,
          device: internals.device,
          beforeSubmit: renderInternals.beforeSubmit,
          isCurrent: () => !disposed && activeDeviceScope.generation === generation,
          reportError: (error: RhiError) => internals.errorRegistry.fire(error),
        };
        return submitted.ok;
      };
      const submitted = uiOnlyFrame
        ? yield* prepareFrameSubmission([recordUi()], undefined, renderInternals, isCurrent)
        : yield* cameraViews.prepareSubmission(
            worlds,
            drawOptions,
            readLeases,
            volumeTimingCapture,
            publication === undefined || publicationReceiver === undefined
              ? undefined
              : { publication, receiver: publicationReceiver },
            isCurrent,
          );
      timingHost.observationFrameId = undefined;
      timingHost.observationCaptureDomains = undefined;
      timingHost.gpuPassTimingFrameIdentity = undefined;
      if (!submitted) {
        const cleanupFailure = disposeOwnedObservationCaptures(observationCaptureOwner.drain());
        volumeTimingCapture?.discard();
        if (cleanupFailure !== undefined) return err(cleanupFailure);
        const invalidMotionBlur = cameraViews.currentSystem.motionBlurInvalidParams;
        if (invalidMotionBlur !== undefined) return err(invalidMotionBlur);
        return err(
          new RendererContractFailureError(
            'draw',
            'the Standard render owner did not submit a command buffer; inspect Renderer error events and recover the owning frame path',
          ),
        );
      }
      const timingCompletion = timingHost.gpuPassTimingSubmittedWork;
      timingHost.gpuPassTimingSubmittedWork = undefined;
      const reflectionFallbackCompletion = uiOnlyFrame
        ? undefined
        : cameraViews.currentSystem.reflectionFallbackCompletion;
      const receiptFrameId = isFrameRequest ? ++frameId : undefined;
      const receiptGeneration = activeDeviceScope.generation;
      const queueCompletion = timingCompletion ?? internals.device.queue.onSubmittedWorkDone();
      // Submission succeeded, so a rejected completion leaves this generation's
      // GPU work unconfirmed. Do not retire the device scope here: a completion
      // failure is not proof of device loss. Health and continuations own admission.
      void Promise.resolve(queueCompletion).catch((cause: unknown) => {
        if (
          disposed ||
          receiptGeneration !== activeDeviceScope.generation ||
          internals.healthRegistry.getLastSnapshot().reason !== 'alive'
        )
          return;
        const failure = new RendererOperationError(
          'device-operation-failed',
          {
            operation: 'complete-frame',
            ...(receiptFrameId === undefined ? {} : { frameId: receiptFrameId }),
            deviceGeneration: receiptGeneration,
            cause: structuredRendererCause(cause, 'complete-frame'),
          },
          { cause },
        );
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
      ui?.submitted(queueCompletion);
      gpuStore.trackMeshSubmission(queueCompletion);
      internals.pack.instrumentation?.onFrameBoundary?.();
      if (receiptFrameId === undefined) {
        const cleanupFailure = disposeOwnedObservationCaptures(observationCaptureOwner.drain());
        renderTargetHost.onFrameSubmitted(
          queueCompletion.then(() => ({ ok: true, value: undefined }) as const),
        );
        if (cleanupFailure !== undefined) return err(cleanupFailure);
        return ok(undefined);
      }
      const completion: FrameReceipt['completed'] = Promise.all([
        queueCompletion,
        reflectionFallbackCompletion ?? Promise.resolve(),
      ])
        .then(() => ok(undefined))
        .catch((cause: unknown) =>
          err(
            new RendererOperationError(
              'device-operation-failed',
              {
                operation: 'complete-frame',
                frameId: receiptFrameId,
                deviceGeneration: receiptGeneration,
                cause: structuredRendererCause(cause, 'complete-frame'),
              },
              { cause },
            ),
          ),
        );
      const continuation = createContinuationTerminator();
      const receiptPresentation = uiOnlyFrame
        ? 'pending'
        : (cameraViews.presentation ?? renderSystem.presentation);
      const presentationPendingReason =
        receiptPresentation === 'ready'
          ? undefined
          : uiOnlyFrame
            ? Object.freeze({ code: 'ui-only' as const })
            : cameraViews.active
              ? cameraViews.presentationPendingReason
              : renderSystem.presentationPendingReason;
      frameContinuations.set(continuation, {
        frameId: receiptFrameId,
        deviceGeneration: receiptGeneration,
        presentation: receiptPresentation,
        stages: observeFrameCompletionStages(queueCompletion, reflectionFallbackCompletion),
      });
      const guardedCompletion = guardFrameCompletion(
        completion,
        () => continuation.guard('queue-completion'),
        () =>
          new RendererOperationError('device-operation-failed', {
            operation: 'complete-frame',
            frameId: receiptFrameId,
            deviceGeneration: receiptGeneration,
            cause: structuredRendererCause(
              {
                code: 'stale-generation',
                expected: 'frame completion belongs to its device generation',
                hint: 'discard the stale receipt',
              },
              'complete-frame',
            ),
          }),
        (cause: unknown) =>
          new RendererOperationError('device-operation-failed', {
            operation: 'complete-frame',
            frameId: receiptFrameId,
            deviceGeneration: receiptGeneration,
            cause: structuredRendererCause(cause, 'complete-frame'),
          }),
      );
      const terminated = continuation.promise().then((reason) =>
        err(
          new RendererOperationError(
            'device-operation-failed',
            {
              operation: 'complete-frame',
              frameId: receiptFrameId,
              deviceGeneration: receiptGeneration,
              cause: structuredRendererCause(
                reason.code === 'internal-fault'
                  ? reason.detail
                  : {
                      code: reason.code,
                      expected: 'a frame continuation completes before device loss or disposal',
                      hint: 'discard the stale receipt and inspect the current renderer generation',
                      detail: reason,
                    },
                'complete-frame',
              ),
            },
            reason.code === 'internal-fault' ? { cause: reason.detail.cause } : undefined,
          ),
        ),
      );
      const completed: FrameReceipt['completed'] = Promise.race([
        guardedCompletion,
        terminated,
      ]).finally(() => {
        frameContinuations.delete(continuation);
      });
      const captures = observationCaptureOwner.consume(receiptFrameId);
      pendingObservationDomains = undefined;
      const receiptGraphGeneration =
        timingHost.observationGraphGeneration ??
        (uiOnlyFrame ? 0 : (cameraViews.currentSystem.perFrameGraphInfo?.generation ?? 0));
      const receipt = Object.freeze({
        frameId: receiptFrameId,
        deviceGeneration: receiptGeneration,
        presentation: receiptPresentation,
        ...(presentationPendingReason === undefined ? {} : { presentationPendingReason }),
        backendId: internals.device.caps.backendKind,
        graphGeneration: receiptGraphGeneration,
        ...(uiOnlyFrame ||
        cameraViews.active ||
        renderSystem.lastSuccessfulBarrelDistortion === undefined
          ? {}
          : { barrelDistortion: renderSystem.lastSuccessfulBarrelDistortion }),
        completed,
      });
      renderTargetHost.onFrameSubmitted(completed, receipt);
      latestReceipt = receipt;
      latestPublicationRevision = publicationReceiver?.acceptedRevision ?? 0;
      latestLodObservation = {
        receipt,
        capture: cameraViews.lastLodObservationCapture,
        draws: captureMaterialDraws(cameraViews.lastLodObservationCapture),
      };
      if (captures.length > 0) {
        const captureRead: ObservationCaptureRead = async () => {
          const completion = await completed;
          if (!completion.ok) {
            const cleanupFailure = disposeObservationCaptures(captures);
            return cleanupFailure === undefined ? completion : err(cleanupFailure);
          }
          const read = [];
          for (const capture of captures) {
            const bytes = await readObservationCapture(capture);
            if (!bytes.ok) {
              const cleanupFailure = disposeObservationCaptures(captures);
              return cleanupFailure === undefined ? bytes : err(cleanupFailure);
            }
            read.push({ capture, bytes: bytes.value });
          }
          return ok(read);
        };
        receiptObservationBuffers.set(receipt, captures);
        receiptObservationCaptures.set(receipt, captureRead);
      }
      const passTimingCapture = uiOnlyFrame ? undefined : timingHost.gpuPassTimingCapture;
      const timingBeginReason = uiOnlyFrame ? undefined : timingHost.gpuPassTimingBeginReason;
      const timingSource =
        passTimingCapture === undefined
          ? gpuPassTimingUnavailable === undefined && timingBeginReason === undefined
            ? undefined
            : async (): Promise<GpuPassTimingObservation> =>
                gpuPassTimingUnavailable ??
                failedGpuPassTimingObservation(timingBeginReason as GpuPassTimingReason)
          : async (): Promise<GpuPassTimingObservation> => {
              const observed = await passTimingCapture.observe();
              if (!observed.ok) return failedGpuPassTimingObservation(observed.error);
              const frame = observed.value;
              const unmeasured = frame.passes.find((pass) => pass.status === 'unmeasured');
              if (unmeasured !== undefined) {
                return { status: 'partial', frame, reason: unmeasured.reason };
              }
              if (frame.droppedPassCount > 0) {
                return {
                  status: 'partial',
                  frame,
                  reason: {
                    code: 'query-budget-exceeded',
                    expected: 'all executed passes fit within the bounded query budget',
                    hint: 'increase maxPassesPerFrame or simplify the pass graph',
                    detail: { droppedPassCount: frame.droppedPassCount },
                  },
                };
              }
              return { status: 'complete', frame };
            };
      timingObservationStore?.register(receipt, timingSource);
      if (timingRequested && gpuPassTimingOptions === undefined) {
        receiptTimings.set(
          receipt,
          volumeTimingCapture?.observation() ??
            Promise.resolve({
              status: 'unavailable',
              reason: volumeTimingUnavailableReason,
            }),
        );
      }
      issuedReceipts.add(receipt);
      terrainReceipts.register(receipt, uiOnlyFrame ? [] : cameraViews.terrainSections());
      if (!uiOnlyFrame)
        dynamicGeometryHost.publishDynamicGeometry(receipt, worlds, frameRequest?.fixedStep);
      return ok(receipt);
    } catch (cause) {
      internals.observationFrameId = undefined;
      internals.observationCaptureDomains = undefined;
      internals.gpuPassTimingFrameIdentity = undefined;
      const cleanupFailure = disposeOwnedObservationCaptures(observationCaptureOwner.drain());
      if (cleanupFailure !== undefined) return err(cleanupFailure);
      if (cause instanceof RendererOperationError) return err(cause);
      if (cause instanceof CameraViewInvalidError) return err(cause);
      if (cause instanceof ProjectedDecalInvalidError) return err(cause);
      const error =
        cause instanceof Error
          ? { code: 'unknown' as const, message: cause.message, name: cause.name }
          : { code: 'unknown' as const, message: String(cause) };
      const e = new RhiError({
        code: 'webgpu-runtime-error',
        expected:
          'renderSystem.draw(worlds, { cameraOwner, resourceOwner }) completes without throwing',
        hint: `RenderSystem internal error: ${error.message}`,
        detail: { error },
      });
      internals.errorRegistry.fire(e);
      return err(e);
    } finally {
      // Native video pixels have been consumed by synchronous queue copy calls.
      // Release them on every success/failure path, including direct publication users.
      publicationReceiver?.releaseVideoFrames();
    }
  }
  const renderer: RendererAssemblyImplementation = {
    setSurfaceDynamicInput(frame) {
      cameraViews.setSurfaceDynamicInput(frame);
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
    preparePublishedMeshResidency: createPublishedMeshResidencyHost({
      assets,
      prepareCandidatePipelines: (input, signal) =>
        cameraViews.prepareCandidatePipelines(input, signal),
      receiver: publicationReceiver,
      getGpuStore: () => gpuStore,
      currentGeneration: () => activeDeviceScope.generation,
      completeUploads: () => internals.device.queue.onSubmittedWorkDone(),
      isCurrentFrame: (receipt) =>
        !uiOnlyFrame &&
        latestReceipt === receipt &&
        publicationReceiver?.acceptedRevision === latestPublicationRevision,
      recordStageLane: (resources, entity, handle) =>
        cameraViews.dynamicGeometryRecordStageLane(resources, entity, handle),
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
    nativeDevice: () => externalTextureHost.nativeDevice(),
    setProfile(profile: RenderProfile): RenderResult<void, RenderError> {
      const invalid = validateRenderProfile(profile);
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
      const inspectedSystem = cameraViews.currentSystem;
      return {
        lodOcclusion: inspectedSystem.lodOcclusionInspection,
        gpuDriven: inspectedSystem.gpuDrivenInspection,
      };
    },
    bounds: (world, entity) => (disposed ? undefined : cameraViews.bounds(world, entity)),
    currentDeviceGeneration: () => activeDeviceScope.generation,
    inspect(options): RenderInspection {
      const library = internals.device.pipelineLibrary;
      const exported = options?.pipelineLibrary === true ? library?.export() : undefined;
      if (options?.pipelineLibrary === true && exported === undefined)
        throw new RhiError({
          code: 'feature-not-enabled',
          expected: 'backend pipeline library support',
          hint: 'select WebGPU for pipeline recipe collection',
        });
      if (exported?.ok === false) throw exported.error;
      const inspectedSystem = cameraViews.currentSystem;
      const health = internals.healthRegistry.getLastSnapshot();
      const deviceLost = health.reason === 'device-lost';
      const state = disposed
        ? 'disposed'
        : deviceLost
          ? 'device-lost'
          : health.reason === 'internal-fault' || (!readySettled && ui === undefined)
            ? 'faulted'
            : 'alive';
      const graph = deviceLost ? undefined : inspectedSystem.perFrameGraphInfo;
      const graphResourceAllocation = graph?.resourceAllocation;
      const graphGenerationAllocation = deviceLost
        ? undefined
        : inspectedSystem.renderGraphGenerationAllocation;
      const standardLighting = deviceLost ? undefined : inspectedSystem.standardLightingInspection;
      const barrelDistortion = inspectBarrelDistortion(
        disposed,
        deviceLost,
        surfaceReleased,
        frameId,
        activeDeviceScope.generation,
        inspectedSystem.barrelDistortionInspection,
      );
      const bloom: BloomInspection = deviceLost ? emptyBloomInspection() : inspectedSystem.bloom;
      const observationId = `${STANDARD_OUTPUT_TRANSFORM_FEATURE_ID}:frame-${frameId}`;
      const outputInspection = projectRendererOutputInspectionFromSurface({
        graph,
        surfaceReleased,
        pipelineState,
        rgba16floatRenderable: internals.device.caps.rgba16floatRenderable,
        colorSpace: internals.outputColorSpace.report,
        autoExposure: inspectedSystem.autoExposure,
        standardLut: inspectedSystem.standardLut,
        presentationProof: internals.context?.presentationProof,
      });
      const volumetricFog = inspectedSystem.volumetricFog;
      const directionalShadow = inspectedSystem.directionalShadow;
      const shadowRaster = inspectedSystem.shadowRaster;
      const recoveryEvidence = inspectedSystem.recoveryEvidence;
      const pointShadow = projectPointShadowInspection(
        inspectedSystem.pointShadowInspection,
        materialShadersSamplePointShadows(getShader().materialShaderManifestEntries()),
      );
      return Object.freeze({
        ...(library === undefined ? {} : { pipelineLibrary: library.inspect() }),
        ...(exported?.ok === true ? { pipelineLibraryManifest: exported.value } : {}),
        state,
        views: cameraViews.inspect(),
        recovery: recoveryInspection,
        surface: surfaceReleased ? 'released' : 'available',
        profile: activeProfile,
        ...inspectDeviceCapabilities(internals.device),
        frame: inspectFrameCompletionContinuations(
          frameId,
          activeDeviceScope.generation,
          frameContinuations,
        ),
        barrelDistortion,
        ...projectRendererFeatureInspection(internals.featureHost),
        featureGraph: inspectedSystem.featureGraphInspection,
        materialTextureSources: inspectedSystem.materialTextureSources,
        frustumStats: Object.freeze({ ...inspectedSystem.frustumStats }),
        visibilityStats: Object.freeze({ ...inspectedSystem.visibilityStats }),
        instanceCollections: Object.freeze(
          inspectedSystem.instanceCollectionsInspection.map((collection) =>
            Object.freeze({
              ...collection,
              uploadRanges: Object.freeze(
                collection.uploadRanges.map((range) => Object.freeze({ ...range })),
              ),
              ...(collection.error === undefined
                ? {}
                : {
                    error: Object.freeze({
                      ...collection.error,
                      detail: Object.freeze({ ...collection.error.detail }),
                    }),
                  }),
            }),
          ),
        ),
        dynamicGeometry: dynamicGeometry.inspect(),
        renderScene: inspectedSystem.renderScene,
        ...(graphResourceAllocation === undefined
          ? {}
          : { renderGraphResourceAllocation: graphResourceAllocation }),
        ...(graphGenerationAllocation === undefined
          ? {}
          : { renderGraphGenerationAllocation: graphGenerationAllocation }),
        ...(inspectedSystem.iblBinding === undefined
          ? {}
          : { iblBinding: inspectedSystem.iblBinding }),
        reflectionProbes: inspectedSystem.reflectionProbes,
        ssrDependencies: inspectedSystem.ssrDependencies,
        ssr: inspectedSystem.ssr,
        ...(inspectedSystem.probePlacement === undefined
          ? {}
          : { probePlacement: inspectedSystem.probePlacement }),
        ...(inspectedSystem.diffuseGi === undefined
          ? {}
          : { diffuseGi: inspectedSystem.diffuseGi }),
        volumetricFog,
        environment: inspectedSystem.environment,
        temporal: inspectedSystem.temporal,
        ...(inspectedSystem.dynamicResolution === undefined
          ? {}
          : { dynamicResolution: inspectedSystem.dynamicResolution }),
        bloom,
        extendedLighting: projectExtendedLightingInspection(extendedLightingState),
        directionalShadow,
        shadowRaster,
        ...(inspectedSystem.temporalTargetInspection === undefined
          ? {}
          : { temporalTarget: Object.freeze(inspectedSystem.temporalTargetInspection) }),
        ...(inspectedSystem.motionBlurInspection === undefined
          ? {}
          : { motionBlur: Object.freeze(inspectedSystem.motionBlurInspection) }),
        ...dofInspection(inspectedSystem.depthOfFieldInspection),
        ...(inspectedSystem.lodOcclusionInspection === undefined
          ? {}
          : { lodOcclusion: Object.freeze(inspectedSystem.lodOcclusionInspection) }),
        ...(inspectedSystem.transmission === undefined
          ? {}
          : { transmission: inspectedSystem.transmission }),
        ...(standardLighting === undefined
          ? {}
          : { standardLighting: Object.freeze({ ...standardLighting }) }),
        ...(pointShadow === undefined ? {} : { pointShadow: Object.freeze({ ...pointShadow }) }),
        ...(inspectedSystem.capsuleShadowInspection === undefined
          ? {}
          : { capsuleShadow: inspectedSystem.capsuleShadowInspection }),
        ...(inspectedSystem.transparencyInspection === undefined
          ? {}
          : { transparency: inspectedSystem.transparencyInspection }),
        meshMaterialBindings: Object.freeze(
          inspectedSystem.meshMaterialBindings.map((observation) =>
            Object.freeze({
              ...observation,
              bindings: Object.freeze(
                observation.bindings.map((binding) => Object.freeze({ ...binding })),
              ),
              diagnostics: Object.freeze(
                observation.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
              ),
            }),
          ),
        ),
        perFramePassNames: Object.freeze([...cameraViews.perFramePassNames]),
        bindGroupCounts: Object.freeze({
          createBindGroup: inspectedSystem.bindGroupCounts.createBindGroup,
          keys: Object.freeze([...inspectedSystem.bindGroupCounts.keys]),
        }),
        recoveryEvidence: Object.freeze({
          ...recoveryEvidence,
          graph: deviceLost
            ? { ready: false, generation: 0, passCount: 0, resourceCount: 0 }
            : recoveryEvidence.graph,
          producerRoots: Object.freeze([...recoveryEvidence.producerRoots]),
          receipts: Object.freeze({
            count: frameId,
            lastGeneration: latestReceipt?.deviceGeneration,
          }),
        }),
        output: Object.freeze({
          ...outputInspection,
          graphPassNames: Object.freeze([...outputInspection.graphPassNames]),
          ...(outputInspection.standardOutputColor === undefined
            ? {}
            : { standardOutputColor: Object.freeze({ ...outputInspection.standardOutputColor }) }),
        }),
        observation: Object.freeze({
          observationId,
          frameId,
          ...(inspectedSystem.lastSuccessfulCameraAntialias === undefined
            ? {}
            : { antialias: inspectedSystem.lastSuccessfulCameraAntialias }),
          ...(outputInspection.surfaceProfile === undefined
            ? {}
            : { surfaceProfile: outputInspection.surfaceProfile }),
          rgba16floatRenderable: internals.device.caps.rgba16floatRenderable,
          passNames: Object.freeze([...outputInspection.graphPassNames]),
          ...(outputInspection.standardOutputColor === undefined
            ? {}
            : { standardOutputColor: Object.freeze({ ...outputInspection.standardOutputColor }) }),
          resourceStats: Object.freeze({
            allocationCount: observationStats.allocationCount,
            liveCount: observationStats.liveCount,
            peakLiveCount: observationStats.peakLiveCount,
            mapCount: observationStats.mapCount,
            readbackCount: observationStats.readbackCount,
            liveByteLength: observationStats.liveByteLength,
          }),
        }),
      });
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
      try {
        transformReleases.set(world, registerRenderSourceSystems(world, assets, gpuStore));
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
      return cameraViews.currentSystem.observeCurrentFrame(options);
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
    getCurrentGraphTarget(name: string) {
      return cameraViews.currentSystem.getCurrentGraphTarget(name);
    },
    requestGraphTargetCapture(request) {
      cameraViews.currentSystem.requestGraphTargetCapture(request);
    },
    get frustumStats() {
      return cameraViews.currentSystem.frustumStats;
    },
    get visibilityStats() {
      return cameraViews.currentSystem.visibilityStats;
    },
    get renderScene() {
      return cameraViews.currentSystem.renderScene;
    },
    get meshMaterialBindings() {
      return cameraViews.currentSystem.meshMaterialBindings;
    },
    get perFramePassNames() {
      return cameraViews.perFramePassNames;
    },
    get bindGroupCounts() {
      return cameraViews.currentSystem.bindGroupCounts;
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
      if (disposed) {
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
      let nextRequiredFullscreenPostProcesses: readonly {
        readonly identity: string;
        readonly source: string;
      }[];
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
      const fullscreenPrewarm = await prewarmFullscreenFeatureModules(feature);
      if (!fullscreenPrewarm.ok) {
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'prepare', 'registration'),
        );
      }
      for (const materialShaderId of feature.requiredMaterialShaders ?? []) {
        const lookup = getShader().findMaterialArtifact(materialShaderId);
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
        const moduleResult = internals.pack.createShaderModule
          ? await internals.pack.createShaderModule(internals.device, {
              code: lookup.value.source,
              label,
            })
          : await invokeDeviceCreateShaderModule(internals.device, {
              code: lookup.value.source,
              label,
            });
        if (!moduleResult.ok) {
          internals.errorRegistry.fire(moduleResult.error);
          return err(
            new RenderFeatureStageFailedError(feature.identity, -1, 'prepare', 'registration'),
          );
        }
        getShaderModuleAdapter().seedModule(label, moduleResult.value);
      }
      const installed = host.install(feature);
      if (!installed.ok) return installed;
      if (installed.ok) {
        for (const materialShaderId of feature.requiredMaterialShaders ?? []) {
          requiredMaterialShaderSet.add(materialShaderId);
        }
        requiredMaterialShaders = Object.freeze([...requiredMaterialShaderSet]);
        requiredFullscreenPostProcesses = nextRequiredFullscreenPostProcesses;
        cameraViews.reset();
      }
      return installed;
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
      worldsOrRequest: readonly World[] | RenderFrameInput | PublishedRenderFrameInput,
      options?: DrawOwnerOptions,
    ): Result<void | FrameReceipt, RhiError | RenderError> {
      if (preparationActive) return preparationRejected();
      preparationActive = true;
      try {
        return drainFramePreparation(prepareDraw(worldsOrRequest, options));
      } finally {
        preparationActive = false;
      }
    },
    async drawFrameScheduled(request, schedule) {
      if (preparationActive) return preparationRejected();
      preparationActive = true;
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
        const operation = prepareDraw(request, undefined, current);
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
        preparationActive = false;
      }
    },
    async observeGeometry(receipt: FrameReceipt) {
      const state = latestLodObservation;
      const view = state?.capture?.views.find((view) => view.system === cameraViews.currentSystem);
      const valid = () =>
        state !== undefined &&
        view !== undefined &&
        state.receipt === receipt &&
        latestReceipt === receipt &&
        staleObservationReceipt(receipt) === undefined &&
        lodObservationCaptureFailure(state.capture, lodObservationValidity(state, receipt)) ===
          undefined;
      if (!valid() || view === undefined)
        return unavailableGeometry(
          'receipt-or-source-unavailable',
          receipt.frameId,
          receipt.deviceGeneration,
        );
      const completed = await receipt.completed;
      if (!completed.ok || !valid())
        return unavailableGeometry(
          'superseded-or-incomplete',
          receipt.frameId,
          receipt.deviceGeneration,
        );
      const observed = await view.system.observeGeometry(receipt);
      if (!valid())
        return unavailableGeometry('superseded', receipt.frameId, receipt.deviceGeneration);
      return {
        ...observed,
        viewKey: view.viewKey,
        ...(receipt.graphGeneration === undefined
          ? {}
          : { graphGeneration: receipt.graphGeneration }),
      };
    },
    observe(receipt: FrameReceipt, request: FrameObservationRequest) {
      return observeRendererReceipt(receipt, request, {
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
        isCaptureGenerationCurrent: () =>
          internals.pack.instrumentation?.isCaptureGenerationCurrent,
      });
    },
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
      terrainReceipts.clear();
      // A live backend's unresolved loss promise must not retain this renderer.
      internals.lossObserver.current = null;
      delete internals.generationState.onStaleLoss;
      cameraViews.dispose();
      retireGpuPassTimingSession();
      internals.gpuPassTimingCapture = undefined;
      internals.gpuPassTimingSubmittedWork = undefined;
      for (const world of attachedWorlds) dynamicGeometryHost.invalidateDynamicGeometryWorld(world);
      dynamicGeometry.dispose();
      publicationReceiver?.dispose();
      for (const continuation of frameContinuations.keys()) {
        continuation.terminate({ code: 'disposed' });
      }
      const cleanupFailures: RendererOperationCause[] = [];
      try {
        ui?.dispose();
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
      // RenderSystem closure (frameState is closure-private).
      try {
        renderSystem.disposeFrameState();
      } catch (cause) {
        const error = wrapDisposeError(cause, 'renderSystem.disposeFrameState');
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
      // Retire assembly-owned device resources only after the surface and
      // renderer-owned GPU pools have been released. The wgpu WebGL2 surface
      // still needs a live device while `unconfigure()` presents its pending
      // image; disposing the scope first lets wasm finalizers race that
      // presentation and can surface a parking_lot panic in WebKit.
      try {
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
    recoveryGraphCandidate: RecoveryGraphCandidate | undefined,
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
    // lost-device RenderSystem owners before installing the candidate state.
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
    publishRendererGeneration(candidate);
    renderTargetDevice = candidate.device;
    // Arm the first-frame guard before any publication code can resolve a
    // fallback pipeline or residency entry. Candidate preparation populated
    // these caches already; a miss here is a hard recovery failure, not an
    // opportunity to hide cold work inside the first visible frame.
    renderSystem.publishRecoveryPostProcessResources(candidatePostProcessResources);
    if (recoveryGraphCandidate !== undefined) {
      renderSystem.publishRecoveryGraphCandidate(recoveryGraphCandidate);
    }
    candidate.pipeline.perPassResources.commitBloomResources?.();
    recoveryRootBundle.publish();
    recoveryGraphCandidate?.markPublished();
    // RenderSystem owns frame/feature GPU state; the generation bindings own
    // residency stores; DeviceScope owns the remaining lifecycle roots. Their
    // retirement is intentionally centralized and ordered after publication.
    previousGpuStore.destroyAll();
    previousDynamicTextureStore.destroyAll();
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
    getShaderModuleAdapter,
    getImmediateShaderModuleAdapter,
    getShader,
    assets,
    buildPipeline,
    getMaterialShaderPipeline,
    getMaterialShaderPipelineEntry,
    prepareMaterialShaderPipeline,
    prepareMaterialShaderPipelineEntry,
    getMaterialShaderArtifact,
    getMaterialShaderBindingContract,
    getParamSchema,
    getMaterialBindGroupLayout,
    metrics,
    buildPostProcessPipeline,
    renderSystem,
    createRecoveryFailureLocation,
    publishAndRetireRendererGeneration,
  });
  return renderer;
}
