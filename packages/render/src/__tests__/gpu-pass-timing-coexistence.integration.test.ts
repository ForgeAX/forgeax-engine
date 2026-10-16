import type { Buffer, QuerySet, RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  createGpuPassTimingSession,
  type GpuPassTimingFrameIdentity,
} from '../record/gpu-pass-timing/session.js';

function makeDevice() {
  const device = {
    caps: {
      backendKind: 'webgpu',
      timestampQuery: true,
      timestampPeriodNanoseconds: 1,
    },
    createQuerySet: vi.fn(() => ok({} as QuerySet)),
    createBuffer: vi.fn(() => ok({} as Buffer)),
    destroyQuerySet: vi.fn(() => ok(undefined)),
    destroyBuffer: vi.fn(() => ok(undefined)),
    queue: { onSubmittedWorkDone: vi.fn(async () => undefined) },
  } as unknown as RhiDevice;
  return device;
}

const identity: GpuPassTimingFrameIdentity = {
  frameId: 3,
  deviceGeneration: 1,
  graphGeneration: 22,
};

describe('GPU pass timing coexistence with producer-owned timestamps', () => {
  it('keeps the producer timestamp owner and reports generic timing as unmeasured', async () => {
    const device = makeDevice();
    const session = createGpuPassTimingSession(device, {
      maxPassesPerFrame: 2,
      maxFramesInFlight: 1,
      retentionFrames: 8,
    }).unwrap();
    const capture = session.beginFrame(identity).unwrap();
    const producerPass = {
      passName: 'cluster-membership-producer',
      passKind: 'compute' as const,
      executionIndex: 0,
    };
    capture.recordPass(producerPass);
    capture.markOwnerConflict(producerPass);

    expect(capture.timestampWrites(producerPass)).toBeUndefined();
    expect(capture.snapshot()).toMatchObject({
      measuredPassCount: 0,
      passes: [
        {
          passName: 'cluster-membership-producer',
          status: 'unmeasured',
          reason: { code: 'timestamp-owner-conflict' },
        },
      ],
    });
    const commandEncoder = {
      encodeEmptyComputePass: vi.fn(),
      resolveQuerySet: vi.fn(() => ok(undefined)),
      copyBufferToBuffer: vi.fn(),
    } as unknown as RhiCommandEncoder;
    expect(capture.encodeTail(commandEncoder)).toMatchObject({ ok: true });
    expect(commandEncoder.resolveQuerySet).not.toHaveBeenCalled();
    expect(commandEncoder.copyBufferToBuffer).not.toHaveBeenCalled();
    capture.markSubmitted();
    expect(device.queue.onSubmittedWorkDone).not.toHaveBeenCalled();
    await expect(capture.observe()).resolves.toMatchObject({
      ok: true,
      value: {
        frameId: 3,
        deviceGeneration: 1,
        graphGeneration: 22,
        passes: [{ passName: 'cluster-membership-producer', executionIndex: 0 }],
      },
    });
    session.dispose();
  });
});
