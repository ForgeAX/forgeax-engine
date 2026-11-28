import type { Buffer } from '@forgeax/engine-rhi';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { GpuDrivenBatchBinding } from '../gpu-driven/batch-topology';
import type { CollectedMaterialArtifacts } from '../gpu-driven/material-artifacts';
import { sceneIndexKeyForPass } from '../gpu-driven/material-artifacts';
import type { GpuDrivenPrepareInput } from '../gpu-driven/production-raster';
import { sourceDrawForSection } from '../gpu-driven/source-draw-indices';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { VisibleSurfaceProjection } from '../raytracing/visible-surface';
import type { CameraSnapshot } from '../render-contract';
import type { RenderableSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import type { PersistentShadowCasterProjection } from '../scene/render-scene';
import { admitsInlineSsr } from '../ssr/admission';
import type { ViewLights } from '../world/render-lights';
import { renderWorldFor } from '../world/render-world';
import { viewSsrAdmissionOf } from '../world/ssr-admission-systems';
import { directionalShadowSimple } from './directional-shadow-simple';
import type { GpuDrivenRecordInput } from './frame';
import {
  prepareDeferredProbeBuffer,
  projectFrameVisibleSurface,
  resolveFrameMaterials,
} from './frame-admission';
import {
  captureCasterMaterialReads,
  collectFrameGpuDrivenArtifacts,
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
  readonly hasLightProbes?: boolean;
  readonly shadowCasterProjection: PersistentShadowCasterProjection | undefined;
  readonly materialBindingClasses: ReadonlyMap<string, string>;
  readonly gpuDriven: GpuDrivenRecordInput;
  readonly profilePhase: RecordProfileRunner | undefined;
  readonly captureShadows?: boolean;
  readonly onSourceSceneIndexDemand?: (() => void) | undefined;
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
  readonly shadowReads?: ReturnType<typeof captureCasterMaterialReads> | undefined;
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
    const draw = sourceDrawForSection(source.gpuDrivenDraws, member.drawItemIndex);
    const slot =
      draw?.materialSlot ??
      (member.drawItemIndex === 0 && source.materials.length === 1 ? 0 : undefined);
    if (slot === undefined) return false;
    const material = source.materials[slot]?.snapshot;
    if (material?.surfaceModel !== 'single-layer-medium' || material.materialShaderId === undefined)
      return false;
    const sharedPageProgram =
      sceneIndexKeyForPass(material, 'forward', material.materialShaderId) ??
      material.materialShaderId;
    artifact ??= internals.getMaterialShaderArtifact?.(sharedPageProgram, {
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
    sources.hasLightProbes,
  );
  const hasShadows = hasShadowViewDemand(sources.lights);
  const shadowViews = hasShadows && frame?.geometryLane !== 'direct';
  if (frame === undefined)
    return {
      meshes,
      visibleSurface,
      deferredProbeBuffer,
      artifacts: undefined,
      shadowViews: false,
      request: undefined,
      materialBindingClasses: sources.materialBindingClasses,
    };
  const artifacts = collectFrameGpuDrivenArtifacts(
    internals,
    frame.scene,
    frame.scene?.materialPrograms ?? shadowCasterProjection?.materialPrograms,
    standard,
    shadowViews ? 'forward-and-shadow' : hasShadows ? 'forward-with-direct-shadows' : 'forward',
  );
  if (artifacts.sourcePreparationPending === true)
    return {
      meshes,
      visibleSurface,
      deferredProbeBuffer,
      artifacts,
      sourcePreparationPending: true,
      shadowViews,
      request: undefined,
      materialBindingClasses: sources.materialBindingClasses,
    };
  // Only GPU shadow views consume physical caster versions during Queue.
  // Direct passes bind their live materials while encoding. A retained directional
  // atlas admits its own reads once its mesh domain is known during Record.
  const shadowReads = shadowViews
    ? captureCasterMaterialReads(
        internals,
        sourceScope,
        artifacts.batchExecutions,
        resolveFrameMaterials(shadowCasterProjection, renderables).materials,
        shadowCasterProjection,
      )
    : undefined;
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
    shadowReads?.content,
    sources.materialBindingClasses,
    shadowCasterProjection,
    sources.profilePhase,
    standard.prepared.renderPath === 'deferred',
    directionalShadowSimple(sources.lights),
    sources.leanLighting === true,
    directSurface,
  );

  const ssr =
    pipelineState.extendedLightingAvailable === true && internals.viewEntity !== undefined
      ? viewSsrAdmissionOf(renderWorldFor(internals), internals.viewEntity)
      : undefined;
  return {
    meshes,
    visibleSurface,
    deferredProbeBuffer,
    artifacts,
    shadowReads,
    shadowViews,
    request: admitsInlineSsr(
      internals.device,
      pipelineState.extendedLightingAvailable,
      ssr?.kind === 'resolved' ? ssr.admission : undefined,
    )
      ? { ...request, forwardInlineSsr: true }
      : request,
    materialBindingClasses: sources.materialBindingClasses,
  };
}
