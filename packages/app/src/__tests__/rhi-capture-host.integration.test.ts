import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import type { RhiBackendInstrumentation } from '@forgeax/engine-render/internal/construct-renderer';
import {
  attachRecorder,
  type EncodedTape,
  type RecorderAttachment,
  type RhiDebugError,
  tapeArtifact,
} from '@forgeax/engine-rhi-debug';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { ok, type Result } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../create-app';
import {
  bindRhiCaptureFrameDriver,
  createRhiCapture,
  createRhiInstrumentation,
  mergeRhiInstrumentation,
  type RhiCapture,
} from '../internal/rhi-capture';
import { testPlatform } from './platform-fixture';

const encoded: EncodedTape = {
  ...tapeArtifact([new Uint8Array([82, 72, 73, 84, 65, 80, 69])]),
  tape: {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
    bootstrap: [],
    events: [],
    blobs: [],
  },
};

const expectedFacts = {
  kind: 'rhi-tape',
  byteLength: encoded.byteLength,
  digest: encoded.digest,
  bytes: encoded.bytes,
};

function artifactFacts(result: Awaited<ReturnType<RhiCapture['captureFrame']>>) {
  if (!result.ok) return result;
  const { kind, byteLength, digest, bytes } = result.value;
  return { kind, byteLength, digest, bytes };
}

function attachment(): RecorderAttachment {
  return {
    backend: {} as RecorderAttachment['backend'],
    captureGeneration: 0,
    isRecordingCapture: () => true,
    readPipelineReference: () => undefined,
    captureFrame: async () => ok(encoded),
    frameBoundary: async () => ok(undefined),
    deviceLost: () => undefined,
    dispose: async () => ok(undefined),
  };
}

function deferredAttachment(): {
  readonly attachment: RecorderAttachment;
  readonly releaseSnapshot: () => void;
} {
  let releaseSnapshot!: () => void;
  const snapshotReleased = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  let resolveCapture!: (result: Result<EncodedTape, RhiDebugError>) => void;
  let boundaryCount = 0;
  const deferred: RecorderAttachment = {
    backend: {} as RecorderAttachment['backend'],
    captureGeneration: 0,
    isRecordingCapture: () => true,
    readPipelineReference: () => undefined,
    captureFrame: () =>
      new Promise((resolve) => {
        resolveCapture = resolve;
      }),
    frameBoundary: async () => {
      boundaryCount += 1;
      if (boundaryCount === 1) {
        await snapshotReleased;
        return ok(undefined);
      }
      resolveCapture(ok(encoded));
      return ok(undefined);
    },
    deviceLost: () => undefined,
    dispose: async () => ok(undefined),
  };
  return { attachment: deferred, releaseSnapshot };
}

function driverFor(
  attachment: RecorderAttachment,
  initialState: 'running' | 'paused',
): {
  readonly driver: Parameters<typeof bindRhiCaptureFrameDriver>[1];
  readonly pause: ReturnType<typeof vi.fn>;
  readonly resume: ReturnType<typeof vi.fn>;
  readonly stepFrame: ReturnType<typeof vi.fn>;
} {
  let state = initialState;
  const pause = vi.fn(() => {
    state = 'paused';
    return ok(undefined);
  });
  const resume = vi.fn(() => {
    state = 'running';
    if (initialState === 'running') void attachment.frameBoundary();
    return ok(undefined);
  });
  const stepFrame = vi.fn((_deltaSeconds: number) => {
    void attachment.frameBoundary();
    return ok(undefined);
  });
  return {
    driver: {
      getState: () => state,
      pause,
      resume,
      stepFrame,
    },
    pause,
    resume,
    stepFrame,
  };
}

