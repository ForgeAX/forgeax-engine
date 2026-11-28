import {
  appendCompiledRenderGraphPassNames,
  compiledRenderGraphGeneration,
} from '@forgeax/engine-render-graph';
import type { Result } from '@forgeax/engine-rhi';
import {
  directionalShadowProfileFromQuality,
  projectDirectionalShadowInspectionSource,
} from './assembly/directional-shadow-inspection';
import type { ObservationUnavailableError } from './errors/render';
import {
  depthOfFieldGraphForParams,
  projectDepthOfFieldInspection,
} from './features/depth-of-field/depth-of-field-inspection';
import { projectMotionBlurInspection } from './features/motion-blur/motion-blur-runtime';
import type {
  BarrelDistortionInspection,
  BloomInspection,
  DepthOfFieldInspection,
  DirectionalShadowInspection,
  MotionBlurInspection,
  RenderFeatureGraphInspection,
  RenderSceneInspection,
  SsrDependenciesInspection,
  SsrSpatialInspection,
  TemporalTargetInspection,
  TransmissionInspection,
} from './inspection-types';
import { emptyBloomInspection } from './inspection-types';
import type { InstanceCollectionInspection } from './instances';
import type { MaterialResource } from './material-resource';
import {
  type MeshMaterialBindingObservation,
  projectMeshMaterialBindingObservation,
} from './mesh-material-bindings';
import { AUTO_EXPOSURE_HISTOGRAM_BYTES } from './pipeline/standard-output/auto-exposure/gpu';
import {
  type AutoExposureInspection,
  autoExposureCapabilityFailure,
  createAutoExposureInspection,
} from './pipeline/standard-output/auto-exposure/inspection';
import {
  inspectStandardLutState,
  type StandardLutState,
} from './pipeline/standard-output/lut-state';
import { inspectBarrelDistortionState } from './record/barrel-distortion-frame';
import {
  type FrameObservation,
  type FrameObservationOptions,
  observeCurrentFrame,
} from './record/frame';
import { type CurrentGraphTarget, getTextureIdentity } from './record/frame-snapshot';
import { inspectRenderGraphGenerationAllocation } from './record/graph-allocation-owner';
import { getRenderFeatureGraphInspection } from './record/typed-frame-graph';
import {
  createRendererProducerRootMatrix,
  type RendererProducerRoot,
} from './render-system-producer-roots';
import { createMaterialResidencyObserver } from './render-system-residency';
import { type SsrSpatialAdmission, zeroSsrAdmissionWork } from './ssr/admission';
import { projectSsrSpatialInspection } from './ssr/inspection';
import { inspectTemporal, type TemporalInspection } from './temporal/inspection';
import { inspectWaterFoamDraw } from './water/foam-inspection';
import {
  directionalShadowWriterPasses,
  inspectSettledDirectionalShadow,
} from './world/directional-shadow-inspection';
import {
  inspectSharedFeatureGraphs,
  sharedFeatureGraphInspection,
} from './world/feature-graph-systems';
import type { MaterialSlotDrawReceiptFact } from './world/material-draw-receipt';
import { viewPhaseInspection } from './world/queue-systems';
import { viewRecordHistory } from './world/record-history';
import { resolveViewSsrDependencies } from './world/reflection-systems';
import { viewLightsOf } from './world/render-lights';
import { ViewSubmission } from './world/render-views';
import { renderWorldFor } from './world/render-world';
import { viewTransmissionInspection } from './world/transmission-systems';
import type { WaterBakedDrawReceiptFact } from './world/view-draw-receipt';
import { viewDrawReceipt } from './world/view-draw-receipt';
import { viewFrameOf, viewFrameScopes } from './world/view-frame-systems';
import { viewPointsLines } from './world/view-points-lines';
import { recordContext } from './world/view-record-context';
import type { ViewSettlementOwner } from './world/view-settlement';

/*
 * Inspection projections of one view. Each reads the view's owner bag and its
 * Render World entity; none mutates view state. A Renderer inspects the view
 * that records its display (`CameraViews.currentOwner`).
 */

/** Production-owner recovery facts used by `Renderer.inspect()`. */
export interface RecoveryProductionEvidence {
  readonly producerRoots: readonly RendererProducerRoot[];
  readonly graph: {
    readonly ready: boolean;
    readonly generation: number;
    readonly passCount: number;
    readonly resourceCount: number;
  };
  readonly residency: { readonly meshResidencyEpoch: number };
  readonly submissions: {
    readonly count: number;
    readonly lastGeneration: number | undefined;
  };
}

