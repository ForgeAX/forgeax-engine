import { describe, expect, it, vi } from 'vitest';
import {
  beginClusterWorkConformanceFrame,
  type ClusterWorkConformanceState,
  readClusterWorkFrameTrace,
  readClusterWorkObservation,
  recordClusterWorkFrameReceiptForConformance,
  setClusterWorkConformanceEnabled,
  settleClusterWorkConformanceFrame,
} from '../../../../render/src/record/cluster-work-conformance';
import {
  assertForwardGtaoLinearCaptureJoin,
  captureForwardGtaoTarget,
  type ForwardGtaoCaptureHost,
  ForwardGtaoCaptureNotReadyError,
  type ForwardGtaoCompletedReceipt,
  type ForwardGtaoFrameTrace,
  type ForwardGtaoLinearCapture,
  type ForwardGtaoLinearCaptureWorkRow,
  stableForwardGtaoGraphTargetProjection,
} from './forward-gtao-capture';

interface FakeGraphTarget {
  readonly name: 'ssao-raw';
  readonly texture: object;
  readonly textureIdentity: number;
  readonly descriptor: {
    readonly format: 'rgba8unorm';
    readonly size: { readonly width: 1; readonly height: 1 };
    readonly usage: number;
    readonly sample: number;
  };
  readonly recordFrameNumber: number;
  readonly graphGeneration: number;
}

interface ScriptedFrame {
  readonly recordFrameNumber: number;
  readonly publicReceiptFrameId: number;
  readonly presentation?: 'ready' | 'pending';
  readonly completion?: 'pending' | 'completed';
  readonly graphGeneration?: number;
  readonly textureIdentity?: number;
  readonly encoded?: boolean;
  readonly completed?: Promise<unknown>;
}

function target(
  recordFrameNumber: number,
  graphGeneration = 1,
  textureIdentity = 101,
): FakeGraphTarget {
  return {
    name: 'ssao-raw',
    texture: {},
    textureIdentity,
    descriptor: {
      format: 'rgba8unorm',
      size: { width: 1, height: 1 },
      usage: 1,
      sample: 1,
    },
    recordFrameNumber,
    graphGeneration,
  };
}

function fakeHost(initialTarget: FakeGraphTarget) {
  let currentTarget = initialTarget;
  let currentTrace: ForwardGtaoFrameTrace | undefined;
  const mappedRange = new ArrayBuffer(256);
  const mappedBuffer = {
    getMappedRange: vi.fn(() => ({ ok: true as const, value: mappedRange })),
    unmap: vi.fn(),
  };
  const buffers: { readonly mapAsync: ReturnType<typeof vi.fn> }[] = [];
  const createBuffer = vi.fn(() => {
    const buffer = {
      mapAsync: vi.fn(async () => ({ ok: true as const, value: mappedBuffer })),
    };
    buffers.push(buffer);
    return { ok: true as const, value: buffer };
  });
  const requestGraphTargetCapture = vi.fn();
  const cancelGraphTargetCapture = vi.fn();
  const host = {
    getCurrentGraphTarget: vi.fn(() => currentTarget),
    requestGraphTargetCapture,
    cancelGraphTargetCapture,
    clusterWorkFrameTraceForConformance: vi.fn(() => currentTrace),
    device: {
      createBuffer,
      queue: { onSubmittedWorkDone: vi.fn(async () => undefined) },
      destroyBuffer: vi.fn(async () => ({ ok: true as const, value: undefined })),
    },
  } as unknown as ForwardGtaoCaptureHost;
  return {
    host,
    createBuffer,
    buffers,
    mappedBuffer,
    requestGraphTargetCapture,
    cancelGraphTargetCapture,
    setCurrentTarget(next: FakeGraphTarget) {
      currentTarget = next;
    },
    setCurrentTrace(next: ForwardGtaoFrameTrace) {
      currentTrace = next;
    },
    draw: (frames: readonly ScriptedFrame[]) => {
      let index = 0;
      return async (): Promise<ForwardGtaoCompletedReceipt> => {
        const frame = frames[index];
        if (frame === undefined) throw new Error(`unexpected draw attempt ${index + 1}`);
        index += 1;
        const graphGeneration = frame.graphGeneration ?? 1;
        const textureIdentity = frame.textureIdentity ?? 101;
        currentTarget = target(frame.recordFrameNumber, graphGeneration, textureIdentity);
        currentTrace = trace({ ...frame, graphGeneration, textureIdentity });
        return {
          frameId: frame.publicReceiptFrameId,
          deviceGeneration: 3,
          presentation: frame.presentation ?? 'ready',
          completed: frame.completed ?? Promise.resolve({ ok: true, value: undefined }),
        };
      };
    },
  };
}

