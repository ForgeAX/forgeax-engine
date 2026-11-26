import type { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { POST_SCENE_COLOR_HALF_WGSL } from '@forgeax/engine-shader';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../render-pipeline';
import { addTypedFullscreenPass } from '../typed-render-graph-primitives';

export const POST_SCENE_COLOR_HALF_PROGRAM = {
  name: 'forgeax.post-scene-color-half',
  kind: 'fullscreen' as const,
  reads: ['input'] as const,
  source: POST_SCENE_COLOR_HALF_WGSL,
};

type Extent = { readonly width: number; readonly height: number };

export function declarePostSceneColorHalf(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  extent: Extent,
  label: string,
) {
  return createRenderPipelineTarget(graph, label, {
    size: { width: Math.ceil(extent.width / 2), height: Math.ceil(extent.height / 2) },
    format: 'rgba16float',
    domain: 'linear-hdr',
  });
}

export function addPostSceneColorHalf(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  extent: Extent,
  input: RenderPipelineTarget,
  label: string,
) {
  const target = declarePostSceneColorHalf(graph, extent, label);
  if (!target.ok) return target;
  const added = addTypedFullscreenPass(graph, {
    name: label,
    shader: POST_SCENE_COLOR_HALF_PROGRAM.name,
    input,
    outputs: [target.value],
  });
  return added.ok ? target : added;
}
