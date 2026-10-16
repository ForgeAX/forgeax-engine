import { describe, expect, it } from 'vitest';
import { runGpuSceneGraph } from './gpu-scene-render-graph-gpu';

describe('GPU Scene render graph on Dawn', () => {
  it('culls and compacts imported persistent tables into indirect raster work', async () => {
    const evidence = await runGpuSceneGraph();
    expect(evidence.graph.passes.map((pass) => [pass.name, pass.kind])).toEqual([
      ['gpu-scene-cull-compact-args', 'compute'],
      ['gpu-scene-indirect-raster', 'raster'],
      ['gpu-scene-readback', 'copy'],
    ]);
    expect(evidence.graph.passes[1]?.dependencies).toEqual(['gpu-scene-cull-compact-args']);
    const reds = [evidence.pixels[0], evidence.pixels[4]].sort(
      (left, right) => (left ?? 0) - (right ?? 0),
    );
    expect(reds).toEqual([128, 192]);
    expect([evidence.pixels[1], evidence.pixels[5]]).toEqual([255, 255]);
  });
});