function trace(
  input: ScriptedFrame & {
    readonly graphGeneration: number;
    readonly textureIdentity: number;
  },
): ForwardGtaoFrameTrace {
  const ready = (input.presentation ?? 'ready') === 'ready';
  return {
    recordFrameNumber: input.recordFrameNumber,
    observationFrameId: input.publicReceiptFrameId,
    recordStatus: ready ? 'submitted' : 'pending',
    graphGeneration: input.graphGeneration,
    ...(input.encoded !== undefined
      ? {
          graphTargetCopy: {
            targetName: 'ssao-raw',
            recordFrameNumber: input.recordFrameNumber,
            expectedIdentity: {
              graphGeneration: input.graphGeneration,
              recordFrameNumber: input.recordFrameNumber,
              textureIdentity: input.textureIdentity,
            },
            actualIdentity: {
              graphGeneration: input.graphGeneration,
              recordFrameNumber: input.recordFrameNumber,
              textureIdentity: input.textureIdentity,
            },
            encoded: input.encoded,
          },
        }
      : {}),
    receipt: {
      publicReceiptFrameId: input.publicReceiptFrameId,
      deviceGeneration: 3,
      presentation: input.presentation ?? 'ready',
      completion: input.completion ?? 'completed',
    },
  };
}

describe('captureForwardGtaoTarget provenance', () => {
  it('prepares a ready target before arming the one-shot copy', async () => {
    const fixture = fakeHost(target(20));
    const capture = captureForwardGtaoTarget(
      fixture.host,
      'ssao-raw',
      fixture.draw([
        { recordFrameNumber: 21, publicReceiptFrameId: 1 },
        { recordFrameNumber: 22, publicReceiptFrameId: 2, encoded: true },
      ]),
    );

    await expect(capture).resolves.toMatchObject({
      targetRecordFrameNumber: 22,
      publicReceiptFrameId: 2,
      preparation: {
        recordFrameNumber: 21,
        publicReceiptFrameId: 1,
        graphGeneration: 1,
        textureIdentity: 101,
        descriptor: {
          format: 'rgba8unorm',
          size: { width: 1, height: 1 },
          usage: 1,
          sample: 1,
        },
      },
      frameTrace: { recordFrameNumber: 22, receipt: { publicReceiptFrameId: 2 } },
    });
    expect(fixture.requestGraphTargetCapture).toHaveBeenCalledTimes(1);
    expect(fixture.requestGraphTargetCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        expected: expect.objectContaining({
          identity: { graphGeneration: 1, recordFrameNumber: 22, textureIdentity: 101 },
        }),
      }),
    );
  });

  it('rejects a generation or texture replacement during the one-shot copy', async () => {
    const fixture = fakeHost(target(20));
    const capture = captureForwardGtaoTarget(
      fixture.host,
      'ssao-raw',
      fixture.draw([
        {
          recordFrameNumber: 21,
          publicReceiptFrameId: 40,
          graphGeneration: 2,
          textureIdentity: 202,
        },
        {
          recordFrameNumber: 22,
          publicReceiptFrameId: 7,
          graphGeneration: 3,
          textureIdentity: 303,
          encoded: true,
        },
      ]),
    );

    await expect(capture).rejects.toThrow(/graph target changed/);
    expect(fixture.requestGraphTargetCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        expected: expect.objectContaining({
          identity: { graphGeneration: 2, recordFrameNumber: 22, textureIdentity: 202 },
        }),
      }),
    );
    expect(fixture.buffers[0]?.mapAsync).not.toHaveBeenCalled();
    expect(fixture.host.device.destroyBuffer).toHaveBeenCalledTimes(1);
  });

  it('rejects a skipped local frame and does not equate local and public IDs', async () => {
    const fixture = fakeHost(target(20));
    const capture = captureForwardGtaoTarget(
      fixture.host,
      'ssao-raw',
      fixture.draw([
        { recordFrameNumber: 21, publicReceiptFrameId: 500 },
        { recordFrameNumber: 23, publicReceiptFrameId: 12, encoded: true },
      ]),
    );

    await expect(capture).rejects.toThrow(/graph target changed/);
    expect(fixture.buffers[0]?.mapAsync).not.toHaveBeenCalled();
  });

  it('requires a ready completed preparation receipt before allocating capture resources', async () => {
    const fixture = fakeHost(target(20));
    const capture = captureForwardGtaoTarget(
      fixture.host,
      'ssao-raw',
      fixture.draw([
        {
          recordFrameNumber: 21,
          publicReceiptFrameId: 99,
          presentation: 'pending',
          completion: 'completed',
        },
      ]),
    );

    await expect(capture).rejects.toBeInstanceOf(ForwardGtaoCaptureNotReadyError);
    expect(fixture.createBuffer).not.toHaveBeenCalled();
    expect(fixture.requestGraphTargetCapture).not.toHaveBeenCalled();
  });

  it('waits for preparation and copy receipt completion before readback', async () => {
    const fixture = fakeHost(target(20));
    let finishPreparation: (value: unknown) => void = () => {};
    let finishCopy: (value: unknown) => void = () => {};
    const preparationCompleted = new Promise<unknown>((resolve) => {
      finishPreparation = resolve;
    });
    const copyCompleted = new Promise<unknown>((resolve) => {
      finishCopy = resolve;
    });
    const draw = fixture.draw([
      { recordFrameNumber: 21, publicReceiptFrameId: 40, completed: preparationCompleted },
      {
        recordFrameNumber: 22,
        publicReceiptFrameId: 3,
        encoded: true,
        completed: copyCompleted,
      },
    ]);
    const capture = captureForwardGtaoTarget(fixture.host, 'ssao-raw', draw);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fixture.createBuffer).not.toHaveBeenCalled();
    expect(fixture.requestGraphTargetCapture).not.toHaveBeenCalled();
    finishPreparation({ ok: true, value: undefined });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fixture.requestGraphTargetCapture).toHaveBeenCalledTimes(1);
    expect(fixture.buffers[0]?.mapAsync).not.toHaveBeenCalled();
    finishCopy({ ok: true, value: undefined });

    await expect(capture).resolves.toMatchObject({
      targetRecordFrameNumber: 22,
      publicReceiptFrameId: 3,
      preparation: {
        recordFrameNumber: 21,
        publicReceiptFrameId: 40,
      },
    });
    expect(fixture.buffers[0]?.mapAsync).toHaveBeenCalledTimes(1);
  });

  it('uses a fresh request and buffer after a non-ready copy attempt', async () => {
    const fixture = fakeHost(target(10));
    const pending = captureForwardGtaoTarget(
      fixture.host,
      'ssao-raw',
      fixture.draw([
        { recordFrameNumber: 11, publicReceiptFrameId: 90 },
        {
          recordFrameNumber: 12,
          publicReceiptFrameId: 4,
          presentation: 'pending',
          completion: 'completed',
        },
      ]),
    );
    await expect(pending).rejects.toBeInstanceOf(ForwardGtaoCaptureNotReadyError);

    const ready = captureForwardGtaoTarget(
      fixture.host,
      'ssao-raw',
      fixture.draw([
        { recordFrameNumber: 13, publicReceiptFrameId: 300 },
        { recordFrameNumber: 14, publicReceiptFrameId: 1, encoded: true },
      ]),
    );
    await expect(ready).resolves.toMatchObject({
      targetRecordFrameNumber: 14,
      publicReceiptFrameId: 1,
    });
    expect(fixture.createBuffer).toHaveBeenCalledTimes(2);
    expect(fixture.buffers[0]).not.toBe(fixture.buffers[1]);
    expect(fixture.requestGraphTargetCapture).toHaveBeenCalledTimes(2);
    const firstRequest = fixture.requestGraphTargetCapture.mock.calls[0]?.[0];
    const secondRequest = fixture.requestGraphTargetCapture.mock.calls[1]?.[0];
    expect(firstRequest).not.toBe(secondRequest);
    expect(firstRequest?.buffer).not.toBe(secondRequest?.buffer);
    expect(fixture.cancelGraphTargetCapture).toHaveBeenCalledTimes(2);
  });
});