const recordHistoryOf = ({ internals }: ViewSettlementOwner) =>
  viewRecordHistory(renderWorldFor(internals), internals.viewEntity);

/** The view's compiled-graph facts, absent before its first compile. */
export function viewGraphInfo(owner: ViewSettlementOwner) {
  return owner.frameState.compiledFrameGraph?.graph.inspect();
}

/** The generation written to timings and receipts belongs to the installed procedure. */
export function viewGraphGeneration(owner: ViewSettlementOwner): number {
  const graph = owner.frameState.compiledFrameGraph?.graph;
  return graph === undefined ? 0 : compiledRenderGraphGeneration(graph);
}

/** The view's compiled pass names in declaration order; empty before its first compile. */
export function viewPassNames(owner: ViewSettlementOwner): readonly string[] {
  const graph = owner.frameState.compiledFrameGraph?.graph;
  const names: string[] = [];
  if (graph !== undefined) appendCompiledRenderGraphPassNames(graph, names);
  return names;
}

/** Persistent scene maintenance evidence of the view's scene. */
export function viewRenderScene(owner: ViewSettlementOwner): RenderSceneInspection {
  const { frameState, internals, scene } = owner;
  const renderWorld = renderWorldFor(internals);
  const submission = owner.surfaceSubmission.inspect();
  return {
    ...scene.inspect(),
    pointsLines: viewPointsLines(renderWorld, internals.viewEntity)?.inspections() ?? [],
    gpuDriven: owner.gpuDriven.inspect(owner.skin.paletteUploadBytes),
    frameCaches: {
      materialUniforms: {
        ...(frameState.materialUboCounters ?? {
          packHits: 0,
          packMisses: 0,
          uploadRanges: 0,
          uploadedLogicalBytes: 0,
          skippedUploads: 0,
        }),
      },
      ...(internals.getMaterialPipelineRequestInspection === undefined
        ? {}
        : { materialPipelineRequests: internals.getMaterialPipelineRequestInspection() }),
      visibilityProjection: scene.visibilityProjectionCacheInspection(),
      temporalSnapshots: scene.temporalSnapshotCacheInspection(),
      transparentSort: viewPhaseInspection(renderWorld, internals.viewEntity) ?? {
        hits: 0,
        misses: 0,
      },
      renderBundles: {
        ...(frameState.renderBundleCounters ?? { hits: 0, misses: 0 }),
        ...(frameState.renderBundleCounters?.geometry === undefined
          ? {}
          : { geometry: structuredClone(frameState.renderBundleCounters.geometry) }),
      },
    },
    ...(submission === undefined ? {} : { submission }),
  };
}

/** Detached residency and upload facts of the view's explicit instance collections. */
export function viewInstanceCollections(
  owner: ViewSettlementOwner,
): readonly InstanceCollectionInspection[] {
  return owner.instanceCollections._inspections(owner.frameState.frameNumber - 1);
}

/** Live SSR spatial admission and bounded graph/history projection. */
export function viewSsr(owner: ViewSettlementOwner): SsrSpatialInspection {
  const { frameState, internals } = owner;
  const camera = owner.recorded.camera;
  const lane =
    (frameState.cameraStandardProfile ?? internals.standardProfile)?.renderPath === 'deferred'
      ? 'deferred'
      : 'forward';
  const admission: SsrSpatialAdmission =
    frameState.ssrSpatialAdmission ??
    Object.freeze({
      status: camera?.screenSpaceReflection === undefined ? 'not-requested' : 'requested',
      lane,
      config: camera?.screenSpaceReflection,
      viewRange: camera === undefined ? 0 : camera.far - camera.near,
      work: zeroSsrAdmissionWork(),
    });
  const admitted = admission.status === 'admitted';
  const status =
    admitted && (internals.ssrShaders === undefined || internals.depthPyramidShaders === undefined)
      ? ('structural-only' as const)
      : admission.status;
  const graph = viewGraphInfo(owner);
  const passRoster =
    admitted && graph !== undefined
      ? graph.passes
          .filter((pass) => /^(ssr-|hzb-(seed|reduce-))/.test(pass.name))
          .map((pass) => pass.name)
      : [];
  const dependencies = resolveViewSsrDependencies(owner, frameState.ssrRequested === true);
  const fallbackSource = dependencies.reflectionFallback?.source;
  return projectSsrSpatialInspection(admission, {
    status,
    passRoster,
    ...(fallbackSource === undefined ? {} : { fallbackSource }),
  });
}

