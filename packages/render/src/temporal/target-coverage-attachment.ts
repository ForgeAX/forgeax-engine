import type {
  GraphTextureDescriptor,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../gpu-texture-usage';
import type { RenderExtent } from '../pipeline/render-extent';
import type {
  RenderPipelineFrame,
  RenderPipelineGpuDrivenProjection,
  RenderPipelineTarget,
} from '../render-pipeline';
import { createRenderPipelineTarget } from '../render-pipeline';
import { COLOR_PASS_SELECTOR } from '../systems/pass-selector';
import { addTypedScenePass } from '../typed-render-graph-primitives';

export interface TargetCoverageAttachment {
  readonly coverage: RenderPipelineTarget;
  readonly depth: RenderPipelineTarget;
  readonly outputWidth: number;
  readonly outputHeight: number;
}

const COVERAGE_DESCRIPTOR: GraphTextureDescriptor = {
  format: 'rgba16float',
  size: 'surface',
  sampleCount: 1,
  usage: GPU_TEXTURE_USAGE_COPY_SRC,
};

const COVERAGE_DEPTH_DESCRIPTOR: GraphTextureDescriptor = {
  format: 'depth32float-stencil8',
  size: 'surface',
  sampleCount: 1,
};

/** Create the per-generation output-domain coverage/depth pair. */
export function createTargetCoverageAttachment(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  extent: RenderExtent,
): Result<TargetCoverageAttachment, RenderGraphError> {
  const coverage = createRenderPipelineTarget(graph, 'standard-scene-coverage', {
    ...COVERAGE_DESCRIPTOR,
    size: { width: extent.outputWidth, height: extent.outputHeight },
  });
  if (!coverage.ok) return coverage;
  const depth = createRenderPipelineTarget(graph, 'standard-scene-coverage-depth', {
    ...COVERAGE_DEPTH_DESCRIPTOR,
    size: { width: extent.outputWidth, height: extent.outputHeight },
  });
  if (!depth.ok) return depth;
  return ok({
    coverage: coverage.value,
    depth: depth.value,
    outputWidth: extent.outputWidth,
    outputHeight: extent.outputHeight,
  });
}

/** Rasterize output-domain SceneTemporalV1 evidence for reduced radiance. */
export function addTargetCoveragePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  target: TargetCoverageAttachment,
  gpuDriven?: RenderPipelineGpuDrivenProjection,
): Result<void, RenderGraphError> {
  return addTypedScenePass(graph, {
    name: 'standard-scene-coverage',
    ...(gpuDriven === undefined ? {} : { gpuDriven, gpuDrivenFilter: 'opaque' as const }),
    color: target.coverage,
    colorTargets: [target.coverage],
    depth: target.depth,
    selector: COLOR_PASS_SELECTOR,
    // Coverage is a generic Standard raster producer. Surface medium pixels
    // are owned by the later paired nearest/color passes and have no raw-depth
    // input at this point, so keep this attachment on the opaque lane.
    recordMode: 'opaque',
    passKind: 'temporal',
    clearColor: [0, 0, -1, 3],
    depthLoadOp: 'clear',
  });
}
