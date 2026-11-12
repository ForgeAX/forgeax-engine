import { DirectionalLight } from '../components/directional-light';
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
  MaterialSnapshot,
  RenderableSnapshot,
  SpotLightSnapshot,
} from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { ShadowMaterialContent } from '../scene/material-shadow-content';
import type {
  PersistentGpuDrivenState,
  PersistentShadowCasterProjection,
} from '../scene/render-scene';
import { shadowPlanes } from '../shadow-frustum';
import { SHADOW_CASTER_PASS_SELECTOR } from '../systems/pass-selector';
import { storeViewGpuDrivenOutcome } from '../world/gpu-driven-systems';
import { shadowViewCasterChannels, shadowViewLight, type ViewLights } from '../world/render-lights';
import { renderWorldFor } from '../world/render-world';
import { reflectionFallbackDemandOf } from '../world/ssr-admission-systems';
import type { ViewDrawPhases } from './direct-draw-phase';
import type { ShadowMeshInput } from './directional-shadow-cache';
import type { CubeCaptureFrameInput, GpuDrivenRecordInput } from './frame';
import type { RenderFrameState, ValidatedRenderable } from './frame-snapshot';
import { materialMatchesPass } from './material-pass-selection';
import { ensureProbeBlendRecordBuffer } from './probe-blend-buffer';
import {
  type PipelineState,
  type RecordProfileRunner,
  type RenderSystemInternals,
  runRecordProfilePhase,
} from './render-context';

type PrepareSources = (
  sources: FrameList<RenderableSnapshot>,
  dispatch?: DispatchList,
) => readonly ValidatedRenderable[];
type PrepareShadowGeometry = (
  mesh: MeshGpuHandles,
  material: MaterialSnapshot,
  source?: RenderableSnapshot,
) => MeshGpuHandles;
type LodRows = (rows: readonly ValidatedRenderable[]) => readonly ValidatedRenderable[];

/** GPU draws consume the same prepared lighting topology as direct draws. */
export function clusteredLightingActive(standard: StandardTopologyInputValue): boolean {
  return standard.kind === 'clustered';
}

/**
 * Resolve one producer artifact for every prepared draw. COLOR_0 is a
 * per-geometry ABI axis, so a residency-wide `.some(color)` would pair a
 * no-color draw with the colored receipt and collapse two distinct
 * pipeline/projection identities before indirect record.
 */
