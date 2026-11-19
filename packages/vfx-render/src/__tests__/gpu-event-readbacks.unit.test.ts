import { VFX_GPU_OUTPUT_HEADER_BYTES } from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';
import { createVfxGpuEventReadbacks } from '../feature/gpu-event-readbacks.js';

function harness() {
  const owner = createVfxGpuEventReadbacks();
  const append = (frame: number) =>
    owner.append({
      frame,
      runtimeId: 1,
      epoch: 2,
      generation: 3,
      capacity: 1,
      resource: 'events',
      resources: [],
      passes: [],
    })[0];
  const receive = (frame: number, particleId: number) => {
    const request = append(frame);
    if (!request) throw new Error('Expected available readback slot');
    const bytes = new Uint8Array(VFX_GPU_OUTPUT_HEADER_BYTES + 32);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 2, true);
    view.setUint32(VFX_GPU_OUTPUT_HEADER_BYTES + 16, 1, true);
    view.setUint32(VFX_GPU_OUTPUT_HEADER_BYTES + 20, particleId, true);
    owner.receive({ tag: request.tag, bytes });
  };
  return { owner, append, receive, ready: () => owner.ready(1, 2, 3) };
}

describe('GPU event readback aborted receipts', () => {
  it('bounds consecutive aborted frames while advancing the receipt watermark', () => {
    const h = harness();
    for (let frame = 1; frame <= 10000; frame++) {
      h.append(frame);
      h.owner.abort(frame);
    }
    expect(h.ready()).toEqual([{ epoch: 2, generation: 3, sequence: 10000, events: [] }]);
    h.owner.submitted(1, h.ready());
    expect(h.ready()).toEqual([]);
    h.receive(10001, 42);
    expect(h.ready()[0]?.events[0]?.particleId).toBe(42);
  });

  it('preserves nonempty event order around abort gaps and clears retired observers', () => {
    const h = harness();
    h.receive(1, 11);
    for (let frame = 2; frame <= 100; frame++) {
      h.append(frame);
      h.owner.abort(frame);
    }
    h.receive(101, 22);
    expect(h.ready().map((batch) => batch.sequence)).toEqual([1, 100, 101]);
    expect(h.ready().flatMap((batch) => batch.events.map((event) => event.particleId))).toEqual([
      11, 22,
    ]);
    const late = h.append(102);
    h.owner.reset();
    if (!late) throw new Error('Expected pending readback');
    h.owner.receive({ tag: late.tag });
    h.owner.abort(102);
    expect(h.ready()).toEqual([]);
  });
});
