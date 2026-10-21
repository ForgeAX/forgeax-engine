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
import { STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from '../render-contract';
import type { ExtractedFrame } from '../render-system-extract';
import { materialSamplerHandles, materialTextureHandles } from '../render-system-residency';
import type { PersistentGpuDrivenCandidate, PersistentRenderScene } from '../scene/render-scene';
import { SHADOW_ATLAS_DEFAULT_LAYERS } from '../shadow-atlas';
import { ReadonlyDynamicInputPage, type SurfaceDynamicInputFrame } from '../surface/dynamic-input';
import { prepareSkinPalette } from '../systems/skin-palette-allocator';
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
    persistentRenderScene,
    gpuDrivenShaderFactory,
    createFeatureGpuWorkOwner,
    pointsLinesOwner,
    createPreparedResolverFactory,
    createPreparedResolverCaches,
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
    let seed = lastSuccessfulFrameSeed;
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
    const setupWorks: MipmapEncoderWork[] = [];
    const candidateGpuStore = runtime.internals.gpuStore;
    let candidateGpuDrivenScene: PersistentGpuDrivenCandidate | undefined;
    let candidateGpuDrivenProduction: GpuDrivenProduction | undefined;
    let candidateFeatureHost: RenderFeatureHost | undefined;
    let candidateFeatureGpuWork: RenderFeatureGpuWorkOwner | undefined;
    let candidatePointsLines: RecoveryPointsLinesCandidate | undefined;
    let candidateSurfacePage: ReadonlyDynamicInputPage | undefined;
    let candidateFeatureGraph: RenderFeatureGraphCandidate = {
      plans: Object.freeze([]),
      fullscreenEffects: new Map(),
    };
    let candidateValidated: ValidatedRenderable[] = [];
    let recoveryReadiness: RecoveryPipelineReadiness | undefined;
    let preparedGpuDriven:
      | import('../gpu-driven/production-raster').PreparedGpuDrivenFrame
      | undefined;
    let recoveryGraphFailure: unknown;
    let candidatePublished = false;
    let candidateReleased = false;
    const releaseCandidate = (): void => {
      if (candidateReleased || candidatePublished) return;
      candidateReleased = true;
      retirePendingStandardOutputGpu(candidateFrameState);
      for (const work of setupWorks) work.discard();
      const graph = candidateFrameState.compiledFrameGraph?.graph;
      candidateFrameState.compiledFrameGraph = null;
      candidateFrameState.compiledFrameGraphCandidate = undefined;
      try {
        if (graph !== undefined) retireCompiledGraph(candidateFrameState, graph);
      } catch {
        // Candidate cleanup continues through every independent owner.
      }
      try {
        candidateFrameState.pointShadowAtlas?.dispose();
        candidateFrameState.shadowDepthLayers?.dispose();
      } catch {
        // Candidate cleanup continues through every independent owner.
      }
      candidateFrameState.pointShadowAtlas = null;
      candidateFeatureGraph.onAbandoned?.();
      const featureHost = candidateFeatureHost;
      candidateFeatureHost = undefined;
      if (featureHost !== undefined) {
        featureHost.dispose();
      }
      candidateFeatureGpuWork?.dispose();
      candidateFeatureGpuWork = undefined;
      candidateSceneInputs.dispose();
      candidateGpuDrivenProduction?.dispose();
      candidateGpuDrivenProduction = undefined;
      candidateGpuDrivenScene?.release();
      candidateGpuDrivenScene = undefined;
      candidatePointsLines?.release();
      candidatePointsLines = undefined;
      candidateSurfacePage?.release();
      candidateSurfacePage = undefined;
      disposeInstanceBuffers(candidateFrameState.instanceBuffers, runtime.internals.errorRegistry);
      if (candidateFrameState.instanceBufferChunks !== undefined) {
        disposeInstanceBufferChunks(
          candidateFrameState.instanceBufferChunks,
          runtime.internals.errorRegistry,
        );
      }
      candidateGpuStore.destroyAll();
    };
    const markPublished = (): void => {
      // The readiness graph is retired at publication; it is never submitted.
      preparedGpuDriven?._abortResourceReplacement?.();
      preparedGpuDriven = undefined;
      candidatePointsLines?.publish();
      candidateSurfacePage?.release();
      candidateSurfacePage = undefined;
      candidatePublished = true;
    };
    const failed = (
      reason: string,
      cause: unknown = recoveryGraphFailure,
    ): RecoveryGraphCandidatePreparation => {
      releaseCandidate();
      return cause === undefined ? { kind: 'failed', reason } : { kind: 'failed', reason, cause };
    };

    try {
      const output = prepareStandardOutputResources(
        candidateFrameState,
        runtime.internals,
        camera,
        seed.worlds[seed.cameraOwner] as RenderResourceScope,
      );
      if (!output.ok) return failed('candidate Standard output preparation failed', output.error);
      const gpuScene = persistentRenderScene.prepareRecoveryGpuDrivenCandidate(
        runtime.internals.device,
        runtime.pipelineState.skinPaletteAllocator,
      );
      if (!gpuScene.ok) return failed('candidate GPU scene preparation failed', gpuScene.error);
      candidateGpuDrivenScene = gpuScene.value;
      seed = {
        ...seed,
        frame: {
          ...seed.frame,
          renderables: seed.frame.renderables.map((row) => {
            const { temporal: _temporal, ...source } = row;
            if (source.skinPose === undefined) return source;
            const palette = runtime.pipelineState.skinPaletteAllocator;
            if (palette === null) throw new Error('Skin recovery requires a palette owner.');
            return { ...source, skin: prepareSkinPalette(source.skinPose, palette) };
          }),
        },
      };
      const recoveryWorlds = seed.worlds;
      candidateValidated = validateRenderables(
        runtime.internals,
        seed.worlds[seed.cameraOwner] as RenderResourceScope,
        seed.worlds,
        runtime.pipelineState,
        candidateFrameState,
        seed.frame.renderables,
        seed.frame.dispatch,
      );
      if (candidateValidated.length !== seed.frame.renderables.length) {
        return failed('candidate validation did not retain every LKG-visible renderable');
      }
      const lighting = prepareFrameLighting(
        runtime.internals,
        candidateFrameState,
        seed.frame.lights,
        camera,
        runtime.pipelineState,
      );
      if (!lighting.ok) return failed('candidate lighting preparation failed');
      let recoverySurfaceDynamicInput = seed.surfaceDynamicInput;
      if (
        recoverySurfaceDynamicInput !== undefined &&
        recoverySurfaceDynamicInput.page.deviceGeneration !==
          runtime.internals.deviceScope.generation
      ) {
        const source = recoverySurfaceDynamicInput;
        const created = ReadonlyDynamicInputPage.create({
          sourceId: source.page.sourceId,
          pageId: source.page.pageId,
          schema: source.page.schema,
        });
        if (!created.ok) {
          return failed('candidate Surface recovery page creation failed', created.error);
        }
        candidateSurfacePage = created.value;
        // Preserve CPU-authored parameters before preparing the replacement GPU page.
        candidateSurfacePage.bytes.set(source.page.bytes);
        const reconfigured = candidateSurfacePage.reconfigureDevice(
          runtime.internals.deviceScope.generation,
        );
        if (!reconfigured.ok) {
          return failed('candidate Surface recovery page generation failed', reconfigured.error);
        }
        const ranges = (source.ranges ?? []).map((range) => {
          const reserved = candidateSurfacePage?.reserveRange({
            domain: range.domain,
            recordStart: range.recordStart,
            recordCount: range.recordCount,
            instanceIndex: range.instanceIndex,
            member: range.member,
          });
          if (reserved === undefined || !reserved.ok) {
            throw reserved?.error ?? new Error('candidate Surface recovery range unavailable');
          }
          return reserved.value;
        });
        recoverySurfaceDynamicInput = {
          page: candidateSurfacePage,
          ranges,
          projectionRevision: source.projectionRevision + 1,
          frameTime: source.frameTime,
        };
      }
      if (candidateGpuDrivenScene.state !== undefined) {
        // Recovery compiles real execution work, including every shared Mesh section.
        const candidateScene = querySceneExecution(candidateGpuDrivenScene.state);
        candidateGpuDrivenProduction = GpuDrivenProduction.forDevice(
          runtime.internals.device,
          gpuDrivenShaderFactory,
        );
        const clustered = lighting.value.standard?.kind === 'clustered';
        const standardVariantSet = standardTopologyVariantSet(
          lighting.value.standard,
          runtime.internals.device.caps.storageBuffer,
          false,
        );
        const standardPbrArtifact = runtime.internals.getMaterialShaderArtifact?.(
          'forgeax::default-standard-pbr',
          {
            vertexColorAvailable: false,
            deformation: 'rigid',
            pass: 'forward',
            address: 'scene-index',
            variantSet: standardVariantSet,
          },
        );
        const standardPbrSkinArtifact = runtime.internals.getMaterialShaderArtifact?.(
          'forgeax::pbr-skin',
          {
            vertexColorAvailable: false,
            deformation: 'skin',
            pass: 'forward',
            address: 'scene-index',
            variantSet: standardVariantSet,
          },
        );
        const shadowProjection = persistentRenderScene.shadowCasterProjection();
        const shadowViews = hasShadowViewDemand(seed.frame.lights);
        const collectedArtifacts = collectGpuDrivenMaterialArtifacts({
          batches: candidateScene.plan.batches,
          probeBlend: (candidateScene.probeBlend?.records.length ?? 0) > 0,
          programs: shadowProjection?.materialPrograms,
          resolve: runtime.internals.getMaterialShaderArtifact,
          clustered:
            seed.frame.lights.point.length +
              seed.frame.lights.spot.length +
              seed.frame.lights.rect.length >
              0 || candidateFrameState.installedPipelineConfig?.ssao?.enabled === true,
          reflectionFallback: candidateFrameState.reflectionFallbackDemand === true,
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
        const firstMaterialArtifact = materialArtifacts.values().next().value as
          | MaterialShaderArtifact
          | undefined;
        const firstSkinArtifact = [...materialArtifacts.values()].find(
          (artifact) => artifact.receipt?.skinPaletteAddress !== undefined,
        );
        const firstArtifact = firstMaterialArtifact ?? standardPbrArtifact;
        const materialSkinArtifact = firstSkinArtifact ?? standardPbrSkinArtifact;
        const probeBlendRequested = [...materialArtifacts.values()].some((artifact) =>
          requiresProbeBlendRecord(artifact),
        );
        const probeBlendRecordBuffer = probeBlendRequested
          ? ensureProbeBlendRecordBuffer(
              runtime.internals.device,
              candidateFrameState,
              candidateScene.probeBlend,
            )
          : undefined;
        const prepared = candidateGpuDrivenProduction.prepare({
          scene: candidateScene,
          batchExecutions: collectedArtifacts.batchExecutions,
          shadowViews,
          ...(shadowProjection === undefined
            ? {}
            : { materialFrame: shadowProjection.content.materials }),
          camera,
          meshByBinding: gpuDrivenMeshesForFrame(runtime.internals, seed.worlds, candidateScene),
          viewBindGroupLayout: runtime.pipelineState.viewBindGroupLayout,
          hdrp:
            clustered &&
            ((lighting.value.standard?.prepared.local.length ?? 0) > 0 ||
              candidateFrameState.installedPipelineConfig?.ssao?.enabled === true),
          clustered,
          ...(firstArtifact === undefined ? {} : { materialArtifact: firstArtifact }),
          ...(materialSkinArtifact === undefined ? {} : { materialSkinArtifact }),
          ...(materialArtifacts.size === 0 ? {} : { materialArtifacts }),
          ...(shadowMaterialArtifacts.size === 0 ? {} : { shadowMaterialArtifacts }),
          ...(probeBlendRecordBuffer === undefined ? {} : { probeBlendRecordBuffer }),
          ...(seed.frameTime === undefined ? {} : { frameTime: seed.frameTime }),
          ...(recoverySurfaceDynamicInput === undefined
            ? {}
            : { surfaceDynamicInput: recoverySurfaceDynamicInput }),
          deviceGeneration: runtime.internals.deviceScope.generation,
          materialPipelineState: runtime.pipelineState,
          ...(runtime.internals.getMaterialShaderPipelineEntry === undefined
            ? {}
            : { materialPipelineFactory: runtime.internals.getMaterialShaderPipelineEntry }),
        });
        if (!prepared.ok) return failed('candidate GPU-driven preparation failed', prepared.error);
        preparedGpuDriven = prepared.value;
      }
      for (const entry of candidateValidated) {
        if (entry.source.instances === undefined) continue;
        const prepared = resolveGeometryInstanceBuffer(
          {
            runtime: runtime.internals,
            pipelineState: runtime.pipelineState,
            frameState: candidateFrameState,
            bindGroupCounts: { createBindGroup: 0, keys: [] },
          },
          entry,
          [],
          false,
        );
        if (prepared === null) return failed('candidate instance preparation failed');
      }
      candidateFeatureHost = runtime.internals.featureHost;
      if (candidateFeatureHost !== undefined && candidateFeatureHost.size > 0) {
        candidateFeatureGpuWork = createFeatureGpuWorkOwner(runtime.internals);
        const featureTargets = resolveStandardRenderFeatureTargets({
          tonemap: camera.tonemap,
          antialias: camera.antialias,
          colorAttachmentFormat: runtime.pipelineState.colorAttachmentFormat,
          storageBuffer: runtime.internals.device.caps.storageBuffer,
          multisample: runtime.internals.device.caps.backendKind !== 'wgpu-webgl2',
          cloudHistory: seed.frame.cloudLayer !== undefined,
        });
        const featureBatch = runRenderFeatureFrame(candidateFeatureHost, [
          {
            ...renderFeatureCameraView(camera),
            worlds: seed.worlds.flatMap((scope) =>
              scope.world === undefined ? [] : [scope.world],
            ),
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
            frameNumber: candidateFrameState.frameNumber,
            selectedCamera: camera,
            frameSize: {
              width: runtime.internals.canvas.width,
              height: runtime.internals.canvas.height,
            },
            visibilitySnapshots: seed.frame.featureVisibilitySnapshots,
            hiddenEntityReports: seed.frame.hiddenEntityReports,
            targets: featureTargets,
            generation: runtime.internals.deviceScope.generation,
            caps: runtime.internals.device.caps,
            featureReadOnlyDepthBatchDiagnostic:
              (runtime.internals.standardProfile?.featureReadOnlyDepthBatchDiagnostic ??
                runtime.internals.standardProfile?.featureReadOnlyDepthBatching) === true,
            ...(runtime.internals.getMaterialShaderBindingContract === undefined
              ? {}
              : {
                  materialShaderBindingContract: runtime.internals.getMaterialShaderBindingContract,
                }),
            createPreparedGraphicsResolver: createPreparedResolverFactory(
              runtime.internals,
              candidateFeatureGpuWork,
              seed.worlds,
              createPreparedResolverCaches(),
            ),
            gpuWork: candidateFeatureGpuWork,
            sceneResources: {
              prepare: (identity, resource) =>
                candidateSceneInputs.prepare(identity, resource, {
                  retained: persistentRenderScene.compositionRetainedScene(),
                  scopes: recoveryWorlds,
                }),
              abortFeature: (identity) => candidateSceneInputs.abortFeature(identity),
            },
          },
        ]);
        const featureFrame = featureBatch.views.get(renderFeatureViewIdentity(camera));
        if (featureFrame === undefined) return failed('candidate render-feature view is missing');
        if (featureFrame.errors.length > 0) {
          return failed('candidate render-feature preparation failed', featureFrame.errors[0]);
        }
        const featurePreparationIncomplete = featureFrame.plans.some((planned) => {
          const execution = getRenderFeaturePlanExecutionProjection(planned);
          return (
            execution === undefined ||
            execution.passes.some(
              (pass) =>
                (pass.graphics !== undefined && pass.resolvedGraphics === undefined) ||
                (pass.gpuCompute !== undefined && pass.resolvedGpuCompute === undefined),
            )
          );
        });
        if (featurePreparationIncomplete) {
          return failed('candidate render-feature resources are not fully prepared');
        }
        const batches = Object.freeze([...featureBatch.preparedResourceBatches]);
        let batchesReleased = false;
        const releaseBatches = (): void => {
          if (batchesReleased) return;
          batchesReleased = true;
          for (const batch of batches) {
            const released = batch.release();
            if (!released.ok) runtime.internals.errorRegistry.fire(released.error);
          }
        };
        candidateFeatureGraph = {
          onAccepted: () => {
            featureBatch.commitPreparedResources();
            candidateSceneInputs.complete(true);
            featureBatch.onAborted();
          },
          plans: featureFrame.plans,
          fullscreenEffects: featureFrame.fullscreenEffects,
          postProcessIdentities: featureFrame.postProcessIdentities,
          ...(batches.length === 0
            ? {}
            : { preparedResourceKey: `recovery-${runtime.internals.deviceScope.generation}` }),
          onRejected: () => {
            featureBatch.onAborted();
            releaseBatches();
          },
          onAbandoned: () => {
            featureBatch.onAborted();
            releaseBatches();
          },
        };
      }
      for (const renderable of seed.frame.renderables) {
        const world = seed.worlds[renderable.worldId];
        if (world === undefined) return failed(`world ${renderable.worldId} is unavailable`);
        if (renderable.generatedMesh !== undefined) {
          const prepared = runtime.internals.gpuStore.ensureGeneratedMesh(renderable.generatedMesh);
          if (!prepared.ok) return failed('generated layout residency failed');
        } else if (renderable.assetHandle !== undefined) {
          const mesh = world.resolveAsset<MeshAsset>(renderable.assetHandle as AssetHandle<'mesh'>);
          if (!mesh.ok) return failed(`mesh ${renderable.assetHandle} resolution failed`);
          const preparedMesh = runtime.internals.gpuStore.prepareResidentForRecovery(
            renderable.assetHandle as AssetHandle<'mesh'>,
            mesh.value,
            world,
          );
          if (!preparedMesh.ok) return failed(`mesh ${renderable.assetHandle} residency failed`);
          if (preparedMesh.value.mipmapWork !== undefined) {
            setupWorks.push(preparedMesh.value.mipmapWork);
          }
        }
        for (const material of renderable.materials) {
          for (const textureHandle of materialTextureHandles(material.snapshot)) {
            const texture = world.resolveAsset<TextureAsset>(textureHandle);
            if (!texture.ok) return failed(`texture ${textureHandle} resolution failed`);
            const preparedTexture = runtime.internals.gpuStore.prepareResidentForRecovery(
              textureHandle,
              texture.value,
              world,
            );
            if (!preparedTexture.ok) return failed(`texture ${textureHandle} residency failed`);
            if (preparedTexture.value.mipmapWork !== undefined) {
              setupWorks.push(preparedTexture.value.mipmapWork);
            }
          }
          for (const samplerHandle of materialSamplerHandles(material.snapshot)) {
            const sampler = world.resolveAsset<SamplerAsset>(samplerHandle);
            if (!sampler.ok) return failed(`sampler ${samplerHandle} resolution failed`);
            const preparedSampler = runtime.internals.gpuStore.ensureSamplerResident(
              samplerHandle,
              sampler.value,
              world,
            );
            if (!preparedSampler.ok) return failed(`sampler ${samplerHandle} residency failed`);
          }
        }
      }
      const resourceWorld = seed.worlds[seed.resourceOwner] ?? seed.worlds[0];
      if (resourceWorld === undefined)
        return failed('recovery resource-owner world is unavailable');
      const volumetricFog = seed.frame.volumetricFog;
      if (volumetricFog?.status === 'available') {
        const volumeWorld =
          seed.worlds[volumetricFog.worldId ?? seed.resourceOwner] ?? resourceWorld;
        if (volumetricFog.densityHandle === undefined || volumetricFog.densityAsset === undefined) {
          return failed('recovery volumetric density source is unavailable');
        }
        const preparedDensity = candidateGpuStore.prepareResidentForRecovery(
          volumetricFog.densityHandle,
          volumetricFog.densityAsset,
          volumeWorld,
        );
        if (!preparedDensity.ok) return failed('volumetric density residency failed');
        if (preparedDensity.value.mipmapWork !== undefined) {
          setupWorks.push(preparedDensity.value.mipmapWork);
        }
        if (
          volumetricFog.projectorHandle !== undefined &&
          volumetricFog.projectorAsset !== undefined
        ) {
          const preparedProjector = candidateGpuStore.prepareResidentForRecovery(
            volumetricFog.projectorHandle,
            volumetricFog.projectorAsset,
            volumeWorld,
          );
          if (!preparedProjector.ok) return failed('volumetric projector residency failed');
          if (preparedProjector.value.mipmapWork !== undefined) {
            setupWorks.push(preparedProjector.value.mipmapWork);
          }
        }
      }
      candidatePointsLines = pointsLinesOwner.prepareRecoveryCandidate(
        candidateValidated,
        lighting.value.standard?.kind === 'clustered',
        runtime.internals,
      );
      recoveryReadiness = prepareRecoveryPipelineReadiness({
        internals: runtime.internals,
        pipelineState: runtime.pipelineState,
        camera,
        standardLighting: lighting.value.standard,
        validated: candidateValidated,
        dispatch: seed.frame.dispatch,
        shadowCastersActive:
          seed.frame.lights.pointShadow.length > 0 ||
          seed.frame.lights.spot.some((spot) => spot.castShadow === true) ||
          (seed.frame.lights.lightViewProj?.length ?? 0) > 0,
        splitLdrSprite: computeSplitLdrSprite(
          candidateValidated,
          camera.tonemap !== 'none',
          seed.frame.dispatch,
        ),
        reflectionFallbackAvailable: candidateFrameState.reflectionFallbackDemand === true,
      });
      const candidatePostProcessIds = new Set<string>([
        ...(candidateFrameState.installedPipelineConfig?.postEffects ?? []),
        // Required identities include effects disabled for this frame. Warm only
        // published entries, using their public identity rather than graph aliases.
        ...(candidateFeatureGraph.postProcessIdentities ?? []).filter((id) =>
          candidateFeatureGraph.fullscreenEffects.has(id),
        ),
      ]);
      const configuredPostEffects = candidateFrameState.installedPipelineConfig?.postEffects ?? [];
      const postProcessPipeline = runtime.internals.getPostProcessPipeline;
      const postProcessLookup = runtime.internals.lookupPostProcess;
      if (postProcessPipeline === undefined || postProcessLookup === undefined) {
        return failed('candidate post-process pipeline owner is unavailable');
      }
      const depthMultisampled =
        camera.antialias === 'msaa' && runtime.internals.device.caps.backendKind !== 'wgpu-webgl2';
      const warmPostProcessPipeline = (
        id: string,
        colorFormat: GPUTextureFormat,
        entryOverride?: PostProcessShaderEntry,
      ): void => {
        const entry =
          entryOverride ?? candidateFeatureGraph.fullscreenEffects.get(id) ?? postProcessLookup(id);
        if (entry === undefined) {
          throw new Error(`recovery post-process declaration is unavailable: ${id}`);
        }
        const built = buildFullscreenPostProcessPass(
          { device: runtime.internals.device, errorRegistry: runtime.internals.errorRegistry },
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
      };
      const rawOnlyPostInput =
        runtime.pipelineState.surfaceProfile === 'raw-only' &&
        runtime.internals.device.caps.storageBuffer &&
        configuredPostEffects.length > 0;
      const outputFormat =
        camera.antialias === 'fxaa' || rawOnlyPostInput
          ? ('rgba16float' as GPUTextureFormat)
          : (runtime.pipelineState.format as GPUTextureFormat);
      // Standard's output transform is a graph pass even when no authored
      // effect is installed. Warm its exact target format before publication;
      // the first recovery frame must only resolve this candidate-owned cache.
      warmPostProcessPipeline(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, outputFormat);
      if (camera.antialias === 'taa') {
        const temporal = getTemporalGpuState(
          candidateFrameState,
          runtime.internals.device,
          runtime.internals.deviceScope,
          seed.width,
          seed.height,
        );
        getTemporalParamsBuffer(temporal);
        const temporalBindings = getTemporalBindGroupResources(temporal);
        const taaEntry = postProcessLookup('forgeax.taa-resolve');
        if (taaEntry === undefined) {
          throw new Error('recovery TAA post-process declaration is unavailable');
        }
        const taaPipeline = postProcessPipeline(
          'forgeax.taa-resolve',
          temporalBindings.layout,
          [
            TEMPORAL_HISTORY_FORMATS.color,
            TEMPORAL_HISTORY_FORMATS.temporal,
            TEMPORAL_HISTORY_FORMATS.stability,
          ],
          taaEntry,
        );
        if (taaPipeline === null) {
          throw new Error('recovery TAA pipeline is unavailable');
        }
      }
      if (
        camera.motionBlur !== undefined &&
        motionBlurTemporalDemand({
          shutterAngle: camera.motionBlur.shutterAngle,
          maxRadiusPixels: camera.motionBlur.maxRadiusPixels,
          sampleCount: camera.motionBlur.sampleCount,
          targetFps: camera.motionBlur.targetFps ?? 60,
        })
      ) {
        warmPostProcessPipeline('forgeax.motion-blur', 'rgba16float');
      }
      for (const id of candidatePostProcessIds) {
        warmPostProcessPipeline(id, runtime.pipelineState.format as GPUTextureFormat);
      }
      if (standardBloomAdmitted(camera)) {
        runtime.pipelineState.perPassResources.ensureBloomResources?.();
        const bloom = runtime.pipelineState.perPassResources.getBloomResources?.();
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
      const graph = ensureCompiledFrameGraph(
        runtime.internals,
        candidateFrameState,
        runtime.pipelineState,
        camera,
        seed.frame.lights,
        seed.width,
        seed.height,
        undefined,
        preparedGpuDriven,
        candidateFeatureGraph,
        undefined,
        false,
        undefined,
        seed.frame.volumetricFog,
        seed.frame.volumetricFog?.status === 'available',
        lighting.value.standard,
        (error) => {
          recoveryGraphFailure ??= error;
        },
        undefined,
        undefined,
        false,
        false,
        seed.frame.cloudLayer === undefined
          ? undefined
          : cloudShadowResolutionForQuality(seed.frame.cloudLayer.params.quality),
      );
      if (graph === null) return failed('candidate frame graph compilation failed');
      if (recoveryReadiness === undefined)
        return failed('candidate pipeline readiness was not prepared');
      // Keep recovery inspection derived from the exact Standard declaration
      // admitted to the candidate graph.  The point-shadow projection is
      // likewise detached from the candidate atlas and never waits for the
      // first post-recovery frame to rediscover the retained budget.
      // Capsule and transparency projections carry over from the frame state
      // this candidate was cloned from; they are not re-derived here.
      candidateFrameState.submittedInspection = {
        standardLighting: inspectStandardLighting(lighting.value.standard),
        pointShadow: inspectPointShadow(seed.frame.lights.pointShadow, SHADOW_ATLAS_DEFAULT_LAYERS),
        capsuleShadow: candidateFrameState.submittedInspection?.capsuleShadow,
        transparency: candidateFrameState.submittedInspection?.transparency,
      };
      return {
        kind: 'ready',
        candidate: {
          frameState: candidateFrameState,
          setupWorks: Object.freeze(setupWorks),
          device: runtime.internals.device,
          generation: runtime.internals.deviceScope.generation,
          ...(candidateGpuDrivenProduction === undefined
            ? {}
            : { gpuDrivenProduction: candidateGpuDrivenProduction }),
          ...(candidateGpuDrivenScene === undefined
            ? {}
            : { gpuDrivenScene: candidateGpuDrivenScene }),
          ...(candidatePointsLines === undefined ? {} : { pointsLines: candidatePointsLines }),
          ...(candidateFeatureHost === undefined ? {} : { featureHost: candidateFeatureHost }),
          ...(candidateFeatureGpuWork === undefined
            ? {}
            : { featureGpuWork: candidateFeatureGpuWork }),
          featureSceneInputs: candidateSceneInputs,
          featureGraphCandidate: candidateFeatureGraph,
          postProcessPipelines: new Map(
            runtime.internals.getRecoveryPostProcessPipelines?.() ?? [],
          ),
          recoveryReadiness,
          release: releaseCandidate,
          markPublished,
        },
      };
    } catch (cause) {
      return failed(`candidate preparation threw: ${String(cause)}`, cause);
    }
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
