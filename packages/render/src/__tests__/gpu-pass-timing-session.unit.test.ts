import type {
  Buffer,
  MappedBuffer,
  QuerySet,
  RhiCommandEncoder,
  RhiDevice,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { gpuPassFrameMilliseconds } from '../pipeline/dynamic-resolution';
import type { GpuPassTimingOptions } from '../record/gpu-pass-timing/contract';
import { createPassTimingInstrumentation } from '../record/gpu-pass-timing/instrumentation';
import {
  createGpuPassTimingSession as createTimingSession,
  type GpuPassTimingCapture,
  type GpuPassTimingSessionOptions,
} from '../record/gpu-pass-timing/session.js';

function createGpuPassTimingSession(
  device: RhiDevice,
  options: GpuPassTimingOptions = {},
  sessionOptions: GpuPassTimingSessionOptions = {},
) {
  return createTimingSession(device, options, {
    shaderModuleFactory: { createShaderModule: () => ok({} as ShaderModule) },
    ...sessionOptions,
  });
}

function makeDevice() {
  const calls: string[] = [];
  const buffers: Array<{ size: number; usage: number }> = [];
  const device = {
    caps: {
      backendKind: 'webgpu',
      timestampQuery: true,
      timestampPeriodNanoseconds: 1,
    },
    createBindGroupLayout: vi.fn(() => ok({} as never)),
    createBindGroup: vi.fn(() => ok({} as never)),
    createPipelineLayout: vi.fn(() => ok({} as never)),
    createComputePipeline: vi.fn(() => ok({} as never)),
    createQuerySet: vi.fn(() => {
      calls.push('create-query-set');
      return { ok: true, value: {} as QuerySet };
    }),
    createBuffer: vi.fn((descriptor: { size: number; usage: number }) => {
      buffers.push(descriptor);
      calls.push('create-buffer');
      return { ok: true, value: {} as Buffer };
    }),
    destroyQuerySet: vi.fn(() => {
      calls.push('destroy-query-set');
      return { ok: true, value: undefined };
    }),
    destroyBuffer: vi.fn(() => {
      calls.push('destroy-buffer');
      return { ok: true, value: undefined };
    }),
    queue: {
      onSubmittedWorkDone: vi.fn(async () => undefined),
    },
  } as unknown as RhiDevice;
  return { calls, buffers, device };
}

function encoder() {
  return {
    resolveQuerySet: vi.fn(() => ({ ok: true, value: undefined })),
    copyBufferToBuffer: vi.fn(),
    beginComputePass: vi.fn(() => ({
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      end: vi.fn(),
    })),
  } as unknown as RhiCommandEncoder;
}

const identity = {
  frameId: 12,
  deviceGeneration: 3,
  graphGeneration: 4,
};

describe('GPU pass timing session', () => {
  it('allocates marker work only for copies, reuses it and releases its private buffer once', () => {
    const { device, buffers } = makeDevice();
    const session = createGpuPassTimingSession(device, { maxFramesInFlight: 1 }).unwrap();
    const first = session.beginFrame(identity).unwrap();
    first.recordPass({ passName: 'scene', passKind: 'raster', executionIndex: 0 });
    first.abort();
    expect(device.createComputePipeline).not.toHaveBeenCalled();
    expect(buffers).toHaveLength(2);
    for (let frameId = 20; frameId < 22; frameId += 1) {
      const capture = session.beginFrame({ ...identity, frameId }).unwrap();
      const copy = { passName: 'copy', passKind: 'copy' as const, executionIndex: 0 };
      capture.recordPass(copy);
      const commandEncoder = encoder();
      capture.copyBoundaryBefore(copy, commandEncoder);
      capture.copyBoundaryAfter(copy, commandEncoder);
      expect(commandEncoder.beginComputePass).toHaveBeenCalledTimes(2);
      const passes = (commandEncoder.beginComputePass as ReturnType<typeof vi.fn>).mock.results;
      for (const pass of passes) {
        expect(pass.value.dispatchWorkgroups).toHaveBeenCalledWith(1);
        expect(pass.value.end).toHaveBeenCalledTimes(1);
      }
      capture.abort();
    }
    expect(device.createComputePipeline).toHaveBeenCalledTimes(1);
    expect(buffers).toHaveLength(3);
    expect(buffers[2]).toEqual({ size: 4, usage: 0x80 });
    session.dispose();
    session.dispose();
    expect(device.destroyBuffer).toHaveBeenCalledTimes(3);
  });

  it('records two views and composition in one capture with independent DRS intervals', async () => {
    const { device } = makeDevice();
    const session = createGpuPassTimingSession(
      device,
      { maxPassesPerFrame: 8 },
      {
        mapReadback: async () =>
          ok({
            getMappedRange: (_offset: number, size: number) => {
              const bytes = new ArrayBuffer(size);
              new BigUint64Array(bytes).set([
                1000000n,
                3000000n,
                5000000n,
                11000000n,
                13000000n,
                14000000n,
              ]);
              return ok(bytes);
            },
            unmap() {},
          } as MappedBuffer),
      },
    ).unwrap();
    const capture = session.beginFrame(identity).unwrap();
    for (const viewId of [11, 22, undefined]) {
      const instrumentation = createPassTimingInstrumentation(capture, viewId);
      instrumentation.begin(
        {
          name: viewId === undefined ? 'camera-view-composite' : 'main',
          kind: 'raster',
          executionIndex: 0,
        } as never,
        {} as never,
      );
    }
    expect(capture.nextExecutionIndex).toBe(3);
    capture.encodeTail(encoder(), 42).unwrap();
    capture.markSubmitted(Promise.resolve());
    const frame = (await capture.observe()).unwrap();
    expect(frame.frameId).toBe(identity.frameId);
    expect(frame.graphGeneration).toBe(42);
    expect(frame.passes.map((pass) => [pass.viewId, pass.executionIndex])).toEqual([
      [11, 0],
      [22, 1],
      [undefined, 2],
    ]);
    expect(gpuPassFrameMilliseconds(frame, 11)).toBe(2);
    expect(gpuPassFrameMilliseconds(frame, 22)).toBe(6);
    expect(gpuPassFrameMilliseconds(frame)).toBe(13);
    session.dispose();
  });

  it('never reads previous raster timestamps as successful unwritten copy markers', async () => {
    const { device } = makeDevice();
    const session = createGpuPassTimingSession(
      device,
      { maxPassesPerFrame: 2, maxFramesInFlight: 1, retentionFrames: 8 },
      {
        mapReadback: async () =>
          ok({
            getMappedRange: (offset: number, size: number) => {
              expect(offset).toBe(0);
              expect(size).toBe(288);
              const bytes = new ArrayBuffer(size);
              new BigUint64Array(bytes).set([100n, 110n, 200n, 210n]);
              return ok(bytes);
            },
            unmap() {},
          } as MappedBuffer),
      },
    ).unwrap();
    const capture = session.beginFrame(identity).unwrap();
    const copy = { passName: 'copy', passKind: 'copy' as const, executionIndex: 0 };
    const raster = { passName: 'raster', passKind: 'raster' as const, executionIndex: 1 };
    const copyWrites = capture.recordPass(copy);
    const rasterWrites = capture.recordPass(raster);
    if (copyWrites === undefined || rasterWrites === undefined)
      throw new Error('missing timing writes');
    const commands = encoder();
    capture.copyBoundaryBefore(copy, commands);
    capture.copyBoundaryAfter(copy, commands);
    capture.encodeTail(commands).unwrap();
    capture.markSubmitted(Promise.resolve());
    const observed = (await capture.observe()).unwrap();
    expect(observed.passes[0]).toMatchObject({
      status: 'unmeasured',
      reason: { code: 'timestamp-write-unavailable' },
    });
    expect(observed.passes[1]).toMatchObject({ status: 'measured' });
    expect(copyWrites.querySet).not.toBe(rasterWrites.querySet);
    session.dispose();
  });

  it('rejects unchanged positive markers on slot reuse and accepts fresh writes', async () => {
    const { device } = makeDevice();
    let ticks = [100n, 110n];
    const session = createGpuPassTimingSession(
      device,
      { maxPassesPerFrame: 20, maxFramesInFlight: 1, retentionFrames: 8 },
      {
        mapReadback: async () =>
          ok({
            getMappedRange: (offset: number, size: number) => {
              expect(offset).toBe(0);
              expect(size).toBe(528);
              const bytes = new ArrayBuffer(size);
              new BigUint64Array(bytes, 512).set(ticks);
              return ok(bytes);
            },
            unmap() {},
          } as MappedBuffer),
      },
    ).unwrap();
    for (const [frameId, status] of [
      [12, 'measured'],
      [13, 'unmeasured'],
      [14, 'measured'],
    ] as const) {
      if (frameId === 14) ticks = [200n, 210n];
      const capture = session.beginFrame({ ...identity, frameId }).unwrap();
      const copy = { passName: 'copy', passKind: 'copy' as const, executionIndex: 0 };
      capture.recordPass(copy);
      const commands = encoder();
      capture.copyBoundaryBefore(copy, commands);
      capture.copyBoundaryAfter(copy, commands);
      capture.encodeTail(commands).unwrap();
      expect(commands.resolveQuerySet).toHaveBeenLastCalledWith(
        expect.anything(),
        0,
        2,
        expect.anything(),
        512,
      );
      capture.markSubmitted(Promise.resolve());
      expect((await capture.observe()).unwrap().passes[0]).toMatchObject({ status });
    }
    session.dispose();
  });

  it('isolates marker query slots and allocates two aligned readback regions', () => {
    const { device, buffers } = makeDevice();
    const created = createGpuPassTimingSession(device, {
      maxPassesPerFrame: 2,
      maxFramesInFlight: 1,
      retentionFrames: 8,
    });

    expect(created.ok).toBe(true);
    expect(device.createQuerySet).toHaveBeenCalledWith({ type: 'timestamp', count: 4 });
    expect(buffers).toEqual([
      { size: 512, usage: expect.any(Number) },
      { size: 512, usage: expect.any(Number) },
    ]);
  });

  it('does not wait or consume a query when all slots are in flight', () => {
    const { device } = makeDevice();
    const session = createGpuPassTimingSession(device, {
      maxPassesPerFrame: 1,
      maxFramesInFlight: 1,
      retentionFrames: 8,
    }).unwrap();
    const first = session.beginFrame(identity).unwrap();
    const second = session.beginFrame({ ...identity, frameId: 13 });

    expect(second).toMatchObject({ ok: false, error: { code: 'timing-in-flight-exhausted' } });
    expect(device.queue.onSubmittedWorkDone).not.toHaveBeenCalled();
    expect(first.snapshot()).toMatchObject({ frameId: 12, passes: [] });
  });

  it('records actual pass identity and resolves the used pair on the same encoder tail', () => {
    const { device } = makeDevice();
    const session = createGpuPassTimingSession(device, {
      maxPassesPerFrame: 2,
      maxFramesInFlight: 1,
      retentionFrames: 8,
    }).unwrap();
    const capture = session.beginFrame(identity).unwrap();
    capture.recordPass({ passName: 'geometry', passKind: 'raster', executionIndex: 0 });
    capture.recordPass({ passName: 'post', passKind: 'compute', executionIndex: 1 });
    const commandEncoder = encoder();

    expect(capture.encodeTail(commandEncoder)).toMatchObject({ ok: true });
    expect(commandEncoder.resolveQuerySet).toHaveBeenCalledWith(
      expect.anything(),
      0,
      4,
      expect.anything(),
      0,
    );
    expect(capture.snapshot()).toMatchObject({
      executedPassCount: 2,
      passes: [
        { passName: 'geometry', passKind: 'raster', executionIndex: 0 },
        { passName: 'post', passKind: 'compute', executionIndex: 1 },
      ],
    });
  });

  it('marks both boundaries of an interior copy with dedicated marker passes', () => {
    const { device } = makeDevice();
    const session = createGpuPassTimingSession(device, {
      maxPassesPerFrame: 3,
      maxFramesInFlight: 1,
      retentionFrames: 8,
    }).unwrap();
    const capture = session.beginFrame(identity).unwrap();
    const first = { passName: 'first', passKind: 'raster' as const, executionIndex: 0 };
    const copy = { passName: 'copy', passKind: 'copy' as const, executionIndex: 1 };
    const last = { passName: 'last', passKind: 'raster' as const, executionIndex: 2 };
    capture.recordPass(first);
    capture.recordPass(copy);
    capture.recordPass(last);

    const copyWrites = capture.timestampWrites(copy);
    expect(copyWrites).toMatchObject({
      beginningOfPassWriteIndex: 2,
      endOfPassWriteIndex: 3,
    });

    const commandEncoder = {
      ...encoder(),
      beginComputePass: vi.fn(() => ({
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
        end: vi.fn(),
      })),
    } as unknown as RhiCommandEncoder;
    capture.copyBoundaryBefore(copy, commandEncoder);
    capture.copyBoundaryAfter(copy, commandEncoder);
    const markerCalls = (commandEncoder.beginComputePass as ReturnType<typeof vi.fn>).mock.calls;
    expect(markerCalls[0]?.[0]).toMatchObject({
      timestampWrites: { beginningOfPassWriteIndex: 2 },
    });
    expect(markerCalls[1]?.[0]).toMatchObject({
      timestampWrites: { endOfPassWriteIndex: 3 },
    });
    expect(markerCalls[0]?.[0]).not.toHaveProperty('label');
    expect(markerCalls[1]?.[0]).not.toHaveProperty('label');
    expect(capture.encodeTail(commandEncoder)).toMatchObject({ ok: true });
    expect(commandEncoder.beginComputePass).toHaveBeenCalledTimes(2);
    expect(commandEncoder.resolveQuerySet).toHaveBeenCalledWith(
      expect.anything(),
      0,
      6,
      expect.anything(),
      0,
    );
    expect(commandEncoder.copyBufferToBuffer).toHaveBeenCalledWith(
      expect.anything(),
      0,
      expect.anything(),
      0,
      304,
    );
  });

  it('reuses slot-owned marker descriptors while updating only their query indices', () => {
    const { device } = makeDevice();
    const session = createGpuPassTimingSession(device, {
      maxPassesPerFrame: 3,
      maxFramesInFlight: 1,
      retentionFrames: 8,
    }).unwrap();
    const copy = { passName: 'copy', passKind: 'copy' as const, executionIndex: 1 };
    const recordCopy = (capture: GpuPassTimingCapture) => {
      capture.recordPass({ passName: 'first', passKind: 'raster', executionIndex: 0 });
      capture.recordPass(copy);
      capture.recordPass({ passName: 'last', passKind: 'raster', executionIndex: 2 });
    };
    const first = session.beginFrame({ ...identity, frameId: 20 }).unwrap();
    recordCopy(first);
    const firstEncoder = {
      ...encoder(),
      beginComputePass: vi.fn(() => ({
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
        end: vi.fn(),
      })),
    } as unknown as RhiCommandEncoder;
    first.copyBoundaryBefore(copy, firstEncoder);
    first.copyBoundaryAfter(copy, firstEncoder);
    const firstCalls = (firstEncoder.beginComputePass as ReturnType<typeof vi.fn>).mock.calls;
    first.encodeTail(firstEncoder);
    first.abort();

    const second = session.beginFrame({ ...identity, frameId: 21 }).unwrap();
    recordCopy(second);
    const secondEncoder = {
      ...encoder(),
      beginComputePass: vi.fn(() => ({
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
        end: vi.fn(),
      })),
    } as unknown as RhiCommandEncoder;
    second.copyBoundaryBefore(copy, secondEncoder);
    second.copyBoundaryAfter(copy, secondEncoder);
    const secondCalls = (secondEncoder.beginComputePass as ReturnType<typeof vi.fn>).mock.calls;

    expect(secondCalls[0]?.[0]).toBe(firstCalls[0]?.[0]);
    expect(secondCalls[1]?.[0]).toBe(firstCalls[1]?.[0]);
    expect(firstCalls[0]?.[0]).toMatchObject({
      timestampWrites: { beginningOfPassWriteIndex: 2 },
    });
    expect(firstCalls[1]?.[0]).toMatchObject({
      timestampWrites: { endOfPassWriteIndex: 3 },
    });
  });

  it.each([
    ['begin', 1],
    ['end', 2],
  ] as const)('turns a raw %s marker throw into a copy-only unmeasured fact', async (phase, failureCall) => {
    const { device } = makeDevice();
    const map = vi.fn(async (_buffer: Buffer) =>
      ok({
        getMappedRange: () => {
          const bytes = new ArrayBuffer(256);
          const view = new DataView(bytes);
          view.setBigUint64(16, 10n, true);
          view.setBigUint64(24, 20n, true);
          return { ok: true, value: bytes };
        },
        unmap: vi.fn(),
      } as unknown as MappedBuffer),
    );
    const session = createGpuPassTimingSession(
      device,
      { maxPassesPerFrame: 2, maxFramesInFlight: 1, retentionFrames: 8 },
      { mapReadback: map },
    ).unwrap();
    const capture = session.beginFrame(identity).unwrap();
    const copy = { passName: 'copy', passKind: 'copy' as const, executionIndex: 0 };
    const scene = { passName: 'scene', passKind: 'raster' as const, executionIndex: 1 };
    capture.recordPass(copy);
    capture.recordPass(scene);
    let calls = 0;
    const commandEncoder = {
      ...encoder(),
      beginComputePass: vi.fn(() => {
        calls += 1;
        if (calls === failureCall) throw new Error(`raw ${phase} marker failed`);
        return {
          setPipeline: vi.fn(),
          setBindGroup: vi.fn(),
          dispatchWorkgroups: vi.fn(),
          end: vi.fn(),
        };
      }),
    } as unknown as RhiCommandEncoder;

    capture.copyBoundaryBefore(copy, commandEncoder);
    capture.copyBoundaryAfter(copy, commandEncoder);
    expect(capture.encodeTail(commandEncoder)).toMatchObject({ ok: true });
    capture.markSubmitted(Promise.resolve());

    await expect(capture.observe()).resolves.toMatchObject({
      ok: true,
      value: {
        measuredPassCount: 1,
        passes: [
          {
            passName: 'copy',
            status: 'unmeasured',
            reason: {
              code: 'timestamp-write-unavailable',
              detail: { phase },
              cause: { message: `raw ${phase} marker failed` },
            },
          },
          { passName: 'scene', status: 'measured', measurementSource: 'pass-boundary' },
        ],
      },
    });
  });

  it('keeps a failed copy timestamp boundary unmeasured instead of parsing untouched ticks', async () => {
    const { device } = makeDevice();
    const session = createGpuPassTimingSession(device, {
      maxPassesPerFrame: 1,
      maxFramesInFlight: 1,
      retentionFrames: 8,
    }).unwrap();
    const capture = session.beginFrame(identity).unwrap();
    const copy = { passName: 'copy', passKind: 'copy' as const, executionIndex: 0 };
    capture.recordPass(copy);
    expect(capture.timestampWrites(copy)).toBeDefined();
    capture.markTimestampWriteFailure(copy, 'begin', { code: 'timestamp-write-failed' });
    capture.markTimestampWriteFailure(copy, 'end', { code: 'second-timestamp-write-failed' });

    const commandEncoder = encoder();
    expect(capture.encodeTail(commandEncoder)).toMatchObject({ ok: true });
    expect(commandEncoder.resolveQuerySet).not.toHaveBeenCalled();
    capture.markSubmitted();

    await expect(capture.observe()).resolves.toMatchObject({
      ok: true,
      value: {
        executedPassCount: 1,
        measuredPassCount: 0,
        passes: [
          {
            passName: 'copy',
            status: 'unmeasured',
            reason: { code: 'timestamp-write-unavailable', detail: { phase: 'begin' } },
          },
        ],
      },
    });
  });

  it('preserves a failed copy entry while reading the remaining measured entries', async () => {
    const { device } = makeDevice();
    const map = vi.fn(async (_buffer: Buffer) =>
      ok({
        getMappedRange: () => {
          const bytes = new ArrayBuffer(256);
          const view = new DataView(bytes);
          view.setBigUint64(16, 10n, true);
          view.setBigUint64(24, 20n, true);
          return { ok: true, value: bytes };
        },
        unmap: vi.fn(),
      } as unknown as MappedBuffer),
    );
    const session = createGpuPassTimingSession(
      device,
      { maxPassesPerFrame: 2, maxFramesInFlight: 1, retentionFrames: 8 },
      { mapReadback: map },
    ).unwrap();
    const capture = session.beginFrame(identity).unwrap();
    const failedCopy = { passName: 'copy', passKind: 'copy' as const, executionIndex: 0 };
    const measuredPass = { passName: 'scene', passKind: 'raster' as const, executionIndex: 1 };
    capture.recordPass(failedCopy);
    capture.recordPass(measuredPass);
    expect(capture.timestampWrites(failedCopy)).toBeDefined();
    capture.markTimestampWriteFailure(failedCopy, 'end', new Error('end write failed'));
    expect(capture.timestampWrites(measuredPass)).toBeDefined();
    expect(capture.encodeTail(encoder())).toMatchObject({ ok: true });
    capture.markSubmitted();

    const observed = await capture.observe();
    expect(observed).toMatchObject({
      ok: true,
      value: {
        executedPassCount: 2,
        measuredPassCount: 1,
        passes: [
          { passName: 'copy', status: 'unmeasured' },
          {
            passName: 'scene',
            status: 'measured',
            measurementSource: 'pass-boundary',
            durationNanoseconds: 10,
          },
        ],
      },
    });
    if (observed.ok) expect(observed.value.passes[1]).not.toHaveProperty('reason');
  });

  it('reuses a caller-provided queue completion for readback', async () => {
    const { device } = makeDevice();
    const map = vi.fn(async (_buffer: Buffer) =>
      ok({
        getMappedRange: () => {
          const bytes = new ArrayBuffer(256);
          const view = new DataView(bytes);
          view.setBigUint64(0, 10n, true);
          view.setBigUint64(8, 20n, true);
          return { ok: true, value: bytes };
        },
        unmap: vi.fn(),
      } as unknown as MappedBuffer),
    );
    const session = createGpuPassTimingSession(
      device,
      { maxPassesPerFrame: 1, maxFramesInFlight: 1, retentionFrames: 8 },
      { mapReadback: map },
    ).unwrap();
    const capture = session.beginFrame(identity).unwrap();
    const pass = { passName: 'scene', passKind: 'raster' as const, executionIndex: 0 };
    capture.recordPass(pass);
    expect(capture.timestampWrites(pass)).toBeDefined();
    expect(capture.encodeTail(encoder())).toMatchObject({ ok: true });

    capture.markSubmitted(Promise.resolve());

    expect(device.queue.onSubmittedWorkDone).not.toHaveBeenCalled();
    await expect(capture.observe()).resolves.toMatchObject({
      ok: true,
      value: {
        measuredPassCount: 1,
        passes: [
          {
            status: 'measured',
            passName: 'scene',
            measurementSource: 'pass-boundary',
          },
        ],
      },
    });
    expect(map).toHaveBeenCalledTimes(1);
  });

  it('terminalizes submit, map, consumer, abort, and reuse paths exactly once', async () => {
    const { device } = makeDevice();
    const map = vi.fn(async (_buffer: Buffer) =>
      ok({
        getMappedRange: () => ({ ok: true, value: new ArrayBuffer(256) }),
        unmap: vi.fn(),
      } as unknown as MappedBuffer),
    );
    const session = createGpuPassTimingSession(
      device,
      {
        maxPassesPerFrame: 1,
        maxFramesInFlight: 1,
        retentionFrames: 8,
      },
      { mapReadback: map },
    ).unwrap();
    const capture = session.beginFrame(identity).unwrap();
    capture.abort({ code: 'timestamp-readback-failed' });
    capture.abort({ code: 'timestamp-readback-failed' });
    await expect(capture.observe()).resolves.toMatchObject({ ok: false });
    expect(map).not.toHaveBeenCalled();
    expect(capture.snapshot()).toMatchObject({ frameId: 12 });
  });
});
