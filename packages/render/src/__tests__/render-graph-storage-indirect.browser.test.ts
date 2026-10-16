import { describe, expect, it } from 'vitest';
import { runStorageIndirectGraph } from './render-graph-storage-indirect-gpu';

describe('RenderGraph storage texture and indirect dispatch in Chromium', () => {
  it('executes storage-write -> copy-readback through browser WebGPU', async () => {
    const evidence = await runStorageIndirectGraph();
    expect(evidence.caps).toEqual({
      compute: true,
      storageTexture: true,
      indirectDrawing: true,
    });
    expect(evidence.graph.passes.map((pass) => [pass.name, pass.kind])).toEqual([
      ['storage-write', 'compute'],
      ['readback', 'copy'],
    ]);
    expect(evidence.pixel[0]).toBeCloseTo(64, 0);
    expect(evidence.pixel[1]).toBeCloseTo(128, 0);
    expect(evidence.pixel[2]).toBeCloseTo(191, 0);
    expect(evidence.pixel[3]).toBe(255);
  });
});
