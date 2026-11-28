import {
  type CompiledRenderGraph,
  RenderGraphBuilder,
  type RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { vi } from 'vitest';
import { adoptViewGraph } from '../record/graph-adoption';
import { compileViewGraph, type GraphCompileInput } from '../record/typed-frame-graph';
import type { RenderPipelineFrame } from '../render-pipeline';

/** A direct recorder's compile: the pure compile, then its adoption into the view's frame state. */
export function compileAndAdoptViewGraph(
  input: GraphCompileInput,
): CompiledRenderGraph<RenderPipelineFrame> | null {
  return adoptViewGraph(input.internals, input.frameState, compileViewGraph(input))?.graph ?? null;
}

/** Introduce a genuine read before initialization in each newly declared main view. */
export function rejectMainViewBinding() {
  const original = RenderGraphBuilder.prototype.addRasterPass;
  let rejected = 0;
  const spy = vi.spyOn(RenderGraphBuilder.prototype, 'addRasterPass').mockImplementation(function (
    this: RenderGraphBuilder<RenderGraphFrame>,
    ...args
  ) {
    if (args[0] === 'main') {
      const input = this.createBuffer('unwritten-test-input', { size: 16 }).unwrap();
      this.addCopyPass('read-unwritten-test-input', {
        accesses: [{ resource: input, usage: 'copy-src' }],
        encode() {},
      }).unwrap();
      rejected++;
    }
    return original.apply(this, args);
  });
  return {
    get count() {
      return rejected;
    },
    restore: () => spy.mockRestore(),
  };
}
