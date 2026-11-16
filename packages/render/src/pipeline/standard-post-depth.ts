import type { GraphTextureView, RenderGraphError } from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import {
  createRenderPipelineTarget,
  type RenderPipelineBuildContext,
  type RenderPipelineFrame,
  type RenderPipelineGpuDrivenProjection,
  type RenderPipelineTarget,
  type RenderPipelineTopology,
} from '../render-pipeline';
import { COLOR_PASS_SELECTOR, FORWARD_PASS_SELECTOR } from '../systems/pass-selector';
import { addTypedScenePass } from '../typed-render-graph-primitives';
import { addWaterFluidGraph } from '../water/fluid-graph';
import { addSingleLayerMediumRawDepthProducer } from './single-layer-medium-passes';
import type { WaterInfoGraphTargets } from './standard-build-context';

/** Real output-domain coverage; TAA's dilated motion/depth is not display geometry. */
export function addStandardPostProcessDepth(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: RenderPipelineTarget,
  gpuDriven?: RenderPipelineGpuDrivenProjection,
  waterInfoTargets?: WaterInfoGraphTargets,
  waterFoamSimulation?: GraphTextureView,
): Result<RenderPipelineTarget, RenderGraphError> {
  const { graph } = context;
  const depth = createRenderPipelineTarget(graph, 'standard-post-process-depth', {
    format: 'depth32float-stencil8',
    size: 'surface',
    sampleCount: 1,
  });
  if (!depth.ok) return depth;
  const coverage = createRenderPipelineTarget(graph, 'standard-post-process-coverage', {
    format: 'rgba16float',
    size: 'surface',
    sampleCount: 1,
  });
  if (!coverage.ok) return coverage;
  const opaque = addTypedScenePass(graph, {
    name: 'standard-post-process-coverage',
    color: coverage.value,
    depth: depth.value,
    selector: COLOR_PASS_SELECTOR,
    recordMode: 'opaque',
    passKind: 'temporal',
    coverageOnly: true,
    rasterProjection: 'unjittered',
    ...(gpuDriven === undefined ? {} : { gpuDriven, gpuDrivenFilter: 'opaque' as const }),
    ...(waterInfoTargets === undefined ? {} : { waterInfoTargets }),
  });
  if (!opaque.ok) return opaque;
  if (topology.water !== true && topology.singleLayerMedium !== true) return ok(depth.value);
  // Surface coverage can read opaque depth while writing nearest depth.
  const rawDepth = addSingleLayerMediumRawDepthProducer({
    graph,
    label: 'standard-post-process-opaque-depth',
    sourceColor: scene,
    sourceDepth: depth.value,
    size: 'surface',
  });
  if (!rawDepth.ok) return rawDepth;
  const fluid = topology.water === true ? addWaterFluidGraph(context) : undefined;
  if (fluid !== undefined && !fluid.ok) return fluid;
  for (const recordMode of [
    ...(topology.singleLayerMedium === true ? ['single-layer-medium-nearest-layer' as const] : []),
    ...(topology.water === true ? ['water-velocity' as const] : []),
  ]) {
    const surface = addTypedScenePass(graph, {
      name: `standard-post-process-${recordMode}`,
      color: coverage.value,
      depth: depth.value,
      selector: FORWARD_PASS_SELECTOR,
      recordMode,
      passKind: 'forward',
      ...(recordMode === 'water-velocity'
        ? {
            coverageOnly: true,
            surfaceFoamSimulation: waterFoamSimulation,
            ...(fluid?.ok === true ? { surfaceFluidSimulation: fluid.value } : {}),
          }
        : {}),
      rasterProjection: 'unjittered',
      transmissionBackdrop: scene.view,
      surfacePair: {
        opaqueColor: scene.view,
        rawDepth: { status: 'available', view: rawDepth.value.view },
      },
      ...(waterInfoTargets === undefined ? {} : { waterInfoTargets }),
      colorLoadOp: 'load',
      depthLoadOp: 'load',
    });
    if (!surface.ok) return surface;
  }
  return ok(depth.value);
}
