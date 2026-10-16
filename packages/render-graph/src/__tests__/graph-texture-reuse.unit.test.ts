import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { RenderGraphBuilder } from '../builder';
import type { CompiledRenderGraph, GraphTextureViewDescriptor, RenderGraphFrame } from '../types';

function compile(
  device: RhiDevice,
  previous?: CompiledRenderGraph<RenderGraphFrame>,
  width = 8,
  extra = false,
  viewDescriptor: GraphTextureViewDescriptor = {},
) {
  const builder = new RenderGraphBuilder();
  const texture = builder
    .createTexture('scene-color', { size: 'surface', format: 'rgba8unorm' })
    .unwrap();
  const view = builder.view(texture, viewDescriptor).unwrap();
  builder
    .addRasterPass('scene', {
      accesses: [{ resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      encode() {},
    })
    .unwrap();
  if (extra) builder.addCopyPass('vfx-topology-change', { accesses: [], encode() {} }).unwrap();
  return builder
    .compile({ device, surfaceSize: { width, height: 8 }, reuseResourcesFrom: previous })
    .unwrap();
}

it('retains same-descriptor targets across topology replacements until every graph fence retires', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const creates = vi.spyOn(device, 'createTexture');
  const views = vi.spyOn(device, 'createTextureView');
  const destroys = vi.spyOn(device, 'destroyTexture');
  const first = compile(device);
  const second = compile(device, first, 8, true);
  expect(creates).toHaveBeenCalledTimes(1);
  expect(views).toHaveBeenCalledTimes(1);
  expect(second.inspect().resources[0]?.physicalAllocationKey).toBe(
    first.inspect().resources[0]?.physicalAllocationKey,
  );
  await first.retire();
  expect(destroys).not.toHaveBeenCalled();
  const third = compile(device, second);
  expect(creates).toHaveBeenCalledTimes(1);
  expect(views).toHaveBeenCalledTimes(1);
  await second.retire();
  expect(destroys).not.toHaveBeenCalled();
  await third.retire();
  expect(destroys).toHaveBeenCalledTimes(1);
});

it('allocates a distinct resized target and retains the old graph for rollback', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const creates = vi.spyOn(device, 'createTexture');
  const first = compile(device);
  const resized = compile(device, first, 16);
  expect(creates).toHaveBeenCalledTimes(2);
  await resized.retire();
  const fallback = compile(device, first);
  expect(creates).toHaveBeenCalledTimes(2);
  await fallback.retire();
  await first.retire();
});

it('releases a failed candidate lease without destroying the usable previous graph', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const first = compile(device);
  const destroys = vi.spyOn(device, 'destroyTexture');
  const views = vi
    .spyOn(device, 'createTextureView')
    .mockReturnValueOnce({ ok: false, error: { code: 'webgpu-runtime-error' } } as never);
  expect(() => compile(device, first, 8, false, { baseMipLevel: 0 })).toThrow();
  expect(destroys).not.toHaveBeenCalled();
  views.mockRestore();
  const creates = vi.spyOn(device, 'createTexture');
  const retry = compile(device, first);
  expect(creates).not.toHaveBeenCalled();
  await retry.retire();
  expect(destroys).not.toHaveBeenCalled();
  await first.retire();
  expect(destroys).toHaveBeenCalledTimes(1);
});

it('waits for both generation fences even when they complete out of order', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const fences: Array<() => void> = [];
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(
    () => new Promise<undefined>((resolve) => fences.push(() => resolve(undefined))),
  );
  const destroys = vi.spyOn(device, 'destroyTexture');
  const first = compile(device);
  const second = compile(device, first);
  const oldRetirement = first.retire();
  const newRetirement = second.retire();
  expect(fences).toHaveLength(2);
  fences[1]?.();
  expect((await newRetirement).ok).toBe(true);
  expect(destroys).not.toHaveBeenCalled();
  expect(first.inspect().resources[0]?.allocationState).toBe('pending-retirement');
  fences[0]?.();
  expect((await oldRetirement).ok).toBe(true);
  expect(destroys).toHaveBeenCalledTimes(1);
  expect(first.inspect().resources[0]?.allocationState).toBe('released');
});

it('never borrows from a retired graph or a different device', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const otherDevice = (await adapter.requestDevice()).unwrap();
  const creates = vi.spyOn(device, 'createTexture');
  const otherCreates = vi.spyOn(otherDevice, 'createTexture');
  const first = compile(device);
  const other = compile(otherDevice, first);
  expect(otherCreates).toHaveBeenCalledTimes(1);
  await first.retire();
  const replacement = compile(device, first);
  expect(creates).toHaveBeenCalledTimes(2);
  await replacement.retire();
  await other.retire();
});
