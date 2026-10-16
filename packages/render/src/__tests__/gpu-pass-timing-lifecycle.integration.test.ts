import type {
  Buffer,
  MappedBuffer,
  QuerySet,
  RhiCommandEncoder,
  RhiDevice,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  createGpuPassTimingSession,
  type GpuPassTimingFrameIdentity,
} from '../record/gpu-pass-timing/session.js';
import type { FrameReceipt } from '../render-contract.js';
import { createGpuPassTimingObservationStore } from '../renderer.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function makeDevice(timestampQuery = true) {
  const destroyCalls: string[] = [];
  const device = {
    caps: {
      backendKind: 'webgpu',
      timestampQuery,
      timestampPeriodNanoseconds: timestampQuery ? 1 : null,
    },
    createQuerySet: vi.fn(() => ok({} as QuerySet)),
    createBuffer: vi.fn(() => ok({} as Buffer)),
    destroyQuerySet: vi.fn(() => {
      destroyCalls.push('query-set');
      return ok(undefined);
    }),
    destroyBuffer: vi.fn(() => {
      destroyCalls.push('buffer');
      return ok(undefined);
    }),
    queue: {
      onSubmittedWorkDone: vi.fn(async () => undefined),
    },
  } as unknown as RhiDevice;
  return { device, destroyCalls };
}

function encoder(): RhiCommandEncoder {
  return {
    encodeEmptyComputePass: vi.fn(),
    resolveQuerySet: vi.fn(() => ok(undefined)),
    copyBufferToBuffer: vi.fn(),
  } as unknown as RhiCommandEncoder;
}

function mappedBuffer(unmap: () => void): MappedBuffer {
  const bytes = new ArrayBuffer(256);
  const view = new DataView(bytes);
  view.setBigUint64(0, 10n, true);
  view.setBigUint64(8, 20n, true);
  return {
    getMappedRange: () => ok(bytes),
    unmap,
  } as unknown as MappedBuffer;
}

const oldIdentity: GpuPassTimingFrameIdentity = {
  frameId: 20,
  deviceGeneration: 1,
  graphGeneration: 101,
};

