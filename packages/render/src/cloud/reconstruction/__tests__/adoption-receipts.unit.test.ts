import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { FrameReceipt } from '../../../render-contract';
import type { CloudRecordedAdoption } from '../adoption';
import { CloudAdoptionReceipts } from '../adoption-receipts';

const adoption = (requestRevision: number, worldIdentity = 'world'): CloudRecordedAdoption => ({
  requestRevision,
  worldIdentity,
  entity: 9,
  path: 'sampled',
  materialGuid: 'material',
  cookIdentity: 'cook',
  programIdentity: 'program',
  values: { thicknessMeters: 4000 + requestRevision },
  unavailableFields: {},
});

function pendingReceipt(frameId: number, options: Partial<FrameReceipt> = {}) {
  let resolve!: (result: Awaited<FrameReceipt['completed']>) => void;
  const fence = new Promise<Awaited<FrameReceipt['completed']>>((settle) => {
    resolve = settle;
  });
  const receipt: FrameReceipt = {
    frameId,
    deviceGeneration: 1,
    graphGeneration: 2,
    presentation: 'ready',
    completed: fence,
    ...options,
  };
  return {
    receipt,
    complete: async (success = true) => {
      resolve(success ? ok(undefined) : err({} as never));
      await fence;
    },
  };
}

describe('completed cloud adoption receipts', () => {
  it('waits for the exact ready physical submission and GPU completion', async () => {
    const owner = new CloudAdoptionReceipts(() => true);
    owner.record(7, 'left', adoption(1));
    const pending = pendingReceipt(20, { presentation: 'pending' });
    owner.observe(7, true, pending.receipt);
    await pending.complete();
    expect(owner.read('left', 1)).toBeUndefined();

    owner.record(8, 'left', adoption(2));
    const mismatched = pendingReceipt(21);
    owner.observe(9, true, mismatched.receipt);
    await mismatched.complete();
    expect(owner.read('left', 1)).toBeUndefined();

    owner.record(10, 'left', adoption(3));
    const unaccepted = pendingReceipt(22);
    owner.observe(10, false, unaccepted.receipt);
    await unaccepted.complete();
    expect(owner.read('left', 1)).toBeUndefined();

    owner.record(11, 'left', adoption(4));
    const ready = pendingReceipt(23);
    owner.observe(11, true, ready.receipt);
    expect(owner.read('left', 1)).toBeUndefined();
    await ready.complete();
    expect(owner.read('left', 1)).toMatchObject({
      requestRevision: 4,
      frameId: 23,
      deviceGeneration: 1,
      graphGeneration: 2,
      values: { thicknessMeters: 4004 },
    });
    expect(owner.read('right', 1)).toBeUndefined();
  });

  it('retires ready adoption when an accepted pending frame moves or loses the graph identity', async () => {
    const owner = new CloudAdoptionReceipts(() => true);
    const first = pendingReceipt(1);
    owner.record(1, 'left', adoption(1));
    owner.observe(1, true, first.receipt);
    await first.complete();
    expect(owner.read('left', 1)?.frameId).toBe(1);

    const late = pendingReceipt(2);
    owner.record(2, 'left', adoption(2));
    owner.observe(2, true, late.receipt);
    const pending = pendingReceipt(3, { graphGeneration: 3, presentation: 'pending' });
    owner.observe(3, true, pending.receipt);
    expect(owner.read('left', 1)).toBeUndefined();
    await late.complete();
    await pending.complete();
    expect(owner.read('left', 1)).toBeUndefined();

    const next = pendingReceipt(4, { graphGeneration: 3 });
    owner.record(4, 'left', adoption(4));
    owner.observe(4, true, next.receipt);
    await next.complete();
    expect(owner.read('left', 1)?.graphGeneration).toBe(3);

    const unknown = pendingReceipt(5, { presentation: 'pending' });
    const { graphGeneration: _unknown, ...withoutGraph } = unknown.receipt;
    owner.observe(5, true, withoutGraph);
    expect(owner.read('left', 1)).toBeUndefined();
  });

  it('cannot regress to late, failed, retired, or other World observations', async () => {
    let live = true;
    const owner = new CloudAdoptionReceipts(() => live);
    const submit = (frameId: number, options?: Partial<FrameReceipt>, world = 'world') => {
      const frame = pendingReceipt(frameId, options);
      owner.record(frameId, 'left', adoption(frameId, world));
      owner.observe(frameId, true, frame.receipt);
      return frame;
    };
    const earlier = submit(10);
    const newer = submit(11);
    await newer.complete();
    await earlier.complete();
    expect(owner.read('left', 1)?.frameId).toBe(11);

    const failed = submit(12);
    await failed.complete(false);
    expect(owner.read('left', 1)?.frameId).toBe(11);

    const oldGraph = submit(13);
    const newGraph = submit(14, { graphGeneration: 3 });
    expect(owner.read('left', 1)).toBeUndefined();
    await oldGraph.complete();
    expect(owner.read('left', 1)).toBeUndefined();
    await newGraph.complete();
    expect(owner.read('left', 1)?.frameId).toBe(14);

    const newWorld = submit(15, { graphGeneration: 3 }, 'next');
    expect(owner.read('left', 1)).toBeUndefined();
    await newWorld.complete();
    expect(owner.read('left', 1)?.worldIdentity).toBe('next');

    const lost = submit(16, { deviceGeneration: 2 });
    live = false;
    await lost.complete();
    expect(owner.read('left', 2)).toBeUndefined();
    expect(owner.read('left', 1)).toBeUndefined();

    live = true;
    const restored = submit(17, { deviceGeneration: 3 });
    await restored.complete();
    expect(owner.read('left', 3)?.frameId).toBe(17);
    const off = pendingReceipt(18, { deviceGeneration: 3 });
    owner.observe(18, true, off.receipt);
    await off.complete();
    expect(owner.read('left', 3)).toBeUndefined();
  });
});