/** Auto-exposure state published after a successful completed frame; absent without an auto exposure camera. */
export function viewAutoExposure(owner: ViewSettlementOwner): AutoExposureInspection | undefined {
  const camera = owner.recorded.camera;
  const state = owner.frameState.autoExposureState;
  if (camera?.output?.exposure.kind !== 'auto' || state === undefined) return undefined;
  const unavailable = autoExposureCapabilityFailure(
    owner.internals.device.caps,
    state.targetGeneration,
  );
  const physicalPassCount = viewPassNames(owner).filter((name) =>
    name.startsWith('auto-exposure-'),
  ).length;
  const fragment = owner.frameState.autoExposureGpuResources?.execution === 'fragment';
  const actual =
    unavailable !== undefined ? state.fallback : state.acceptedEv > 0 ? state.acceptedEv : null;
  return createAutoExposureInspection({
    requested: camera.output.exposure,
    actual,
    actualState:
      unavailable !== undefined
        ? 'fallback'
        : actual === null
          ? state.receipt.committed
            ? 'gpu-resident'
            : 'fallback'
          : 'accepted',
    fallback: state.fallback,
    lastKnownGood: state.lastKnownGood,
    targetGeneration: state.targetGeneration,
    reset: state.reset,
    ...(unavailable === undefined ? {} : { recentFailure: unavailable }),
    cost:
      unavailable === undefined
        ? {
            histogramBytes: AUTO_EXPOSURE_HISTOGRAM_BYTES,
            passCount: fragment ? physicalPassCount : 3,
            physicalPassCount,
          }
        : { histogramBytes: 0, passCount: 0, physicalPassCount: 0 },
    receipt: state.receipt,
  });
}

/** The view's probe placement history; absent unless the Standard profile declares placement. */
export function viewProbePlacement(owner: ViewSettlementOwner) {
  return owner.internals.standardProfile?.probePlacement === undefined
    ? undefined
    : owner.frameState.probePlacement?.inspect();
}

/** The view's diffuse GI owner selected by the Standard profile's gather. */
export function viewDiffuseGi(owner: ViewSettlementOwner) {
  const { frameState } = owner;
  const gather = owner.internals.standardProfile?.diffuseGi?.gather;
  if (gather === 'exact') return frameState.rayDiffuse?.inspect();
  if (gather === 'irradiance-field') return frameState.irradianceField?.inspect();
  if (gather === 'screen-probe')
    return frameState.screenProbe?.inspect(frameState.irradianceField?.inspect());
  if (gather === 'baked') return frameState.bakedField?.inspect();
  return undefined;
}

/** The view's accepted, candidate and retiring temporal state. */
export function viewTemporal(owner: ViewSettlementOwner): TemporalInspection {
  const { frameState } = owner;
  return inspectTemporal(frameState.temporalView.accepted, undefined, {
    ...(frameState.activeTemporalGpuState === undefined
      ? {}
      : { active: frameState.activeTemporalGpuState }),
    ...(frameState.temporalGpuState === undefined
      ? {}
      : { candidate: frameState.temporalGpuState }),
    retiring: [...frameState.retiringTemporalGpuStates],
    deviceGeneration: recordContext(owner.internals).deviceScope.generation,
  });
}

/** Motion-blur request, validation and execution facts of the view's last attempt. */
export function viewMotionBlur(owner: ViewSettlementOwner): MotionBlurInspection | undefined {
  const { frameState, internals } = owner;
  return projectMotionBlurInspection({
    camera: owner.recorded.camera,
    invalidParams: owner.recorded.motionBlurInvalidParams,
    capabilities: internals.device.caps,
    acceptedTemporal: frameState.temporalView.accepted,
    transaction: frameState.temporalFrameTransaction.inspect(),
    execution: frameState.motionBlurExecution,
    temporalFrameId: frameState.temporalFrameTransaction.accepted()?.frameId,
    deviceGeneration: recordContext(internals).deviceScope.generation,
    graphGeneration: frameState.graphGeneration,
  });
}

