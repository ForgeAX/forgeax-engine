import { describe, expect, it } from 'vitest';
import type {
  GpuPassTimingFrame,
  GpuPassTimingObservation,
} from '../record/gpu-pass-timing/index.js';
import type { FrameReceipt } from '../render-contract.js';
import { createGpuPassTimingObservationStore, observeGpuPassTimingDisabled } from '../renderer.js';

function receipt(frameId: number): FrameReceipt {
  return {
    frameId,
    deviceGeneration: 3,
    completed: Promise.resolve({ ok: true, value: undefined }),
  } as FrameReceipt;
}

function frame(frameId: number, graphGeneration = frameId): GpuPassTimingFrame {
  return {
    schemaVersion: '1.0',
    frameId,
    deviceGeneration: 3,
    graphGeneration,
    backendKind: 'webgpu',
    timestampPeriodNanoseconds: 1,
    passCapacity: 4,
    executedPassCount: 0,
    measuredPassCount: 0,
    droppedPassCount: 0,
    passes: [],
    measuredPassNanoseconds: 0,
  };
}

function complete(frameId: number, graphGeneration = frameId): GpuPassTimingObservation {
  return { status: 'complete', frame: frame(frameId, graphGeneration) };
}

function partial(frameId: number): GpuPassTimingObservation {
  return {
    status: 'partial',
    frame: frame(frameId),
    reason: {
      code: 'timing-in-flight-exhausted',
      expected: 'a bounded timing slot is available',
      hint: 'observe a later receipt',
      detail: {},
    },
  };
}

describe('receipt-bound GPU pass timing observation', () => {
  it('observes an opt-out receipt without constructing a timing retention store', async () => {
    const current = receipt(6);
    const timingResult = await observeGpuPassTimingDisabled(
      current,
      { include: ['timings'] },
      () => 3,
    );
    const drawResult = await observeGpuPassTimingDisabled(current, { include: ['draws'] }, () => 3);

    expect(timingResult).toMatchObject({
      ok: true,
      value: {
        frameId: 6,
        deviceGeneration: 3,
        timings: { status: 'unavailable', reason: { code: 'gpu-timing-not-enabled' } },
      },
    });
    expect(drawResult).toMatchObject({
      ok: true,
      value: { frameId: 6, deviceGeneration: 3 },
    });
    if (drawResult.ok) expect(drawResult.value).not.toHaveProperty('timings');
  });

  it('keeps receipt, device, and graph identity attached to the requested frame', async () => {
    const store = createGpuPassTimingObservationStore({
      retentionFrames: 8,
      currentDeviceGeneration: () => 3,
    });
    const first = receipt(41);
    const second = receipt(42);
    store.register(first, async () => complete(41, 101));
    store.register(second, async () => complete(42, 102));

    const firstResult = await store.observe(first, { include: ['timings'] });
    const secondResult = await store.observe(second, { include: ['timings'] });

    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    if (!firstResult.ok || !secondResult.ok) return;
    expect(firstResult.value).toMatchObject({
      frameId: 41,
      deviceGeneration: 3,
      timings: { status: 'complete', frame: { frameId: 41, graphGeneration: 101 } },
    });
    expect(secondResult.value).toMatchObject({
      frameId: 42,
      timings: { status: 'complete', frame: { frameId: 42, graphGeneration: 102 } },
    });
  });

  it('does not materialize timings or activate a future frame when timings are omitted', async () => {
    const store = createGpuPassTimingObservationStore({
      retentionFrames: 8,
      currentDeviceGeneration: () => 3,
    });
    const current = receipt(7);
    let sourceCalls = 0;
    store.register(current, async () => {
      sourceCalls += 1;
      return complete(7);
    });

    const result = await store.observe(current, { include: ['draws'] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty('timings');
    expect(sourceCalls).toBe(0);
  });

  it('waits only for the requested receipt when receipts complete concurrently', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstCompleted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondCompleted = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const first = {
      ...receipt(1),
      completed: firstCompleted.then(() => ({ ok: true, value: undefined })),
    } as FrameReceipt;
    const second = {
      ...receipt(2),
      completed: secondCompleted.then(() => ({ ok: true, value: undefined })),
    } as FrameReceipt;
    const store = createGpuPassTimingObservationStore({
      retentionFrames: 8,
      currentDeviceGeneration: () => 3,
    });
    let firstSourceCalls = 0;
    let secondSourceCalls = 0;
    store.register(first, async () => {
      firstSourceCalls += 1;
      return complete(1);
    });
    store.register(second, async () => {
      secondSourceCalls += 1;
      return complete(2);
    });

    const firstObservation = store.observe(first, { include: ['timings'] });
    const secondObservation = store.observe(second, { include: ['timings'] });
    releaseSecond();
    const secondResult = await secondObservation;
    expect(secondResult.ok).toBe(true);
    expect(firstSourceCalls).toBe(0);
    expect(secondSourceCalls).toBe(1);
    releaseFirst();
    expect((await firstObservation).ok).toBe(true);
  });

  it('surfaces not-enabled, unsupported, complete, partial, and failed statuses', async () => {
    const store = createGpuPassTimingObservationStore({
      retentionFrames: 8,
      currentDeviceGeneration: () => 3,
    });
    const notEnabled = receipt(1);
    const unsupported = receipt(2);
    const completeReceipt = receipt(3);
    const partialReceipt = receipt(4);
    const failedReceipt = receipt(5);
    store.register(notEnabled);
    store.register(unsupported, async () => ({
      status: 'unavailable',
      reason: {
        code: 'timestamp-query-unsupported',
        expected: 'the active device exposes timestamp-query',
        hint: 'use a backend that supports timestamp-query',
        detail: {},
      },
      capability: { timestampQuery: false, timestampPeriodNanoseconds: null },
    }));
    store.register(completeReceipt, async () => complete(3));
    store.register(partialReceipt, async () => partial(4));
    store.register(failedReceipt, async () => ({
      status: 'failed',
      error: {
        code: 'timestamp-readback-failed',
        expected: 'the resolved timing buffer can be read',
        hint: 'observe a later receipt',
        detail: {},
      },
    }));

    const results = await Promise.all(
      [notEnabled, unsupported, completeReceipt, partialReceipt, failedReceipt].map((item) =>
        store.observe(item, { include: ['timings'] }),
      ),
    );

    expect(results.map((result) => (result.ok ? result.value.timings?.status : 'error'))).toEqual([
      'unavailable',
      'unavailable',
      'complete',
      'partial',
      'failed',
    ]);
  });

  it('returns a bounded retention failure after the receipt leaves the ring', async () => {
    const store = createGpuPassTimingObservationStore({
      retentionFrames: 2,
      currentDeviceGeneration: () => 3,
    });
    const expired = receipt(1);
    store.register(expired, async () => complete(1));
    store.register(receipt(2), async () => complete(2));
    store.register(receipt(3), async () => complete(3));

    const result = await store.observe(expired, { include: ['timings'] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.timings).toMatchObject({
      status: 'failed',
      error: { code: 'timing-retention-expired' },
    });
  });
});
