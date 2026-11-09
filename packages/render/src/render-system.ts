import type { World } from '@forgeax/engine-ecs';
import type { BindGroupLayout, RenderPipeline, RhiDevice } from '@forgeax/engine-rhi';
import { err, probeR32FloatRenderCapability, type Result, RhiError } from '@forgeax/engine-rhi';
import { createFeatureSceneInputs } from './assembly/feature-scene-inputs';
import { createGpuDrivenOwner } from './assembly/gpu-driven-owner';
import { createPostProcessParamsOwner } from './assembly/post-process-params';
import { createClusterBinScratch } from './cluster-binner';
import { EnvironmentLifecycle } from './environment/lifecycle';
import { SkinDemandMissingError } from './errors/render';
import type { PendingRenderFeatureErrorReport } from './features/error-reporting';
import { createFeatureNoiseResolver } from './features/noise-texture';
import {
  createRenderFeatureGpuWorkOwner,
  type RenderFeatureGpuWorkOwner,
} from './features/prepared-gpu-work';
import {
  type PostProcessShaderEntry,
  postProcessShaderEntrySignature,
  postProcessShaderModuleLabel,
  postProcessShaderPipelineLabel,
} from './fullscreen-post-process-pass';
import type { LodOcclusionInspection } from './inspection-types';
import { StandardClusterMembershipOwner } from './pipeline/standard-lighting/membership-owner';
import { createStandardLutState } from './pipeline/standard-output/lut-state';
import {
  disposeStandardOutput,
  resetStandardOutputForDeviceLoss,
} from './pipeline/standard-output/resources';
import { worldRenderResources } from './publication/resource-scope';
import { MaterialBgAssemblyCache } from './record/material-bg-assembly-cache';
import { RecordingSkinTasks } from './record/recording-skin-tasks';
import type { SkinTaskBinding } from './record/skin-tasks';
import { disposeTargetCaptures } from './record/target-capture-lighting';
import { prepareRenderSystemRecoveryRoots } from './recovery/render-system-roots';
import type {
  RecoveryPostProcessResources,
  RecoveryRootBundle,
  RecoveryRootRuntime,
} from './recovery/types';
import { ReflectionProbeRecordOwner } from './reflection/record-owner';
import { TerrainLayers } from './terrain/layers';
import { inspectVolumetricFog } from './volume/inspection';
import { recordContext } from './world/view-record-context';

export type { RenderSceneInspection } from './inspection-types';

import { resetHdrpBuffers } from './hdrp-buffers';
import {
  disposeInstanceBufferChunks,
  disposeInstanceBuffers,
  disposeTransientInstanceBuffers,
} from './instance-buffer-cache';
import { InstanceProjectionStore } from './instances';
import type { RenderFrameState } from './record/frame-snapshot';
import {
  emptyFrameRecordingOutputs,
  resetFrameRecordingOutputs,
  worldEntityKey,
} from './record/frame-snapshot';
import type { GpuPassTimingError } from './record/gpu-pass-timing/errors';
import type {
  GpuPassTimingCapture,
  GpuPassTimingFrameIdentity,
  GpuPassTimingSession,
} from './record/gpu-pass-timing/session';
import { LodInspectionOwner } from './record/lod-inspection';
import { createPreparedResolverCaches } from './record/prepared-material-bindings';
import type { PipelineState, RenderSystemInternals } from './record/render-context';
import { ShadowRasterLedger } from './record/shadow-raster-ledger';
import type { CubeCaptureGraphState } from './record/typed-frame-graph';
import {
  discardCompiledFrameGraphs,
  resetRenderFeatureGraphState,
} from './record/typed-frame-graph';
import { emptyVolumetricFogParams } from './record/volume-params';
import { RENDER_PHASE_CATALOG } from './render-contract';
import type { RenderableSnapshot } from './render-system-extract';
import { PersistentRenderScene, SceneComposition } from './scene/render-scene';
import { resetSsaoResources } from './ssao-buffers';
import { SurfaceSubmissionObservationOwner } from './surface/submission-observation';
import {
  createTemporalFrameTransaction,
  resetTemporalHistory,
  TemporalViewHistory,
} from './temporal/frame';
import { releaseTemporalGpuStates } from './temporal/gpu';
import { registerCaptureFaceFeatureSystem } from './world/capture-face-feature-systems';
import { registerViewCaptureSystems } from './world/capture-systems';
import { registerDebugOverlaySystems } from './world/debug-overlay-systems';
import { registerEnvironmentAdmissionSystem } from './world/environment-systems';
import { registerFeaturePlanSystems } from './world/feature-plan-systems';
import { featureSkylightOf, registerFeatureViewsSystem } from './world/feature-view-systems';
import { registerViewDiffuseGiSystem, registerVisibleSurfaceSystem } from './world/gi-systems';
import { registerGpuDrivenRasterSystem } from './world/gpu-driven-raster-systems';
import { registerGpuDrivenPrepareSystem } from './world/gpu-driven-systems';
import { registerHistoryAdmissionSystem } from './world/history-admission-systems';
import { registerLightSystems } from './world/light-systems';
import { registerMaterialSystems } from './world/material-systems';
import { registerPassPlanSystems } from './world/pass-plan-systems';
import { registerReflectionProbeSystems } from './world/reflection-systems';
import { renderSubmission, renderWorldFor } from './world/render-world';
import { registerSceneSystem } from './world/scene-systems';
import { registerShadowCasterSystem } from './world/shadow-caster-systems';
import { registerSkinDemandSystem, viewSkinDemandOf } from './world/skin-systems';
import { registerSsrAdmissionSystem } from './world/ssr-admission-systems';
import { registerStandardLightingSystem } from './world/standard-lighting-systems';
import { registerSubsurfaceAdmissionSystem } from './world/subsurface-admission-systems';
import { registerTemporalStageSystems } from './world/temporal-systems';
import { recoverViewTransmission, registerTransmissionSystem } from './world/transmission-systems';
import { type ViewDrawReceipt, viewDrawReceipt } from './world/view-draw-receipt';
import { registerViewFrameSystem } from './world/view-frame-systems';
import { viewPointsLines } from './world/view-points-lines';
import type {
  ViewRecordFacts,
  ViewRecordingState,
  ViewSettlementOwner,
} from './world/view-settlement';
import { registerViewTopologySystem } from './world/view-topology-systems';