/** Depth-of-field parameters, graph and submit-bound acceptance of the view; absent before a camera. */
export function viewDepthOfField(owner: ViewSettlementOwner): DepthOfFieldInspection | undefined {
  const { frameState } = owner;
  const camera = owner.recorded.camera;
  if (camera === undefined) return undefined;
  return projectDepthOfFieldInspection({
    ...(camera.depthOfField === undefined ? {} : { params: camera.depthOfField }),
    ...(camera.depthOfFieldError === undefined ? {} : { error: camera.depthOfFieldError }),
    graph: depthOfFieldGraphForParams(frameState.compiledFrameGraph, camera.depthOfField),
    // The explicit property keeps the inspector on the submit-bound
    // transaction path even before the first accepted frame.
    accepted: frameState.depthOfFieldAccepted,
    ...(frameState.depthOfFieldLastSubmitFailed === true ? { lastSubmitFailed: true } : {}),
    // Inspection can run while the renderer assembles, before a device scope is published.
    deviceGeneration: recordContext(owner.internals).deviceScope?.generation ?? 0,
  });
}

/** The graph-owned `standard-scene-temporal` target of the view's compiled graph. */
export function viewTemporalTarget(
  owner: ViewSettlementOwner,
): TemporalTargetInspection | undefined {
  const graph = viewGraphInfo(owner);
  if (graph === undefined) return undefined;
  const producer = graph.passes.find((pass) => pass.name === 'standard-scene-data');
  // Resolve the semantic target from the compiled resource table: a backend
  // may keep a view alias in the pass access list while the resource owner
  // carries the canonical label.
  const target = graph.resources.find(
    (resource) => resource.kind === 'texture' && resource.label === 'standard-scene-temporal',
  );
  if (producer === undefined || target === undefined) return undefined;
  const descriptor = target.descriptor.kind === 'texture' ? target.descriptor : undefined;
  const width = descriptor?.width ?? Math.max(1, recordContext(owner.internals).canvas.width);
  const height = descriptor?.height ?? Math.max(1, recordContext(owner.internals).canvas.height);
  return Object.freeze({
    identity: 'standard-scene-temporal',
    producerId: 'forgeax::standard::scene-data',
    schema: 'forgeax::scene-data::temporal-v1',
    targetCount: 1,
    descriptor: Object.freeze({
      format: 'rgba16float',
      width,
      height,
      sampleCount: 1,
      bytes: width * height * 8,
    }),
  });
}

/** Bloom resource lifecycle against the view's compiled graph. */
export function viewBloom(owner: ViewSettlementOwner): BloomInspection {
  const resources = recordContext(owner.internals).getPipelineState()?.perPassResources;
  const lifecycle = resources?.inspectBloomResources?.(viewGraphInfo(owner));
  return Object.freeze(lifecycle ?? emptyBloomInspection());
}

/** Single production projection of the view's Directional author/extract/record facts. */
export function viewDirectionalShadow(owner: ViewSettlementOwner): DirectionalShadowInspection {
  const settled = recordHistoryOf(owner)?.directionalShadow.settled;
  if (settled !== undefined) return inspectSettledDirectionalShadow(owner, settled);
  const { frameState, internals } = owner;
  const lights = viewLightsOf(renderWorldFor(internals), internals.viewEntity);
  const cascadeCount = lights?.cascades?.cascadeCount ?? 0;
  const requested = directionalShadowProfileFromQuality(lights?.cascades?.directionalShadowQuality);
  const shadowReady = frameState.frameOutputs.directionalShadowView !== null;
  const directionalShadow = recordHistoryOf(owner)?.directionalShadow;
  return projectDirectionalShadowInspectionSource({
    requested,
    candidate: directionalShadow?.candidate ?? 'failed',
    ...(frameState.directionalShadowCache === null
      ? {}
      : {
          lastKnownGood: directionalShadowProfileFromQuality(
            frameState.directionalShadowCache.directionalShadowQuality,
          ),
        }),
    cascadeCount,
    mapSize: recordContext(internals).getPipelineState()?.perPassResources.shadowMapSize ?? 0,
    shadowMapBytes: shadowReady
      ? (frameState.shadowDepthLayers?.byteSize('directional-shadow-depth') ?? 0)
      : 0,
    writerPasses: directionalShadowWriterPasses(frameState.compiledFrameGraph, cascadeCount),
    shadowAngularRadius: lights?.directionalCsmConfig?.shadowAngularRadius,
    maxPenumbraTexels: lights?.directionalCsmConfig?.maxPenumbraTexels,
    deviceGeneration: recordContext(internals).deviceScope.generation,
    graphGeneration:
      frameState.compiledFrameGraph?.targets.graphGeneration ?? frameState.graphGeneration,
    shadowReady,
    ...(directionalShadow?.error === undefined ? {} : { error: directionalShadow.error }),
  });
}

