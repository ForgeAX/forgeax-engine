import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import type { Result } from '@forgeax/engine-types';
import {
  createRenderPipelineTarget,
  type RenderPipelineBuildContext,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../render-pipeline';
import { addTypedFullscreenPass } from '../typed-render-graph-primitives';
import { SSR_HIT_COLOR_DOWNSAMPLE_PROGRAM, ssrColorExtent } from './scene-color-input';

type ColorExtent = { readonly width: number; readonly height: number };

/** Sample the scene once into a dedicated half-resolution linear color target. */
export function addSsrColorDownsample(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  source: RenderPipelineTarget,
  size: ColorExtent,
  label: string,
): Result<RenderPipelineTarget, RenderGraphError> {
  const target = createRenderPipelineTarget(
    graph,
    label,
    { format: source.format, size, domain: source.domain },
    { mipLevelCount: 1 },
  );
  if (!target.ok) return target;
  const pass = addTypedFullscreenPass(graph, {
    name: `${label}-downsample`,
    shader: SSR_HIT_COLOR_DOWNSAMPLE_PROGRAM.name,
    input: source,
    outputs: [target.value],
  });
  return pass.ok ? target : pass;
}

export function addSsrHitColor(
  context: Pick<RenderPipelineBuildContext<RenderPipelineFrame>, 'graph'>,
  source: RenderPipelineTarget,
  sceneSize: ColorExtent,
  label: string,
): Result<RenderPipelineTarget, RenderGraphError> {
  return addSsrColorDownsample(context.graph, source, ssrColorExtent(sceneSize), label);
}
