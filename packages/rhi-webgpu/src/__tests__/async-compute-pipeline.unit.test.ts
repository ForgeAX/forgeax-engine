import type { ComputePipelineDescriptor } from '@forgeax/engine-rhi';
import { expect, it, vi } from 'vitest';
import { makeRhiDevice } from '../device';
import { createMockGpu } from './__mocks__/gpu-device';

async function rawDevice() {
  const gpu = createMockGpu(),
    adapter = await gpu.requestAdapter();
  if (adapter === null) throw Error('missing adapter');
  return (await adapter.requestDevice()) as unknown as GPUDevice;
}
const desc: ComputePipelineDescriptor = {
  layout: 'auto',
  compute: { module: {} as never, entryPoint: 'actual' },
};
it('exposes real native compute completion and mirrors the call descriptor', async () => {
  const raw = await rawDevice();
  let finish: ((pipeline: GPUComputePipeline) => void) | undefined;
  const native = vi.fn(() => new Promise<GPUComputePipeline>((resolve) => (finish = resolve)));
  Object.assign(raw, { createComputePipelineAsync: native });
  const { device } = makeRhiDevice(raw),
    create = device.createComputePipelineAsync;
  if (create === undefined) throw Error('missing capability');
  const result = create(desc),
    observed = vi.fn();
  void result.then(observed);
  await Promise.resolve();
  expect(observed).not.toHaveBeenCalled();
  expect(native.mock.calls[0]).toEqual([desc]);
  if (finish === undefined) throw Error('missing completion');
  const pipeline = {} as GPUComputePipeline;
  finish(pipeline);
  expect((await result).unwrap()).toBe(pipeline);
});
it('preserves validation failure and does not advertise completion on a legacy provider', async () => {
  const raw = await rawDevice();
  expect(makeRhiDevice(raw).device.createComputePipelineAsync).toBeUndefined();
  Object.assign(raw, {
    createComputePipelineAsync: async () => {
      throw Object.assign(Error('invalid actual kernel'), { reason: 'validation' });
    },
  });
  const create = makeRhiDevice(raw).device.createComputePipelineAsync;
  if (create === undefined) throw Error('missing capability');
  const result = await create(desc);
  expect(result.ok).toBe(false);
  if (result.ok) throw Error('failed kernel became ready');
  expect(result.error.code).toBe('rhi-descriptor-invalid');
});