/** Mesh-slot provenance, diagnostics and residency of the view's staged frame. */
export interface MaterialSlotDrawReceiptQuery {
  readonly worldIdentity: string | undefined;
  readonly entityKey: number;
  readonly materialSlot: number;
  readonly submeshIndices: readonly number[];
  readonly materialHandle: number;
  readonly frameId: number | undefined;
  readonly deviceGeneration: number;
  readonly graphGeneration: number | undefined;
}

/** Return only a receipt for the exact entity, slot, material, and accepted draw. */
export function findMaterialSlotDrawReceipt(
  draws: readonly MaterialSlotDrawReceiptFact[],
  query: MaterialSlotDrawReceiptQuery,
): MaterialSlotDrawReceiptFact | undefined {
  if (
    query.worldIdentity === undefined ||
    query.frameId === undefined ||
    query.graphGeneration === undefined
  )
    return undefined;
  return draws.find(
    (draw) =>
      draw.worldIdentity === query.worldIdentity &&
      draw.entityKey === query.entityKey &&
      draw.materialSlot === query.materialSlot &&
      query.submeshIndices.includes(draw.submeshIndex) &&
      draw.materialHandle === query.materialHandle &&
      draw.frameId === query.frameId &&
      draw.deviceGeneration === query.deviceGeneration &&
      draw.graphGeneration === query.graphGeneration,
  );
}

