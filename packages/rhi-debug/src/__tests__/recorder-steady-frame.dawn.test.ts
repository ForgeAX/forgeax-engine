/// <reference types="@webgpu/types" />

import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { decodeTape } from '../protocol/codec';
import { attachRecorder, type RecordableBackend } from '../recorder/session';

async function dawnBackend(): Promise<RecordableBackend> {
  return (await import('@forgeax/engine-rhi-webgpu')) as unknown as RecordableBackend;
}

describe('RecorderSession steady-frame Dawn contract', () => {
  it('skips graph textures retired while an earlier snapshot batch is awaiting its fence', async () => {
    const attachment = attachRecorder(await dawnBackend()).unwrap();
    const device = (
      await (await attachment.backend.rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap();
    const real = (device as typeof device & { _realDevice: typeof device })._realDevice;
    const buffer = device.createBuffer({ size: 16, usage: 0x28 }).unwrap();
    const texture = device
      .createTexture({
        label: 'retiring-spot-shadow-depth',
        size: { width: 2, height: 2 },
        format: 'depth32float',
        usage: 0x14,
      })
      .unwrap();
    const copy = vi.fn();
    const createEncoder = real.createCommandEncoder.bind(real);
    const create = vi.spyOn(real, 'createCommandEncoder').mockImplementation((descriptor) => {
      const encoder = createEncoder(descriptor).unwrap();
      const encodeCopy = encoder.copyTextureToBuffer.bind(encoder);
      vi.spyOn(encoder, 'copyTextureToBuffer').mockImplementation((...args) => {
        copy(args[0].texture);
        encodeCopy(...args);
      });
      return ok(encoder);
    });
    const fence = vi
      .spyOn(real.queue, 'onSubmittedWorkDone')
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        device.destroyTexture(texture).unwrap();
      });
    try {
      const capture = attachment.captureFrame();
      (await attachment.frameBoundary()).unwrap();
      (await attachment.frameBoundary()).unwrap();
      expect(copy).not.toHaveBeenCalledWith(texture);
      expect((await capture).ok).toBe(true);
    } finally {
      create.mockRestore();
      fence.mockRestore();
      device.destroyBuffer(buffer).unwrap();
      (await attachment.dispose()).unwrap();
    }
  });

  it('captures a resource created and uploaded before the requested frame', async () => {
    const backend = await dawnBackend();
    const attached = attachRecorder(backend);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const adapter = await attached.value.backend.rhi.requestAdapter();
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) return;
    const device = await adapter.value.requestDevice();
    expect(device.ok).toBe(true);
    if (!device.ok) return;
    const buffer = device.value.createBuffer({ size: 16, usage: 0x28 });
    expect(buffer.ok).toBe(true);
    if (!buffer.ok) return;
    const write = device.value.queue.writeBuffer(buffer.value, 0, new Uint8Array(16));
    expect(write.ok).toBe(true);

    const capture = attached.value.captureFrame();
    expect((await attached.value.frameBoundary()).ok).toBe(true);
    const encoder = device.value.createCommandEncoder({});
    expect(encoder.ok).toBe(true);
    if (!encoder.ok) return;
    encoder.value.clearBuffer(buffer.value, 0, 16);
    const command = encoder.value.finish();
    expect(command.ok).toBe(true);
    if (!command.ok) return;
    const submit = device.value.queue.submit([command.value]);
    expect(submit.ok).toBe(true);
    expect((await attached.value.frameBoundary()).ok).toBe(true);

    const result = await capture;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decoded = decodeTape(result.value.bytes);
    if (!decoded.ok)
      throw new Error(`${decoded.error.code}: ${JSON.stringify(decoded.error.detail)}`);
    expect(decoded.value.bootstrap.some((resource) => resource.kind === 'buffer')).toBe(true);
    expect(decoded.value.events.some((event) => event.kind === 'clearBuffer')).toBe(true);
  });
});