describe('stableForwardGtaoGraphTargetProjection', () => {
  it('ignores per-frame record numbers while retaining every resource identity field', () => {
    const base = {
      name: 'ssao-raw',
      recordFrameNumber: 20,
      graphGeneration: 3,
      textureIdentity: 101,
      descriptor: {
        format: 'rgba8unorm',
        size: { width: 23, height: 17 },
        usage: 19,
        sample: 1,
      },
    } as const;
    const expected = stableForwardGtaoGraphTargetProjection(base);

    expect(stableForwardGtaoGraphTargetProjection({ ...base, recordFrameNumber: 21 })).toEqual(
      expected,
    );
    expect(expected).toEqual({
      name: 'ssao-raw',
      graphGeneration: 3,
      textureIdentity: 101,
      descriptor: {
        format: 'rgba8unorm',
        size: { width: 23, height: 17 },
        usage: 19,
        sample: 1,
      },
    });

    const changed = [
      { ...base, name: 'ssao-blurred' },
      { ...base, graphGeneration: 4 },
      { ...base, textureIdentity: 102 },
      { ...base, descriptor: { ...base.descriptor, format: 'r8unorm' } },
      {
        ...base,
        descriptor: {
          ...base.descriptor,
          size: { ...base.descriptor.size, width: 24 },
        },
      },
      {
        ...base,
        descriptor: {
          ...base.descriptor,
          size: { ...base.descriptor.size, height: 18 },
        },
      },
      { ...base, descriptor: { ...base.descriptor, usage: 23 } },
      { ...base, descriptor: { ...base.descriptor, sample: 4 } },
    ];
    for (const target of changed) {
      expect(stableForwardGtaoGraphTargetProjection(target)).not.toEqual(expected);
    }
  });
});

