import { projectedProbeCount } from '../scene/probe-blend';
import type { DrawRows } from './frame-snapshot';
import type { MaterialRelationFrame } from './material-binding-index';
// GPU-driven lane preparation for one display frame: producer artifacts,
// the GPU owner's prepare request, its shadow view roster, and the direct
// shadow rows that remain CPU-recorded beside it.

import type { Buffer } from '@forgeax/engine-rhi';
import { requiresProbeBlendRecord } from '../assembly/material/artifact-probe-blend';
import { DirectionalLight } from '../components/directional-light';
import { directionalShadowFilterRadiusTexels } from '../components/directional-shadow-filter';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { GpuDrivenBatchBinding } from '../gpu-driven/batch-topology';
import {
  type CollectedMaterialArtifacts,
  collectGpuDrivenMaterialArtifacts,
  type MaterialArtifactDemand,
} from '../gpu-driven/material-artifacts';
import type {
  GpuDrivenPrepareInput,
  PreparedGpuDrivenFrame,
  ShadowViewRequest,
} from '../gpu-driven/production-raster';
import {
  type ShadowCameraCullDilation,
  shadowCameraCullDilation,
} from '../gpu-driven/shadow-views';
import type { MaterialResource } from '../material-resource';
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
import {
  MaterialFrame,
  someCapturedMaterialPass,
  visitCapturedCasterMaterials,
} from '../scene/material-dispatch';
import { ShadowMaterialContent } from '../scene/material-shadow-content';
import type {
  PersistentGpuDrivenState,
  PersistentShadowCasterProjection,
} from '../scene/render-scene';
import type { ShadowDepthLayers } from '../shadow-depth-layers';
import { shadowPlanes } from '../shadow-frustum';
import { DEFAULT_STATIC_SHADOW_BUDGET_BYTES } from '../static-shadow-memory';
import { SHADOW_CASTER_PASS_SELECTOR } from '../systems/pass-selector';
import { storeViewGpuDrivenOutcome } from '../world/gpu-driven-systems';
import {
  type ShadowViewProjection,
  shadowViewCasterChannels,
  shadowViewLight,
  type ViewLights,
} from '../world/render-lights';
import { renderWorldFor } from '../world/render-world';
import { reflectionFallbackDemandOf } from '../world/ssr-admission-systems';
import type { ViewDrawPhases } from './direct-draw-phase';
import type { ShadowMeshInput } from './directional-shadow-cache';
import type { CubeCaptureFrameInput, GpuDrivenRecordInput } from './frame';
import type { RenderFrameState } from './frame-snapshot';
import { resolveSpotShadowMapSize } from './frame-targets';
import { materialMatchesPass } from './material-pass-selection';
import { ensureProbeBlendRecordBuffer } from './probe-blend-buffer';
import {
  type PipelineState,
  type RecordProfileRunner,
  type RenderSystemInternals,
  runRecordProfilePhase,
} from './render-context';
import { staticShadowAdmission } from './static-shadow-budget';

type PrepareSources = (sources: FrameList<RenderableSnapshot>, dispatch?: DispatchList) => DrawRows;
type PrepareShadowGeometry = (
  mesh: MeshGpuHandles,
  material: MaterialSnapshot,
  source?: RenderableSnapshot,
) => MeshGpuHandles;
type LodRows = (rows: DrawRows) => DrawRows;

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
  demand: MaterialArtifactDemand,
): CollectedMaterialArtifacts {
  return collectGpuDrivenMaterialArtifacts({
    batches: scene?.plan.batches ?? [],
    probeBlend: projectedProbeCount(scene?.probeBlend) > 0,
    programs,
    resolve: internals.getMaterialShaderArtifact,
    canAwaitSource: (id) =>
      (
        internals.shaderRegistry ?? internals.assets.shaderRegistry
      ).isMaterialArtifactPreparationPending(id),
    clustered: clusteredLightingActive(standard),
    reflectionFallback: reflectionFallbackDemandOf(internals),
    demand,
  });
}

