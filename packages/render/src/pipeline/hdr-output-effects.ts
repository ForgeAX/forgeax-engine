import { ok } from '@forgeax/engine-types';
import {
  createRenderPipelineTarget,
  type RenderPipelineBuildContext,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
  type RenderPipelineTopology,
} from '../render-pipeline';
import { addTypedFullscreenPass } from '../typed-render-graph-primitives';
import { renderExtentSize } from './render-extent';

/** In-order, color-only HDR effects between the scene/Bloom and output encoding. */
export function addHdrOutputEffects(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  input: RenderPipelineTarget,
) {
  let color = input;
  for (const [index, shader] of (topology.hdrOutputEffects ?? []).entries()) {
    const name = `hdr-output-effect-${index}`;
    const output = createRenderPipelineTarget(context.graph, `${name}-color`, {
      format: 'rgba16float',
      size:
        topology.extent === undefined ? 'surface' : renderExtentSize(topology.extent, 'internal'),
      domain: 'linear-hdr',
    });
    if (!output.ok) return output;
    const pass = addTypedFullscreenPass(context.graph, {
      name,
      shader,
      input: color,
      outputs: [output.value],
    });
    if (!pass.ok) return pass;
    color = output.value;
  }
  return ok(color);
}
