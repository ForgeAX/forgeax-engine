import type { Buffer } from '@forgeax/engine-rhi';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import type { GpuDrivenBatchBinding } from '../gpu-driven/batch-topology';
import type { CollectedMaterialArtifacts } from '../gpu-driven/material-artifacts';
import type { GpuDrivenPrepareInput } from '../gpu-driven/production-raster';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { VisibleSurfaceProjection } from '../raytracing/visible-surface';
import type { CameraSnapshot } from '../render-contract';
import type { RenderableSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import { ShadowMaterialContent } from '../scene/material-shadow-content';
import type { PersistentShadowCasterProjection } from '../scene/render-scene';
import type { ViewLights } from '../world/render-lights';
import { directionalShadowSimple } from './directional-shadow-simple';
import type { GpuDrivenRecordInput } from './frame';
import {
  prepareDeferredProbeBuffer,
  projectFrameVisibleSurface,
  resolveFrameMaterials,
} from './frame-admission';
import {
  collectFrameGpuDrivenArtifacts,
  collectGpuShadowMaterials,
  gpuDrivenPrepareRequest,
  gpuProbeBlendBufferFor,
} from './frame-gpu-driven';
import type { RenderFrameState } from './frame-snapshot';
import { hasShadowViewDemand } from './frame-targets';
import type { PipelineState, RecordProfileRunner, RenderSystemInternals } from './render-context';
import { gpuDrivenMeshesForFrame } from './resident-meshes';

/** Facts staged before Queue; no recording callback or second preparation path. */
export interface FrameGpuDrivenSources {
  readonly internals: RenderSystemInternals;
  readonly frameState: RenderFrameState;
  readonly sourceScope: RenderResourceScope;
  readonly camera: CameraSnapshot;
  readonly lights: ViewLights;
  readonly renderables: FrameList<RenderableSnapshot>;
  readonly shadowCasterProjection: PersistentShadowCasterProjection | undefined;
  readonly materialBindingClasses: ReadonlyMap<string, string>;
  readonly gpuDriven: GpuDrivenRecordInput;
  readonly profilePhase: RecordProfileRunner | undefined;
  readonly captureShadows?: boolean;
  /** `leanLightingFrame` of this view, staged with the frame's environment and cloud layer. */
  readonly leanLighting?: boolean;
}

/** Resident inputs shared by GPU preparation and the recording that consumes it. */
export interface FrameGpuDrivenInput {
  readonly meshes: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>;
  readonly visibleSurface: VisibleSurfaceProjection | undefined;
  readonly deferredProbeBuffer: Buffer | undefined;
  readonly artifacts: CollectedMaterialArtifacts | undefined;
  readonly sourcePreparationPending?: true;
  readonly shadowMaterials: ShadowMaterialContent;
  readonly shadowViews: boolean;
  readonly request: GpuDrivenPrepareInput | undefined;
  readonly materialBindingClasses: ReadonlyMap<string, string>;
}

/** GPU-generated vertices use direct draws but share the retained Surface input page. */
function resolveDirectSurface(
  internals: RenderSystemInternals,
  renderables: FrameList<RenderableSnapshot>,
  frame: GpuDrivenRecordInput,
  standard: StandardTopologyInputValue,
): GpuDrivenPrepareInput['directSurface'] {
  const ranges = frame.surfaceDynamicInput?.ranges;
  if (!ranges?.length || !internals.getMaterialShaderArtifact) return undefined;
  const owners = new Map<number, RenderableSnapshot>();
  const keys = new Set(ranges.map((range) => range.member.entityKey));
  for (const source of renderables) {
    if (source.gpuVertexSource !== undefined && keys.has(source.entityKey))
      owners.set(source.entityKey, source);
  }
  let artifact: NonNullable<GpuDrivenPrepareInput['directSurface']>['artifact'] | undefined;
  const directRanges = ranges.filter(({ member }) => {
    const source = owners.get(member.entityKey);
    if (!source) return false;
    const draw = source.gpuDrivenDraws?.find(
      (draw, index) => gpuDrivenSourceDrawItemIndex(draw, index) === member.drawItemIndex,
    );
    const slot =
      draw?.materialSlot ??
      (member.drawItemIndex === 0 && source.materials.length === 1 ? 0 : undefined);
    if (slot === undefined) return false;
    const material = source.materials[slot]?.snapshot;
    if (material?.surfaceModel !== 'single-layer-medium' || material.materialShaderId === undefined)
      return false;
    artifact ??= internals.getMaterialShaderArtifact?.(material.materialShaderId, {
      address: 'scene-index',
      pass: 'forward',
      clustered: standard.kind === 'clustered',
    });
    return true;
  });
  return artifact?.receipt?.surface === undefined ? undefined : { artifact, ranges: directRanges };
}

/** Build once after lane admission, before any validation retains resident handles. */
export function buildFrameGpuDrivenInput(
  sources: Omit<FrameGpuDrivenSources, 'gpuDriven'>,
  input: GpuDrivenRecordInput | undefined,
  frame: GpuDrivenRecordInput | undefined,
  standard: StandardTopologyInputValue,
  pipelineState: PipelineState,
  meshPolicy: 'prepare' | 'resident-only' = 'prepare',
): FrameGpuDrivenInput {
  const { internals, frameState, sourceScope, renderables, shadowCasterProjection } = sources;
  const meshes = gpuDrivenMeshesForFrame(internals, sourceScope, input?.scene, meshPolicy);
  const visibleSurface = projectFrameVisibleSurface(internals, frame?.scene, renderables);
  const deferredProbeBuffer = prepareDeferredProbeBuffer(
    internals,
    frameState,
    standard,
    frame?.scene,
    renderables,
  );
  const { materials } = resolveFrameMaterials(
    shadowCasterProjection,
    shadowCasterProjection?.renderables ?? renderables,
  );
  const shadowMaterials = new ShadowMaterialContent(materials);
  const hasShadows = hasShadowViewDemand(sources.lights);
  const shadowViews = hasShadows && frame?.geometryLane !== 'direct';
  if (frame === undefined)
    return {
      meshes,
      visibleSurface,
      deferredProbeBuffer,
      artifacts: undefined,
      shadowMaterials,
      shadowViews: false,
      request: undefined,
      materialBindingClasses: sources.materialBindingClasses,
    };
  const artifacts = collectFrameGpuDrivenArtifacts(
    internals,
    frame.scene,
    frame.scene?.materialPrograms ?? shadowCasterProjection?.materialPrograms,
    standard,
    hasShadows,
  );
  if (artifacts.sourcePreparationPending === true)
    return {
      meshes,
      visibleSurface,
      deferredProbeBuffer,
      artifacts,
      sourcePreparationPending: true,
      shadowMaterials,
      shadowViews,
      request: undefined,
      materialBindingClasses: sources.materialBindingClasses,
    };
  if (hasShadows)
    collectGpuShadowMaterials(
      internals,
      sourceScope,
      artifacts.batchExecutions,
      meshes,
      shadowMaterials,
      undefined,
      shadowCasterProjection,
    );
  const probeBuffer = gpuProbeBlendBufferFor(
    internals,
    frameState,
    artifacts.materialArtifacts,
    deferredProbeBuffer,
    frame.scene,
  );
  const directSurface = resolveDirectSurface(internals, renderables, frame, standard);
  const request = gpuDrivenPrepareRequest(
    internals,
    frame,
    artifacts,
    standard,
    sources.camera,
    pipelineState,
    meshes,
    visibleSurface,
    probeBuffer,
    shadowViews,
    shadowMaterials,
    sources.materialBindingClasses,
    shadowCasterProjection,
    sources.profilePhase,
    standard.prepared.renderPath === 'deferred',
    directionalShadowSimple(sources.lights),
    sources.leanLighting === true,
    directSurface,
  );
  return {
    meshes,
    visibleSurface,
    deferredProbeBuffer,
    artifacts,
    shadowMaterials,
    shadowViews,
    request,
    materialBindingClasses: sources.materialBindingClasses,
  };
}
