import type { RenderPipelineDescriptor } from '@forgeax/engine-rhi';
import { expect, it, vi } from 'vitest';
import { makeRhiDevice } from '../device';
import { createMockGpu } from './__mocks__/gpu-device';

async function rawDevice() {
  const gpu = createMockGpu();
  const adapter = await gpu.requestAdapter();
  if (adapter === null) throw new Error('mock adapter unavailable');
  return (await adapter.requestDevice()) as unknown as GPUDevice;
}
const desc: RenderPipelineDescriptor = {
  layout: 'auto',
  vertex: { module: {} as never, entryPoint: 'v', buffers: [] },
  primitive: { topology: 'triangle-list' },
};

it('exposes only a real backend async capability and mirrors its descriptor', async () => {
  const raw = await rawDevice();
  let resolve!: (pipeline: GPURenderPipeline) => void;
  const native = vi.fn(
    (_descriptor: GPURenderPipelineDescriptor) =>
      new Promise<GPURenderPipeline>((r) => (resolve = r)),
  );
  Object.assign(raw, { createRenderPipelineAsync: native });
  const { device } = makeRhiDevice(raw);
  const create = device.createRenderPipelineAsync;
  if (create === undefined) throw new Error('async capability unavailable');
  const promise = create(desc);
  const observed = vi.fn();
  void promise.then(observed);
  await Promise.resolve();
  expect(observed).not.toHaveBeenCalled();
  expect(native.mock.calls[0]?.[0]).toEqual({
    ...desc,
    vertex: { ...desc.vertex },
    primitive: { ...desc.primitive },
  });
  const pipeline = {} as GPURenderPipeline;
  resolve(pipeline);
  expect((await promise).unwrap()).toBe(pipeline);
});

it('converts native async validation failure to a structured Result', async () => {
  const raw = await rawDevice();
  Object.assign(raw, {
    createRenderPipelineAsync: vi.fn(async () => {
      throw Object.assign(new Error('invalid actual entry'), { reason: 'validation' });
    }),
  });
  const { device } = makeRhiDevice(raw);
  const create = device.createRenderPipelineAsync;
  if (create === undefined) throw new Error('async capability unavailable');
  const result = await create(desc);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('failed pipeline became ready');
  expect(result.error.code).toBe('rhi-descriptor-invalid');
  expect(result.error.hint).toContain('invalid actual entry');
});

it('does not advertise async completion on a legacy provider seam', async () => {
  const { device } = makeRhiDevice(await rawDevice());
  expect(device.createRenderPipelineAsync).toBeUndefined();
});
