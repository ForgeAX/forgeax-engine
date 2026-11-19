import type { GraphTextureDescriptor } from '@forgeax/engine-render-graph';
import { ok } from '@forgeax/engine-types';
import { standardBloomAdmitted } from '../bloom-admission';
import type {
  RenderPipeline,
  RenderPipelineBuildContext,
  RenderPipelineFrame,
  RenderPipelineTarget,
  RenderPipelineTopology,
} from '../render-pipeline';
import { buildStandard, standardPipeline } from './standard-pipeline';
import { addStandardBloom } from './standard-post';

/** Replace only Forward's color target and finishing graph; all scene work stays shared. */
export interface StandardForwardOutput {
  readonly format: GraphTextureDescriptor['format'];
  readonly domain: NonNullable<GraphTextureDescriptor['domain']>;
  build(
    context: RenderPipelineBuildContext<RenderPipelineFrame>,
    topology: RenderPipelineTopology,
    color: RenderPipelineTarget,
    depth: RenderPipelineTarget,
    surface: { readonly display?: RenderPipelineTarget; readonly storage: RenderPipelineTarget },
  ): ReturnType<RenderPipeline['build']>;
}

export function createStandardForwardPipeline(
  output: StandardForwardOutput,
): typeof standardPipeline {
  return {
    identity: standardPipeline.identity,
    build(context, topology) {
      return buildStandard(
        { ...context, forwardOutput: output },
        // The replaced output exists only on the Forward lane.
        { ...topology, opaque: { ...topology.opaque, lane: 'forward' } },
      );
    },
  };
}

/** Give custom Forward outputs the Standard HDR Bloom stage before output encoding. */
export function addForwardOutputBloom(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  color: RenderPipelineTarget,
) {
  return standardBloomAdmitted(topology.camera)
    ? addStandardBloom(context, topology, color)
    : ok(color);
}
