import { describe, expect, it } from 'vitest';
import type { RenderTargetDescriptor } from '../targets/contracts';
import { createRenderTargetOwner } from '../targets/owner';
import {
  bindRenderTargetReadbackTicket,
  completeRenderTargetReadback,
  createRenderTargetReadbackTicket,
} from '../targets/readback';

const descriptor: RenderTargetDescriptor = {
  shape: 'cube',
  width: 4,
  height: 4,
  format: 'rgba8unorm-srgb',
  mipLevels: 1,
  sampleCount: 4,
  sampled: true,
  readback: true,
};

describe('RenderTarget recovery integration', () => {
  it('keeps the logical token and LKG while a candidate aborts', () => {
    const owner = createRenderTargetOwner({
      rendererId: Symbol('renderer'),
      getGeneration: () => 3,
    });
    const target = owner.create(descriptor);
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const candidate = owner.stage(target.value);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    expect(owner.promote(target.value, candidate.value.generation).ok).toBe(true);
    const resized = owner.stage(target.value, { ...descriptor, width: 8, height: 8 });
    expect(resized.ok).toBe(true);
    if (!resized.ok) return;
    expect(owner.rejectCandidate(target.value, resized.value.generation, 'submit').ok).toBe(false);
    const inspection = owner.inspect(target.value);
    expect(inspection.ok).toBe(true);
    if (inspection.ok) {
      expect(inspection.value.token).toBe(target.value);
      expect(inspection.value.state).toBe('active');
      expect(inspection.value.generation).toBe(3);
      expect(inspection.value.descriptor.width).toBe(4);
    }
  });

  it('retires the old generation before rebuilding readback state', () => {
    const owner = createRenderTargetOwner({
      rendererId: Symbol('renderer'),
      getGeneration: () => 1,
    });
    const target = owner.create(descriptor);
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const staged = owner.stage(target.value);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(owner.promote(target.value, 1).ok).toBe(true);
    const ticket = createRenderTargetReadbackTicket(target.value, {
      deviceGeneration: 1,
      mipLevel: 0,
      layer: 2,
      width: 4,
      height: 4,
      bytesPerPixel: 4,
    });
    expect(ticket.ok).toBe(true);
    if (!ticket.ok) return;
    expect(
      bindRenderTargetReadbackTicket(ticket.value, { frameId: 7, deviceGeneration: 1 }).ok,
    ).toBe(true);
    expect(owner.beginRecovery(target.value, 2).ok).toBe(true);
    expect(owner.finishRecovery(target.value).ok).toBe(true);
    const stale = completeRenderTargetReadback(
      ticket.value,
      { frameId: 8, deviceGeneration: 2 },
      new Uint8Array(ticket.value.byteLength),
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('render-target-state-invalid');
    const recovered = owner.inspect(target.value);
    expect(recovered.ok).toBe(true);
    if (recovered.ok)
      expect(recovered.value).toMatchObject({
        token: target.value,
        state: 'uninitialized',
        generation: 2,
      });
  });
});
