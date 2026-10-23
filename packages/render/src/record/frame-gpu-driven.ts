// GPU-driven lane preparation for one display frame: producer artifacts,
// the GPU owner's prepare request, its shadow view roster, and the direct
// shadow rows that remain CPU-recorded beside it.

import type { Buffer } from '@forgeax/engine-rhi';
import { requiresProbeBlendRecord } from '../assembly/material/artifact-probe-blend';
import { directionalShadowFilterRadiusTexels } from '../components/directional-shadow-filter';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { GpuDrivenBatchBinding } from '../gpu-driven/batch-topology';
import {
  type CollectedMaterialArtifacts,
  collectGpuDrivenMaterialArtifacts,
} from '../gpu-driven/material-artifacts';
import type {
  GpuDrivenPrepareInput,
  GpuDrivenProduction,
  PreparedGpuDrivenFrame,
  ShadowViewRequest,
} from '../gpu-driven/production-raster';
import {
  type ShadowCameraCullDilation,
  type ShadowViewIdentity,
  shadowCameraCullDilation,
  shadowViewIdentityKey,
} from '../gpu-driven/shadow-views';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { VisibleSurfaceProjection } from '../raytracing/visible-surface';
import type { CameraSnapshot } from '../render-contract';
import type {
  DispatchList,
  ExtractedLights,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { ShadowMaterialContent } from '../scene/material-shadow-content';
import type {
  PersistentGpuDrivenState,
  PersistentShadowCasterProjection,
} from '../scene/render-scene';
import { SHADOW_CASTER_PASS_SELECTOR } from '../systems/pass-selector';
import { directDrawRows } from './direct-draws';
import type { ShadowMeshInput } from './directional-shadow-cache';
import type { CubeCaptureFrameInput, FrameRecordingAttempt, GpuDrivenRecordInput } from './frame';
import type { RenderFrameState, ValidatedRenderable } from './frame-snapshot';
import { materialMatchesPass } from './material-pass-selection';
import { ensureProbeBlendRecordBuffer } from './probe-blend-buffer';
import {
  type PipelineState,
  type RecordProfileRunner,
  type RenderSystemInternals,
  runRecordProfilePhase,
} from './render-context';
import { shadowPlanes } from './shadow-culling';

type PrepareSources = (
  sources: FrameList<RenderableSnapshot>,
  dispatch?: DispatchList,
) => readonly ValidatedRenderable[];
type PrepareShadowGeometry = (mesh: MeshGpuHandles, material: MaterialSnapshot) => MeshGpuHandles;
type LodRows = (rows: readonly ValidatedRenderable[]) => readonly ValidatedRenderable[];

/** Clustered Standard lighting binds its cluster owner only with local lights or SSAO. */
export function clusteredLightingActive(
  standard: StandardTopologyInputValue,
  frameState: RenderFrameState,
): boolean {
  return (
    standard.kind === 'clustered' &&
    (standard.prepared.local.length > 0 ||
      frameState.installedPipelineConfig?.ssao?.enabled === true)
  );
}

/**
 * Resolve one producer artifact for every prepared draw. COLOR_0 is a
 * per-geometry ABI axis, so a residency-wide `.some(color)` would pair a
 * no-color draw with the colored receipt and collapse two distinct
 * pipeline/projection identities before indirect record.
 */
export function collectFrameGpuDrivenArtifacts(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  scene: PersistentGpuDrivenState | undefined,
  programs: PersistentShadowCasterProjection['materialPrograms'] | undefined,
  standard: StandardTopologyInputValue,
  shadowViews: boolean,
): CollectedMaterialArtifacts {
  return collectGpuDrivenMaterialArtifacts({
    batches: scene?.plan.batches ?? [],
    probeBlend: (scene?.probeBlend?.records.length ?? 0) > 0,
    programs,
    resolve: internals.getMaterialShaderArtifact,
    clustered: clusteredLightingActive(standard, frameState),
    reflectionFallback: frameState.reflectionFallbackDemand === true,
    shadowViews,
  });
}

export function collectGpuShadowMaterials(
  internals: RenderSystemInternals,
  worlds: readonly RenderResourceScope[],
  batchExecutions: CollectedMaterialArtifacts['batchExecutions'],
  meshes: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>,
  shadowMaterials: ShadowMaterialContent,
  meshReads: ShadowMeshInput | undefined,
): void {
  for (const [binding, execution] of batchExecutions) {
    if (execution.shadow.route === 'none') continue;
    const scope = worlds[binding.worldId];
    if (scope !== undefined)
      shadowMaterials.add(
        binding.material,
        execution.shadow.material,
        scope,
        internals.preparedMaterialTexture,
      );
    const mesh = meshes.get(binding);
    meshReads?.reads.add(mesh?.changeToken);
  }
}

export function gpuProbeBlendBufferFor(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  materialArtifacts: CollectedMaterialArtifacts['materialArtifacts'],
  deferredProbeBuffer: Buffer | undefined,
  scene: PersistentGpuDrivenState | undefined,
): Buffer | undefined {
  const requested = [...materialArtifacts.values()].some((artifact) =>
    requiresProbeBlendRecord(artifact),
  );
  if (deferredProbeBuffer !== undefined) return deferredProbeBuffer;
  return requested
    ? ensureProbeBlendRecordBuffer(internals.device, frameState, scene?.probeBlend)
    : undefined;
}

function gpuDrivenFrameFacts(frameGpuDriven: GpuDrivenRecordInput) {
  return {
    ...(frameGpuDriven.activeEntityKeys === undefined
      ? {}
      : { activeEntityKeys: frameGpuDriven.activeEntityKeys }),
    ...(frameGpuDriven.activeEntityRevision === undefined
      ? {}
      : { activeEntityRevision: frameGpuDriven.activeEntityRevision }),
    ...(frameGpuDriven.telemetryCandidateCount === undefined
      ? {}
      : { telemetryCandidateCount: frameGpuDriven.telemetryCandidateCount }),
    ...(frameGpuDriven.telemetrySubmit === undefined
      ? {}
      : { telemetrySubmit: frameGpuDriven.telemetrySubmit }),
    ...(frameGpuDriven.frameTime === undefined ? {} : { frameTime: frameGpuDriven.frameTime }),
    ...(frameGpuDriven.deviceGeneration === undefined
      ? {}
      : { deviceGeneration: frameGpuDriven.deviceGeneration }),
    ...(frameGpuDriven.surfaceDynamicInput === undefined
      ? {}
      : { surfaceDynamicInput: frameGpuDriven.surfaceDynamicInput }),
    ...(frameGpuDriven.scene?.structureMetrics === undefined
      ? {}
      : { structureMetrics: frameGpuDriven.scene.structureMetrics }),
  };
}

function gpuDrivenArtifactInputs(
  artifacts: CollectedMaterialArtifacts,
  probeBlendRecordBuffer: Buffer | undefined,
) {
  const { firstArtifact, firstSkinArtifact, materialArtifacts, shadowMaterialArtifacts } =
    artifacts;
  return {
    ...(firstArtifact === undefined ? {} : { materialArtifact: firstArtifact }),
    ...(firstSkinArtifact === undefined ? {} : { materialSkinArtifact: firstSkinArtifact }),
    ...(materialArtifacts.size === 0 ? {} : { materialArtifacts }),
    ...(shadowMaterialArtifacts.size === 0 ? {} : { shadowMaterialArtifacts }),
    ...(probeBlendRecordBuffer === undefined ? {} : { probeBlendRecordBuffer }),
  };
}

function materialPipelineFactories(internals: RenderSystemInternals) {
  return {
    ...(internals.getMaterialShaderPipelineEntry === undefined
      ? {}
      : { materialPipelineFactory: internals.getMaterialShaderPipelineEntry }),
    ...(internals.prepareMaterialShaderPipelineEntry === undefined
      ? {}
      : { materialPipelinePreparationFactory: internals.prepareMaterialShaderPipelineEntry }),
  };
}

export function gpuDrivenPrepareRequest(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  frameGpuDriven: GpuDrivenRecordInput,
  artifacts: CollectedMaterialArtifacts,
  standard: StandardTopologyInputValue,
  camera: CameraSnapshot,
  pipelineState: PipelineState,
  meshByBinding: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>,
  visibleSurface: VisibleSurfaceProjection | undefined,
  probeBlendRecordBuffer: Buffer | undefined,
  shadowViews: boolean,
  shadowMaterials: ShadowMaterialContent,
  materialBindingClasses: ReadonlyMap<string, string>,
  shadowCasterProjection: PersistentShadowCasterProjection | undefined,
  profilePhase: RecordProfileRunner | undefined,
  capsuleShadowDirectional: boolean,
): GpuDrivenPrepareInput {
  const scene = frameGpuDriven.scene;
  return {
    scene,
    batchExecutions: artifacts.batchExecutions,
    materialArtifactResolver: (shader, request) =>
      internals.getMaterialShaderArtifact?.(shader, {
        ...(typeof request === 'boolean' ? { vertexColorAvailable: request } : request),
        clustered: clusteredLightingActive(standard, frameState),
        probeBlend: (scene?.probeBlend?.records.length ?? 0) > 0,
        reflectionFallback: frameState.reflectionFallbackDemand === true,
      }),
    geometryLane: frameGpuDriven.geometryLane ?? 'automatic',
    gbufferBatchOrderDiagnostic: internals.standardProfile?.gbufferBatchOrderDiagnostic,
    ...(visibleSurface === undefined ? {} : { visibleSurface }),
    camera,
    meshByBinding,
    viewBindGroupLayout: pipelineState.viewBindGroupLayout,
    // `hdrp` remains a compatibility stop for callers that cannot provide
    // the clustered topology. The production frame supplies the explicit
    // Standard topology, so the GPU owner can select a matching published
    // group(2) artifact and bind the existing cluster owner.
    hdrp: clusteredLightingActive(standard, frameState),
    clustered: standard.kind === 'clustered',
    materialBindingClasses,
    ...gpuDrivenFrameFacts(frameGpuDriven),
    ...gpuDrivenArtifactInputs(artifacts, probeBlendRecordBuffer),
    materialPipelineState: pipelineState,
    shadowViews,
    shadowMaterials,
    ...(shadowCasterProjection === undefined
      ? {}
      : { materialFrame: shadowCasterProjection.content.materials }),
    ...materialPipelineFactories(internals),
    capsuleShadowDirectional,
    ...(profilePhase === undefined ? {} : { profilePhase }),
  };
}

function shadowCasterChannelsFor(lights: ExtractedLights, identity: ShadowViewIdentity) {
  return identity.kind === 'directional'
    ? lights.directionalCsmConfig?.shadowCasterChannels
    : identity.kind === 'point'
      ? lights.pointShadow[identity.index]?.shadowCasterChannels
      : lights.spot.filter((light) => (light.shadowAtlasTile ?? -1) >= 0)[identity.index]
          ?.shadowCasterChannels;
}

function pushShadowViewRequest(
  views: ShadowViewRequest[],
  lights: ExtractedLights,
  planesByView: ReadonlyMap<string, Float32Array>,
  targetSize: number | undefined,
  graphGeneration: number,
  identity: ShadowViewIdentity,
  matrix: Float32Array,
  cameraCull?: ShadowCameraCullDilation,
): void {
  views.push({
    identity,
    casterChannels: shadowCasterChannelsFor(lights, identity),
    planes: planesByView.get(shadowViewIdentityKey(identity)) ?? shadowPlanes(matrix),
    matrix,
    targetSize,
    graphGeneration,
    ...(cameraCull === undefined ? {} : { cameraCull }),
    ...(identity.kind === 'directional' && lights.directionalCsmConfig?.staticShadowCache === false
      ? { staticLayer: false as const }
      : {}),
  });
}

/** Directional cascades, point cube faces and atlas spots, in GPU shadow view order. */
function gpuShadowViewRequests(
  lights: ExtractedLights,
  planesByView: ReadonlyMap<string, Float32Array>,
  targetSize: number | undefined,
  graphGeneration: number,
  directionalLimit: number | undefined,
): ShadowViewRequest[] {
  const views: ShadowViewRequest[] = [];
  const directionalCameraCull =
    lights.directionalShadowQuality === undefined
      ? undefined
      : shadowCameraCullDilation(
          directionalShadowFilterRadiusTexels(lights.directionalShadowQuality),
          lights.normalBias ?? 0.05,
          targetSize,
        );
  for (const [index, matrix] of (lights.lightViewProj ?? []).entries()) {
    if (directionalLimit !== undefined && index >= directionalLimit) continue;
    pushShadowViewRequest(
      views,
      lights,
      planesByView,
      targetSize,
      graphGeneration,
      { kind: 'directional', index },
      matrix,
      directionalCameraCull,
    );
  }
  for (const [index, point] of lights.pointShadow.entries()) {
    for (let face = 0; face < 6; face += 1) {
      pushShadowViewRequest(
        views,
        lights,
        planesByView,
        targetSize,
        graphGeneration,
        { kind: 'point', index, face },
        point.shadowMatrices.subarray(face * 16, face * 16 + 16),
      );
    }
  }
  let shadowSpotIndex = 0;
  for (const spot of lights.spot) {
    if (spot.lightViewProj === undefined) continue;
    pushShadowViewRequest(
      views,
      lights,
      planesByView,
      targetSize,
      graphGeneration,
      { kind: 'spot', index: shadowSpotIndex },
      spot.lightViewProj,
      shadowCameraCullDilation(
        Math.min(2, Math.max(0, (Math.round(spot.pcfKernelSize ?? 3) - 1) / 2)),
        0,
        targetSize,
      ),
    );
    shadowSpotIndex += 1;
  }
  return views;
}

/**
 * A capable GPU-owned candidate with missing producer resources is a
 * structured stop, not permission to enumerate the same draw through the CPU
 * semantic path. The last-known-good graph is preserved and the frame retries
 * after the producer publishes a validated artifact.
 */
export function prepareGpuDrivenOwner(
  internals: RenderSystemInternals,
  attempt: FrameRecordingAttempt,
  owner: GpuDrivenProduction,
  request: GpuDrivenPrepareInput,
  profilePhase: RecordProfileRunner | undefined,
  gpuShadowViews: boolean,
  lights: ExtractedLights,
  shadowPlanesByView: () => ReadonlyMap<string, Float32Array>,
  targetSize: number | undefined,
  graphGeneration: number,
  directionalLimit: number | undefined,
): boolean {
  const prepared = owner.prepare(request);
  if (!prepared.ok) {
    internals.errorRegistry.fire(prepared.error);
    return false;
  }
  if (prepared.value === undefined) return true;
  attempt.preparedGpuDriven = prepared.value;
  const shadowViews = gpuShadowViews
    ? gpuShadowViewRequests(
        lights,
        shadowPlanesByView(),
        targetSize,
        graphGeneration,
        directionalLimit,
      )
    : [];
  const updateShadowViews = prepared.value.updateShadowViews;
  if (updateShadowViews === undefined) return true;
  const shadowUpdate = runRecordProfilePhase(
    profilePhase,
    'record/gpu-driven-prepare/shadow-views',
    () => updateShadowViews(shadowViews),
  );
  if (!shadowUpdate.ok) {
    internals.errorRegistry.fire(shadowUpdate.error);
    return false;
  }
  return true;
}

function captureViewsCastShadows(
  captureWorkCount: number,
  cubeCapture: CubeCaptureFrameInput | undefined,
): boolean {
  return (
    captureWorkCount > 0 ||
    cubeCapture?.reflectionProbes?.graph.work.some((work) => work.rawCaptureFace !== undefined) ===
      true
  );
}

/** Unbatched and capture-visible shadow casters beside the GPU shadow view pool. */
export function gpuLaneDirectShadowRows(
  prepared: PreparedGpuDrivenFrame | undefined,
  scene: PersistentGpuDrivenState | undefined,
  gpuShadowViews: boolean,
  batchExecutions: CollectedMaterialArtifacts['batchExecutions'],
  captureWorkCount: number,
  cubeCapture: CubeCaptureFrameInput | undefined,
  meshes: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>,
  worlds: readonly RenderResourceScope[],
  prepareSources: PrepareSources,
  viewDraws: FrameList<RenderableSnapshot> | undefined,
  prepareShadowGeometry: PrepareShadowGeometry,
  shadowLodRows: LodRows,
): readonly ValidatedRenderable[] | undefined {
  if (
    !gpuShadowViews ||
    prepared?.shadowViewPool === undefined ||
    scene?.unbatchedSlots === undefined
  ) {
    return undefined;
  }
  const captureShadows = captureViewsCastShadows(captureWorkCount, cubeCapture);
  return shadowLodRows(
    directDrawRows(
      scene,
      (binding) => {
        const execution = batchExecutions.get(binding)?.shadow;
        if (execution === undefined) throw new Error('Missing accepted Shadow execution');
        if (execution.route === 'none') return undefined;
        return captureShadows || execution.route === 'direct' ? execution.material : undefined;
      },
      meshes,
      worlds,
      'shadow',
      prepareSources,
      viewDraws,
      prepareShadowGeometry,
    ),
  );
}

/** CPU shadow rows when the GPU lane did not provide its own direct roster. */
export function validateDirectShadowRows(
  nativeScene: PersistentGpuDrivenState | undefined,
  sourceRenderables: FrameList<RenderableSnapshot>,
  dispatch: DispatchList,
  materials: MaterialFrame,
  meshes: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>,
  worlds: readonly RenderResourceScope[],
  prepareSources: PrepareSources,
  viewDraws: FrameList<RenderableSnapshot> | undefined,
  prepareShadowGeometry: PrepareShadowGeometry,
  shadowLodRows: LodRows,
): readonly ValidatedRenderable[] {
  if (nativeScene === undefined) return shadowLodRows(prepareSources(sourceRenderables, dispatch));
  return shadowLodRows(
    directDrawRows(
      nativeScene,
      (binding) => {
        const material = materials.get(binding.material);
        if (material === undefined) throw new Error('Shadow draw requires its accepted material');
        return materialMatchesPass(material, SHADOW_CASTER_PASS_SELECTOR, undefined, undefined)
          ? material.snapshot
          : undefined;
      },
      meshes,
      worlds,
      'shadow',
      prepareSources,
      viewDraws,
      prepareShadowGeometry,
    ),
  );
}

export function collectDirectShadowMaterials(
  internals: RenderSystemInternals,
  worlds: readonly RenderResourceScope[],
  rows: readonly ValidatedRenderable[] | undefined,
  materials: MaterialFrame,
  shadowMaterials: ShadowMaterialContent,
  meshReads: ShadowMeshInput | undefined,
): void {
  for (const row of rows ?? []) {
    meshReads?.reads.add(row.mesh.changeToken);
    const scope = worlds[row.source.worldId ?? 0];
    if (scope === undefined) continue;
    for (const index of row.submeshIndices ?? row.mesh.submeshes.keys()) {
      const submesh = row.mesh.submeshes[index];
      if (submesh === undefined) continue;
      const resource = row.source.materials[submesh.materialSlot] ?? row.source.material;
      const accepted = materials.get(resource);
      if (accepted !== undefined)
        shadowMaterials.add(resource, accepted.snapshot, scope, internals.preparedMaterialTexture);
    }
  }
}