export function viewMeshMaterialBindings(
  owner: ViewSettlementOwner,
): readonly MeshMaterialBindingObservation[] {
  const { internals } = owner;
  const observeResidency = createMaterialResidencyObserver(internals);
  const renderWorld = renderWorldFor(internals);
  const staged = viewFrameOf(renderWorld, internals.viewEntity);
  if (staged?.result?.ok !== true) return [];
  const scope = viewFrameScopes(renderWorld, staged).source;
  const graph = viewGraphInfo(owner);
  const shared = sharedFeatureGraphInspection(renderWorld);
  const drawReceipt = viewDrawReceipt(renderWorld, internals.viewEntity);
  const waterBakedDraws = drawReceipt?.waterBakedDraws ?? Object.freeze([]);
  const viewSubmission =
    internals.viewEntity !== undefined &&
    renderWorld.hasComponent(internals.viewEntity, ViewSubmission)
      ? renderWorld.get(internals.viewEntity, ViewSubmission).unwrap()
      : undefined;
  const acceptedFrame = acceptedViewInspectionFrame(viewSubmission, staged.frame, waterBakedDraws);
  const receiptMatchesAcceptedFrame = acceptedFrame !== undefined;
  const inspectionFrameId = staged.frame;
  const submitted = receiptMatchesAcceptedFrame;
  const descriptorOf = owner.frameState.compiledFrameGraph?.waterFluidBodyDescriptor;
  const sceneContent = owner.scene.shadowCasterProjection()?.content;
  const materials = sceneContent?.materials;
  const meshes = sceneContent?.meshes;
  // Scene-owned draws read the version the shadow/Scene frame accepted.
  // Generated view draws capture their material at their producer from the
  // resource's current snapshot; inspect the same one.
  const snapshotOf = (material: MaterialResource) =>
    materials?.get(material)?.snapshot ?? material.snapshot;
  return staged.result.value.renderables.map((renderable) => {
    const materialWorld = scope;
    return projectMeshMaterialBindingObservation({
      waterFoamInputs: renderable.materials.map((material, materialSlot) => {
        const draw = waterBakedDraws.find(
          (fact) => fact.entityKey === renderable.entityKey && fact.materialSlot === materialSlot,
        );
        const descriptor =
          renderable.waterOwner === undefined ? undefined : descriptorOf?.(renderable.waterOwner);
        const viewIdentity =
          renderable.waterOwner?.viewIdentity ?? renderable.waterMeshTiles?.viewIdentity;
        const drawKey = renderable.waterOwner?.drawKey ?? renderable.waterMeshTiles?.drawKey;
        const ownerWorldIdentity =
          renderable.waterOwner?.worldIdentity ?? renderable.waterMeshTiles?.worldIdentity;
        const graphGeneration =
          (receiptMatchesAcceptedFrame ? draw?.graphGeneration : undefined) ?? graph?.generation;
        const deviceGeneration =
          (receiptMatchesAcceptedFrame ? draw?.deviceGeneration : undefined) ??
          (receiptMatchesAcceptedFrame ? descriptor?.deviceGeneration : undefined) ??
          recordContext(internals).deviceScope.generation;
        return inspectWaterFoamDraw(
          snapshotOf(material),
          internals,
          graph,
          owner.frameState.graphGeneration,
          {
            frameId: inspectionFrameId,
            deviceGeneration,
            ...(graphGeneration === undefined ? {} : { graphGeneration }),
            ...(viewIdentity === undefined ? {} : { viewIdentity }),
            ...(drawKey === undefined ? {} : { drawKey }),
            ...(ownerWorldIdentity === undefined ? {} : { ownerWorldIdentity }),
            ...(materialWorld?.identity === undefined
              ? {}
              : { materialWorldIdentity: materialWorld.identity }),
            entityKey: renderable.entityKey,
            materialSlot,
            submitted,
            descriptor,
            shared,
            waterBakedDraws,
            ...(drawReceipt?.waterBakedUnavailableReason === undefined
              ? {}
              : { waterBakedUnavailableReason: drawReceipt.waterBakedUnavailableReason }),
          },
        );
      }),
      worldId: 0,
      ...(materialWorld === undefined ? {} : { worldIdentity: materialWorld.identity }),
      entityKey: renderable.entityKey,
      bindings: renderable.materials.map((material, slotIndex) => {
        const snapshot = snapshotOf(material),
          handle = snapshot.materialHandle ?? 0,
          sceneSubmeshIndices =
            meshes
              ?.get(renderable.assetHandle)
              ?.submeshes.flatMap((submesh, submeshIndex) =>
                submesh.materialSlot === slotIndex ? [submeshIndex] : [],
              ) ?? [],
          submeshIndices =
            sceneSubmeshIndices.length > 0
              ? sceneSubmeshIndices
              : (drawReceipt?.materials.draws
                  .filter(
                    (draw) =>
                      draw.entityKey === renderable.entityKey && draw.materialSlot === slotIndex,
                  )
                  .map((draw) => draw.submeshIndex) ?? []),
          materialDraw =
            receiptMatchesAcceptedFrame && drawReceipt !== undefined
              ? findMaterialSlotDrawReceipt(drawReceipt.materials.draws, {
                  worldIdentity: materialWorld?.identity,
                  entityKey: renderable.entityKey,
                  materialSlot: slotIndex,
                  submeshIndices,
                  materialHandle: handle,
                  frameId: acceptedFrame,
                  deviceGeneration: recordContext(internals).deviceScope.generation,
                  graphGeneration: graph?.generation,
                })
              : undefined;
        return {
          handle,
          source: renderable.materialBindingSources[slotIndex] ?? 'engine-default',
          ...(materialDraw === undefined
            ? {}
            : {
                sourceRevision: materialDraw.sourceRevision,
                drawReceipt: {
                  frameId: materialDraw.frameId,
                  deviceGeneration: materialDraw.deviceGeneration,
                  graphGeneration: materialDraw.graphGeneration,
                },
              }),
        };
      }),
      diagnostics: renderable.materialBindingDiagnostics ?? [],
      residency: renderable.materials.map((material) => {
        const snapshot = snapshotOf(material);
        return observeResidency(materialWorld, snapshot, material.ownsValues(snapshot));
      }),
    });
  });
}

/** Use this view's last accepted scene attempt and its own retained draw receipts. */
export function acceptedViewInspectionFrame(
  submission: Readonly<{ accepted: boolean; scene: boolean; attempt: number }> | undefined,
  stagedFrame: number,
  waterBakedDraws: readonly WaterBakedDrawReceiptFact[],
): number | undefined {
  if (submission?.accepted !== true || !submission.scene || submission.attempt !== stagedFrame)
    return undefined;
  return waterBakedDraws.every((draw) => draw.frameId === stagedFrame) ? stagedFrame : undefined;
}

