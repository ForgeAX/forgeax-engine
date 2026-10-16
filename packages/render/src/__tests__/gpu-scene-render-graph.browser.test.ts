import { describe, expect, it } from 'vitest';
import { runGpuSceneGraph } from './gpu-scene-render-graph-gpu';

describe('GPU Scene render graph in Chromium WebGPU', () => {
  it('uses compute-generated visible instances and draw args in the browser path', async () => {
    const evidence = await runGpuSceneGraph();
    expect(evidence.graph.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'gpu-scene-primitives', origin: 'imported' }),
        expect.objectContaining({ label: 'gpu-scene-transforms', origin: 'imported' }),
        expect.objectContaining({ label: 'gpu-scene-draw-args', derivedUsage: 0x0180 }),
      ]),
    );
    const reds = [evidence.pixels[0], evidence.pixels[4]].sort(
      (left, right) => (left ?? 0) - (right ?? 0),
    );
    expect(reds).toEqual([128, 192]);
  });
});
