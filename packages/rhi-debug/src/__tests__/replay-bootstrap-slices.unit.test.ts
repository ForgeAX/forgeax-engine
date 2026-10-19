import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { InitialDataSlice, Tape } from '../protocol/types';
import { openReplay } from '../replay/session';

async function replay(kind: 'buffer' | 'texture', slice: InitialDataSlice) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const storage = new ArrayBuffer(8);
  const unmap = vi.fn();
  const createBuffer = device.createBuffer.bind(device);
  vi.spyOn(device, 'createBuffer').mockImplementation((desc) => {
    const result = createBuffer(desc);
    if (result.ok) Object.assign(result.value, { getMappedRange: () => ok(storage), unmap });
    return result;
  });
  const written: number[][] = [];
  vi.spyOn(device.queue, 'writeTexture').mockImplementation((_destination, data) => {
    written.push(
      Array.from(
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      ),
    );
    return ok(undefined);
  });
  const events: Tape['events'] = [
    { kind: 'createCommandEncoder', cmdHandleId: 'encoder', desc: {} },
    { kind: 'beginComputePass', cmdHandleId: 'encoder', passHandleId: 'pass', desc: {} },
    { kind: 'dispatchWorkgroups', passHandleId: 'pass', x: 1, y: 1, z: 1 },
    { kind: 'endComputePass', passHandleId: 'pass' },
    { kind: 'finish', cmdHandleId: 'encoder' },
    { kind: 'submit', cmdHandleIds: ['encoder'] },
  ];
  const tape: Tape = {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: events.length, blobCount: 1 },
    events,
    blobs: [
      { hash: 'payload', bytes: new Uint8Array([9, 8, 1, 2, 3, 4, 7, 6]), compression: 'none' },
    ],
    bootstrap: [
      {
        kind,
        handleId: 'seed',
        initialData: [slice],
        create:
          kind === 'buffer'
            ? { kind: 'createBuffer', handleId: 'seed', desc: { size: 8, usage: 8 } }
            : {
                kind: 'createTexture',
                handleId: 'seed',
                desc: { size: [1, 1], format: 'rgba8unorm', usage: 2 },
              },
      },
    ],
  };
  const session = (await openReplay(tape, { device, createShaderModule })).unwrap();
  try {
    const result = await session.inspectWork(0, []);
    return { result, storage: Array.from(new Uint8Array(storage)), written, unmap };
  } finally {
    await session.dispose();
  }
}

describe.each(['buffer', 'texture'] as const)('%s bootstrap byte slices', (kind) => {
  it('restores only the selected byte window', async () => {
    const observed = await replay(kind, { hash: 'payload', byteOffset: 2, byteLength: 4 });
    expect(observed.result.ok).toBe(true);
    if (kind === 'buffer') {
      expect(observed.storage).toEqual([1, 2, 3, 4, 0, 0, 0, 0]);
      expect(observed.unmap).toHaveBeenCalledOnce();
    } else expect(observed.written).toEqual([[1, 2, 3, 4]]);
  });

  it.each([
    { hash: 'missing', byteOffset: 0, byteLength: 4 },
    { hash: 'payload', byteOffset: -1, byteLength: 4 },
    { hash: 'payload', byteOffset: 1.5, byteLength: 4 },
    { hash: 'payload', byteOffset: 2, byteLength: 4.5 },
    { hash: 'payload', byteOffset: Number.NaN, byteLength: 4 },
    { hash: 'payload', byteOffset: 2, byteLength: Number.NaN },
    { hash: 'payload', byteOffset: 6, byteLength: 4 },
  ])('rejects an invalid slice before seeding: %j', async (slice) => {
    const observed = await replay(kind, slice);
    expect(observed.result).toMatchObject({
      ok: false,
      error: { code: 'replay-event-failed', detail: { eventIndex: -1, stage: 'lookup' } },
    });
    expect(observed.storage).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(observed.written).toEqual([]);
    if (kind === 'buffer') expect(observed.unmap).toHaveBeenCalledOnce();
  });
});