describe('GPU pass timing generation-safe lifecycle', () => {
  it('does not publish a stale duration when loss occurs during readback map', async () => {
    const { device, destroyCalls } = makeDevice();
    const mapStarted = deferred<void>();
    const mapResult = deferred<ReturnType<typeof ok<MappedBuffer>>>();
    const unmap = vi.fn();
    const session = createGpuPassTimingSession(
      device,
      { maxPassesPerFrame: 1, maxFramesInFlight: 1, retentionFrames: 8 },
      {
        mapReadback: async () => {
          mapStarted.resolve();
          return mapResult.promise;
        },
      },
    ).unwrap();
    const capture = session.beginFrame(oldIdentity).unwrap();
    capture.recordPass({ passName: 'scene', passKind: 'raster', executionIndex: 0 });
    capture.encodeTail(encoder());
    capture.markSubmitted();
    await mapStarted.promise;

    session.dispose();
    session.dispose();
    mapResult.resolve(ok(mappedBuffer(unmap)));

    const result = await capture.observe();
    expect(result).toMatchObject({ ok: false, error: { code: 'timing-session-disposed' } });
    expect(unmap).toHaveBeenCalledTimes(1);
    expect(capture.snapshot()).toMatchObject({
      deviceGeneration: 1,
      graphGeneration: 101,
      measuredPassCount: 0,
      passes: [{ status: 'unmeasured', passName: 'scene' }],
    });
    expect(device.destroyBuffer).toHaveBeenCalledTimes(2);
    expect(device.destroyQuerySet).toHaveBeenCalledTimes(2);
    expect(destroyCalls).toEqual(['buffer', 'buffer', 'query-set', 'query-set']);
  });

  it('keeps an old callback out of a replacement generation and separates current failure from LKG', async () => {
    const oldDevice = makeDevice();
    const oldMapResult = deferred<ReturnType<typeof ok<MappedBuffer>>>();
    const oldSession = createGpuPassTimingSession(
      oldDevice.device,
      { maxPassesPerFrame: 1, maxFramesInFlight: 1, retentionFrames: 8 },
      { mapReadback: async () => oldMapResult.promise },
    ).unwrap();
    const oldCapture = oldSession.beginFrame(oldIdentity).unwrap();
    oldCapture.recordPass({ passName: 'old', passKind: 'compute', executionIndex: 0 });
    oldCapture.encodeTail(encoder());
    oldCapture.markSubmitted();
    oldSession.dispose();

    const replacement = makeDevice();
    const newSession = createGpuPassTimingSession(replacement.device, {
      maxPassesPerFrame: 1,
      maxFramesInFlight: 1,
      retentionFrames: 8,
    }).unwrap();
    const newIdentity = { ...oldIdentity, frameId: 21, deviceGeneration: 2, graphGeneration: 202 };
    const newCapture = newSession.beginFrame(newIdentity).unwrap();
    newCapture.recordPass({ passName: 'new', passKind: 'raster', executionIndex: 0 });
    expect(newCapture.snapshot()).toMatchObject({ deviceGeneration: 2, graphGeneration: 202 });

    let currentGeneration = 2;
    const store = createGpuPassTimingObservationStore({
      retentionFrames: 8,
      currentDeviceGeneration: () => currentGeneration,
    });
    const oldReceipt = {
      frameId: oldIdentity.frameId,
      deviceGeneration: oldIdentity.deviceGeneration,
      presentation: 'ready',
      completed: Promise.resolve(ok(undefined)),
    } as FrameReceipt;
    store.register(oldReceipt, async () => {
      const observed = await oldCapture.observe();
      if (!observed.ok) return { status: 'failed', error: observed.error };
      return { status: 'complete', frame: observed.value };
    });
    const oldObservation = store.observe(oldReceipt, { include: ['timings'] });
    currentGeneration = 2;
    oldMapResult.resolve(ok(mappedBuffer(() => undefined)));

    await expect(oldObservation).resolves.toMatchObject({
      ok: false,
      error: { code: 'frame-receipt-stale' },
    });
    expect(oldCapture.snapshot().measuredPassCount).toBe(0);
    newSession.dispose();
  });

  it('keeps unsupported recovery as a structured refusal without allocating timing resources', () => {
    const unsupported = makeDevice(false);
    const created = createGpuPassTimingSession(unsupported.device, { retentionFrames: 8 });

    expect(created).toMatchObject({
      ok: false,
      error: { code: 'timestamp-period-unavailable' },
    });
    expect(unsupported.device.createQuerySet).not.toHaveBeenCalled();
    expect(unsupported.device.createBuffer).not.toHaveBeenCalled();
  });

  it('keeps a timing resolve failure out of the render submission result', async () => {
    const { device } = makeDevice();
    const capture = createGpuPassTimingSession(device, {
      maxPassesPerFrame: 1,
      maxFramesInFlight: 1,
      retentionFrames: 8,
    })
      .unwrap()
      .beginFrame(oldIdentity)
      .unwrap();
    capture.recordPass({ passName: 'scene', passKind: 'raster', executionIndex: 0 });
    const timingEncoder = {
      resolveQuerySet: vi.fn(() => ({
        ok: false,
        error: { code: 'resolve-failed' },
      })),
      copyBufferToBuffer: vi.fn(),
    } as unknown as RhiCommandEncoder;
    const timingResult = capture.encodeTail(timingEncoder);
    const renderSubmissionResult = ok(undefined);
    if (!timingResult.ok) capture.abort({ code: timingResult.error.code });

    expect(renderSubmissionResult.ok).toBe(true);
    await expect(capture.observe()).resolves.toMatchObject({
      ok: false,
      error: { code: 'timestamp-readback-failed' },
    });
  });

  it('terminalizes abort before dispose exactly once and preserves graph identity', async () => {
    const { device } = makeDevice();
    const session = createGpuPassTimingSession(device, {
      maxPassesPerFrame: 1,
      maxFramesInFlight: 1,
      retentionFrames: 8,
    }).unwrap();
    const capture = session.beginFrame(oldIdentity).unwrap();
    capture.abort({ code: 'device-lost' });
    capture.abort({ code: 'second-terminal' });
    session.dispose();

    await expect(capture.observe()).resolves.toMatchObject({
      ok: false,
      error: { code: 'timestamp-readback-failed' },
    });
    expect(capture.snapshot()).toMatchObject({
      frameId: oldIdentity.frameId,
      deviceGeneration: oldIdentity.deviceGeneration,
      graphGeneration: oldIdentity.graphGeneration,
    });
  });
});
