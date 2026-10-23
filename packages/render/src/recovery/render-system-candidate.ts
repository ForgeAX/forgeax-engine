import type { MipmapEncoderWork } from '@forgeax/engine-assets-runtime';
import {
  type CommandBuffer,
  err,
  ok,
  type RenderPipeline,
  type Result,
  RhiError,
} from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import { terrainMaterialChannels } from '@forgeax/engine-terrain';
import type {
  AssetHandle,
  MaterialAsset,
  MeshAsset,
  SamplerAsset,
  TerrainAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import { materialProgramUsesSkin } from '@forgeax/engine-types';
import { createFeatureSceneInputs } from '../assembly/feature-scene-inputs';
import { requiresProbeBlendRecord } from '../assembly/material/artifact-probe-blend';
import { standardBloomAdmitted } from '../bloom-admission';
import { cloudShadowResolutionForQuality } from '../cloud/parameters';
import { createClusterBinScratch } from '../cluster-binner';
import type { EnvironmentLifecycle } from '../environment/lifecycle';
import {
  getRenderFeaturePlanExecutionProjection,
  type RenderFeatureFrameInput,
  type RenderFeatureHost,
  type RenderFeaturePreparedGraphicsResolverInput,
  runRenderFeatureFrame,
} from '../features/host';
import { motionBlurTemporalDemand } from '../features/motion-blur/motion-blur-params';
import { createFeatureNoiseResolver } from '../features/noise-texture';
import type { RenderFeaturePlannedFrame } from '../features/plan';
import type { RenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import { resolveStandardRenderFeatureTargets } from '../features/targets';
import { renderFeatureCameraView, renderFeatureViewIdentity } from '../features/view';
import {
  buildFullscreenPostProcessPass,
  entryHasDepthRead,
  type PostProcessShaderEntry,
  postProcessShaderEntrySignature,
} from '../fullscreen-post-process-pass';
import { collectGpuDrivenMaterialArtifacts } from '../gpu-driven/material-artifacts';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { disposeInstanceBufferChunks, disposeInstanceBuffers } from '../instance-buffer-cache';
import { inspectStandardLighting } from '../pipeline/standard-lighting/inspection';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import {
  prepareStandardOutputResources,
  resetStandardOutputForDeviceLoss,
  retirePendingStandardOutputGpu,
} from '../pipeline/standard-output/resources';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import { standardTopologyVariantSet } from '../pipeline-spec';
import { inspectPointShadow } from '../point-shadow-inspection';
import type { PreparedGraphicsResolver } from '../prepare/prepared-graphics-resolver';
import type { RenderResourceScope } from '../publication/resource-scope';
import { validateRenderables } from '../record/frame';
import { prepareFrameLighting } from '../record/frame-lighting';
import {
  emptyFrameRecordingOutputs,
  type RenderFrameState,
  type ValidatedRenderable,
} from '../record/frame-snapshot';
import { hasShadowViewDemand } from '../record/frame-targets';
import { resolveGeometryInstanceBuffer } from '../record/main-pass-geometry';
import { computeSplitLdrSprite } from '../record/main-pass-sprite-draws';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import type { PreparedResolverCaches } from '../record/prepared-material-bindings';
import { ensureProbeBlendRecordBuffer } from '../record/probe-blend-buffer';
import {
  prepareRecoveryPipelineReadiness,
  type RecoveryPipelineReadiness,
} from '../record/recovery-pipeline';
import type { PointsLinesRecordOwner, RenderSystemInternals } from '../record/render-context';
import { gpuDrivenMeshesForFrame, querySceneExecution } from '../record/resident-meshes';
import { ShadowRasterLedger } from '../record/shadow-raster-ledger';
import {
  ensureCompiledFrameGraph,
  getRenderFeatureGraphState,
  type RenderFeatureGraphCandidate,
  retire as retireCompiledGraph,
  shareRenderGraphGenerationAllocationOwner,
} from '../record/typed-frame-graph';
import { emptyVolumetricFogParams } from '../record/volume-params';
import { type CameraSnapshot, STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from '../render-contract';
import type { ExtractedFrame } from '../render-system-extract';
import { materialSamplerHandles, materialTextureHandles } from '../render-system-residency';
import type { PersistentGpuDrivenCandidate, PersistentRenderScene } from '../scene/render-scene';
import { SHADOW_ATLAS_DEFAULT_LAYERS } from '../shadow-atlas';
import { ReadonlyDynamicInputPage, type SurfaceDynamicInputFrame } from '../surface/dynamic-input';
import { createTemporalFrameTransaction } from '../temporal/frame';
import {
  getTemporalBindGroupResources,
  getTemporalGpuState,
  getTemporalParamsBuffer,
  TEMPORAL_HISTORY_FORMATS,
} from '../temporal/gpu';
import type {
  RecoveryGraphCandidate,
  RecoveryGraphCandidatePreparation,
  RecoveryGraphCandidateRuntime,
  RecoveryGraphSetupSubmission,
  RecoveryPointsLinesCandidate,
} from './types';

interface RecoveryFrameSeed {
  /** Exact feature POD from the submitted publication; never re-extract a receiver World. */
  readonly publishedFeatures?: RenderFeatureFrameInput['publishedFeatures'];
  readonly frame: ExtractedFrame;
  readonly worlds: readonly RenderResourceScope[];
  readonly cameraOwner: number;
  readonly resourceOwner: number;
  readonly width: number;
  readonly height: number;
  /** Last submitted Surface page is reused while the replacement device warms. */
  readonly surfaceDynamicInput?: SurfaceDynamicInputFrame;
  /** Last submitted RenderResourceScope/App time snapshot for the Surface frame ABI. */
  readonly frameTime?: number;
  /** Exact forward artifacts accepted by the submitted frame. */
  readonly materialArtifacts?: ReadonlyMap<string, MaterialShaderArtifact>;
  /** Exact ShadowCaster artifacts accepted by the submitted frame. */
  readonly shadowMaterialArtifacts?: ReadonlyMap<string, MaterialShaderArtifact>;
}

interface RenderSystemRecoveryDependencies {
  readonly frameState: RenderFrameState;
  readonly internals: RenderSystemInternals;
  readonly getEnvironmentLifecycle: () => EnvironmentLifecycle;
  readonly getGpuDrivenProduction: () => GpuDrivenProduction;
  readonly setGpuDrivenProduction: (production: GpuDrivenProduction) => void;
  readonly disposeFeatureGpuWork: () => void;
  readonly setFeatureGpuWork: (owner: RenderFeatureGpuWorkOwner) => void;
  readonly getActiveFeaturePostProcessEntries: () => ReadonlyMap<string, PostProcessShaderEntry>;
  readonly setActiveFeaturePostProcessEntries: (
    entries: ReadonlyMap<string, PostProcessShaderEntry>,
  ) => void;
  readonly postProcessPipelineCache: Map<string, RenderPipeline>;
  readonly clearPostProcessPipelineCache: (id: string) => void;
  readonly clearPostProcessPipelineEntry: (id: string, entry: PostProcessShaderEntry) => void;
  readonly invalidatePostProcessModule: (id: string) => void;
  readonly persistentRenderScene: PersistentRenderScene;
  readonly gpuDrivenShaderFactory: PipelineBuilderShaderModuleFactory;
  readonly createFeatureGpuWorkOwner: (runtime: RenderSystemInternals) => RenderFeatureGpuWorkOwner;
  readonly pointsLinesOwner: PointsLinesRecordOwner & {
    prepareRecoveryCandidate: (
      entries: readonly ValidatedRenderable[],
      clustered: boolean,
      runtime: RenderSystemInternals,
    ) => RecoveryPointsLinesCandidate | undefined;
  };
  readonly createPreparedResolverFactory: (
    runtime: RenderSystemInternals,
    gpuWork: RenderFeatureGpuWorkOwner,
    worlds: readonly RenderResourceScope[],
    caches: PreparedResolverCaches,
  ) => (input: RenderFeaturePreparedGraphicsResolverInput) => PreparedGraphicsResolver;
  readonly createPreparedResolverCaches: () => PreparedResolverCaches;
}

interface RenderSystemRecoveryOwner {
  setLastSuccessfulFrameSeed(seed: RecoveryFrameSeed): void;
  prepareRecoveryTextureData(runtime: RecoveryGraphCandidateRuntime): Promise<void>;
  prepareRecoveryGraphCandidate(
    runtime: RecoveryGraphCandidateRuntime,
  ): RecoveryGraphCandidatePreparation;
  submitCandidateSetup(
    candidate: RecoveryGraphCandidate,
    isValid: () => boolean,
  ): Result<RecoveryGraphSetupSubmission, RhiError>;
  publishRecoveryGraphCandidate(candidate: RecoveryGraphCandidate): void;
  discardRecoveryGraphCandidate(candidate: RecoveryGraphCandidate): void;
}

/**
 * Keep the missing-texture sentinel out of residency preparation. A zero
 * handle is the same absent-reference value used by materialHandle; resolving
 * it as a real TextureAsset would otherwise pass an undefined pod to the GPU
 * store and fail before the renderer can produce a structured readiness
 * result.
 */
export function createRenderSystemRecovery(
  deps: RenderSystemRecoveryDependencies,
): RenderSystemRecoveryOwner {
  const {
    frameState,
    internals,
    getEnvironmentLifecycle,
    getGpuDrivenProduction,
    setGpuDrivenProduction,
    disposeFeatureGpuWork,
    setFeatureGpuWork,
    getActiveFeaturePostProcessEntries,
    setActiveFeaturePostProcessEntries,
    postProcessPipelineCache,
    clearPostProcessPipelineCache,
    clearPostProcessPipelineEntry,
    invalidatePostProcessModule,
  } = deps;

  // This is a detached CPU projection, retained only after queue submission.
  // It is not a RenderResourceScope/lease cache and it never carries target or scheduler state.
  let lastSuccessfulFrameSeed: RecoveryFrameSeed | undefined;

  const createRecoveryCandidateFrameState = (): RenderFrameState => {
    const {
      probeBlendRecordBuffer: discardedProbeBlendRecordBuffer,
      instanceCollections: discardedInstanceInspection,
      ...baseFrameState
    } = frameState;
    void discardedProbeBlendRecordBuffer;
    // Candidate uploads must not publish residency into the active inspection.
    void discardedInstanceInspection;
    return {
      ...baseFrameState,
      successfulTemporalFrameIndex: 0,
      temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
      ssrRequested: false,
      ssrSpatialAdmission: undefined,
      ssrHistoryOwner: undefined,
      // These owners capture the lost device and retire at publication.
      // Rebuild from accepted inputs on the first replacement frame.
      rayDiffuse: undefined,
      irradianceField: undefined,
      screenProbe: undefined,
      probePlacement: undefined,
      probePlacementFrame: undefined,
      ssrTemporalParamsPayload: undefined,
      ssrLastCameraEntity: undefined,
      ssrLastHistoryVersion: undefined,
      graphTargetCapture: undefined,
      directionalShadowCache: null,
      directionalShadowCacheRecorded: false,
      shadowRaster: new ShadowRasterLedger(),
      shadowDepthLayers: undefined,
      compiledFrameGraph: null,
      compiledFrameGraphCandidate: undefined,
      volumetricFogParams: emptyVolumetricFogParams(),
      volumetricFogAccepted: undefined,
      volumetricFogAcceptedContext: undefined,
      volumetricFogHistoryGraph: null,
      volumetricFogHistorySlot: null,
      volumetricFogHistorySignature: null,
      retiredCompiledFrameGraphs: new Set(),
      frameOutputs: emptyFrameRecordingOutputs(),
      lastSuccessfulCameraAntialias: undefined,
      lastSuccessfulBarrelDistortion: undefined,
      temporalGpuState: undefined,
      activeTemporalGpuState: undefined,
      retiringTemporalGpuStates: new Set(),
      cloudHistoryActive: false,
      lastSuccessfulTemporalView: undefined,
      pendingTemporalCommit: { kind: 'none' },
      environmentGeneration: undefined,
      instanceBuffers: new Map(),
      instanceBufferChunks: new Map(),
      morphBuffers: new Map(),
      hdrpClusterBinScratch: createClusterBinScratch(),
      hdrpClusterGridScratch: null,
      hdrpLightIndexListScratch: null,
      hdrpClusterMembership: null,
      standardLightingGraphSignature: '',
      transientInstanceBuffers: [],
      pointShadowAtlas: null,
      pointShadowSnapshots: [],
      spotShadowSnapshots: [],
      viewBindGroupCache: new WeakMap(),
      meshBindGroupCache: new WeakMap(),
      materialBgPerEntity: new Map(),
      instancesBgPerEntity: new Map(),
      instancesBgShared: new WeakMap(),
      materialBgShared: new Map(),
      materialBgAssemblyCache: new MaterialBgAssemblyCache(),
      shadowMaterialBindGroups: new WeakMap(),
      postProcessBgCache: new WeakMap(),
      probeBlendBuffers: new Map(),
      probeBlendRecordBufferCapacity: 0,
      standardOncePerFrameFired: new Set(),
    } as RenderFrameState;
  };

  const publishRecoveryGraphCandidate = (candidate: RecoveryGraphCandidate): void => {
    if (candidate.recoveryReadiness.assertFirstRecoveryFrame) {
      candidate.recoveryReadiness.assertFirstRecoveryFrame();
    } else {
      candidate.recoveryReadiness.assertPreparedCache();
    }
    const previousFeatureHost = internals.featureHost;
    // The candidate graph proves topology and pipeline readiness before the
    // publication boundary, but its imported display view was acquired before
    // the shared canvas context was reconfigured for the replacement device.
    // Retire that frame-bound graph and preserve the prepared owners/caches;
    // the first recovered frame recompiles the same topology against the
    // newly configured context instead of submitting a view from the lost
    // device generation.
    const candidateDisplayGraph = candidate.frameState.compiledFrameGraph?.graph;
    candidate.frameState.compiledFrameGraph = null;
    candidate.frameState.compiledFrameGraphCandidate = undefined;
    candidateDisplayGraph?.retire().catch(() => undefined);
    // The caller enters this method only after the active generation swap and
    // after resetForRecover() has shed every lost-device owner. Replace the
    // whole device-bound frame projection so no stale cache/map/temporal view
    // survives publication; the candidate was already built from the CPU/LKG
    // facts before this synchronous boundary.
    Object.assign(frameState, candidate.frameState);
    // EnvironmentLifecycle is published by the candidate root bundle. The
    // candidate frame state was created before that owner switch, so bind the
    // freshly selected lifecycle explicitly at the same boundary.
    Object.assign(frameState, {
      environmentLifecycle: getEnvironmentLifecycle(),
      temporalFrame: undefined,
      bloomFrameReceipts: undefined,
    });
    candidate.gpuDrivenScene?.publish();
    if (candidate.gpuDrivenProduction !== undefined) {
      getGpuDrivenProduction().dispose();
      setGpuDrivenProduction(candidate.gpuDrivenProduction);
    }
    if (candidate.featureGpuWork !== undefined) {
      disposeFeatureGpuWork();
      setFeatureGpuWork(candidate.featureGpuWork);
    }
    if (candidate.featureSceneInputs !== undefined) {
      internals.featureSceneInputs?.dispose();
      internals.featureSceneInputs = candidate.featureSceneInputs;
    }
    if (candidate.featureHost !== undefined) {
      const setFeatureHost = internals.setFeatureHost;
      if (setFeatureHost !== undefined) setFeatureHost(candidate.featureHost);
      if (previousFeatureHost !== undefined && previousFeatureHost !== candidate.featureHost) {
        const disposed = previousFeatureHost.dispose();
        if (!disposed.ok) internals.errorRegistry.fire(disposed.error);
      }
    }
    if (candidate.featureGraphCandidate !== undefined) {
      for (const [id, previous] of getActiveFeaturePostProcessEntries()) {
        const next = candidate.featureGraphCandidate.fullscreenEffects.get(id);
        if (next === undefined) {
          clearPostProcessPipelineCache(id);
          invalidatePostProcessModule(id);
        } else if (
          postProcessShaderEntrySignature(previous) !== postProcessShaderEntrySignature(next)
        ) {
          clearPostProcessPipelineEntry(id, previous);
          if (previous.source !== next.source) invalidatePostProcessModule(id);
        }
      }
      setActiveFeaturePostProcessEntries(candidate.featureGraphCandidate.fullscreenEffects);
      const graphState = getRenderFeatureGraphState(internals);
      graphState.plans = candidate.featureGraphCandidate.plans;
      graphState.fullscreenEffects = candidate.featureGraphCandidate.fullscreenEffects;
    }
    for (const [key, pipeline] of candidate.postProcessPipelines ?? []) {
      postProcessPipelineCache.set(key, pipeline);
    }
  };

  const discardRecoveryGraphCandidate = (candidate: RecoveryGraphCandidate): void => {
    candidate.release();
  };

  const prepareRecoveryTextureData = async (
    runtime: RecoveryGraphCandidateRuntime,
  ): Promise<void> => {
    const seed = lastSuccessfulFrameSeed;
    if (seed === undefined) return;
    const store = runtime.internals.gpuStore;
    const waits: Promise<void>[] = [];
    const seen = new Map<RenderResourceScope, Map<number, number>>();
    const terrainLayers = new Set<TerrainAsset['layers']>();
    const prepare = (world: RenderResourceScope, handle: number, rgba: boolean) => {
      let handles = seen.get(world);
      if (handles === undefined) {
        handles = new Map();
        seen.set(world, handles);
      }
      const bit = rgba ? 2 : 1;
      const before = handles.get(handle) ?? 0;
      if ((before & bit) !== 0) return;
      handles.set(handle, before | bit);
      const source = world.resolveAsset<TextureAsset>(handle);
      if (!source.ok || source.value.encoding === undefined) return;
      store.prepareTextureData(
        handle,
        source.value,
        world,
        rgba ? (source.value.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm') : undefined,
      );
      waits.push(store.waitTextureData(handle, world));
    };
    for (const renderable of seed.frame.renderables) {
      const world = seed.worlds[renderable.worldId];
      if (world === undefined) continue;
      for (const material of renderable.materials)
        for (const handle of materialTextureHandles(material.snapshot))
          prepare(world, handle, false);
      let layers = renderable.terrainSection?.source.layers;
      if (layers === undefined && renderable.terrain !== undefined) {
        const source = world.resolveAsset<TerrainAsset>(renderable.terrain.handle);
        if (source.ok) layers = source.value.layers;
      }
      if (layers === undefined || terrainLayers.has(layers)) continue;
      terrainLayers.add(layers);
      // These are the submitted Terrain's ordinary Layer Material references,
      // not the generated section material's height/control texture bindings.
      for (const layer of layers) {
        const material = world.resolveAsset<MaterialAsset>(Number(layer.material));
        if (!material.ok) continue;
        for (const texture of terrainMaterialChannels(material.value).unwrap().textures)
          if (texture !== undefined) prepare(world, Number(texture), true);
        if (layer.blend === 'height') prepare(world, Number(layer.height), true);
      }
    }
    await Promise.all(waits);
  };

  const prepareRecoveryGraphCandidate = (
    runtime: RecoveryGraphCandidateRuntime,
  ): RecoveryGraphCandidatePreparation => {
    const seed = lastSuccessfulFrameSeed;
    if (seed === undefined) return { kind: 'no-seed' };
    const camera = seed.frame.cameras[0];
    // A successful clear-only draw can have no display camera. There is no
    // frame graph to rehydrate in that case, but the device generation is
    // still recoverable; the next camera-bearing draw will build its graph
    // from the current RenderResourceScope composition.
    if (camera === undefined) return { kind: 'no-seed' };

    const candidateFrameState = createRecoveryCandidateFrameState();
    // Candidate graph generations are one renderer-owned allocation stream;
    // publication changes their role, not their accounting owner.
    shareRenderGraphGenerationAllocationOwner(frameState, candidateFrameState);
    resetStandardOutputForDeviceLoss(candidateFrameState, runtime.internals.deviceScope.generation);
    Object.assign(candidateFrameState, {
      temporalFrame: undefined,
      bloomFrameReceipts: undefined,
    });
    const candidateSceneInputs = createFeatureSceneInputs(
      runtime.internals,
      createFeatureNoiseResolver({
        scope: runtime.internals.deviceScope,
        getDevice: () => runtime.internals.device,
        onError: (error) => runtime.internals.errorRegistry.fire(error),
      }),
    );
    runtime.internals.featureSceneInputs = candidateSceneInputs;
    candidateSceneInputs.begin(candidateFrameState.frameNumber);
    return new RecoveryCandidateBuild(
      deps,
      runtime,
      seed,
      camera,
      candidateFrameState,
      candidateSceneInputs,
    ).prepare();
  };

  const submitCandidateSetup = (
    candidate: RecoveryGraphCandidate,
    isValid: () => boolean,
  ): Result<RecoveryGraphSetupSubmission, RhiError> => {
    const setupFailure = (hint: string): Result<never, RhiError> =>
      err(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'recovery setup remains candidate-only and valid before publication',
          hint,
        }),
      );
    const discardSetupWorks = (): void => {
      for (const work of candidate.setupWorks) work.discard();
    };
    try {
      if (!isValid()) {
        discardSetupWorks();
        return setupFailure('discard the recovery candidate after its setup deadline or loss');
      }
      const commandBuffers: CommandBuffer[] = [];
      for (const work of candidate.setupWorks) {
        const finished = work.finish();
        if (!finished.ok) {
          discardSetupWorks();
          return err(finished.error);
        }
        if (finished.value !== undefined) commandBuffers.push(finished.value);
      }
      if (!isValid()) {
        discardSetupWorks();
        return setupFailure('discard the recovery candidate after mip setup became stale');
      }
      if (commandBuffers.length === 0) return ok({});
      const submitted = candidate.device.queue.submit(commandBuffers);
      discardSetupWorks();
      if (!submitted.ok) return err(submitted.error);
      if (!isValid()) {
        return setupFailure('discard the recovery candidate after setup submission became stale');
      }
      return ok({ completion: candidate.device.queue.onSubmittedWorkDone() });
    } catch (cause) {
      discardSetupWorks();
      if (cause instanceof RhiError) return err(cause);
      return setupFailure(`recovery setup submission raised: ${String(cause)}`);
    }
  };

  return {
    setLastSuccessfulFrameSeed(seed: RecoveryFrameSeed): void {
      lastSuccessfulFrameSeed = seed;
    },
    prepareRecoveryTextureData,
    prepareRecoveryGraphCandidate,
    submitCandidateSetup,
    publishRecoveryGraphCandidate,
    discardRecoveryGraphCandidate,
  };
}

/** Candidate-owned recovery preparation: every GPU owner it creates is released together unless published. */
class RecoveryCandidateBuild {
  private readonly setupWorks: MipmapEncoderWork[] = [];
  private readonly gpuStore: RenderSystemInternals['gpuStore'];
  private gpuDrivenScene: PersistentGpuDrivenCandidate | undefined;
  private gpuDrivenProduction: GpuDrivenProduction | undefined;
  private featureHost: RenderFeatureHost | undefined;
  private featureGpuWork: RenderFeatureGpuWorkOwner | undefined;
  private pointsLines: RecoveryPointsLinesCandidate | undefined;
  private surfacePage: ReadonlyDynamicInputPage | undefined;
  private featureGraph: RenderFeatureGraphCandidate = {
    plans: Object.freeze([]),
    fullscreenEffects: new Map(),
  };
  private validated: ValidatedRenderable[] = [];
  private preparedGpuDriven:
    | import('../gpu-driven/production-raster').PreparedGpuDrivenFrame
    | undefined;
  private graphFailure: unknown;
  private published = false;
  private released = false;

  constructor(
    private readonly deps: RenderSystemRecoveryDependencies,
    private readonly runtime: RecoveryGraphCandidateRuntime,
    private seed: RecoveryFrameSeed,
    private readonly camera: CameraSnapshot,
    private readonly frameState: RenderFrameState,
    private readonly sceneInputs: ReturnType<typeof createFeatureSceneInputs>,
  ) {
    this.gpuStore = runtime.internals.gpuStore;
  }

  prepare(): RecoveryGraphCandidatePreparation {
    try {
      return this.prepareReady();
    } catch (cause) {
      return this.failed(`candidate preparation threw: ${String(cause)}`, cause);
    }
  }

  private failed(
    reason: string,
    cause: unknown = this.graphFailure,
  ): RecoveryGraphCandidatePreparation {
    this.release();
    return cause === undefined ? { kind: 'failed', reason } : { kind: 'failed', reason, cause };
  }

  readonly release = (): void => {
    if (this.released || this.published) return;
    this.released = true;
    const frameState = this.frameState;
    retirePendingStandardOutputGpu(frameState);
    for (const work of this.setupWorks) work.discard();
    const graph = frameState.compiledFrameGraph?.graph;
    frameState.compiledFrameGraph = null;
    frameState.compiledFrameGraphCandidate = undefined;
    try {
      if (graph !== undefined) retireCompiledGraph(frameState, graph);
    } catch {
      // Candidate cleanup continues through every independent owner.
    }
    try {
      frameState.pointShadowAtlas?.dispose();
      frameState.shadowDepthLayers?.dispose();
    } catch {
      // Candidate cleanup continues through every independent owner.
    }
    frameState.pointShadowAtlas = null;
    this.featureGraph.onAbandoned?.();
    const featureHost = this.featureHost;
    this.featureHost = undefined;
    featureHost?.dispose();
    this.featureGpuWork?.dispose();
    this.featureGpuWork = undefined;
    this.sceneInputs.dispose();
    this.gpuDrivenProduction?.dispose();
    this.gpuDrivenProduction = undefined;
    this.gpuDrivenScene?.release();
    this.gpuDrivenScene = undefined;
    this.pointsLines?.release();
    this.pointsLines = undefined;
    this.surfacePage?.release();
    this.surfacePage = undefined;
    const errorRegistry = this.runtime.internals.errorRegistry;
    disposeInstanceBuffers(frameState.instanceBuffers, errorRegistry);
    if (frameState.instanceBufferChunks !== undefined) {
      disposeInstanceBufferChunks(frameState.instanceBufferChunks, errorRegistry);
    }
    this.gpuStore.destroyAll();
  };

  readonly markPublished = (): void => {
    // The readiness graph is retired at publication; it is never submitted.
    this.preparedGpuDriven?._abortResourceReplacement?.();
    this.preparedGpuDriven = undefined;
    this.pointsLines?.publish();
    this.surfacePage?.release();
    this.surfacePage = undefined;
    this.published = true;
  };

  private prepareReady(): RecoveryGraphCandidatePreparation {
    const { internals, pipelineState } = this.runtime;
    const camera = this.camera;
    const output = prepareStandardOutputResources(
      this.frameState,
      internals,
      camera,
      this.seed.worlds[this.seed.cameraOwner] as RenderResourceScope,
    );
    if (!output.ok)
      return this.failed('candidate Standard output preparation failed', output.error);
    const gpuScene = this.deps.persistentRenderScene.prepareRecoveryGpuDrivenCandidate(
      internals.device,
    );
    if (!gpuScene.ok) return this.failed('candidate GPU scene preparation failed', gpuScene.error);
    this.gpuDrivenScene = gpuScene.value;
    this.seed = withoutTemporalSnapshots(this.seed);
    const seed = this.seed;
    this.validated = validateRenderables(
      internals,
      seed.worlds[seed.cameraOwner] as RenderResourceScope,
      seed.worlds,
      pipelineState,
      this.frameState,
      seed.frame.renderables,
      seed.frame.dispatch,
    );
    if (this.validated.length !== seed.frame.renderables.length) {
      return this.failed('candidate validation did not retain every LKG-visible renderable');
    }
    const lighting = prepareFrameLighting(
      internals,
      this.frameState,
      seed.frame.lights,
      camera,
      pipelineState,
    );
    if (!lighting.ok) return this.failed('candidate lighting preparation failed');
    const standardLighting = lighting.value.standard;
    const surface = this.recoverSurfaceDynamicInput();
    if (!surface.ok) return surface.error;
    if (this.gpuDrivenScene.state !== undefined) {
      const gpuDrivenFailure = this.prepareGpuDriven(
        this.gpuDrivenScene.state,
        standardLighting,
        surface.value,
      );
      if (gpuDrivenFailure !== undefined) return gpuDrivenFailure;
    }
    let failure = this.prepareInstances();
    if (failure !== undefined) return failure;
    failure = this.prepareFeatures();
    if (failure !== undefined) return failure;
    failure = this.prepareRenderableResidency();
    if (failure !== undefined) return failure;
    failure = this.prepareVolumetricFogResidency();
    if (failure !== undefined) return failure;
    this.pointsLines = this.deps.pointsLinesOwner.prepareRecoveryCandidate(
      this.validated,
      standardLighting?.kind === 'clustered',
      internals,
    );
    const recoveryReadiness = this.prepareReadiness(standardLighting);
    const warmFailure = this.warmPostProcessing();
    if (warmFailure !== undefined) return warmFailure;
    return this.compileGraph(standardLighting, recoveryReadiness);
  }

  /** Rebind the last submitted Surface page onto the replacement device generation. */
  private recoverSurfaceDynamicInput(): Result<
    SurfaceDynamicInputFrame | undefined,
    RecoveryGraphCandidatePreparation
  > {
    const source = this.seed.surfaceDynamicInput;
    const generation = this.runtime.internals.deviceScope.generation;
    if (source === undefined || source.page.deviceGeneration === generation) return ok(source);
    const created = ReadonlyDynamicInputPage.create({
      sourceId: source.page.sourceId,
      pageId: source.page.pageId,
      schema: source.page.schema,
    });
    if (!created.ok) {
      return err(this.failed('candidate Surface recovery page creation failed', created.error));
    }
    const page = created.value;
    this.surfacePage = page;
    // Preserve CPU-authored parameters before preparing the replacement GPU page.
    page.bytes.set(source.page.bytes);
    const reconfigured = page.reconfigureDevice(generation);
    if (!reconfigured.ok) {
      return err(
        this.failed('candidate Surface recovery page generation failed', reconfigured.error),
      );
    }
    const ranges = (source.ranges ?? []).map((range) => {
      const reserved = page.reserveRange({
        domain: range.domain,
        recordStart: range.recordStart,
        recordCount: range.recordCount,
        instanceIndex: range.instanceIndex,
        member: range.member,
      });
      if (!reserved.ok) throw reserved.error;
      return reserved.value;
    });
    return ok({
      page,
      ranges,
      projectionRevision: source.projectionRevision + 1,
      frameTime: source.frameTime,
    });
  }

  /** Recovery compiles real execution work, including every shared Mesh section. */
  private prepareGpuDriven(
    state: NonNullable<PersistentGpuDrivenCandidate['state']>,
    standardLighting: StandardTopologyInputValue,
    surfaceDynamicInput: SurfaceDynamicInputFrame | undefined,
  ): RecoveryGraphCandidatePreparation | undefined {
    const { internals, pipelineState } = this.runtime;
    const seed = this.seed;
    const candidateScene = querySceneExecution(state);
    const production = GpuDrivenProduction.forDevice(
      internals.device,
      this.deps.gpuDrivenShaderFactory,
    );
    this.gpuDrivenProduction = production;
    const clustered = standardLighting?.kind === 'clustered';
    const standardPbr = this.standardPbrArtifacts(standardLighting);
    const shadowProjection = this.deps.persistentRenderScene.shadowCasterProjection();
    const shadowViews = hasShadowViewDemand(seed.frame.lights);
    const { collectedArtifacts, materialArtifacts, shadowMaterialArtifacts } =
      this.recoveryMaterialArtifacts(candidateScene, shadowProjection, shadowViews);
    const firstMaterialArtifact = materialArtifacts.values().next().value as
      | MaterialShaderArtifact
      | undefined;
    const firstSkinArtifact = [...materialArtifacts.values()].find((artifact) =>
      materialProgramUsesSkin(artifact.receipt),
    );
    const firstArtifact = firstMaterialArtifact ?? standardPbr.rigid;
    const materialSkinArtifact = firstSkinArtifact ?? standardPbr.skin;
    const probeBlendRequested = [...materialArtifacts.values()].some((artifact) =>
      requiresProbeBlendRecord(artifact),
    );
    const probeBlendRecordBuffer = probeBlendRequested
      ? ensureProbeBlendRecordBuffer(internals.device, this.frameState, candidateScene.probeBlend)
      : undefined;
    const prepared = production.prepare({
      scene: candidateScene,
      batchExecutions: collectedArtifacts.batchExecutions,
      shadowViews,
      ...(shadowProjection === undefined
        ? {}
        : { materialFrame: shadowProjection.content.materials }),
      camera: this.camera,
      meshByBinding: gpuDrivenMeshesForFrame(internals, seed.worlds, candidateScene),
      viewBindGroupLayout: pipelineState.viewBindGroupLayout,
      hdrp:
        clustered &&
        ((standardLighting?.prepared.local.length ?? 0) > 0 ||
          this.frameState.installedPipelineConfig?.ssao?.enabled === true),
      clustered,
      ...(firstArtifact === undefined ? {} : { materialArtifact: firstArtifact }),
      ...(materialSkinArtifact === undefined ? {} : { materialSkinArtifact }),
      ...(materialArtifacts.size === 0 ? {} : { materialArtifacts }),
      ...(shadowMaterialArtifacts.size === 0 ? {} : { shadowMaterialArtifacts }),
      ...(probeBlendRecordBuffer === undefined ? {} : { probeBlendRecordBuffer }),
      ...(seed.frameTime === undefined ? {} : { frameTime: seed.frameTime }),
      ...(surfaceDynamicInput === undefined ? {} : { surfaceDynamicInput }),
      deviceGeneration: internals.deviceScope.generation,
      materialPipelineState: pipelineState,
      ...(internals.getMaterialShaderPipelineEntry === undefined
        ? {}
        : { materialPipelineFactory: internals.getMaterialShaderPipelineEntry }),
    });
    if (!prepared.ok) return this.failed('candidate GPU-driven preparation failed', prepared.error);
    this.preparedGpuDriven = prepared.value;
    return undefined;
  }

  /** Artifacts collected from the candidate scene, else those the LKG frame accepted. */
  private recoveryMaterialArtifacts(
    candidateScene: ReturnType<typeof querySceneExecution>,
    shadowProjection: ReturnType<PersistentRenderScene['shadowCasterProjection']>,
    shadowViews: boolean,
  ) {
    const seed = this.seed;
    const lights = seed.frame.lights;
    const collectedArtifacts = collectGpuDrivenMaterialArtifacts({
      batches: candidateScene.plan.batches,
      probeBlend: (candidateScene.probeBlend?.records.length ?? 0) > 0,
      programs: shadowProjection?.materialPrograms,
      resolve: this.runtime.internals.getMaterialShaderArtifact,
      clustered:
        lights.point.length + lights.spot.length + lights.rect.length > 0 ||
        this.frameState.installedPipelineConfig?.ssao?.enabled === true,
      reflectionFallback: this.frameState.reflectionFallbackDemand === true,
      shadowViews,
    });
    const materialArtifacts =
      collectedArtifacts.materialArtifacts.size > 0
        ? collectedArtifacts.materialArtifacts
        : (seed.materialArtifacts ?? new Map());
    const shadowMaterialArtifacts =
      !shadowViews || collectedArtifacts.shadowMaterialArtifacts.size > 0
        ? collectedArtifacts.shadowMaterialArtifacts
        : (seed.shadowMaterialArtifacts ?? new Map());
    return { collectedArtifacts, materialArtifacts, shadowMaterialArtifacts };
  }

  /** Default Standard PBR forward artifacts for the candidate's lighting topology. */
  private standardPbrArtifacts(standardLighting: StandardTopologyInputValue): {
    readonly rigid: MaterialShaderArtifact | undefined;
    readonly skin: MaterialShaderArtifact | undefined;
  } {
    const internals = this.runtime.internals;
    const standardVariantSet = standardTopologyVariantSet(
      standardLighting,
      internals.device.caps.storageBuffer,
      false,
    );
    const rigid = internals.getMaterialShaderArtifact?.('forgeax::default-standard-pbr', {
      vertexColorAvailable: false,
      deformation: 'rigid',
      pass: 'forward',
      address: 'scene-index',
      variantSet: standardVariantSet,
    });
    const skin = internals.getMaterialShaderArtifact?.('forgeax::pbr-skin', {
      vertexColorAvailable: false,
      deformation: 'skin',
      pass: 'forward',
      address: 'scene-index',
      variantSet: standardVariantSet,
    });
    return { rigid, skin };
  }

  private prepareInstances(): RecoveryGraphCandidatePreparation | undefined {
    for (const entry of this.validated) {
      if (entry.source.instances === undefined) continue;
      const prepared = resolveGeometryInstanceBuffer(
        {
          runtime: this.runtime.internals,
          pipelineState: this.runtime.pipelineState,
          frameState: this.frameState,
          bindGroupCounts: { createBindGroup: 0, keys: [] },
        },
        entry,
        [],
        false,
      );
      if (prepared === null) return this.failed('candidate instance preparation failed');
    }
    return undefined;
  }

  /** Run the installed Features once on the candidate and require fully prepared work. */
  private prepareFeatures(): RecoveryGraphCandidatePreparation | undefined {
    const internals = this.runtime.internals;
    this.featureHost = internals.featureHost;
    const featureHost = this.featureHost;
    if (featureHost === undefined || featureHost.size === 0) return undefined;
    const gpuWork = this.deps.createFeatureGpuWorkOwner(internals);
    this.featureGpuWork = gpuWork;
    const featureBatch = runRenderFeatureFrame(featureHost, [this.featureFrameInput(gpuWork)]);
    const featureFrame = featureBatch.views.get(renderFeatureViewIdentity(this.camera));
    if (featureFrame === undefined) return this.failed('candidate render-feature view is missing');
    if (featureFrame.errors.length > 0) {
      return this.failed('candidate render-feature preparation failed', featureFrame.errors[0]);
    }
    if (featureFrame.plans.some(featurePlanIncomplete)) {
      return this.failed('candidate render-feature resources are not fully prepared');
    }
    const batches = Object.freeze([...featureBatch.preparedResourceBatches]);
    let batchesReleased = false;
    const releaseBatches = (): void => {
      if (batchesReleased) return;
      batchesReleased = true;
      for (const batch of batches) {
        const released = batch.release();
        if (!released.ok) internals.errorRegistry.fire(released.error);
      }
    };
    const sceneInputs = this.sceneInputs;
    this.featureGraph = {
      onAccepted: () => {
        featureBatch.commitPreparedResources();
        sceneInputs.complete(true);
        featureBatch.onAborted();
      },
      plans: featureFrame.plans,
      fullscreenEffects: featureFrame.fullscreenEffects,
      postProcessIdentities: featureFrame.postProcessIdentities,
      ...(batches.length === 0
        ? {}
        : { preparedResourceKey: `recovery-${internals.deviceScope.generation}` }),
      onRejected: () => {
        featureBatch.onAborted();
        releaseBatches();
      },
      onAbandoned: () => {
        featureBatch.onAborted();
        releaseBatches();
      },
    };
    return undefined;
  }

  private featureFrameInput(gpuWork: RenderFeatureGpuWorkOwner): RenderFeatureFrameInput {
    const { internals, pipelineState } = this.runtime;
    const camera = this.camera;
    const seed = this.seed;
    const recoveryWorlds = seed.worlds;
    const sceneInputs = this.sceneInputs;
    const persistentRenderScene = this.deps.persistentRenderScene;
    const featureTargets = resolveStandardRenderFeatureTargets({
      tonemap: camera.tonemap,
      antialias: camera.antialias,
      colorAttachmentFormat: pipelineState.colorAttachmentFormat,
      storageBuffer: internals.device.caps.storageBuffer,
      multisample: internals.device.caps.backendKind !== 'wgpu-webgl2',
      cloudHistory: seed.frame.cloudLayer !== undefined,
    });
    return {
      ...renderFeatureCameraView(camera),
      worlds: seed.worlds.flatMap((scope) => (scope.world === undefined ? [] : [scope.world])),
      ...(seed.publishedFeatures === undefined
        ? {}
        : { publishedFeatures: seed.publishedFeatures }),
      resolveAsset: (index, handle, revision) => {
        const source = recoveryWorlds[index];
        return source === undefined
          ? err(new Error(`Missing feature asset source ${index}`))
          : source.resolveAsset(handle, revision);
      },
      owner: seed.resourceOwner,
      frameNumber: this.frameState.frameNumber,
      selectedCamera: camera,
      frameSize: {
        width: internals.canvas.width,
        height: internals.canvas.height,
      },
      visibilitySnapshots: seed.frame.featureVisibilitySnapshots,
      hiddenEntityReports: seed.frame.hiddenEntityReports,
      targets: featureTargets,
      generation: internals.deviceScope.generation,
      caps: internals.device.caps,
      featureReadOnlyDepthBatchDiagnostic:
        (internals.standardProfile?.featureReadOnlyDepthBatchDiagnostic ??
          internals.standardProfile?.featureReadOnlyDepthBatching) === true,
      ...(internals.getMaterialShaderBindingContract === undefined
        ? {}
        : {
            materialShaderBindingContract: internals.getMaterialShaderBindingContract,
          }),
      createPreparedGraphicsResolver: this.deps.createPreparedResolverFactory(
        internals,
        gpuWork,
        seed.worlds,
        this.deps.createPreparedResolverCaches(),
      ),
      gpuWork,
      sceneResources: {
        prepare: (identity, resource) =>
          sceneInputs.prepare(identity, resource, {
            retained: persistentRenderScene.compositionRetainedScene(),
            scopes: recoveryWorlds,
          }),
        abortFeature: (identity) => sceneInputs.abortFeature(identity),
      },
    };
  }

  /** Make every LKG renderable's mesh, textures and samplers resident on the new device. */
  private prepareRenderableResidency(): RecoveryGraphCandidatePreparation | undefined {
    const gpuStore = this.runtime.internals.gpuStore;
    for (const renderable of this.seed.frame.renderables) {
      const world = this.seed.worlds[renderable.worldId];
      if (world === undefined) return this.failed(`world ${renderable.worldId} is unavailable`);
      if (renderable.generatedMesh !== undefined) {
        const prepared = gpuStore.ensureGeneratedMesh(renderable.generatedMesh);
        if (!prepared.ok) return this.failed('generated layout residency failed');
      } else if (renderable.assetHandle !== undefined) {
        const failure = this.prepareMeshResidency(
          renderable.assetHandle as AssetHandle<'mesh'>,
          world,
        );
        if (failure !== undefined) return failure;
      }
      for (const material of renderable.materials) {
        const failure = this.prepareMaterialResidency(material.snapshot, world);
        if (failure !== undefined) return failure;
      }
    }
    return undefined;
  }

  private prepareMeshResidency(
    handle: AssetHandle<'mesh'>,
    world: RenderResourceScope,
  ): RecoveryGraphCandidatePreparation | undefined {
    const mesh = world.resolveAsset<MeshAsset>(handle);
    if (!mesh.ok) return this.failed(`mesh ${handle} resolution failed`);
    const preparedMesh = this.runtime.internals.gpuStore.prepareResidentForRecovery(
      handle,
      mesh.value,
      world,
    );
    if (!preparedMesh.ok) return this.failed(`mesh ${handle} residency failed`);
    if (preparedMesh.value.mipmapWork !== undefined) {
      this.setupWorks.push(preparedMesh.value.mipmapWork);
    }
    return undefined;
  }

  private prepareMaterialResidency(
    snapshot: Parameters<typeof materialTextureHandles>[0],
    world: RenderResourceScope,
  ): RecoveryGraphCandidatePreparation | undefined {
    const gpuStore = this.runtime.internals.gpuStore;
    for (const textureHandle of materialTextureHandles(snapshot)) {
      const texture = world.resolveAsset<TextureAsset>(textureHandle);
      if (!texture.ok) return this.failed(`texture ${textureHandle} resolution failed`);
      const preparedTexture = gpuStore.prepareResidentForRecovery(
        textureHandle,
        texture.value,
        world,
      );
      if (!preparedTexture.ok) return this.failed(`texture ${textureHandle} residency failed`);
      if (preparedTexture.value.mipmapWork !== undefined) {
        this.setupWorks.push(preparedTexture.value.mipmapWork);
      }
    }
    for (const samplerHandle of materialSamplerHandles(snapshot)) {
      const sampler = world.resolveAsset<SamplerAsset>(samplerHandle);
      if (!sampler.ok) return this.failed(`sampler ${samplerHandle} resolution failed`);
      const preparedSampler = gpuStore.ensureSamplerResident(samplerHandle, sampler.value, world);
      if (!preparedSampler.ok) return this.failed(`sampler ${samplerHandle} residency failed`);
    }
    return undefined;
  }

  private prepareVolumetricFogResidency(): RecoveryGraphCandidatePreparation | undefined {
    const seed = this.seed;
    const resourceWorld = seed.worlds[seed.resourceOwner] ?? seed.worlds[0];
    if (resourceWorld === undefined)
      return this.failed('recovery resource-owner world is unavailable');
    const volumetricFog = seed.frame.volumetricFog;
    if (volumetricFog?.status !== 'available') return undefined;
    const volumeWorld = seed.worlds[volumetricFog.worldId ?? seed.resourceOwner] ?? resourceWorld;
    if (volumetricFog.densityHandle === undefined || volumetricFog.densityAsset === undefined) {
      return this.failed('recovery volumetric density source is unavailable');
    }
    const preparedDensity = this.gpuStore.prepareResidentForRecovery(
      volumetricFog.densityHandle,
      volumetricFog.densityAsset,
      volumeWorld,
    );
    if (!preparedDensity.ok) return this.failed('volumetric density residency failed');
    if (preparedDensity.value.mipmapWork !== undefined) {
      this.setupWorks.push(preparedDensity.value.mipmapWork);
    }
    if (volumetricFog.projectorHandle === undefined || volumetricFog.projectorAsset === undefined)
      return undefined;
    const preparedProjector = this.gpuStore.prepareResidentForRecovery(
      volumetricFog.projectorHandle,
      volumetricFog.projectorAsset,
      volumeWorld,
    );
    if (!preparedProjector.ok) return this.failed('volumetric projector residency failed');
    if (preparedProjector.value.mipmapWork !== undefined) {
      this.setupWorks.push(preparedProjector.value.mipmapWork);
    }
    return undefined;
  }

  private prepareReadiness(
    standardLighting: StandardTopologyInputValue,
  ): RecoveryPipelineReadiness {
    const seed = this.seed;
    const camera = this.camera;
    const lights = seed.frame.lights;
    return prepareRecoveryPipelineReadiness({
      internals: this.runtime.internals,
      pipelineState: this.runtime.pipelineState,
      camera,
      standardLighting,
      validated: this.validated,
      dispatch: seed.frame.dispatch,
      shadowCastersActive:
        lights.pointShadow.length > 0 ||
        lights.spot.some((spot) => spot.castShadow === true) ||
        (lights.lightViewProj?.length ?? 0) > 0,
      splitLdrSprite: computeSplitLdrSprite(
        this.validated,
        camera.tonemap !== 'none',
        seed.frame.dispatch,
      ),
      reflectionFallbackAvailable: this.frameState.reflectionFallbackDemand === true,
    });
  }

  /** Warm every post-process pipeline the first recovered frame resolves from the candidate cache. */
  private warmPostProcessing(): RecoveryGraphCandidatePreparation | undefined {
    const { internals, pipelineState } = this.runtime;
    const camera = this.camera;
    const featureGraph = this.featureGraph;
    const installed = this.frameState.installedPipelineConfig;
    const candidatePostProcessIds = new Set<string>([
      ...(installed?.postEffects ?? []),
      // Required identities include effects disabled for this frame. Warm only
      // published entries, using their public identity rather than graph aliases.
      ...(featureGraph.postProcessIdentities ?? []).filter((id) =>
        featureGraph.fullscreenEffects.has(id),
      ),
    ]);
    const configuredPostEffects = installed?.postEffects ?? [];
    const postProcessPipeline = internals.getPostProcessPipeline;
    const postProcessLookup = internals.lookupPostProcess;
    if (postProcessPipeline === undefined || postProcessLookup === undefined) {
      return this.failed('candidate post-process pipeline owner is unavailable');
    }
    const depthMultisampled =
      camera.antialias === 'msaa' && internals.device.caps.backendKind !== 'wgpu-webgl2';
    const warm = (id: string, colorFormat: GPUTextureFormat): void =>
      this.warmPostProcessPipeline(id, colorFormat, depthMultisampled);
    const rawOnlyPostInput =
      pipelineState.surfaceProfile === 'raw-only' &&
      internals.device.caps.storageBuffer &&
      configuredPostEffects.length > 0;
    const outputFormat =
      camera.antialias === 'fxaa' || rawOnlyPostInput
        ? ('rgba16float' as GPUTextureFormat)
        : (pipelineState.format as GPUTextureFormat);
    // Standard's output transform is a graph pass even when no authored
    // effect is installed. Warm its exact target format before publication;
    // the first recovery frame must only resolve this candidate-owned cache.
    warm(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, outputFormat);
    if (camera.antialias === 'taa') this.warmTaaResolve();
    if (
      camera.motionBlur !== undefined &&
      motionBlurTemporalDemand({
        shutterAngle: camera.motionBlur.shutterAngle,
        maxRadiusPixels: camera.motionBlur.maxRadiusPixels,
        sampleCount: camera.motionBlur.sampleCount,
        targetFps: camera.motionBlur.targetFps ?? 60,
      })
    ) {
      warm('forgeax.motion-blur', 'rgba16float');
    }
    for (const id of candidatePostProcessIds) {
      warm(id, pipelineState.format as GPUTextureFormat);
    }
    if (standardBloomAdmitted(camera)) assertRecoveryBloomResources(pipelineState);
    return undefined;
  }

  private warmPostProcessPipeline(
    id: string,
    colorFormat: GPUTextureFormat,
    depthMultisampled: boolean,
  ): void {
    const internals = this.runtime.internals;
    const postProcessPipeline = internals.getPostProcessPipeline;
    const entry = this.featureGraph.fullscreenEffects.get(id) ?? internals.lookupPostProcess?.(id);
    if (entry === undefined || postProcessPipeline === undefined) {
      throw new Error(`recovery post-process declaration is unavailable: ${id}`);
    }
    const built = buildFullscreenPostProcessPass(
      { device: internals.device, errorRegistry: internals.errorRegistry },
      entry,
      depthMultisampled,
    );
    if (
      built === null ||
      built.sampler === null ||
      (entryHasDepthRead(entry) && built.depthSampler === null)
    ) {
      throw new Error(`recovery post-process bindings are unavailable: ${id}`);
    }
    const pipeline = postProcessPipeline(id, built.bindGroupLayout, [colorFormat], entry);
    if (pipeline === null) {
      throw new Error(`recovery post-process pipeline is unavailable: ${id}`);
    }
  }

  private warmTaaResolve(): void {
    const internals = this.runtime.internals;
    const temporal = getTemporalGpuState(
      this.frameState,
      internals.device,
      internals.deviceScope,
      this.seed.width,
      this.seed.height,
    );
    getTemporalParamsBuffer(temporal);
    const temporalBindings = getTemporalBindGroupResources(temporal);
    const taaEntry = internals.lookupPostProcess?.('forgeax.taa-resolve');
    if (taaEntry === undefined) {
      throw new Error('recovery TAA post-process declaration is unavailable');
    }
    const taaPipeline = internals.getPostProcessPipeline?.(
      'forgeax.taa-resolve',
      temporalBindings.layout,
      [
        TEMPORAL_HISTORY_FORMATS.color,
        TEMPORAL_HISTORY_FORMATS.temporal,
        TEMPORAL_HISTORY_FORMATS.stability,
      ],
      taaEntry,
    );
    if (taaPipeline === null || taaPipeline === undefined) {
      throw new Error('recovery TAA pipeline is unavailable');
    }
  }

  private compileGraph(
    standardLighting: StandardTopologyInputValue,
    recoveryReadiness: RecoveryPipelineReadiness | undefined,
  ): RecoveryGraphCandidatePreparation {
    const { internals, pipelineState } = this.runtime;
    const seed = this.seed;
    const frameState = this.frameState;
    const graph = ensureCompiledFrameGraph(
      internals,
      frameState,
      pipelineState,
      this.camera,
      seed.frame.lights,
      seed.width,
      seed.height,
      undefined,
      this.preparedGpuDriven,
      this.featureGraph,
      undefined,
      false,
      undefined,
      seed.frame.volumetricFog,
      seed.frame.volumetricFog?.status === 'available',
      standardLighting,
      (error) => {
        this.graphFailure ??= error;
      },
      undefined,
      undefined,
      false,
      false,
      seed.frame.cloudLayer === undefined
        ? undefined
        : cloudShadowResolutionForQuality(seed.frame.cloudLayer.params.quality),
    );
    if (graph === null) return this.failed('candidate frame graph compilation failed');
    if (recoveryReadiness === undefined)
      return this.failed('candidate pipeline readiness was not prepared');
    // Keep recovery inspection derived from the exact Standard declaration
    // admitted to the candidate graph.  The point-shadow projection is
    // likewise detached from the candidate atlas and never waits for the
    // first post-recovery frame to rediscover the retained budget.
    // Capsule and transparency projections carry over from the frame state
    // this candidate was cloned from; they are not re-derived here.
    frameState.submittedInspection = {
      standardLighting: inspectStandardLighting(standardLighting),
      pointShadow: inspectPointShadow(seed.frame.lights.pointShadow, SHADOW_ATLAS_DEFAULT_LAYERS),
      capsuleShadow: frameState.submittedInspection?.capsuleShadow,
      transparency: frameState.submittedInspection?.transparency,
    };
    return { kind: 'ready', candidate: this.readyCandidate(recoveryReadiness) };
  }

  private readyCandidate(recoveryReadiness: RecoveryPipelineReadiness): RecoveryGraphCandidate {
    const internals = this.runtime.internals;
    return {
      frameState: this.frameState,
      setupWorks: Object.freeze(this.setupWorks),
      device: internals.device,
      generation: internals.deviceScope.generation,
      ...(this.gpuDrivenProduction === undefined
        ? {}
        : { gpuDrivenProduction: this.gpuDrivenProduction }),
      ...(this.gpuDrivenScene === undefined ? {} : { gpuDrivenScene: this.gpuDrivenScene }),
      ...(this.pointsLines === undefined ? {} : { pointsLines: this.pointsLines }),
      ...(this.featureHost === undefined ? {} : { featureHost: this.featureHost }),
      ...(this.featureGpuWork === undefined ? {} : { featureGpuWork: this.featureGpuWork }),
      featureSceneInputs: this.sceneInputs,
      featureGraphCandidate: this.featureGraph,
      postProcessPipelines: new Map(internals.getRecoveryPostProcessPipelines?.() ?? []),
      recoveryReadiness,
      release: this.release,
      markPublished: this.markPublished,
    };
  }
}

/** Temporal snapshots belong to the lost device's history; recovery restarts it. */
function withoutTemporalSnapshots(seed: RecoveryFrameSeed): RecoveryFrameSeed {
  return {
    ...seed,
    frame: {
      ...seed.frame,
      renderables: seed.frame.renderables.map((row) => {
        const { temporal: _temporal, ...source } = row;
        return source;
      }),
    },
  };
}

/** Is any graphics or compute pass of this planned Feature work still unresolved? */
function featurePlanIncomplete(planned: RenderFeaturePlannedFrame): boolean {
  const execution = getRenderFeaturePlanExecutionProjection(planned);
  return (
    execution === undefined ||
    execution.passes.some(
      (pass) =>
        (pass.graphics !== undefined && pass.resolvedGraphics === undefined) ||
        (pass.gpuCompute !== undefined && pass.resolvedGpuCompute === undefined),
    )
  );
}

function assertRecoveryBloomResources(
  pipelineState: RecoveryGraphCandidateRuntime['pipelineState'],
): void {
  pipelineState.perPassResources.ensureBloomResources?.();
  const bloom = pipelineState.perPassResources.getBloomResources?.();
  if (
    bloom === null ||
    bloom === undefined ||
    bloom.bloomHorizontalPipeline === null ||
    bloom.bloomVerticalPipeline === null ||
    bloom.bloomCompositePipeline === null ||
    bloom.bloomHorizontalBindGroupLayout === null ||
    bloom.bloomVerticalBindGroupLayout === null ||
    bloom.bloomCompositeBindGroupLayout === null ||
    bloom.bloomSampler === null ||
    bloom.bloomHorizontalParamsBuffer === null ||
    bloom.bloomVerticalParamsBuffer === null ||
    bloom.bloomCompositeParamsBuffer === null
  ) {
    throw new Error('recovery Bloom resources are incomplete');
  }
}