describe('assertForwardGtaoLinearCaptureJoin', () => {
  type CapturedTraceSample = Extract<
    NonNullable<ForwardGtaoFrameTrace['clusterWork']>,
    { readonly status: 'captured' }
  >;

  const noSampleFixture = () => {
    const frameTrace: ForwardGtaoFrameTrace = {
      recordFrameNumber: 2,
      observationFrameId: 3,
      recordStatus: 'submitted',
      deviceGeneration: 0,
      receipt: {
        publicReceiptFrameId: 3,
        deviceGeneration: 0,
        presentation: 'ready',
        completion: 'completed',
      },
    };
    const capture: ForwardGtaoLinearCapture = {
      receipt: {
        frameId: 3,
        deviceGeneration: 0,
        presentation: 'ready',
        graphGeneration: 3,
        completion: 'completed',
      },
      frameId: 3,
      deviceGeneration: 0,
      graphGeneration: 3,
      textureIdentity: 31,
      readbackIdentity: 35,
      format: 'rgba16float',
      width: 1,
      height: 1,
      bytesPerRow: 8,
      bytes: new Uint8Array(8),
      gpuTimings: undefined,
      draws: undefined,
    };
    const workRow: ForwardGtaoLinearCaptureWorkRow = {
      receiptFrameId: 3,
      deviceGeneration: 0,
      receiptPresentation: 'ready',
      recordFrameNumber: 2,
      observationFrameId: 3,
      observation: { status: 'unavailable', reason: 'awaiting-write' },
      frameTrace,
    };
    return { capture, frameTrace, workRow };
  };

  const requiredFixture = () => {
    const sample: CapturedTraceSample = {
      status: 'captured' as const,
      frameNumber: 2,
      viewEntityKey: 9,
      deviceGeneration: 0,
      graphGeneration: 3,
      clusterTransportGeneration: 1,
      clusterUsedRows: 1,
      clusterRowBytes: 16,
      transport: 'storage-buffer' as const,
      scope: 'light-data-buffer' as const,
      packedLightSlots: 1,
      acceptedWriteBytes: 16,
      writeSucceeded: true,
      invocations: 1,
    };
    const frameTrace: ForwardGtaoFrameTrace = {
      recordFrameNumber: 2,
      observationFrameId: 3,
      recordStatus: 'submitted',
      deviceGeneration: 0,
      graphGeneration: 3,
      clusterWork: sample,
      receipt: {
        publicReceiptFrameId: 3,
        deviceGeneration: 0,
        presentation: 'ready',
        completion: 'completed',
      },
    };
    const capture: ForwardGtaoLinearCapture = {
      receipt: {
        frameId: 3,
        deviceGeneration: 0,
        presentation: 'ready',
        graphGeneration: 3,
        completion: 'completed',
      },
      frameId: 3,
      deviceGeneration: 0,
      graphGeneration: 3,
      textureIdentity: 31,
      readbackIdentity: 35,
      format: 'rgba16float',
      width: 1,
      height: 1,
      bytesPerRow: 8,
      bytes: new Uint8Array(8),
      gpuTimings: undefined,
      draws: undefined,
    };
    const workRow: ForwardGtaoLinearCaptureWorkRow = {
      receiptFrameId: 3,
      deviceGeneration: 0,
      receiptPresentation: 'ready',
      recordFrameNumber: 2,
      observationFrameId: 3,
      observation: { ...sample, invocations: 1 },
      frameTrace,
    };
    return { capture, frameTrace, workRow };
  };

  it('accepts a real completed no-sample receipt trace without a Cluster graph generation', async () => {
    const fixture = noSampleFixture();
    const state: ClusterWorkConformanceState = { enabled: false };
    setClusterWorkConformanceEnabled(state, true);
    beginClusterWorkConformanceFrame(state, 2, 3);
    settleClusterWorkConformanceFrame(state, 2, 'submitted');
    const completed = Promise.resolve({ ok: true, value: undefined });
    expect(
      recordClusterWorkFrameReceiptForConformance(state, {
        observationFrameId: 3,
        publicReceiptFrameId: 3,
        deviceGeneration: 0,
        presentation: 'ready',
        completed,
      }),
    ).toBe(true);
    await completed;
    await Promise.resolve();
    const frameTrace = readClusterWorkFrameTrace(state);
    const observation = readClusterWorkObservation(state, 0);
    if (frameTrace === undefined || observation === undefined) {
      throw new Error('completed no-sample conformance trace was not published');
    }
    expect(frameTrace).toMatchObject({
      recordFrameNumber: 2,
      observationFrameId: 3,
      recordStatus: 'submitted',
      deviceGeneration: 0,
      receipt: { publicReceiptFrameId: 3, presentation: 'ready', completion: 'completed' },
    });
    expect(frameTrace.graphGeneration).toBeUndefined();
    expect(frameTrace.clusterWork).toBeUndefined();
    const workRow: ForwardGtaoLinearCaptureWorkRow = {
      ...fixture.workRow,
      observation,
      frameTrace,
    };
    expect(() =>
      assertForwardGtaoLinearCaptureJoin({
        transport: 'not-required',
        capture: fixture.capture,
        frameTrace,
        workRow,
      }),
    ).not.toThrow();
  });

  it('requires a captured Cluster sample and matching generation when work is required', () => {
    const fixture = requiredFixture();
    expect(() =>
      assertForwardGtaoLinearCaptureJoin({ transport: 'required', ...fixture }),
    ).not.toThrow();
  });

  it.each<Partial<CapturedTraceSample>>([
    { viewEntityKey: 10 },
    { clusterTransportGeneration: 2 },
    { clusterUsedRows: 2 },
    { clusterRowBytes: 32 },
    { transport: 'cpu-texture' },
    { scope: 'cluster-texture-host-regions' },
    { packedLightSlots: 2 },
    { acceptedWriteBytes: 32 },
    { writeSucceeded: false },
    { errorCode: 'write-failed' },
    { invocations: 2 },
  ])('rejects a required observation that disagrees with its trace: %j', (change) => {
    const fixture = requiredFixture();
    const observation = fixture.workRow.observation;
    if (observation.status !== 'captured') throw new Error('expected captured fixture');
    const workRow = { ...fixture.workRow, observation: { ...observation, ...change } };
    expect(() =>
      assertForwardGtaoLinearCaptureJoin({ transport: 'required', ...fixture, workRow }),
    ).toThrow(/mismatched completed receipt evidence/);
  });

  it('rejects differing invocation counts between the current and receipt-bound traces', () => {
    const fixture = requiredFixture();
    const sample = fixture.frameTrace.clusterWork;
    if (sample?.status !== 'captured') throw new Error('expected captured fixture');
    const frameTrace = {
      ...fixture.frameTrace,
      clusterWork: { ...sample, invocations: 2 },
    };
    expect(() =>
      assertForwardGtaoLinearCaptureJoin({ transport: 'required', ...fixture, frameTrace }),
    ).toThrow(/mismatched completed receipt evidence/);
  });

  type JoinInput = Parameters<typeof assertForwardGtaoLinearCaptureJoin>[0];
  const invalidInputs: readonly { readonly name: string; readonly input: JoinInput }[] = [
    (() => {
      const fixture = requiredFixture();
      const { clusterWork: _sample, ...frameTrace } = fixture.frameTrace;
      const invalidTrace: ForwardGtaoFrameTrace = frameTrace;
      const workRow: ForwardGtaoLinearCaptureWorkRow = {
        ...fixture.workRow,
        observation: { status: 'unavailable', reason: 'awaiting-write' },
        frameTrace: invalidTrace,
      };
      return {
        name: 'required missing sample',
        input: {
          transport: 'required',
          capture: fixture.capture,
          frameTrace: invalidTrace,
          workRow,
        },
      };
    })(),
    (() => {
      const fixture = requiredFixture();
      const { graphGeneration: _generation, ...frameTrace } = fixture.frameTrace;
      const invalidTrace: ForwardGtaoFrameTrace = frameTrace;
      const workRow: ForwardGtaoLinearCaptureWorkRow = {
        ...fixture.workRow,
        frameTrace: invalidTrace,
      };
      return {
        name: 'required missing graph generation',
        input: {
          transport: 'required',
          capture: fixture.capture,
          frameTrace: invalidTrace,
          workRow,
        },
      };
    })(),
    (() => {
      const fixture = noSampleFixture();
      const receipt = fixture.frameTrace.receipt;
      if (receipt === undefined) throw new Error('no-sample fixture must include a receipt');
      const frameTrace: ForwardGtaoFrameTrace = {
        ...fixture.frameTrace,
        receipt: { ...receipt, publicReceiptFrameId: 4 },
      };
      return {
        name: 'wrong public frame',
        input: { transport: 'not-required', ...fixture, frameTrace },
      };
    })(),
    (() => {
      const fixture = noSampleFixture();
      const workRow: ForwardGtaoLinearCaptureWorkRow = {
        ...fixture.workRow,
        recordFrameNumber: 4,
      };
      return {
        name: 'wrong record frame',
        input: { transport: 'not-required', ...fixture, workRow },
      };
    })(),
    (() => {
      const fixture = noSampleFixture();
      const frameTrace: ForwardGtaoFrameTrace = { ...fixture.frameTrace, deviceGeneration: 1 };
      return {
        name: 'wrong device generation',
        input: { transport: 'not-required', ...fixture, frameTrace },
      };
    })(),
    (() => {
      const fixture = noSampleFixture();
      const receipt = fixture.frameTrace.receipt;
      if (receipt === undefined) throw new Error('no-sample fixture must include a receipt');
      const frameTrace: ForwardGtaoFrameTrace = {
        ...fixture.frameTrace,
        receipt: { ...receipt, presentation: 'pending' },
      };
      return {
        name: 'not-ready receipt',
        input: { transport: 'not-required', ...fixture, frameTrace },
      };
    })(),
    (() => {
      const fixture = noSampleFixture();
      const receipt = fixture.frameTrace.receipt;
      if (receipt === undefined) throw new Error('no-sample fixture must include a receipt');
      const frameTrace: ForwardGtaoFrameTrace = {
        ...fixture.frameTrace,
        receipt: { ...receipt, completion: 'pending' },
      };
      return {
        name: 'not-completed receipt',
        input: { transport: 'not-required', ...fixture, frameTrace },
      };
    })(),
    (() => {
      const fixture = requiredFixture();
      const originalSample = fixture.frameTrace.clusterWork;
      if (originalSample?.status !== 'captured') {
        throw new Error('required fixture must include a captured Cluster sample');
      }
      const sample: CapturedTraceSample = { ...originalSample, graphGeneration: 4 };
      const frameTrace: ForwardGtaoFrameTrace = {
        ...fixture.frameTrace,
        graphGeneration: 4,
        clusterWork: sample,
      };
      const workRow: ForwardGtaoLinearCaptureWorkRow = {
        ...fixture.workRow,
        observation: { ...sample, invocations: 1 },
        frameTrace,
      };
      return {
        name: 'required wrong graph generation',
        input: { transport: 'required', capture: fixture.capture, frameTrace, workRow },
      };
    })(),
    (() => {
      const fixture = noSampleFixture();
      const clusterWork = {
        status: 'captured' as const,
        frameNumber: 2,
        viewEntityKey: 9,
        deviceGeneration: 0,
        graphGeneration: 3,
        clusterTransportGeneration: 1,
        transport: 'storage-buffer' as const,
        scope: 'light-data-buffer' as const,
        packedLightSlots: 0,
        acceptedWriteBytes: 0,
        writeSucceeded: true,
        invocations: 1,
      };
      const frameTrace: ForwardGtaoFrameTrace = { ...fixture.frameTrace, clusterWork };
      const workRow: ForwardGtaoLinearCaptureWorkRow = { ...fixture.workRow, frameTrace };
      return {
        name: 'not-required Cluster work',
        input: { transport: 'not-required', ...fixture, frameTrace, workRow },
      };
    })(),
    (() => {
      const fixture = noSampleFixture();
      const frameTrace: ForwardGtaoFrameTrace = { ...fixture.frameTrace, graphGeneration: 4 };
      const workRow: ForwardGtaoLinearCaptureWorkRow = { ...fixture.workRow, frameTrace };
      return {
        name: 'not-required wrong supplied graph',
        input: { transport: 'not-required', ...fixture, frameTrace, workRow },
      };
    })(),
    (() => {
      const fixture = noSampleFixture();
      const capture: ForwardGtaoLinearCapture = {
        ...fixture.capture,
        receipt: { ...fixture.capture.receipt, graphGeneration: 4 },
      };
      return {
        name: 'receipt and linear attachment graph mismatch',
        input: { transport: 'not-required', ...fixture, capture },
      };
    })(),
  ];

  it.each(invalidInputs)('rejects $name', ({ input }) => {
    expect(() => assertForwardGtaoLinearCaptureJoin(input)).toThrow(
      /mismatched completed receipt evidence/,
    );
  });
});