type TimingSessionHost = RenderSystemInternals & {
  gpuPassTimingSession?: GpuPassTimingSession | undefined;
  gpuPassTimingCapture?: GpuPassTimingCapture | undefined;
  gpuPassTimingFrameIdentity?: GpuPassTimingFrameIdentity | undefined;
  gpuPassTimingBeginReason?: GpuPassTimingError | undefined;
};

/** Attach the Render-owned timing session without widening the public renderer surface. */
export function attachGpuPassTimingSession(
  internals: object,
  session: GpuPassTimingSession | undefined,
): void {
  (internals as TimingSessionHost).gpuPassTimingSession = session;
}

export type {
  _InternalRenderPipelineContext,
  _StandardForwardSceneView,
  PerPassResources,
  PipelineState,
  RenderSystemInternals,
  RenderSystemRuntime,
  SurfaceCapabilityFacts,
  SurfaceProfile,
  SwapChainFormatPair,
} from './record/render-context';
export {
  configureSurface,
  MATERIAL_PER_ENTITY_STRIDE,
  resolveSurfaceProfile,
  STANDARD_PBR_UBO_SIZE,
  selectSwapChainFormat,
} from './record/render-context';

export type {
  RendererProducerRoot,
  RendererProducerRootKind,
} from './render-system-producer-roots';
export { createRendererProducerRootMatrix } from './render-system-producer-roots';

/**
 * Production-owned recovery facts. These values are projections of the live
 * RendererState owners; they are not a test ledger or a second graph model.
 */
/** One submit's LOD/occlusion inspection: cheap identity header, body built on first read. */
export interface LodOcclusionInspectionCell {
  readonly view: LodOcclusionInspection['view'];
  readonly submit: LodOcclusionInspection['submit'];
  value(): LodOcclusionInspection;
}

export interface RendererState {
  /** Complete explicit SSR capability preparation before drawing a device generation. */
  initializeSsr(device?: RhiDevice): Promise<void>;
  /** Release renderer-owned persistent state for one detached World. */
  detachScene(world: World): void;
  /** Release the profiler catalog contribution owned by this RendererState. */
  releaseProfilerCatalog(): void;
  /** Register one engine-owned post-process shader used by the Standard lane. */
  registerBuiltinPostProcess(id: string, entry: PostProcessShaderEntry): () => void;

  /**
   * feat-20260622-s5 M3 / B-2 / w18: drop the device-bound state the recover()
   * rebuild must shed before re-running the pipeline build against a fresh
   * device. Two effects, both keyed to the lost device:
   *   1. the per-frame render-graph's pendingDestroy queue (PooledTextures
   *      minted by the lost device — clearPendingDestroy skips destroyTexture);
   *   2. post-process declarations + their eager param UBOs. Declarations are
   *      CPU-owned author intent and survive; UBOs are stale lost-device
   *      handles and are rebuilt after the replacement device is live.
   * Idempotent and graph-optional (no-op when nothing has compiled yet).
   */
  resetForRecover(retiringPipelineState?: PipelineState, replacementDevice?: RhiDevice): void;
  /** Build post-process parameter buffers without mutating the active bundle. */
  prepareRecoveryPostProcessResources(
    device: RhiDevice,
  ): Result<RecoveryPostProcessResources, RhiError>;
  /** Publish a previously prepared post-process bundle at the recovery boundary. */
  publishRecoveryPostProcessResources(candidate: RecoveryPostProcessResources): void;
  /** Release a candidate bundle that was never published. */
  discardRecoveryPostProcessResources(candidate: RecoveryPostProcessResources): void;
  /** Recreate post-process GPU parameter resources after a device rebuild. */
  restorePostProcessResources(): void;
  /** Build candidate roots from explicit candidate-owned device state. */
  prepareRecoveryRoots(runtime: RecoveryRootRuntime): RecoveryRootBundle;
}

export function createRendererState(internals: RenderSystemInternals): RendererState {
  return createRenderOwner(internals, 'renderer');
}

/** Initialize only a component-owned view; no standalone frame facade is allocated. */
export function createRenderViewOwner(internals: RenderSystemInternals): ViewSettlementOwner {
  return createRenderOwner(internals, 'view');
}

