import { describe, expect, it } from 'vitest';
import { runTextureReuseGraph } from './graph-texture-reuse-gpu';
import { runComputeRasterGraph } from './render-graph-compute-raster-gpu';

describe('RenderGraph compute to indirect raster on Dawn', () => {
  it('consumes compute-generated dispatch and draw args after buffer ping-pong', async () => {
    const evidence = await runComputeRasterGraph();
    expect(evidence.graph.passes.map((pass) => pass.kind)).toEqual([
      'compute',
      'compute',
      'compute',
      'raster',
      'copy',
    ]);
    expect(evidence.graph.passes[1]?.dependencies).toEqual(['prepare-args-and-ping']);
    expect(evidence.graph.passes[2]?.dependencies).toEqual(['ping-pong']);
    expect(evidence.graph.passes[3]?.dependencies).toEqual([
      'prepare-args-and-ping',
      'storage-texture',
    ]);
    expect(evidence.pixel).toEqual([64, 128, 191, 255]);
  });
});

it('reuses replacement targets with fresh pixels and preserves rollback and resize', async () => {
  const result = await runTextureReuseGraph();
  expect(result.shared).toBe(true);
  expect(result.distinct).toBe(true);
  expect(result.pixels).toEqual([
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [255, 0, 0, 255],
    [0, 0, 255, 255],
  ]);
});
