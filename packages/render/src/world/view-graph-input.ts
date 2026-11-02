import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import { RendererOperationError } from '../errors/render';
import type { GraphCompileInput } from '../record/typed-frame-graph';
import { RENDER_FEATURE_PLAN_SYSTEM, viewFeaturePlanOf } from './feature-plan-systems';
import { VIEW_DIFFUSE_GI_SYSTEM, viewDiffuseGiOf } from './gi-systems';
import { RENDER_GPU_DRIVEN_RASTER_SYSTEM } from './gpu-driven-raster-systems';
import { RENDER_GPU_DRIVEN_PREPARE_SYSTEM, viewGpuDrivenOf } from './gpu-driven-systems';
import { readViewPassPlan } from './pass-plan-systems';
import { viewLightsOf } from './render-lights';
import { RENDER_SSR_ADMISSION_SYSTEM, viewSsrAdmissionOf } from './ssr-admission-systems';
import {
  RENDER_STANDARD_LIGHTING_SYSTEM,
  viewStandardLightingOf,
} from './standard-lighting-systems';
import {
  RENDER_SUBSURFACE_ADMISSION_SYSTEM,
  type SubsurfaceCaptureClass,
  viewSubsurfaceAdmissionOf,
} from './subsurface-admission-systems';
import { recordContext } from './view-record-context';
import type { ViewSettlementOwner } from './view-settlement';
import { RENDER_VIEW_TOPOLOGY_SYSTEM, viewTopologyOf } from './view-topology-systems';

/** Record-time facts not yet produced by a Queue component. No prepared owner is copied here. */
export interface ViewGraphCompileRequest {
  readonly camera: GraphCompileInput['camera'];
  readonly clearOnly: boolean;
  readonly subsurfaceClass: SubsurfaceCaptureClass;
  readonly rendererRecording: boolean;
  readonly shadowDepthLayers: GraphCompileInput['shadowDepthLayers'];
}

type GraphInputOwner =
  | typeof RENDER_FEATURE_PLAN_SYSTEM
  | typeof VIEW_DIFFUSE_GI_SYSTEM
  | typeof RENDER_GPU_DRIVEN_RASTER_SYSTEM
  | typeof RENDER_GPU_DRIVEN_PREPARE_SYSTEM
  | typeof RENDER_STANDARD_LIGHTING_SYSTEM
  | typeof RENDER_SSR_ADMISSION_SYSTEM
  | typeof RENDER_SUBSURFACE_ADMISSION_SYSTEM
  | typeof RENDER_VIEW_TOPOLOGY_SYSTEM
  | 'render-cascade-fit';

function unavailable(
  system: GraphInputOwner,
  cause?: unknown,
): RendererOperationError<'graph-build-failed'> {
  return new RendererOperationError('graph-build-failed', {
    operation: 'draw',
    cause: {
      code: 'graph-input-unavailable',
      expected: `${system} prepares this view before graph compilation`,
      hint: 'keep the owning Render World systems registered and retry after preparation',
      detail: { system, cause },
    },
  });
}

/** Resolve the compiler's immutable facts from the current component products; missing work is data. */
export function readViewGraphInput(
  world: World,
  entity: EntityHandle,
  { internals, frameState, captures }: ViewSettlementOwner,
  request: ViewGraphCompileRequest,
): Result<GraphCompileInput, RendererOperationError<'graph-build-failed'>> {
  const lighting = viewStandardLightingOf(world, entity);
  if (lighting?.kind !== 'prepared')
    return err(unavailable(RENDER_STANDARD_LIGHTING_SYSTEM, lighting));
  if (!lighting.lighting.ok || lighting.fence.pipelineState === null)
    return err(unavailable(RENDER_STANDARD_LIGHTING_SYSTEM, lighting.lighting));
  const topology = viewTopologyOf(world, entity);
  if (topology?.kind !== 'planned') return err(unavailable(RENDER_VIEW_TOPOLOGY_SYSTEM, topology));
  const ssr = viewSsrAdmissionOf(world, entity);
  if (ssr?.kind !== 'resolved') return err(unavailable(RENDER_SSR_ADMISSION_SYSTEM, ssr));
  const gi = viewDiffuseGiOf(world, entity);
  if (gi?.ok !== true) return err(unavailable(VIEW_DIFFUSE_GI_SYSTEM, gi));
  const gpu = viewGpuDrivenOf(world, entity);
  if (gpu?.kind !== 'selected') return err(unavailable(RENDER_GPU_DRIVEN_PREPARE_SYSTEM, gpu));
  if (!request.clearOnly && gpu.raster === undefined)
    return err(unavailable(RENDER_GPU_DRIVEN_RASTER_SYSTEM));
  const feature = viewFeaturePlanOf(world, entity);
  if (feature?.kind !== 'planned') return err(unavailable(RENDER_FEATURE_PLAN_SYSTEM, feature));
  const pass = readViewPassPlan(world, entity);
  if (!pass.ok)
    return err(
      new RendererOperationError('graph-build-failed', {
        operation: 'draw',
        cause: {
          code: pass.error.code,
          expected: `${pass.error.system} plans this view before graph compilation`,
          hint: 'keep the RenderQueue plan systems registered',
          detail: pass.error,
        },
      }),
    );
  const subsurface = viewSubsurfaceAdmissionOf(world, entity)?.[request.subsurfaceClass];
  if (subsurface?.ok !== true)
    return err(unavailable(RENDER_SUBSURFACE_ADMISSION_SYSTEM, subsurface));
  const lights = viewLightsOf(world, entity);
  if (lights === undefined) return err(unavailable('render-cascade-fit'));
  const inputs = topology.topology;
  return ok({
    internals,
    frameState,
    pipelineState: lighting.fence.pipelineState,
    camera: request.camera,
    lights,
    surface: recordContext(internals).canvas,
    shadowMapSize: inputs.shadowMapSize,
    gpuDriven: gpu.raster?.raster,
    featurePlan: feature.plan,
    cubeCaptureState: recordContext(internals).captureView?.state ?? captures,
    clearOnly: request.clearOnly,
    passPlan: pass.value,
    unfoggedOpaque: pass.value.unfoggedOpaque,
    volumetricFog: inputs.volume.graphFog,
    volumeTopologyCandidate: inputs.volume.topologyCandidate,
    standardLighting: lighting.lighting.value.standard,
    ssr: ssr.admission,
    renderExtent: gi.value.renderExtent,
    analyticFog: inputs.analyticFog,
    cloudShadowResolution: inputs.cloudShadow?.resolution,
    terrainReceivers: inputs.terrainReceivers,
    subsurface: subsurface.value,
    rendererRecording: request.rendererRecording,
    shadowDepthLayers: request.shadowDepthLayers,
  });
}