describe('RHI capture host capability', () => {
  it('binds native assembly capture to the actual App frame and refuses it after disposal', async () => {
    const deferred = deferredAttachment();
    const capture = createRhiCapture(deferred.attachment);
    const draw = vi.fn(() => {
      void deferred.attachment.frameBoundary();
      return ok(undefined);
    });
    const renderer = {
      ready: Promise.resolve(ok(undefined)),
      state: () => 'alive',
      backend: 'null',
      attach: () => ok({ dispose() {} }),
      draw,
      subscribe: () => () => {},
    } as unknown as Renderer;
    const app = (
      await createApp({
        platform: testPlatform({ now: () => 1000, raf: () => 1, caf: () => {} }),
        renderer,
        world: new World(),
        rhiCapture: capture,
      })
    ).unwrap();
    try {
      expect(app.rhiCapture).toBe(capture);
      if (app.rhiCapture === undefined) throw new Error('native assembly lost its capture');
      app.start().unwrap();
      app.pause().unwrap();
      const pending = app.rhiCapture.captureFrame();
      deferred.releaseSnapshot();
      expect(artifactFacts(await pending)).toEqual(expectedFacts);
      expect(draw).toHaveBeenCalledTimes(1);
      expect(app.execution.report().engine.health).toBe('idle');
    } finally {
      (await app.dispose()).unwrap();
    }
    expect(await capture.captureFrame()).toMatchObject({
      ok: false,
      error: { code: 'capture-unavailable' },
    });
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it('keeps the actual Null recorder device on the normal surface instrumentation seam', async () => {
    const a = attachRecorder({ rhi, createShaderModule }).unwrap();
    try {
      const adapter = (await a.backend.rhi.requestAdapter()).unwrap();
      const device = (await adapter.requestDevice()).unwrap();
      const resolve = createRhiInstrumentation(a).resolveSurfaceDevice;
      if (resolve === undefined) throw new Error('surface resolver unavailable');
      expect(resolve(device).unwrap() === device).toBe(true);
      const raw = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      expect(resolve(raw).ok).toBe(false);
    } finally {
      (await a.dispose()).unwrap();
    }
  });

  it('does not step a new frame after the real recorder has already finalized its capture', async () => {
    const attached = attachRecorder({ rhi, createShaderModule });
    if (!attached.ok) throw attached.error;
    const a = attached.value;
    const adapter = await a.backend.rhi.requestAdapter();
    if (!adapter.ok) throw adapter.error;
    const device = await adapter.value.requestDevice();
    if (!device.ok) throw device.error;
    const boundary = a.frameBoundary.bind(a);
    vi.spyOn(a, 'frameBoundary').mockImplementationOnce(async () => {
      const snapshot = await boundary();
      if (snapshot.ok) await boundary();
      return snapshot;
    });
    const step = vi.fn(() => {
      const encoder = device.value.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({ colorAttachments: [] });
      pass.draw(1);
      pass.end();
      device.value.queue.submit([encoder.finish().unwrap()]).unwrap();
      return ok(undefined);
    });
    const capture = createRhiCapture(a);
    bindRhiCaptureFrameDriver(capture, {
      getState: () => 'paused',
      pause: () => ok(undefined),
      resume: () => ok(undefined),
      stepFrame: step,
    });
    try {
      const result = await capture.captureFrame();
      if (!result.ok) throw result.error;
      expect(step).not.toHaveBeenCalled();
      expect(result.value.submittedFrame).toEqual({
        status: 'unavailable',
        reason: 'frame-unavailable',
      });
    } finally {
      vi.restoreAllMocks();
      await a.dispose();
    }
  });

  it('preserves host fault hooks when the recorder wraps the backend', () => {
    const recorderFrameBoundary = vi.fn();
    const recorderDeviceLost = vi.fn();
    const hostFrameBoundary = vi.fn();
    const hostDeviceLost = vi.fn();
    const hostBeforeSubmit = vi.fn(() => undefined);
    const hostDeviceProjection = vi.fn(
      (device: Parameters<NonNullable<RhiBackendInstrumentation['deviceLost']>>[0]) => device.lost,
    );
    const recorderResolver: NonNullable<RhiBackendInstrumentation['resolveSurfaceDevice']> = (
      device,
    ) => ok(device);
    const recorder: RhiBackendInstrumentation = {
      resolveSurfaceDevice: recorderResolver,
      onFrameBoundary: recorderFrameBoundary,
      onDeviceLost: recorderDeviceLost,
    };
    const host: RhiBackendInstrumentation = {
      beforeSubmit: hostBeforeSubmit,
      deviceLost: hostDeviceProjection,
      onFrameBoundary: hostFrameBoundary,
      onDeviceLost: hostDeviceLost,
    };

    const merged = mergeRhiInstrumentation(recorder, host);

    expect(merged.beforeSubmit).toBe(hostBeforeSubmit);
    expect(merged.deviceLost).toBe(hostDeviceProjection);
    expect(merged.resolveSurfaceDevice).toBe(recorderResolver);
    merged.onFrameBoundary?.();
    merged.onDeviceLost?.();
    expect(recorderFrameBoundary).toHaveBeenCalledTimes(1);
    expect(hostFrameBoundary).toHaveBeenCalledTimes(1);
    expect(recorderDeviceLost).toHaveBeenCalledTimes(1);
    expect(hostDeviceLost).toHaveBeenCalledTimes(1);
  });

  it('uses one typed capability for main and worker host handoff', async () => {
    const main = createRhiCapture(attachment());
    const worker = main;

    const [mainResult, workerResult] = await Promise.all([
      main.captureFrame(),
      worker.captureFrame(),
    ]);

    expect(artifactFacts(mainResult)).toEqual(expectedFacts);
    expect(artifactFacts(workerResult)).toEqual(expectedFacts);
  });

  it('captures the next measured frame and keeps a previously running loop running', async () => {
    const deferred = deferredAttachment();
    const capture = createRhiCapture(deferred.attachment);
    const driver = driverFor(deferred.attachment, 'running');
    bindRhiCaptureFrameDriver(capture, driver.driver);

    const pending = capture.captureFrame();
    await Promise.resolve();

    expect(driver.pause).toHaveBeenCalledTimes(1);
    expect(driver.stepFrame).not.toHaveBeenCalled();

    deferred.releaseSnapshot();
    const result = await pending;

    expect(artifactFacts(result)).toEqual(expectedFacts);
    expect(driver.stepFrame).not.toHaveBeenCalled();
    expect(driver.resume).toHaveBeenCalledTimes(1);
  });

  it('keeps a previously paused loop paused while capture advances one frame', async () => {
    const deferred = deferredAttachment();
    const capture = createRhiCapture(deferred.attachment);
    const driver = driverFor(deferred.attachment, 'paused');
    bindRhiCaptureFrameDriver(capture, driver.driver);

    const pending = capture.captureFrame();
    await Promise.resolve();
    expect(driver.pause).not.toHaveBeenCalled();

    deferred.releaseSnapshot();
    expect((await pending).ok).toBe(true);
    expect(driver.stepFrame).toHaveBeenCalledWith(0);
    expect(driver.resume).not.toHaveBeenCalled();
  });
});