function createRenderOwner(internals: RenderSystemInternals, role: 'renderer'): RendererState;
function createRenderOwner(internals: RenderSystemInternals, role: 'view'): ViewSettlementOwner;
function createRenderOwner(
  internals: RenderSystemInternals,
  role: 'renderer' | 'view',
): RendererState | ViewSettlementOwner {
  const recordingState: ViewRecordingState = {
    preparedWorlds: [],
    directFrameId: 0,
    dispatchCounts: { unlit: 0 },
    pendingFeatureErrors: new Map<string, PendingRenderFeatureErrorReport>(),
  };
  const phaseCatalogRegistration = (
    role === 'renderer' ? internals.profiler : undefined
  )?.registerPhaseCatalog('render', RENDER_PHASE_CATALOG);
  let releaseProfilerCatalog =
    phaseCatalogRegistration?.ok === true ? phaseCatalogRegistration.value : undefined;
  const resolveFeatureNoise = createFeatureNoiseResolver({
    scope: recordContext(internals).deviceScope,
    getDevice: () => internals.device,
    onError: (error) => internals.errorRegistry.fire(error),
  });
  const ownsSceneInputs = recordContext(internals).featureSceneInputs === undefined;
  recordContext(internals).featureSceneInputs ??= createFeatureSceneInputs(
    internals,
    resolveFeatureNoise,
  );
  const drawReceipt = (): ViewDrawReceipt | undefined =>
    viewDrawReceipt(renderWorldFor(internals), internals.viewEntity);
  const clearSubmittedTerrain = (): void => {
    const receipt = drawReceipt();
    if (receipt !== undefined) receipt.terrain = [];
  };
  const recorded: ViewRecordFacts = {
    camera: undefined,
    motionBlurInvalidParams: undefined,
    frustum: { culled: 0, total: 0 },
    visibility: { explicitlyHidden: 0 },
    materialTextureSources: { sourceFieldsVisited: 0, producerRoutes: Object.freeze({}) },
    bindGroups: { createBindGroup: 0, keys: [] },
  };
  // Every system of one Renderer (its CameraViews included) reads the
  // Renderer's single scene composition; the first system creates it.
  const ownsSceneComposition = internals.sceneComposition === undefined;
  // A publication Renderer shares one projection store across views: its rows
  // are prepared once at acceptance. Local extraction shares the composition's.
  const ownsInstanceCollections =
    ownsSceneComposition && internals.instanceCollections === undefined;
  const instanceCollections =
    internals.instanceCollections ??
    internals.sceneComposition?.instanceCollections ??
    new InstanceProjectionStore();
  const reflectionProbeOwner = new ReflectionProbeRecordOwner(internals);
  const ssrFormats = new WeakMap<
    RhiDevice,
    import('@forgeax/engine-rhi').RhiTextureFormatCapabilityReceipt
  >();
  const ensureSsrFormatProbe = async (device = internals.device): Promise<void> => {
    if (
      internals.ssrIdentity === undefined ||
      typeof device.probeTextureFormatCapability !== 'function'
    )
      return;
    // RHI memoizes the probe per physical device. Retain the detached candidate
    // receipt without publishing it: inspection selects only the active device.
    // A failed/late recovery therefore cannot overwrite the active generation.
    try {
      const factory = internals.immediateShaderModuleFactory ?? internals.shaderModuleFactory;
      const result =
        device.caps.compute && device.caps.storageTexture
          ? await device.probeTextureFormatCapability()
          : factory === undefined
            ? undefined
            : await probeR32FloatRenderCapability(
                device,
                (descriptor) => factory.createShaderModule(descriptor),
                0,
              );

      if (result?.ok) ssrFormats.set(device, result.value);
    } catch {
      // Missing capability remains an explicit fallback-only admission.
    }
  };
  // GPU-driven production uses the validated adapter for normal frames. The
  // assembly-supplied closure resolves its device-bound adapter at call time,
  // so recovery candidate preparation still follows candidateShaderState
  // rather than retaining a lost-generation module.
  const gpuDrivenShaderFactory =
    internals.shaderModuleFactory ??
    internals.immediateShaderModuleFactory ??
    ({
      createShaderModule: () =>
        err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'the renderer backend exposes shader module creation',
            hint: 'construct the renderer through the backend pack before activating GPU-driven rendering',
          }),
        ),
    } satisfies import('./pipeline-builder').PipelineBuilderShaderModuleFactory);
  const cubeCaptureState: CubeCaptureGraphState = { work: [] };
  /** This system's last record-attempt outcome, rewritten in place per attempt. */

  const sceneComposition =
    internals.sceneComposition ??
    new SceneComposition({
      terrainLayers: new TerrainLayers(
        () => internals.gpuStore,
        () => internals.device,
        internals.immediateShaderModuleFactory ?? gpuDrivenShaderFactory,
      ),
      assets: internals.assets,
      shaderRegistry: internals.assets.shaderRegistry,
      getDevice: () => internals.device,
      onGpuError: (error) => internals.errorRegistry.fire(error),
      onAssetChange: (scope, change) => {
        // Published GPU residency is adopted once by the outer view assembly.
        if (scope.world === undefined) return;
        const content = change.removed
          ? undefined
          : scope.resolveAsset<import('@forgeax/engine-types').Asset>(change.handle);
        const mesh = content?.ok && content.value.kind === 'mesh' ? content.value : undefined;
        const adopted = internals.gpuStore.adoptMeshChange(change, mesh, scope);
        if (!adopted.ok) internals.errorRegistry.fire(adopted.error);
        const texture = content?.ok && content.value.kind === 'texture' ? content.value : undefined;
        const adoptedTexture = internals.gpuStore.adoptTextureChange(change, texture, scope);
        if (!adoptedTexture.ok) internals.errorRegistry.fire(adoptedTexture.error);
        internals.gpuStore.invalidateSampler(change.handle, scope);
        internals.gpuStore.adoptCubemapChange(change, scope);
      },
      instanceCollections,
    });
  internals.sceneComposition = sceneComposition;
  registerPassPlanSystems(renderWorldFor(internals));
  // The composition owner registers the one scene adoption system of its Render World.
  if (ownsSceneComposition) {
    registerSceneSystem(renderWorldFor(internals), sceneComposition, internals.assets);
    registerViewFrameSystem(renderWorldFor(internals));
    registerSkinDemandSystem(renderWorldFor(internals));
    registerMaterialSystems(renderWorldFor(internals));
    registerLightSystems(renderWorldFor(internals));
    registerShadowCasterSystem(renderWorldFor(internals));
    registerVisibleSurfaceSystem(renderWorldFor(internals), {
      enabled: () => internals.standardProfile?.visibleSurface === true,
      retained: () => sceneComposition.compositionRetainedScene(),
      maxRecords: () =>
        Math.min(1048576, Math.floor(internals.device.limits.maxStorageBufferBindingSize / 64)),
    });
    registerReflectionProbeSystems(renderWorldFor(internals));
    registerViewDiffuseGiSystem(renderWorldFor(internals));
    registerDebugOverlaySystems(renderWorldFor(internals));
    registerStandardLightingSystem(renderWorldFor(internals));
    registerFeatureViewsSystem(renderWorldFor(internals));
    registerCaptureFaceFeatureSystem(renderWorldFor(internals));
    registerViewCaptureSystems(renderWorldFor(internals));
    registerTemporalStageSystems(renderWorldFor(internals));
    registerFeaturePlanSystems(renderWorldFor(internals));
    registerTransmissionSystem(renderWorldFor(internals));
    registerEnvironmentAdmissionSystem(renderWorldFor(internals));
    registerSsrAdmissionSystem(renderWorldFor(internals));
    registerGpuDrivenPrepareSystem(renderWorldFor(internals));
    registerGpuDrivenRasterSystem(renderWorldFor(internals));
    registerSubsurfaceAdmissionSystem(renderWorldFor(internals));
    registerViewTopologySystem(renderWorldFor(internals));
    registerHistoryAdmissionSystem(renderWorldFor(internals));
  }
  const terrainLayers = sceneComposition.terrainLayers;
  if (terrainLayers === undefined)
    throw new Error('The Renderer composition owns its terrain layers');
  Object.assign(internals, { preparedMaterialTexture: terrainLayers.texture.bind(terrainLayers) });
  const persistentRenderScene = new PersistentRenderScene(
    {
      getTemporalConsumerDemand: () => internals.standardProfile?.visibleSurface === true,
      // Each view adopts its own GI dependencies once per shared change, even when held.
      onViewAssetChange: (scope, change) => {
        frameState.irradianceField?.adoptAsset(scope, change);
        frameState.firedEquirectProjectionFailedHandles.delete(change.handle);
      },
    },
    sceneComposition,
    ownsSceneComposition,
  );
  const skinTasks = new RecordingSkinTasks({
    device: () => internals.device,
    roots: persistentRenderScene,
    reportError: (error) => internals.errorRegistry.fire(error),
  });
  // A recorded CPU Skin draw reads the binding its view's RenderQueue demand
  // composed; recording never composes a palette, and a gap is a diagnostic.
  const reportedSkinDemandGaps = new Set<number>();
  let skinDemandGapFrame = -1;
  Object.assign(internals, {
    skinTask: (
      source: Pick<RenderableSnapshot, 'worldId' | 'entityKey'>,
      pass: 'main' | 'shadow',
    ): SkinTaskBinding | undefined => {
      const demand = viewSkinDemandOf(renderWorldFor(internals), internals.viewEntity);
      // The demand's own failure fails the recording, as the palette composition did.
      if (demand?.ok === false) throw demand.cause;
      const key = worldEntityKey(source.worldId, source.entityKey);
      if (demand?.value.has(key) === true) return demand.value.get(key);
      const frame = renderSubmission(renderWorldFor(internals)).frame;
      if (frame !== skinDemandGapFrame) {
        skinDemandGapFrame = frame;
        reportedSkinDemandGaps.clear();
      }
      if (!reportedSkinDemandGaps.has(key)) {
        reportedSkinDemandGaps.add(key);
        internals.errorRegistry.fire(
          new SkinDemandMissingError(source.worldId, source.entityKey, pass),
        );
      }
      return undefined;
    },
    demandCapsuleShadow: (source: Parameters<RecordingSkinTasks['capsules']>[0]) =>
      skinTasks.capsules(source),
  });
  let gpuDrivenRecoveryCount = 0;
  const surfaceSubmissionObservation = new SurfaceSubmissionObservationOwner(
    () => recordContext(internals).deviceScope.generation,
  );
  let gpuDrivenProduction = createGpuDrivenOwner(
    internals.device,
    gpuDrivenShaderFactory,
    gpuDrivenRecoveryCount,
  );
  const createFeatureGpuWorkOwner = (runtime: RenderSystemInternals): RenderFeatureGpuWorkOwner =>
    createRenderFeatureGpuWorkOwner({
      getDevice: () => runtime.device,
      getShaderModuleFactory: () =>
        runtime.shaderModuleFactory ??
        ({
          createShaderModule: () =>
            err(
              new RhiError({
                code: 'rhi-not-available',
                expected: 'the renderer backend exposes shader module creation',
                hint: 'construct the renderer through the backend pack before activating GPU features',
              }),
            ),
        } satisfies import('./pipeline-builder').PipelineBuilderShaderModuleFactory),
      getImmediateShaderModuleFactory: () =>
        runtime.immediateShaderModuleFactory ??
        runtime.shaderModuleFactory ??
        ({
          createShaderModule: () =>
            err(
              new RhiError({
                code: 'rhi-not-available',
                expected: 'the renderer backend exposes shader module creation',
                hint: 'construct the renderer through the backend pack before activating GPU features',
              }),
            ),
        } satisfies import('./pipeline-builder').PipelineBuilderShaderModuleFactory),
    });
  let featureGpuWork =
    recordContext(internals).sharedFeatureGpuWork ?? createFeatureGpuWorkOwner(internals);
  const disposeFeatureGpuWork = (): void => {
    if (recordContext(internals).sharedFeatureGpuWork !== undefined) return;
    const disposed = featureGpuWork.dispose();
    if (!disposed.ok) internals.errorRegistry.fire(disposed.error);
  };
  // Per-RendererState frame state: closure-internal frameNumber + the
  // per-entity instance GPU buffer cache (feat-20260514 M3 / w15: the
  // record stage owns GPU storage buffer allocation for Instances entities;
  // the `instanceBuffers` map is keyed by the packed Entity u32 surfaced
  // through `InstancesSnapshot.cacheKey` and rebuilds buffers on archetype
  // version bump or byte-length change). The legacy
  // `lastFiredLimitExceededFrame` engine-side dedup field was removed in
  // feat-20260513-instanced-mesh M5 (T-M5-1 + T-M5-3); the active
  // `'limit-exceeded'` emit point is now the record stage upload path.
  //
  // feat-20260708 M1 / D-1a #1: positive-half keys are worldEntityKey(worldId,
  // cacheKey) composites. Negative-half fold-bucket keys (sprite fold) stay
  // raw (material-handle-based, cross-world collision semantically correct).
  const frameState: RenderFrameState = {
    frameNumber: 0,
    renderBundleCounters: { hits: 0, misses: 0 },
    surfaceSubmissionObservation: undefined,
    ssrRequested: false,
    ssrSpatialAdmission: undefined,
    ssrHistoryOwner: undefined,
    ssrTemporalParamsPayload: new Uint8Array(32),
    ssrLastCameraEntity: undefined,
    ssrLastHistoryVersion: undefined,
    graphGeneration: 0,
    lastSuccessfulBloom: 'off',
    temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
    reflectionFallbackReadback: undefined,
    directionalShadowCache: null,
    directionalShadowCacheRecorded: false,
    shadowRaster: new ShadowRasterLedger(),
    compiledFrameGraph: null,
    compiledFrameGraphGeneration: 0,
    depthOfFieldAccepted: undefined,
    depthOfFieldLastSubmitFailed: false,
    volumetricFogParams: emptyVolumetricFogParams(),
    volumetricFogInspection: inspectVolumetricFog({ authored: false, capability: 'available' }),
    volumetricFogAccepted: undefined,
    volumetricFogAcceptedContext: undefined,
    volumetricFogHistoryGraph: null,
    volumetricFogHistorySlot: null,
    volumetricFogHistorySignature: null,
    retiredCompiledFrameGraphs: new Set(),
    frameOutputs: emptyFrameRecordingOutputs(),
    reflectionFallbackObservationSource: undefined,
    lastSuccessfulCameraAntialias: undefined,
    lastSuccessfulBarrelDistortion: undefined,
    barrelDistortionGraphResolution: 'accepted',
    temporalGpuState: undefined,
    autoExposureGpuResources: undefined,
    pendingAutoExposureGpuResources: undefined,
    autoExposureState: undefined,
    pendingAutoExposureState: undefined,
    standardLutGpuResources: undefined,
    pendingStandardLutGpuResources: undefined,
    standardLutState: createStandardLutState({
      deviceEpoch: recordContext(internals).deviceScope.generation,
    }),
    pendingStandardLutState: undefined,
    activeTemporalGpuState: undefined,
    retiringTemporalGpuStates: new Set(),
    temporalView: new TemporalViewHistory(),
    environmentGeneration: undefined,
    environmentLifecycle: new EnvironmentLifecycle(recordContext(internals).deviceScope),
    instanceBuffers: new Map(),
    instanceCollections,
    instanceBufferChunks: new Map(),
    probeBlendBuffers: new Map(),
    probeBlendRecordBufferCapacity: 0,
    hdrpClusterBinScratch: createClusterBinScratch(),
    standardClusterMembership: new StandardClusterMembershipOwner(),
    hdrpClusterMembership: null,
    standardLightingGraphSignature: '',
    submittedInspection: undefined,
    transientInstanceBuffers: [],
    warnedZeroLightStandard: false,
    // feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w19:
    // once-warn latches for >1 Skylight / >1 SkyboxBackground (names winner).
    warnedMultiSkylight: false,
    warnedMultiSkybox: false,
    warnedIgnoredDirectionalShadow: false,
    warnedSkyboxTonemapNone: false,
    // feat-20260520-2d-sprite-layer-mvp M-3 / w25 (AC-18 path 4): per-
    // handle warn-once anchor for the sprite-bucket missing-texture
    // fallback. Set<number> keyed by raw Handle<TextureAsset>; never
    // cleared (charter F1 minimal surface — the per-RendererState lifetime
    // is the natural upper bound).
    warnedMissingBaseColorTextureHandles: new Set<number>(),
    // feat-20260527-sprite-nineslice M2 / w11 + M4 / w16 (AC-16): once-per-
    // renderable guard for the runtime `nineslice.scale-too-small` metric
    // counter (`runtime.metrics.increment(...)` in render-system-record.ts).
    warnedNineSliceScaleEntities: new Set<number>(),
    // feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w18:
    // per-handle fire-once anchor for the lazy equirect projection failure
    // (EquirectProjectionFailedError). Set<number> keyed by raw
    // Handle<EquirectAsset>; never cleared (per-RendererState lifetime upper bound).
    firedEquirectProjectionFailedHandles: new Set<number>(),
    // feat-20260622-handle-to-id-allocator-elimination M1 / w3: per-frame
    // bind group caches as nested WeakMap chain roots. viewBindGroupCache
    // covers main and shadow variants; meshBindGroupCache keys on inner
    // buffer handles (D-3). Roots are stable between device recoveries.
    viewBindGroupCache: new WeakMap(),
    meshBindGroupCache: new WeakMap(),
    // feat-20260622-handle-to-id-allocator-elimination M1 / w2: per-entity
    // material and instances caches (outer Map<entityKey, WeakMap>).
    materialBgPerEntity: new Map(),
    instancesBgPerEntity: new Map(),
    instancesBgShared: new WeakMap(),
    // cross-entity shared material cache (outer Map<shaderId, WeakMap>).
    materialBgShared: new Map(),
    // cross-frame material assembly cache; entries are only retained when all
    // explicit texture/sampler handles resolved to resident GPU resources.
    materialBgAssemblyCache: new MaterialBgAssemblyCache(),
    // singleton material cache (flat Map<variant, BindGroup>; D-6).
    shadowMaterialBindGroups: new WeakMap(),
    // post-process bind group cache (bloom / fxaa / ssao): identity-keyed
    // WeakMap chain so resize-retired transient targets rebuild automatically.
    postProcessBgCache: new WeakMap(),
    // feat-20260601-customizable-render-pipeline-seam M1 / w7: installed-pipeline state.
    // 0 = nothing installed yet (createRenderer dogfood installs the default before a
    // draw). activePipeline defaults to the built-in forward pipeline.
    installedPipelineHandle: 0,
    activePipeline: recordContext(internals).standardPipeline,
    // feat-20260601 verify round 2: the standard forward pipeline installs with no config
    // (its topology is frame-invariant). Standard configuration overwrites this with the
    // resolved asset config on every swap so the active graph reads its current config.
    installedPipelineConfig: undefined,
    // Install-time configuration stays separate from the private selected-view override.
    standardInstall: { configured: undefined, built: 0, cameraSignature: '', cameraFailure: '' },
    standardOncePerFrameFired: new Set(),
    // feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-2 (plan-strategy §D-1):
    // cube_array shadow atlas + per-frame snapshot list. Atlas is null until the
    // first frame whose extracted lights.pointShadow is non-empty (zero-shadow
    // scenes never allocate; AC-09); the snapshot list defaults to an empty
    // tuple so the typed point-shadow graph sees zero shadow lights as the
    // initial steady state.
    pointShadowAtlas: null,
    pointShadowSnapshots: [],
    // feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4 (D-1):
    // initial fold-bucket count is 0; recordFrame writes the per-frame
    // value from foldDispatchBuckets(...) before dispatch.
    lastFoldBucketCount: 0,
    // feat-20260625-spot-light-shadow-mapping M2 / w9 (D-2): empty initial spot
    // shadow snapshot list so the spotShadowDepth caster pass renders zero
    // tiles until the first frame with a castShadow spot (AC-03).
    spotShadowSnapshots: [],
    darkShadowViews: { point: new Set(), spot: new Set() },
  };
  const postProcessOwner = createPostProcessParamsOwner(internals, (id, moduleLabel) => {
    clearPostProcessPipelineCache(id);
    recordContext(internals).invalidateShaderModule?.(moduleLabel);
  });
  const lookupPostProcess = postProcessOwner.lookup;
  const invalidatePostProcessModule = (id: string): void => {
    const entry = lookupPostProcess(id);
    if (entry !== undefined) {
      recordContext(internals).invalidateShaderModule?.(postProcessShaderModuleLabel(entry.source));
    }
  };
  // feat-20260609 M4 / T-10-a: post-process pipeline cache (declaration|colorFormat -> RhiRenderPipeline).
  // Solves CONCERN-1: dispatcher previously passed `pipeline=null` to
  // built.createHandle because per-frame execute closures cannot await async
  // shader compile. The cache here delegates the actual build to
  // `internals.buildPostProcessPipeline` (sync wrapper over the shared shader
  // adapter; 1-frame warmup), then memoizes by declaration identity + format.
  const postProcessPipelineCache = new Map<string, RenderPipeline>();
  const getPostProcessPipeline = (
    id: string,
    bgl: BindGroupLayout,
    colorFormats: readonly GPUTextureFormat[],
    entryOverride?: PostProcessShaderEntry,
  ): RenderPipeline | null => {
    const entry = entryOverride ?? lookupPostProcess(id);
    if (entry === undefined) return null;
    const signature = postProcessShaderEntrySignature(entry);
    const key = `${id}|${colorFormats.join(',')}|${signature}`;
    const cached = postProcessPipelineCache.get(key);
    if (cached !== undefined) return cached;
    const factory = internals.buildPostProcessPipeline;
    if (factory === undefined) return null;
    const built = factory(
      entry,
      bgl,
      colorFormats,
      postProcessShaderPipelineLabel(id, entry.source),
    );
    if (built === null) return null;
    postProcessPipelineCache.set(key, built);
    return built;
  };
  const clearPostProcessPipelineCache = (id: string): void => {
    for (const key of postProcessPipelineCache.keys()) {
      if (key.startsWith(`${id}|`)) postProcessPipelineCache.delete(key);
    }
  };
  const clearPostProcessPipelineEntry = (id: string, entry: PostProcessShaderEntry): void => {
    const suffix = `|${postProcessShaderEntrySignature(entry)}`;
    for (const key of postProcessPipelineCache.keys()) {
      if (key.startsWith(`${id}|`) && key.endsWith(suffix)) {
        postProcessPipelineCache.delete(key);
      }
    }
  };
  Object.assign(internals, {
    lookupPostProcess,
    getPostProcessParamsBuffer: postProcessOwner.getBuffer,
    getPostProcessPipeline,
    clearPostProcessPipelineCache,
  });
  const lodInspection = new LodInspectionOwner(internals, persistentRenderScene);
  const activePreparedResolverCaches = createPreparedResolverCaches();
  // The view's owner bag: the Render World per-view prepare and settle systems
  // reach its frame state, scene, probes, captures and SSR receipts through it.
  const viewOwner: ViewSettlementOwner = {
    recording: recordingState,
    frameState,
    internals,
    skin: skinTasks,
    scene: persistentRenderScene,
    reflectionProbes: reflectionProbeOwner,
    ssrFormats,
    captures: cubeCaptureState,
    postProcess: {
      params: postProcessOwner,
      clearPipelineCache: clearPostProcessPipelineCache,
      clearPipelineEntry: clearPostProcessPipelineEntry,
      invalidateModule: invalidatePostProcessModule,
    },
    preparedResolver: {
      runtime: internals,
      get gpuWork() {
        return featureGpuWork;
      },
      caches: activePreparedResolverCaches,
      builtinPostProcessEntries: postProcessOwner.builtinEntries,
      skylightResources: () => featureSkylightOf(renderWorldFor(internals), internals.viewEntity),
    },
    lod: lodInspection,
    get gpuDriven() {
      return gpuDrivenProduction;
    },
    surfaceSubmission: surfaceSubmissionObservation,
    instanceCollections,
    recorded,

    disposeFrameState(): void {
      frameState.gtaoCandidatePreparationFailureGeneration = undefined;
      let failure: unknown;
      try {
        frameState.standardClusterMembership.clear();
        frameState.candidatePipelinePreparations?.dispose();
        if (ownsSceneInputs) recordContext(internals).featureSceneInputs?.dispose();
        disposeTargetCaptures(cubeCaptureState);
        frameState.dynamicResolution?.reset();
        viewPointsLines(renderWorldFor(internals), internals.viewEntity)?.dispose();
        persistentRenderScene.dispose();
        if (ownsSceneComposition) terrainLayers.dispose();
        if (ownsInstanceCollections) instanceCollections.dispose();
        gpuDrivenProduction.dispose();
        disposeFeatureGpuWork();
        reflectionProbeOwner.dispose();
        frameState.ssrHistoryOwner?.dispose();
        frameState.probePlacement?.dispose();
        frameState.probePlacement = undefined;
        frameState.probePlacementFrame = undefined;
        frameState.rayDiffuse?.dispose();
        frameState.rayDiffuse = undefined;
        frameState.irradianceField?.dispose();
        frameState.irradianceField = undefined;
        frameState.screenProbe?.dispose();
        frameState.screenProbe = undefined;
        frameState.bakedField?.dispose();
        frameState.bakedField = undefined;
        frameState.ssrHistoryOwner = undefined;
        frameState.ssrSpatialAdmission = undefined;
        // Bloom generations are renderer-owned rather than graph-owned. Drain
        // candidate, active, and fence-retiring bundles before the rest of the
        // frame state is torn down; the owner callback is idempotent so the
        // outer Renderer.dispose cascade can safely call this once only.
        recordContext(internals).getPipelineState()?.perPassResources.drainBloomResources?.();
        internals.clearPostProcessPipelineCache?.('forgeax.taa-resolve');
        invalidatePostProcessModule('forgeax.taa-resolve');
        // Post-process parameter UBOs are renderer-owned persistent resources,
        // rather than graph-owned transient state. Clear the active table before
        // the feature host is retired so the renderer remains the sole owner.
        postProcessOwner.dispose();
        resetSsaoResources(internals);
        resetHdrpBuffers(internals);
        // Retire graph-owned resources and dispose instance-buffer caches.
        frameState.renderBundleCaches?.passes.clear();
        // Both calls are idempotent + tolerate per-handle errors silently;
        // the Renderer.dispose() cascade owns the surrounding try/catch
        // (D-3 method A: void signature, sub-errors fan out via
        // errorRegistry.fire at the cascade layer, dispose still walks all
        // 6 steps).
        frameState.directionalShadowCache?.meshReads.release();
        frameState.directionalShadowCache = null;
        frameState.directionalShadowLod = undefined;
        frameState.directionalShadowCacheRecorded = false;
        resetFrameRecordingOutputs(frameState.frameOutputs);
        frameState.lastSuccessfulCameraAntialias = undefined;
        frameState.lastSuccessfulBarrelDistortion = undefined;
        frameState.cloudHistoryActive = false;
        delete frameState.pendingCloudHistoryActive;
        disposeStandardOutput(frameState);
        releaseTemporalGpuStates(frameState);
        for (const buffer of frameState.volumetricFogParams.buffers) {
          if (buffer === null) continue;
          const destroyed = internals.device.destroyBuffer(buffer);
          if (!destroyed.ok) internals.errorRegistry.fire(destroyed.error);
        }
        frameState.volumetricFogParams = emptyVolumetricFogParams();
        frameState.volumetricFogAccepted = undefined;
        frameState.volumetricFogAcceptedContext = undefined;
        frameState.volumetricFogHistoryGraph = null;
        frameState.volumetricFogHistorySlot = null;
        frameState.volumetricFogHistorySignature = null;
        frameState.hdrpClusterMembership = null;
        discardCompiledFrameGraphs(frameState);
        frameState.standardLightingGraphSignature = '';
        frameState.submittedInspection = undefined;
        clearSubmittedTerrain();
        frameState.depthOfFieldAccepted = undefined;
        frameState.depthOfFieldLastSubmitFailed = false;
        // feat-20260619 M4 (D-6): pass errorRegistry to disposeInstanceBuffers
        // so destroy failures fire structured errors (unified per-frame +
        // dispose error strategy).
        disposeInstanceBuffers(frameState.instanceBuffers, internals.errorRegistry);
        if (frameState.instanceBufferChunks !== undefined) {
          disposeInstanceBufferChunks(frameState.instanceBufferChunks, internals.errorRegistry);
        }
        disposeTransientInstanceBuffers(
          frameState.transientInstanceBuffers,
          internals.errorRegistry,
        );
        if (frameState.probeBlendRecordBuffer !== undefined) {
          if (!frameState.probeBlendRecordBuffer.isDestroyed) {
            const result = frameState.probeBlendRecordBuffer.destroy();
            if (!result.ok) internals.errorRegistry.fire(result.error);
          }
          delete frameState.probeBlendRecordBuffer;
        }
        frameState.probeBlendRecordBufferCapacity = 0;
        frameState.probeBlendBuffers.clear();
        delete frameState.probeBlendRecordProjection;
        // feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-2: dispose the
        // cube_array shadow atlas owned by the RendererState closure. The atlas
        // is per-RendererState (= per Renderer) and is shared transparently
        // between URP and HDRP pipelines.
        // Idempotent: dispose() on a null / already-disposed atlas is a no-op.
        frameState.shadowDepthLayers?.dispose();
        frameState.shadowDepthLayers = undefined;
        if (frameState.pointShadowAtlas !== null) {
          frameState.pointShadowAtlas.dispose();
          frameState.pointShadowAtlas = null;
        }
      } catch (cause) {
        failure = cause;
      }
      try {
        skinTasks.dispose();
      } catch (cause) {
        if (failure === undefined) failure = cause;
        else
          failure = new AggregateError(
            [failure, cause],
            'Render state and Skin task disposal failed',
            { cause: failure },
          );
      }
      if (failure !== undefined) throw failure;
    },
  };
  internals.viewOwner = viewOwner;
  if (role === 'view') return viewOwner;
  const facade: RendererState = {
    initializeSsr: ensureSsrFormatProbe,
    releaseProfilerCatalog(): void {
      releaseProfilerCatalog?.();
      releaseProfilerCatalog = undefined;
    },
    detachScene(world: World): void {
      frameState.dynamicResolution?.reset();
      persistentRenderScene.detach(world);
      recordContext(internals).featureSceneInputs?.detach(worldRenderResources(world));
    },
    registerBuiltinPostProcess: postProcessOwner.registerBuiltinPostProcess,
    resetForRecover(retiringPipelineState?: PipelineState, replacementDevice?: RhiDevice): void {
      frameState.gtaoCandidatePreparationFailureGeneration = undefined;
      frameState.shadowDepthLayers?.dispose();
      frameState.shadowDepthLayers = undefined;
      disposeTargetCaptures(cubeCaptureState);
      frameState.dynamicResolution?.reset();
      // The active expansion buffers belong to the lost generation. Abandon
      // their handles without invoking destroy on a device that can no longer
      // service cleanup; the staged candidate owns the replacement buffers.
      viewPointsLines(renderWorldFor(internals), internals.viewEntity)?.abandonForDeviceLoss();
      resetStandardOutputForDeviceLoss(frameState, recordContext(internals).deviceScope.generation);
      ssrFormats.delete(internals.device);
      frameState.ssrFallbackGeneration = undefined;
      // The replacement device cannot consume buffers minted by the lost
      // device.  Drop the shared Standard Cluster bundle before the next
      // frame asks for a new generation; resetHdrpBuffers fences the bundle
      // using its own device/queue instead of the replacement runtime device.
      resetSsaoResources(internals);
      resetHdrpBuffers(internals);
      // Keep the persistent material demand observable across device loss.
      // The physical resource has already been fenced by markDeviceLost(); the
      // detached inspection now exposes the rebuild-required lifecycle until a
      // completed frame admits the replacement resource.
      recoverViewTransmission(renderWorldFor(internals), internals.viewEntity, viewOwner);
      persistentRenderScene.resetGpuForRecover();
      gpuDrivenProduction.dispose();
      gpuDrivenRecoveryCount += 1;
      gpuDrivenProduction = createGpuDrivenOwner(
        replacementDevice ?? internals.device,
        gpuDrivenShaderFactory,
        gpuDrivenRecoveryCount,
      );
      disposeFeatureGpuWork();
      recordContext(internals)
        .featureHost?.recover({
          caps: (replacementDevice ?? internals.device).caps,
          frameNumber: internals.rendererFrameNumber ?? frameState.frameNumber,
        })
        .unwrap();
      featureGpuWork = createFeatureGpuWorkOwner(internals);
      reflectionProbeOwner.dispose();
      frameState.ssrHistoryOwner?.dispose();
      frameState.probePlacement?.dispose();
      frameState.probePlacement = undefined;
      frameState.probePlacementFrame = undefined;
      frameState.rayDiffuse?.dispose();
      frameState.rayDiffuse = undefined;
      frameState.irradianceField?.dispose();
      frameState.irradianceField = undefined;
      frameState.screenProbe?.dispose();
      frameState.screenProbe = undefined;
      frameState.bakedField?.dispose();
      frameState.bakedField = undefined;
      frameState.ssrHistoryOwner = undefined;
      frameState.ssrSpatialAdmission = undefined;
      frameState.ssrRequested = false;
      frameState.ssrLastCameraEntity = undefined;
      frameState.ssrLastHistoryVersion = undefined;
      // A recovered device cannot retain handles from the lost device. The
      // Bloom owner abandons candidates and retires every committed generation
      // before the new PipelineState is rebuilt.
      (
        retiringPipelineState ?? recordContext(internals).getPipelineState()
      )?.perPassResources.drainBloomResources?.();
      // feat-20260622-s5 M3 / B-2 / w18: recover() rebuild drops device-bound
      // state minted by the lost device. The active graph and per-entity caches
      // must be discarded, not merely marked for destruction: their opaque
      // handles cannot be used on the fresh device and the next draw must
      // lazily build a new graph from the preserved ECS / asset POD caches.
      // Inspection and capture stay detached from graph-owned texture and
      // descriptor accessors until the replacement graph is accepted.
      discardCompiledFrameGraphs(frameState);
      frameState.volumetricFogAccepted = undefined;
      frameState.volumetricFogAcceptedContext = undefined;
      frameState.volumetricFogHistoryGraph = null;
      frameState.volumetricFogHistorySlot = null;
      frameState.volumetricFogHistorySignature = null;
      // The old device owns these transient params buffers. Discard their
      // handles without calling destroy() on the lost device; the next frame
      // must allocate fresh buffers on the replacement device.
      frameState.volumetricFogParams = emptyVolumetricFogParams();
      frameState.standardLightingGraphSignature = '';
      frameState.submittedInspection = undefined;
      clearSubmittedTerrain();
      frameState.depthOfFieldAccepted = undefined;
      frameState.depthOfFieldLastSubmitFailed = false;
      frameState.directionalShadowCache?.meshReads.release();
      frameState.directionalShadowCache = null;
      frameState.directionalShadowLod = undefined;
      frameState.directionalShadowCacheRecorded = false;
      resetFrameRecordingOutputs(frameState.frameOutputs);
      frameState.lastSuccessfulCameraAntialias = undefined;
      frameState.lastSuccessfulBarrelDistortion = undefined;
      frameState.cloudHistoryActive = false;
      delete frameState.pendingCloudHistoryActive;
      resetTemporalHistory(frameState, 'device-recovery');
      releaseTemporalGpuStates(frameState);
      frameState.hdrpClusterMembership = null;
      frameState.instanceBuffers.clear();
      frameState.instanceBufferChunks?.clear();
      instanceCollections._resetResidency();
      delete frameState.probeBlendRecordBuffer;
      frameState.probeBlendRecordBufferCapacity = 0;
      frameState.probeBlendBuffers.clear();
      delete frameState.probeBlendRecordProjection;
      frameState.transientInstanceBuffers = [];
      frameState.pointShadowAtlas = null;
      // Bind groups retain opaque handles from the lost device. WeakMap roots
      // cannot be cleared, so replace them; the Map-backed caches can be
      // emptied in place. The next frame recreates every binding from the
      // rebuilt PipelineState and fresh residency handles.
      frameState.viewBindGroupCache = new WeakMap();
      frameState.meshBindGroupCache = new WeakMap();
      frameState.materialBgPerEntity.clear();
      frameState.instancesBgPerEntity.clear();
      frameState.materialBgShared.clear();
      frameState.materialBgAssemblyCache.clear();
      frameState.renderBundleCaches?.passes.clear();
      frameState.shadowMaterialBindGroups = new WeakMap();
      frameState.postProcessBgCache = new WeakMap();
      // Fullscreen PSOs are cached outside frameState because the normal
      // path reuses them across frames. They still carry opaque handles from
      // the lost device, so recovery must invalidate this cache alongside the
      // feature-host declarations and UBOs below.
      postProcessPipelineCache.clear();
      // Logical declarations and the active params bundle stay live until the
      // candidate post-process bundle crosses the publication boundary.
      resetRenderFeatureGraphState(internals);
    },
    prepareRecoveryPostProcessResources(device: RhiDevice) {
      return postProcessOwner.prepareRecovery(device);
    },
    publishRecoveryPostProcessResources(candidate: RecoveryPostProcessResources): void {
      postProcessOwner.publishRecovery(candidate);
    },
    discardRecoveryPostProcessResources(candidate: RecoveryPostProcessResources): void {
      postProcessOwner.discardRecovery(candidate);
    },
    restorePostProcessResources(): void {
      const prepared = postProcessOwner.prepareRecovery(internals.device);
      if (!prepared.ok) throw prepared.error;
      postProcessOwner.publishRecovery(prepared.value);
    },
    prepareRecoveryRoots(runtime: RecoveryRootRuntime): RecoveryRootBundle {
      return prepareRenderSystemRecoveryRoots(runtime, frameState);
    },
  };
  return facade;
}

/** Resolve the build identity used by every inspection submit. */
export function resolveInspectionBuild(internals: Pick<RenderSystemInternals, 'build'>): string {
  return internals.build ?? 'render-system';
}
