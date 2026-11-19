import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { createRenderTargetHost } from '../assembly/render-target-host';
import type { RenderTargetDescriptor } from '../targets/contracts';

const descriptor: RenderTargetDescriptor = {
  shape: 'cube',
  width: 64,
  height: 64,
  format: 'rgba8unorm',
  mipLevels: 1,
  sampleCount: 1,
  sampled: true,
  readback: true,
};

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

it('rejects an unsubmitted old-extent readback after resize before encoding an invalid GPU copy', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const host = createRenderTargetHost({ getDevice: () => device });
  const target = value(host.createRenderTarget(descriptor));
  host.beginFrame();
  const stale = value(host.requestTargetReadback(target, { mipLevel: 0, layer: 0 }));
  value(host.resizeRenderTarget(target, { ...descriptor, width: 32, height: 32 }));
  host.beginFrame();
  const physical = host.getPhysicalTarget(target);
  if (physical === undefined) throw new Error('Missing resized candidate');
  const encoder = device.createCommandEncoder({}).unwrap();
  const copy = vi.spyOn(encoder, 'copyTextureToBuffer');
  host.encodePendingReadbacks(encoder, [{ target, layer: 0 }]);
  expect(copy).not.toHaveBeenCalled();
  host.markTargetSubmitted(target, physical);
  host.onFrameSubmitted(Promise.resolve({ ok: true, value: undefined }), {
    frameId: 1,
    deviceGeneration: 0,
  });
  await Promise.resolve();
  const rejected = await host.observeTargetReadbacks({ frameId: 1, deviceGeneration: 0 }, [stale]);
  expect(rejected.ok).toBe(false);
  if (!rejected.ok) expect(rejected.error.code).toBe('render-target-operation-failed');
  const fresh = value(host.requestTargetReadback(target, { mipLevel: 0, layer: 0 }));
  host.encodePendingReadbacks(encoder, [{ target, layer: 0 }]);
  expect(copy).toHaveBeenCalledTimes(1);
  expect(copy.mock.calls[0]?.[2]).toEqual([32, 32, 1]);
  host.onFrameSubmitted(Promise.resolve({ ok: true, value: undefined }), {
    frameId: 2,
    deviceGeneration: 0,
  });
  await Promise.resolve();
  const recovered = await host.observeTargetReadbacks({ frameId: 2, deviceGeneration: 0 }, [fresh]);
  expect(recovered.ok).toBe(true);
  if (recovered.ok)
    expect(recovered.value[0]).toMatchObject({ bytesPerRow: 256, byteLength: 8192 });
  host.dispose();
});

it('reads the matching accepted target while a differently sized candidate is written', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const host = createRenderTargetHost({ getDevice: () => device });
  const target = value(host.createRenderTarget(descriptor));
  host.beginFrame();
  const accepted = host.getPhysicalTarget(target);
  if (accepted === undefined) throw new Error('Missing original candidate');
  host.markTargetSubmitted(target, accepted);
  host.onFrameSubmitted();
  await Promise.resolve();
  const ticket = value(host.requestTargetReadback(target, { mipLevel: 0, layer: 0 }));
  value(host.resizeRenderTarget(target, { ...descriptor, width: 32, height: 32 }));
  const candidate = host.getPhysicalTarget(target);
  if (candidate === undefined) throw new Error('Missing resized candidate');
  const encoder = device.createCommandEncoder({}).unwrap();
  const copy = vi.spyOn(encoder, 'copyTextureToBuffer');
  host.encodePendingReadbacks(encoder, [{ target, layer: 0 }]);
  expect(copy.mock.calls[0]?.[0].texture).toBe(accepted.resolveTexture ?? accepted.texture);
  expect(copy.mock.calls[0]?.[2]).toEqual([64, 64, 1]);
  host.markTargetSubmitted(target, candidate);
  host.onFrameSubmitted(Promise.resolve({ ok: true, value: undefined }), {
    frameId: 2,
    deviceGeneration: 0,
  });
  await Promise.resolve();
  const observed = await host.observeTargetReadbacks({ frameId: 2, deviceGeneration: 0 }, [ticket]);
  expect(observed.ok).toBe(true);
  if (observed.ok) expect(observed.value[0]).toMatchObject({ bytesPerRow: 256, byteLength: 16384 });
  host.dispose();
});

it('admits only completed current physical cube faces for environment preparation', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const host = createRenderTargetHost({ getDevice: () => device });
  const target = value(host.createRenderTarget(descriptor));
  host.beginFrame();
  const physical = host.getPhysicalTarget(target);
  if (physical === undefined) throw new Error('Missing cube candidate');
  host.encodePendingReadbacks(
    device.createCommandEncoder({}).unwrap(),
    Array.from({ length: 6 }, (_, layer) => ({ target, layer })),
  );
  host.markTargetSubmitted(target, physical);
  expect(host.environmentTarget(target)).toBeUndefined();
  host.onFrameSubmitted(Promise.resolve({ ok: true, value: undefined }));
  await Promise.resolve();
  expect(host.environmentTarget(target)).toBeDefined();
  value(host.resizeRenderTarget(target, { ...descriptor, width: 32, height: 32 }));
  expect(host.environmentTarget(target)).toBeUndefined();
  host.dispose();
});

it('admits a capture round by submitted face receipts before any face fence resolves', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const host = createRenderTargetHost({ getDevice: () => device });
  const target = value(host.createRenderTarget({ ...descriptor, format: 'rgba16float' }));
  type Completion = { ok: true; value: undefined };
  let complete!: (result: Completion) => void;
  const fence = new Promise<Completion>((resolve) => {
    complete = resolve;
  });
  const receipts = Array.from({ length: 6 }, (_, layer) => ({
    frameId: layer + 1,
    deviceGeneration: 0,
  }));
  const write = (layer: number, receipt: (typeof receipts)[number]) => {
    host.beginFrame();
    const physical = host.getPhysicalTarget(target);
    if (physical === undefined) throw new Error('Missing cube candidate');
    host.encodePendingReadbacks(device.createCommandEncoder({}).unwrap(), [{ target, layer }]);
    host.markTargetSubmitted(target, physical);
    host.onFrameSubmitted(fence, receipt);
  };
  try {
    for (const [layer, receipt] of receipts.slice(0, 5).entries()) write(layer, receipt);
    expect(host.environmentTarget(target, receipts)).toBeUndefined();
    const last = receipts[5];
    if (last === undefined) throw new Error('Missing last face receipt');
    write(5, last);
    expect(host.environmentTarget(target)).toBeUndefined();
    expect(host.environmentTarget(target, receipts)?.physical.descriptor.format).toBe(
      'rgba16float',
    );
    expect(host.environmentTarget(target, [...receipts].reverse())).toBeUndefined();
    write(5, { frameId: 7, deviceGeneration: 0 });
    expect(host.environmentTarget(target, receipts)).toBeUndefined();
    complete({ ok: true, value: undefined });
    await fence;
    expect(host.environmentTarget(target)).toBeDefined();
    value(host.resizeRenderTarget(target, { ...descriptor, width: 32, height: 32 }));
    expect(host.environmentTarget(target, receipts)).toBeUndefined();
    expect(host.environmentTarget(target)).toBeUndefined();
  } finally {
    host.dispose();
  }
});
