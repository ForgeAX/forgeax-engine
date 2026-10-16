import { describe, expect, it } from 'vitest';
import { runHzbGraph } from './render-graph-hzb-gpu';

describe('RenderGraph HZB mip chain on Dawn', () => {
  it('orders writes and reads by texture subresource and preserves the maximum depth', async () => {
    const evidence = await runHzbGraph();
    expect(evidence.graph.passes.map((pass) => pass.name)).toEqual([
      'hzb-seed',
      'hzb-reduce-1',
      'hzb-reduce-2',
      'hzb-reduce-3',
      'hzb-readback',
    ]);
    expect(evidence.graph.passes.map((pass) => pass.dependencies)).toEqual([
      [],
      ['hzb-seed'],
      ['hzb-reduce-1'],
      ['hzb-reduce-2'],
      ['hzb-reduce-3'],
    ]);
    expect(evidence.finalDepth).toBeCloseTo(1, 6);
  });
});