/** The Scene dispatch includes offscreen casters and each distinct row material. */
function captureSceneCasterMaterials(
  internals: Pick<RenderSystemInternals, 'preparedMaterialTexture'>,
  scope: RenderResourceScope,
  content: ShadowMaterialContent,
  projection: PersistentShadowCasterProjection | undefined,
): boolean {
  return (
    projection !== undefined &&
    visitCapturedCasterMaterials(projection.dispatch, (resource) =>
      content.addFromFrame(
        resource,
        projection.content.materials,
        scope,
        internals.preparedMaterialTexture,
        0,
      ),
    )
  );
}

export function collectGpuShadowMaterials(
  internals: Pick<RenderSystemInternals, 'preparedMaterialTexture'>,
  sourceScope: RenderResourceScope,
  batchExecutions: CollectedMaterialArtifacts['batchExecutions'],
  shadowMaterials: ShadowMaterialContent,
  projection?: PersistentShadowCasterProjection,
): PersistentShadowCasterProjection | undefined {
  if (captureSceneCasterMaterials(internals, sourceScope, shadowMaterials, projection))
    return projection;
  if (sourceScope !== undefined) {
    batchExecutions.forEach((execution, binding) => {
      if (execution.shadow.route === 'none') return;
      shadowMaterials.add(
        binding.material,
        execution.shadow.material,
        sourceScope,
        internals.preparedMaterialTexture,
        0,
      );
      if (binding.rowGroup !== undefined)
        shadowMaterials.addRows(
          binding.rowGroup.rows.keys(),
          sourceScope,
          internals.preparedMaterialTexture,
          0,
        );
    });
  }
  return undefined;
}

