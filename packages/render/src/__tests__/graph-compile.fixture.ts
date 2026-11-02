import type { CompiledRenderGraph } from '@forgeax/engine-render-graph';
import { adoptViewGraph } from '../record/graph-adoption';
import { compileViewGraph, type GraphCompileInput } from '../record/typed-frame-graph';
import type { RenderPipelineFrame } from '../render-pipeline';

/** A direct recorder's compile: the pure compile, then its adoption into the view's frame state. */
export function compileAndAdoptViewGraph(
  input: GraphCompileInput,
): CompiledRenderGraph<RenderPipelineFrame> | null {
  return adoptViewGraph(input.internals, input.frameState, compileViewGraph(input));
}
