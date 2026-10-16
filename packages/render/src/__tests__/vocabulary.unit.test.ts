// @perf-budget-skip: intentional public render-barrel vocabulary smoke gate.

import { describe, expect, it } from 'vitest';

describe('render vocabulary', () => {
  it('exposes the core render roster from the render package', async () => {
    const render = await import('../index');
    expect(render.Camera).toBeDefined();
    expect(render.MeshFilter).toBeDefined();
    expect(render.MeshRenderer).toBeDefined();
    expect(render.DirectionalLight).toBeDefined();
    expect(render.PointLight).toBeDefined();
    expect(render.SpotLight).toBeDefined();
    expect(render.Layer).toBeDefined();
    expect(render.SortKey).toBeDefined();
    expect(render.Instances).toBeDefined();
    expect(render.PostProcessParams).toBeDefined();
    expect(render.TONEMAP_REINHARD).toBeDefined();
    expect('tonemapToU32' in render).toBe(false);
  }, 15_000);
});