export function collectFrameGpuDrivenArtifacts(
  internals: RenderSystemInternals,
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
    clustered: clusteredLightingActive(standard),
    reflectionFallback: reflectionFallbackDemandOf(internals),
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
  for (const binding of batchExecutions.keys()) {
    const execution = batchExecutions.get(binding);
    if (execution === undefined || execution.shadow.route === 'none') continue;
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
  directionalShadowSimple = false,
  leanLighting = false,
): GpuDrivenPrepareInput {
  const scene = frameGpuDriven.scene;
  return {
    scene,
    batchExecutions: artifacts.batchExecutions,
    materialArtifactResolver: (shader, request) =>
      internals.getMaterialShaderArtifact?.(shader, {
        ...(typeof request === 'boolean' ? { vertexColorAvailable: request } : request),
        clustered: clusteredLightingActive(standard),
        probeBlend: (scene?.probeBlend?.records.length ?? 0) > 0,
        reflectionFallback: reflectionFallbackDemandOf(internals),
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
    hdrp: clusteredLightingActive(standard),
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
    ...(directionalShadowSimple ? { directionalShadowSimple } : {}),
    ...(leanLighting ? { leanLighting } : {}),
    ...(profilePhase === undefined ? {} : { profilePhase }),
  };
}

function pushShadowViewRequest(
  views: ShadowViewRequest[],
  lights: ViewLights,
  planesByView: ReadonlyMap<string, Float32Array>,
  targetSize: number | undefined,
  graphGeneration: number,
  identity: ShadowViewIdentity,
  matrix: Float32Array,
  cameraCull?: ShadowCameraCullDilation,
): void {
  views.push({
    identity,
    casterChannels: shadowViewCasterChannels(lights, identity),
    planes:
      planesByView.get(shadowViewIdentityKey(identity)) ??
      shadowPlanes(
        matrix,
        identity.kind === 'directional' &&
          lights.directionalCsmConfig !== undefined &&
          lights.directionalCsmConfig.shadowViewProjection === undefined,
      ),
    matrix,
    targetSize,
    graphGeneration,
    ...(cameraCull === undefined ? {} : { cameraCull }),
    ...(identity.kind === 'directional' && lights.directionalCsmConfig?.staticShadowCache === false
      ? { staticLayer: false as const }
      : {}),
  });
}

/**
 * Every shadow view of this view: its directional cascades, then the Render
 * World's point-face and spot views, each keyed by its light's stable layer.
 */
function gpuShadowViewRequests(
  lights: ViewLights,
  planesByView: ReadonlyMap<string, Float32Array>,
  targetSize: number | undefined,
  graphGeneration: number,
  directionalLimit: number | undefined,
): ShadowViewRequest[] {
  const views: ShadowViewRequest[] = [];
  const quality = lights.cascades?.directionalShadowQuality;
  const directionalCameraCull =
    quality === undefined
      ? undefined
      : shadowCameraCullDilation(
          directionalShadowFilterRadiusTexels(quality),
          lights.normalBias ?? (DirectionalLight.fields.normalBias.default as number),
          targetSize,
        );
  for (const view of lights.shadowViews) {
    const identity = view.identity;
    if (
      identity.kind === 'directional' &&
      directionalLimit !== undefined &&
      identity.index >= directionalLimit
    )
      continue;
    const spot =
      identity.kind === 'spot'
        ? (shadowViewLight(lights, identity) as SpotLightSnapshot | undefined)
        : undefined;
    pushShadowViewRequest(
      views,
      lights,
      planesByView,
      targetSize,
      graphGeneration,
      identity,
      view.matrix,
      identity.kind === 'directional'
        ? directionalCameraCull
        : spot === undefined
          ? undefined
          : shadowCameraCullDilation(
              Math.min(2, Math.max(0, (Math.round(spot.pcfKernelSize ?? 3) - 1) / 2)),
              0,
              targetSize,
            ),
    );
  }
  return views;
}

/**
 * A capable GPU-owned candidate with missing producer resources is a
 * structured stop, not permission to enumerate the same draw through the CPU
 * semantic path. The last-known-good graph is preserved and the frame retries
 * after the producer publishes a validated artifact.
 */
export function updateGpuDrivenShadowViews(
  internals: RenderSystemInternals,
  prepared: PreparedGpuDrivenFrame | undefined,
  profilePhase: RecordProfileRunner | undefined,
  gpuShadowViews: boolean,
  lights: ViewLights,
  shadowPlanesByView: () => ReadonlyMap<string, Float32Array>,
  targetSize: number | undefined,
  graphGeneration: number,
  directionalLimit: number | undefined,
): boolean {
  if (prepared === undefined) return true;
  const requests = gpuShadowViews
    ? gpuShadowViewRequests(
        lights,
        shadowPlanesByView(),
        targetSize,
        graphGeneration,
        directionalLimit,
      )
    : [];
  const updateShadowViews = prepared.updateShadowViews;
  if (updateShadowViews === undefined) return true;
  const shadowUpdate =
    profilePhase === undefined
      ? updateShadowViews(requests, true)
      : runRecordProfilePhase(profilePhase, 'record/gpu-driven-prepare/shadow-views', () =>
          updateShadowViews(requests, true),
        );
  if (!shadowUpdate.ok) {
    if (internals.viewEntity !== undefined)
      storeViewGpuDrivenOutcome(renderWorldFor(internals), internals.viewEntity, {
        kind: 'rejected',
        code: 'shadow-views-rejected',
        error: shadowUpdate.error,
      });
    internals.errorRegistry.fire(shadowUpdate.error);
    return false;
  }
  return true;
}

export function captureViewsCastShadows(
  captureWorkCount: number,
  cubeCapture: CubeCaptureFrameInput | undefined,
): boolean {
  return (
    captureWorkCount > 0 ||
    cubeCapture?.reflectionProbes?.graph.work.some((work) => work.rawCaptureFace !== undefined) ===
      true
  );
}

/** Shadow consumers of one view's retained direct phases. */
const GPU_LANE_SHADOWS = {};
const DIRECT_SHADOWS = {};

/** Shadow rows of one retained phase; `derived` reports material-derived geometry. */
export interface DirectShadowRows {
  readonly rows: readonly ValidatedRenderable[];
  readonly derived: boolean;
}

/** Inputs both shadow consumers share. */
export interface DirectShadowInputs {
  readonly scene: PersistentGpuDrivenState;
  readonly phases: ViewDrawPhases;
  readonly meshes: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>;
  readonly worlds: readonly RenderResourceScope[];
  readonly materials: MaterialFrame;
  readonly prepareSources: PrepareSources;
  readonly viewDraws: FrameList<RenderableSnapshot> | undefined;
  readonly prepareGeometry: PrepareShadowGeometry;
  readonly geometry: readonly unknown[];
  readonly lodRows: LodRows;
}

function shadowRows(
  inputs: DirectShadowInputs,
  consumer: object,
  selection: readonly unknown[],
  select: (binding: GpuDrivenBatchBinding) => MaterialSnapshot | undefined,
): DirectShadowRows {
  const phase = inputs.phases.of(consumer);
  // Record owns this graph-dependent cache: only the compiled graph names its
  // shadow consumers. This queues direct rows, not a World schedule or submit.
  phase.queue({
    scene: inputs.scene,
    selection,
    select,
    meshes: inputs.meshes,
    worlds: inputs.worlds,
    shadow: true,
    materials: inputs.materials,
    prepareUnbatched: inputs.prepareSources,
    viewDraws: inputs.viewDraws ?? [],
    prepareGeometry: inputs.prepareGeometry,
    lod: (rows) => rows,
    geometry: inputs.geometry,
  });
  return { rows: inputs.lodRows(phase.emit().rows), derived: phase.derivesGeometry };
}

/** Unbatched and capture-visible shadow casters beside the GPU shadow view pool. */
export function gpuLaneDirectShadowRows(
  prepared: PreparedGpuDrivenFrame | undefined,
  gpuShadowViews: boolean,
  batchExecutions: CollectedMaterialArtifacts['batchExecutions'],
  captureWorkCount: number,
  cubeCapture: CubeCaptureFrameInput | undefined,
  inputs: DirectShadowInputs,
): DirectShadowRows | undefined {
  if (
    !gpuShadowViews ||
    prepared?.shadowViewPool === undefined ||
    inputs.scene.unbatchedSlots === undefined
  ) {
    return undefined;
  }
  const captureShadows = captureViewsCastShadows(captureWorkCount, cubeCapture);
  return shadowRows(inputs, GPU_LANE_SHADOWS, [batchExecutions, captureShadows], (binding) => {
    const execution = batchExecutions.get(binding)?.shadow;
    if (execution === undefined) throw new Error('Missing accepted Shadow execution');
    if (execution.route === 'none') return undefined;
    return captureShadows || execution.route === 'direct' ? execution.material : undefined;
  });
}

/** CPU shadow rows when the GPU lane did not provide its own direct roster. */
export function validateDirectShadowRows(inputs: DirectShadowInputs): DirectShadowRows {
  const { materials } = inputs;
  return shadowRows(inputs, DIRECT_SHADOWS, [], (binding) => {
    const material = materials.get(binding.material);
    if (material === undefined) throw new Error('Shadow draw requires its accepted material');
    return materialMatchesPass(material, SHADOW_CASTER_PASS_SELECTOR, undefined, undefined)
      ? material.snapshot
      : undefined;
  });
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