/** The consumer owns a concrete record of the physical versions it may retain. */
export function captureCasterMaterialReads(
  internals: Pick<RenderSystemInternals, 'preparedMaterialTexture'>,
  scope: RenderResourceScope,
  executions: CollectedMaterialArtifacts['batchExecutions'],
  materials: MaterialFrame,
  scene: PersistentShadowCasterProjection | undefined,
) {
  const content = new ShadowMaterialContent(materials);
  const source = collectGpuShadowMaterials(internals, scope, executions, content, scene);
  return { content, source };
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
  shadowMaterials: ShadowMaterialContent | undefined,
  materialBindingClasses: ReadonlyMap<string, string>,
  shadowCasterProjection: PersistentShadowCasterProjection | undefined,
  profilePhase: RecordProfileRunner | undefined,
  capsuleShadowDirectional: boolean,
  directionalShadowSimple = false,
  leanLighting = false,
  directSurface?: GpuDrivenPrepareInput['directSurface'],
): GpuDrivenPrepareInput {
  const scene = frameGpuDriven.scene;
  return {
    scene,
    batchExecutions: artifacts.batchExecutions,
    materialShaderRegistry: internals.shaderRegistry ?? internals.assets.shaderRegistry,
    materialArtifactResolver: (shader, request) =>
      internals.getMaterialShaderArtifact?.(shader, {
        ...(typeof request === 'boolean' ? { vertexColorAvailable: request } : request),
        clustered: clusteredLightingActive(standard),
        probeBlend: projectedProbeCount(scene?.probeBlend) > 0,
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
    ...(directSurface === undefined ? {} : { directSurface }),
    ...gpuDrivenArtifactInputs(artifacts, probeBlendRecordBuffer),
    materialPipelineState: pipelineState,
    shadowViews,
    ...(shadowMaterials === undefined ? {} : { shadowMaterials }),
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
  targetSize: number | undefined,
  graphGeneration: number,
  view: ShadowViewProjection,
  layers: ReturnType<typeof staticShadowAdmission>,
  cameraCull?: ShadowCameraCullDilation,
): void {
  const { identity, planes, matrix } = view;
  views.push({
    identity,
    casterChannels: shadowViewCasterChannels(lights, identity),
    planes:
      planes ??
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
    ...((
      identity.kind === 'directional'
        ? layers.directional
        : ((identity.kind === 'point' ? layers.pointMask : layers.spotMask) &
            (1 << identity.index)) !==
          0
    )
      ? {}
      : { staticLayer: false as const }),
  });
}

/**
 * Every shadow view of this view: its directional cascades, then the Render
 * World's point-face and spot views, each keyed by its light's stable layer.
 */
export function gpuShadowViewRequests(
  lights: ViewLights,
  targetSize: number | undefined,
  graphGeneration: number,
  directionalLimit: number | undefined,
  spotSize = lights.spot.find(
    (light) => light.shadowAtlasTile >= 0 && light.lightViewProj !== undefined,
  )?.mapSize ?? 1024,
  budget?: number,
  staticLayers?: ShadowDepthLayers,
): ShadowViewRequest[] {
  const views: ShadowViewRequest[] = [];
  const layers = staticShadowAdmission(lights, targetSize, spotSize, budget, staticLayers);
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
      targetSize,
      graphGeneration,
      view,
      layers,
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
  targetSize: number | undefined,
  graphGeneration: number,
  directionalLimit: number | undefined,
): boolean {
  if (prepared === undefined) return true;
  const staticLayers = prepared.shadowViewPool?.staticLayers;
  if (!gpuShadowViews)
    staticLayers?.staticPlan?.begin(
      internals.options?.staticShadowBudgetBytes ?? DEFAULT_STATIC_SHADOW_BUDGET_BYTES,
    );
  const requests = gpuShadowViews
    ? gpuShadowViewRequests(
        lights,
        targetSize,
        graphGeneration,
        directionalLimit,
        resolveSpotShadowMapSize(internals, lights) ?? 1024,
        internals.options?.staticShadowBudgetBytes,
        staticLayers,
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
  readonly meshDomain: object | null;
  readonly materialRows?: MaterialRelationFrame | undefined;
  readonly rows: DrawRows;
  readonly derived: boolean;
}

/** Inputs both shadow consumers share. */
export interface DirectShadowInputs {
  readonly retainMaterialBindings?: boolean | undefined;
  readonly scene: PersistentGpuDrivenState;
  readonly phases: ViewDrawPhases;
  readonly meshes: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>;
  readonly sourceScope: RenderResourceScope;
  readonly materials: MaterialFrame;
  readonly prepareSources: PrepareSources;
  readonly viewDraws: FrameList<RenderableSnapshot> | undefined;
  readonly prepareGeometry: PrepareShadowGeometry;
  readonly geometry: readonly unknown[];
  /** Native CPU LOD selects ranges or instance windows within each issued physical mesh. */
  readonly lodRows: LodRows;
  readonly retainMeshDomain: boolean;
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
    retainMaterialBindings: inputs.retainMaterialBindings === true,
    scene: inputs.scene,
    selection,
    select,
    meshes: inputs.meshes,
    sourceScope: inputs.sourceScope,
    shadow: true,
    materials: inputs.materials,
    prepareUnbatched: inputs.prepareSources,
    viewDraws: inputs.viewDraws ?? [],
    prepareGeometry: inputs.prepareGeometry,
    geometry: inputs.geometry,
  });
  const output = phase.emit();
  const rows = inputs.lodRows(output.rows);
  return {
    rows,
    meshDomain: inputs.retainMeshDomain && !phase.derivesGeometry ? phase.issuedMeshDomain() : null,
    materialRows: rows === output.rows ? output.materialRows : undefined,
    derived: phase.derivesGeometry,
  };
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

/** The atlas reads physical mesh generations and material inputs from their respective owners. */
export function directionalAtlasMaterialReads(
  internals: Pick<RenderSystemInternals, 'preparedMaterialTexture'>,
  sourceScope: RenderResourceScope,
  rows: DrawRows | undefined,
  materials: MaterialFrame,
  gpuInput: {
    readonly shadowReads?: ReturnType<typeof captureCasterMaterialReads> | undefined;
    readonly request: Pick<GpuDrivenPrepareInput, 'batchExecutions'> | undefined;
  },
  scene: PersistentShadowCasterProjection | undefined,
  meshReads: ShadowMeshInput | undefined,
  sceneOwnsRows = true,
): readonly ShadowMaterialContent[] {
  // The directional atlas is retained as one texture. A live binding on any
  // occupied caster invalidates it all, including the other fixed materials.
  // GPU shadow views keep their full inputs for independently selected casters.
  if (
    gpuInput.shadowReads === undefined &&
    sceneOwnsRows &&
    scene !== undefined &&
    (gpuInput.request !== undefined || (rows?.length ?? 0) > 0) &&
    MaterialFrame.fixedProgramRoot(scene.content.materials) !== undefined &&
    (internals.preparedMaterialTexture === undefined ||
      internals.preparedMaterialTexture.parameters !== undefined)
  ) {
    const content = new ShadowMaterialContent(materials, 'whole-atlas');
    const captured = someCapturedMaterialPass(scene.dispatch, (pass, resource) => {
      if (pass.tags.LightMode !== 'ShadowCaster') return false;
      content.addFromFrame(
        resource,
        scene.content.materials,
        sourceScope,
        internals.preparedMaterialTexture,
        0,
      );
      return content.requiresAtlasRedraw;
    });
    if (captured !== undefined) {
      if (meshReads !== undefined && rows !== undefined)
        for (const row of rows) meshReads.reads.add(row.mesh.changeToken);
      return [content];
    }
  }
  const reads =
    gpuInput.shadowReads ??
    (gpuInput.request === undefined
      ? undefined
      : captureCasterMaterialReads(
          internals,
          sourceScope,
          gpuInput.request.batchExecutions,
          materials,
          scene,
        ));
  if (rows === undefined || rows.length === 0) return reads === undefined ? [] : [reads.content];
  if (sceneOwnsRows && scene !== undefined) {
    const queued = reads?.source === scene;
    const content = queued ? reads.content : new ShadowMaterialContent(materials);
    if (queued || captureSceneCasterMaterials(internals, sourceScope, content, scene)) {
      if (meshReads !== undefined)
        for (const row of rows) meshReads.reads.add(row.mesh.changeToken);
      return queued || reads === undefined ? [content] : [reads.content, content];
    }
  }
  const direct = new ShadowMaterialContent();
  collectDirectShadowMaterials(internals, sourceScope, rows, materials, direct, meshReads);
  return reads === undefined ? [direct] : [reads.content, direct];
}

function collectDirectShadowMaterials(
  internals: Pick<RenderSystemInternals, 'preparedMaterialTexture'>,
  sourceScope: RenderResourceScope,
  rows: DrawRows | undefined,
  materials: MaterialFrame,
  shadowMaterials: ShadowMaterialContent,
  meshReads: ShadowMeshInput | undefined,
): void {
  if (rows === undefined) return;
  let previous: MaterialResource | undefined;
  for (const row of rows) {
    meshReads?.reads.add(row.mesh.changeToken);
    if (sourceScope === undefined) continue;
    const selection = row.submeshIndices;
    const submeshes = row.mesh.submeshes;
    const count = selection?.length ?? submeshes.length;
    for (let cursor = 0; cursor < count; cursor++) {
      const index = selection === undefined ? cursor : selection[cursor];
      const submesh = index === undefined ? undefined : submeshes[index];
      if (submesh === undefined) continue;
      const resource = row.source.materials[submesh.materialSlot] ?? row.source.material;
      if (resource === previous) continue;
      previous = resource;
      shadowMaterials.addFromFrame(
        resource,
        materials,
        sourceScope,
        internals.preparedMaterialTexture,
        0,
      );
    }
  }
}