/** Graph, residency and submission facts of the view's production owners. */
export function viewRecoveryEvidence(owner: ViewSettlementOwner): RecoveryProductionEvidence {
  const graph = viewGraphInfo(owner);
  const history = recordHistoryOf(owner);
  return Object.freeze({
    producerRoots: createRendererProducerRootMatrix(),
    graph: Object.freeze({
      ready: graph !== undefined,
      generation: graph?.generation ?? 0,
      passCount: graph?.passes.length ?? 0,
      resourceCount: graph?.resources.length ?? 0,
    }),
    residency: Object.freeze({ meshResidencyEpoch: owner.internals.gpuStore.meshResidencyEpoch }),
    submissions: Object.freeze({
      count: history?.submittedFrames ?? 0,
      lastGeneration: history?.lastGeneration,
    }),
  });
}

/** The view's volumetric fog inspection with its accepted owner count. */
export function viewVolumetricFog(
  owner: ViewSettlementOwner,
): import('./volume/inspection').VolumetricFogInspection {
  const { frameState } = owner;
  const accepted = frameState.volumetricFogAccepted;
  return {
    ...frameState.volumetricFogInspection,
    ownerCount: accepted === undefined ? 0 : 1 + (accepted.additional?.length ?? 0),
  };
}

/** Observe the view's current-frame linear HDR output. */
export function observeViewFrame(
  owner: ViewSettlementOwner,
  options: FrameObservationOptions,
): Promise<Result<FrameObservation, ObservationUnavailableError>> {
  const { frameState } = owner;
  return observeCurrentFrame(
    options,
    frameState.frameOutputs.observationSource,
    frameState.frameNumber - 1,
  );
}

/** Same-frame access to one color target of the view's compiled graph, for backend diagnostics. */
export function viewGraphTarget(
  owner: ViewSettlementOwner,
  name: string,
): CurrentGraphTarget | undefined {
  const { frameState } = owner;
  const graph = frameState.compiledFrameGraph?.targets;
  if (graph === undefined) return undefined;
  const descriptor = graph.getColorTargetDescriptor(name);
  const texture = graph.getColorTargetTexture(name);
  if (descriptor === undefined || texture === undefined) return undefined;
  return {
    name,
    texture,
    textureIdentity: getTextureIdentity(texture),
    descriptor,
    recordFrameNumber: frameState.frameNumber - 1,
    graphGeneration: graph.graphGeneration,
  };
}

/** Last completed transmission candidate facts of the view. */
export function viewTransmission(owner: ViewSettlementOwner): TransmissionInspection | undefined {
  return viewTransmissionInspection(renderWorldFor(owner.internals), owner.internals.viewEntity);
}

/** Allocation facts across the view's active, candidate and retiring graphs. */
export function viewGraphAllocation(owner: ViewSettlementOwner) {
  return inspectRenderGraphGenerationAllocation(owner.frameState);
}

/** The view's accepted and last-known-good barrel distortion mapping. */
export function viewBarrelDistortion(owner: ViewSettlementOwner): BarrelDistortionInspection {
  return inspectBarrelDistortionState(
    owner.frameState,
    recordContext(owner.internals).deviceScope?.generation ?? 0,
  );
}

/** The view's Standard LUT state published after a successful submit. */
export function viewStandardLut(owner: ViewSettlementOwner): StandardLutState {
  return inspectStandardLutState(owner.frameState.standardLutState);
}

/** Feature signature, compile and lifetime counters of the view's runtime. */
export function viewFeatureGraph(owner: ViewSettlementOwner): RenderFeatureGraphInspection {
  const graph = getRenderFeatureGraphInspection(owner.internals);
  const preparation = owner.frameState.candidatePipelinePreparations;
  const sharedFrame = inspectSharedFeatureGraphs(renderWorldFor(owner.internals));
  return {
    ...graph,
    ...(sharedFrame === undefined ? {} : { sharedFrame }),
    ...(preparation === undefined ? {} : { candidatePipelines: preparation.inspect() }),
  };
}

/** Live producer, RHI and temporal receipts projected through the view's SSR admission. */
export function viewSsrDependencies(owner: ViewSettlementOwner): SsrDependenciesInspection {
  return resolveViewSsrDependencies(owner, owner.frameState.ssrRequested === true);
}
