import type {
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import { addDepthPyramidPasses } from '../depth-pyramid/graph';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame, RenderPipelineGpuDrivenProjection } from '../render-pipeline';

/** One View UBO import shared by every compute consumer that linearizes depth. */
export function sceneViewImport(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
): () => Result<GraphBuffer, RenderGraphError> {
  let sceneView: GraphBuffer | undefined;
  return () => {
    if (sceneView !== undefined) return ok(sceneView);
    const imported = graph.importBuffer(
      'scene-view',
      {
        size: VIEW_UNIFORM_BYTES,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      },
      (frame) => frame.pipelineState.viewUniformBuffer,
    );
    if (imported.ok) sceneView = imported.value;
    return imported;
  };
}

/**
 * Two-phase HZB occlusion shared by the Standard lanes. The early scene pass
 * drew last frame's visible GPU items; its depth seeds a furthest pyramid,
 * the late cull re-tests every other candidate against it, and the caller's
 * late scene pass then draws what that revealed. Returns the pyramid, which
 * later passes may test against, or `undefined` when the projection reserved
 * no late phase, so the caller adds no late pass.
 */
export function addGpuLateOcclusion(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: {
    readonly gpuDriven: RenderPipelineGpuDrivenProjection | undefined;
    /** Depth-only view of the early pass's depth. */
    readonly depth: GraphTextureView;
    /** The early depth is multisampled; the seed then spans every sample. */
    readonly multisampled: boolean;
    readonly width: number;
    readonly height: number;
    readonly view: () => Result<GraphBuffer, RenderGraphError>;
  },
): Result<GraphTextureView | undefined, RenderGraphError> {
  const addLateOcclusion = input.gpuDriven?.addLateOcclusion;
  if (addLateOcclusion === undefined) return ok(undefined);
  const view = input.view();
  if (!view.ok) return view;
  const pyramid = addDepthPyramidPasses(graph, {
    depth: input.depth,
    width: input.width,
    height: input.height,
    view: view.value,
    reduction: 'furthest',
    multisampled: input.multisampled,
  });
  if (!pyramid.ok) return pyramid;
  const late = addLateOcclusion(pyramid.value.pyramid.pyramid);
  if (!late.ok) return late;
  return ok(pyramid.value.pyramid.pyramid);
}
