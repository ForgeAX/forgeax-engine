import { describe, expect, it } from 'vitest';
import { runHzbGraph } from './render-graph-hzb-gpu';

describe('RenderGraph HZB mip chain in Chromium WebGPU', () => {
  it('executes the same subresource chain through the browser driver path', async () => {
    const evidence = await runHzbGraph();
    expect(evidence.graph.passes.map((pass) => pass.kind)).toEqual([
      'compute',
      'compute',
      'compute',
      'compute',
      'copy',
    ]);
    expect(evidence.finalDepth).toBeCloseTo(1, 6);
  });
});
