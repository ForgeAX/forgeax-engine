import type { Buffer } from '@forgeax/engine-rhi';
import type { MeshGpuHandles } from '../device/gpu-residency';
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
  readonly worlds: readonly RenderResourceScope[];
  readonly camera: CameraSnapshot;
  readonly lights: ViewLights;
  readonly renderables: FrameList<RenderableSnapshot>;
  readonly shadowCasterProjection: PersistentShadowCasterProjection | undefined;
  readonly materialBindingClasses: ReadonlyMap<string, string>;
  readonly gpuDriven: GpuDrivenRecordInput;
  readonly profilePhase: RecordProfileRunner | undefined;
  readonly captureShadows?: boolean;
}

/** Resident inputs shared by GPU preparation and the recording that consumes it. */
export interface FrameGpuDrivenInput {
  readonly meshes: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>;
  readonly visibleSurface: VisibleSurfaceProjection | undefined;
  readonly deferredProbeBuffer: Buffer | undefined;
  readonly artifacts: CollectedMaterialArtifacts | undefined;
  readonly shadowMaterials: ShadowMaterialContent;
  readonly shadowViews: boolean;
  readonly request: GpuDrivenPrepareInput | undefined;
  readonly materialBindingClasses: ReadonlyMap<string, string>;
}

/** Build once after lane admission, before any validation retains resident handles. */
export function buildFrameGpuDrivenInput(
  sources: Omit<FrameGpuDrivenSources, 'gpuDriven'>,
  input: GpuDrivenRecordInput | undefined,
  frame: GpuDrivenRecordInput | undefined,
  standard: StandardTopologyInputValue,
  pipelineState: PipelineState,
): FrameGpuDrivenInput {
  const { internals, frameState, worlds, renderables, shadowCasterProjection } = sources;
  const meshes = gpuDrivenMeshesForFrame(internals, worlds, input?.scene);
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
    frameState,
    frame.scene,
    shadowCasterProjection?.materialPrograms,
    standard,
    hasShadows,
  );
  if (hasShadows)
    collectGpuShadowMaterials(
      internals,
      worlds,
      artifacts.batchExecutions,
      meshes,
      shadowMaterials,
      undefined,
    );
  const probeBuffer = gpuProbeBlendBufferFor(
    internals,
    frameState,
    artifacts.materialArtifacts,
    deferredProbeBuffer,
    frame.scene,
  );
  const request = gpuDrivenPrepareRequest(
    internals,
    frameState,
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
