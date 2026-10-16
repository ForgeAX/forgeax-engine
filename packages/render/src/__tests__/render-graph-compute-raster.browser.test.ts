import { describe, expect, it } from 'vitest';
import { runTextureReuseGraph } from './graph-texture-reuse-gpu';
import { runComputeRasterGraph } from './render-graph-compute-raster-gpu';

describe('RenderGraph compute to indirect raster in Chromium WebGPU', () => {
  it('preserves the same graph hazards and pixel through the browser path', async () => {
    const evidence = await runComputeRasterGraph();
    expect(evidence.graph.passes.map((pass) => pass.name)).toEqual([
      'prepare-args-and-ping',
      'ping-pong',
      'storage-texture',
      'indirect-raster',
      'readback',
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
