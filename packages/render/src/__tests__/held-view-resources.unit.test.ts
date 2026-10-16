import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import type { RenderFeature } from '../features/types';

describe('held view resource ownership', () => {
  it('keeps held buffers without allocation or work, then retires removed views', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const gpuWork = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
    });
    const feature: RenderFeature<undefined> = {
      identity: 'held-resource-proof',
      extract: () => ok(undefined),
      plan: (_, { views }) =>
        ok({
          work: views
            .filter((view) => view.render)
            .map((view) => ({
              scope: { view: view.identity },
              resources: [
                { kind: 'buffer' as const, name: 'history', size: 16, usage: ['storage'] as const },
              ],
              passes: [],
            })),
        }),
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    const create = vi.spyOn(device, 'createBuffer');
    const destroy = vi.spyOn(device, 'destroyBuffer');
    const frame = (views: readonly { identity: string; render: boolean }[]) => {
      const result = runRenderFeatureFrame(
        host,
        views.map((view) => ({
          ...view,
          worlds: [],
          owner: 0,
          frameNumber: 1,
          generation: 0,
          caps: device.caps,
          gpuWork,
        })),
      );
      expect(result.frame.errors).toEqual([]);
      result.frame.onSubmitted();
      for (const view of result.views.values()) view.onSubmitted();
      result.onSubmitted();
      for (const batch of result.preparedResourceBatches) batch.release().unwrap();
      return result;
    };
    frame([
      { identity: 'a', render: true },
      { identity: 'b', render: true },
    ]);
    expect(create).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 65; index++) {
      const held = frame([
        { identity: 'a', render: false },
        { identity: 'b', render: true },
      ]);
      expect(held.views.get('a')?.plans).toEqual([]);
    }
    expect(create).toHaveBeenCalledTimes(2);
    expect(destroy).not.toHaveBeenCalled();
    frame([
      { identity: 'b', render: true },
      { identity: 'a', render: true },
    ]);
    expect(create).toHaveBeenCalledTimes(2);
    frame([{ identity: 'b', render: true }]);
    expect(destroy).toHaveBeenCalledTimes(1);
    gpuWork.dispose().unwrap();
    host.dispose();
  });
});
