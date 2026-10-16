import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { createRenderTargetHost } from '../assembly/render-target-host';
import type { RenderTargetDescriptor } from '../targets/contracts';
import { createRenderTargetOwner } from '../targets/owner';
import {
  completeRenderTargetReadback,
  createRenderTargetReadbackTicket,
  type RenderTargetReadbackReceipt,
} from '../targets/readback';

const descriptor: RenderTargetDescriptor = {
  shape: '2d',
  width: 17,
  height: 9,
  format: 'rgba8unorm',
  mipLevels: 1,
  sampleCount: 1,
  sampled: false,
  readback: true,
};

function target() {
  const owner = createRenderTargetOwner({ rendererId: Symbol('renderer'), getGeneration: () => 2 });
  const result = owner.create(descriptor);
  if (!result.ok) throw result.error;
  return result.value;
}

describe('RenderTarget receipt-bound readback', () => {
  it('reads an accepted cube face while another face is progressively written', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const host = createRenderTargetHost({ getDevice: () => device, getGeneration: () => 0 });
    const created = host.createRenderTarget({ ...descriptor, shape: 'cube', width: 9, height: 9 });
    if (!created.ok) throw created.error;
    host.beginFrame();
    const physical = host.getPhysicalTarget(created.value);
    if (physical === undefined) throw new Error('cube storage missing');
    host.markTargetSubmitted(created.value, physical);
    host.onFrameSubmitted();
    await Promise.resolve();
    host.beginFrame();
    const ticket = host.requestTargetReadback(created.value, { mipLevel: 0, layer: 5 });
    if (!ticket.ok) throw ticket.error;
    const encoder = device.createCommandEncoder().unwrap();
    const copy = vi.spyOn(encoder, 'copyTextureToBuffer');
    host.encodePendingReadbacks(encoder, [{ target: created.value, layer: 0 }]);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy.mock.calls[0]?.[0]).toMatchObject({ texture: physical.texture, origin: { z: 5 } });
    host.dispose();
  });
  it('admits a square cube target as six independently addressable faces', () => {
    const owner = createRenderTargetOwner({
      rendererId: Symbol('renderer'),
      getGeneration: () => 3,
    });
    const result = owner.create({ ...descriptor, shape: 'cube', width: 9, height: 9 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const staged = owner.stage(result.value);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.value.descriptor.shape).toBe('cube');
    expect(staged.value.descriptor.width).toBe(staged.value.descriptor.height);
  });

  it('uses 256-byte row alignment and completes exactly once for a matching receipt', () => {
    const ticket = createRenderTargetReadbackTicket(target(), {
      frameId: 11,
      deviceGeneration: 2,
      mipLevel: 0,
      width: 17,
      height: 9,
      bytesPerPixel: 4,
    });
    expect(ticket.ok).toBe(true);
    if (!ticket.ok) return;
    expect(ticket.value.bytesPerRow).toBe(256);
    expect(ticket.value.byteLength).toBe(256 * 9);

    const receipt: RenderTargetReadbackReceipt = {
      frameId: 11,
      deviceGeneration: 2,
    };
    const bytes = new Uint8Array(ticket.value.byteLength);
    const completed = completeRenderTargetReadback(ticket.value, receipt, bytes);
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.bytes).toBe(bytes);
    expect(completeRenderTargetReadback(ticket.value, receipt, bytes).ok).toBe(false);
  });

  it('rejects mismatched frame or generation before consuming the one-shot ticket', () => {
    const ticket = createRenderTargetReadbackTicket(target(), {
      frameId: 4,
      deviceGeneration: 8,
      mipLevel: 0,
      width: 1,
      height: 1,
      bytesPerPixel: 8,
    });
    expect(ticket.ok).toBe(true);
    if (!ticket.ok) return;
    const bytes = new Uint8Array(ticket.value.byteLength);
    const stale = completeRenderTargetReadback(
      ticket.value,
      { frameId: 5, deviceGeneration: 8 },
      bytes,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('render-target-state-invalid');
    expect(
      completeRenderTargetReadback(ticket.value, { frameId: 4, deviceGeneration: 8 }, bytes).ok,
    ).toBe(true);
  });
});
