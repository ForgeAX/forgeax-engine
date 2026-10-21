import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createDebugDraw } from '../src';

const stages = ['vertex-buffer', 'uniform-buffer', 'vertex-shader', 'fragment-shader',
  'createBindGroupLayout', 'createPipelineLayout', 'createRenderPipeline', 'createBindGroup'] as const;

for (const stage of stages) {
  it.each(['result', 'throw'] as const)(`${stage} %s releases every acquired buffer`, async (mode) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const original = device.createBuffer.bind(device);
    const created = vi.spyOn(device, 'createBuffer');
    const destroyed = vi.spyOn(device, 'destroyBuffer');
    const shader = vi.fn(rhi.createShaderModule);
    const failure = new RhiError({ code: 'rhi-not-available', expected: 'test failure', hint: 'retry' });
    const fail = () => {
      if (mode === 'throw') throw failure;
      return err(failure);
    };
    if (stage === 'vertex-buffer' || stage === 'uniform-buffer') {
      if (stage === 'uniform-buffer') created.mockImplementationOnce(original);
      created.mockImplementationOnce(fail);
    } else if (stage === 'vertex-shader' || stage === 'fragment-shader') {
      if (stage === 'fragment-shader') shader.mockImplementationOnce(rhi.createShaderModule);
      shader.mockImplementationOnce(async () => fail());
    } else vi.spyOn(device, stage).mockImplementationOnce(fail);
    try {
      const pending = createDebugDraw({ device, queue: device.queue, createShaderModule: shader });
      if (mode === 'throw') await expect(pending).rejects.toBe(failure);
      else expect((await pending).ok).toBe(false);
      const buffers = created.mock.results.flatMap((result) =>
        result.type === 'return' && result.value.ok ? [result.value.value] : []);
      expect(destroyed.mock.calls.map(([buffer]) => buffer)).toEqual(buffers);
    } finally {
      vi.restoreAllMocks();
    }
  });
}
