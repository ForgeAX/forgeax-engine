import type { GraphTextureDescriptor } from '@forgeax/engine-render-graph';
import type {
  RenderPipeline,
  RenderPipelineBuildContext,
  RenderPipelineFrame,
  RenderPipelineTarget,
  RenderPipelineTopology,
} from '../render-pipeline';
import { buildStandard, DEFAULT_STANDARD_PROFILE } from './standard-pipeline';

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

export function createStandardForwardPipeline(output: StandardForwardOutput): RenderPipeline {
  return {
    build(context, topology) {
      return buildStandard(
        { ...context, forwardOutput: output },
        {
          ...topology,
          standardProfile: {
            ...(topology.standardProfile ?? DEFAULT_STANDARD_PROFILE),
            renderPath: 'forward',
          },
        },
      );
    },
  };
}
