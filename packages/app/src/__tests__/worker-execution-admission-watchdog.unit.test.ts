import type { DisplayFacts, PlatformEvent } from '@forgeax/engine-platform';
import { ok } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionDiagnosticEvent } from '../execution/diagnostic-events';
import type { EngineToHostMessage, ExecutionFrameMessage } from '../execution/protocol';
import { FrameCreditLedger } from '../execution/protocol';
import { workerSelection } from './execution-fixtures';

type SessionListener = (message: EngineToHostMessage) => void;

const probes = vi.hoisted(() => {
  const sessionListeners: SessionListener[] = [];
  const pending = { message: undefined as EngineToHostMessage | undefined };
  return {
    audioDispose: vi.fn(),
    browserCompleted: vi.fn(),
    sessionDispose: vi.fn(),
    pending,
    now: 0,
    visible: true,
    platformListeners: new Set<(event: PlatformEvent) => void>(),
    platformDispose: vi.fn(),
    display: {
      width: 800,
      height: 600,
      pixelRatio: 1,
      drawingWidth: 800,
      drawingHeight: 600,
      safeArea: { x: 0, y: 0, width: 800, height: 600 },
    } as DisplayFacts,
    displayReads: vi.fn(),
    sessionListen: vi.fn((listener: SessionListener) => {
      sessionListeners.push(listener);
      const initial = pending.message;
      pending.message = undefined;
      if (initial !== undefined) listener(initial);
      return () => {};
    }),
    sessionListeners,
    sessionPost: vi.fn(),
  };
});

vi.mock('@forgeax/engine-platform-browser', async () => {
  const { ok } = await import('@forgeax/engine-types');
  return {
    createBrowserPlatform: vi.fn(() =>
      ok({
        now: () => ok(probes.now),
        display: () => {
          probes.displayReads();
          return ok(probes.display);
        },
        visible: () => probes.visible,
        requestFrame: (callback: () => void) => {
          let live = true;
          const id = requestAnimationFrame(() => {
            if (live) callback();
          });
          return ok(() => {
            live = false;
            cancelAnimationFrame(id);
          });
        },
        subscribe: (listener: (event: PlatformEvent) => void) => {
          probes.platformListeners.add(listener);
          return ok(() => {
            probes.platformListeners.delete(listener);
          });
        },
        dispose: probes.platformDispose,
      }),
    ),
  };
});

vi.mock('../execution/engine-worker', async () => {
  const { ok } = await import('@forgeax/engine-types');
  return {
    startEngineWorker: vi.fn(async () =>
      ok({
        worker: {},
        ready: {
          kind: 'ready' as const,
          worldIdentity: 'worker-world',
          realm: 'worker' as const,
          workerWebGpu: true,
        },
        post: probes.sessionPost,
        listen: probes.sessionListen,
        dispose: probes.sessionDispose,
      }),
    ),
  };
});

vi.mock('@forgeax/engine-input', () => ({
  attachBrowserInputBackend: vi.fn(() =>
    Object.assign(() => {}, {
      backend: {
        sample: () => ({
          downKeys: new Set(),
          upKeys: new Set(),
          buttons: [false, false, false],
          movementX: 0,
          movementY: 0,
          wheelDelta: 0,
          focused: true,
          pointerLocked: false,
        }),
        detach: () => {},
      },
    }),
  ),
}));

vi.mock('@forgeax/engine-audio-webaudio', () => ({
  createHostAudioConsumer: vi.fn(() => ({
    consume: vi.fn(),
    dispose: probes.audioDispose,
    state: () => ({ contextState: 'suspended', activeSourceCount: 0, lastError: null }),
  })),
}));

vi.mock('../browser-frame-signal', () => ({
  publishBrowserFrameCompleted: probes.browserCompleted,
  publishBrowserFrameSubmitted: vi.fn(),
  resetBrowserFrameProgress: vi.fn(),
}));

import { createWorkerExecutionApp } from '../execution/host-controller';

const capabilities = {
  worker: { available: true, reason: 'test' },
  offscreenCanvas: { available: true, reason: 'test' },
  workerAnimationFrame: { available: true, reason: 'test' },
  workerWebGpu: { available: true, reason: 'test' },
  crossOriginIsolated: { available: false, reason: 'test' },
  sharedArrayBuffer: { available: false, reason: 'test' },
  atomicsWait: { available: false, reason: 'test' },
} as const;

function makeRaf(): {
  readonly callbacks: Array<(timestamp: number) => void>;
  readonly raf: ReturnType<typeof vi.fn>;
} {
  const callbacks: Array<(timestamp: number) => void> = [];
  const raf = vi.fn((callback: (timestamp: number) => void) => {
    callbacks.push((timestamp) => {
      probes.now = timestamp;
      callback(timestamp);
    });
    return callbacks.length;
  });
  return { callbacks, raf };
}

function makeCanvas(): HTMLCanvasElement {
  return {
    cloneNode: () => makeCanvas(),
    replaceWith: () => {},
    transferControlToOffscreen: () => ({}),
  } as unknown as HTMLCanvasElement;
}

async function createRunningApp(
  tier: 'engine-worker' | 'render-worker' = 'engine-worker',
  renderPipelineCapacity: 2 | 3 | 4 = 2,
  syncCanvas?: import('../execution/host-controller').CreateWorkerExecutionAppOptions['syncCanvas'],
  startupTimeoutMs: number | null = 2_000,
  frameTimeoutMs?: number | null,
) {
  const { callbacks, raf } = makeRaf();
  vi.stubGlobal('requestAnimationFrame', raf);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const result = await createWorkerExecutionApp({
    canvas: makeCanvas(),
    ...(syncCanvas === undefined ? {} : { syncCanvas }),
    appOptions: {
      execution: {
        bootstrap: 'https://example.test/game.js',
        startupTimeoutMs,
        frameTimeoutMs,
        diagnostics: { renderPipelineCapacity },
      },
    } as never,
    capabilities,
    selection: workerSelection({ render: tier === 'render-worker', kernels: false }),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.start().ok).toBe(true);
  callbacks[0]?.(0);
  const frame = probes.sessionPost.mock.calls[0]?.[0] as ExecutionFrameMessage;
  expect(frame?.kind).toBe('frame');
  return { app: result.value, callbacks, frame };
}

function listener(): SessionListener {
  const value = probes.sessionListeners[0];
  if (value === undefined) throw new Error('Worker listener was not registered');
  return value;
}

function visibility(visible: boolean): void {
  probes.visible = visible;
  for (const listener of probes.platformListeners) listener({ kind: 'visibility', visible });
}

function frames(): ExecutionFrameMessage[] {
  return probes.sessionPost.mock.calls
    .map(([message]) => message)
    .filter((message) => message.kind === 'frame');
}

function completeMessage(frame: ExecutionFrameMessage): EngineToHostMessage {
  return {
    kind: 'frame-complete',
    worldIdentity: frame.worldIdentity,
    frameId: frame.frameId,
    deviceGeneration: 1,
    presentation: 'ready',
    engineUpdateMs: 1,
    kernelWaitMs: 0,
  };
}

describe('Worker frame admission watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    probes.sessionListeners.length = 0;
    probes.pending.message = undefined;
    probes.now = 0;
    probes.visible = true;
    probes.platformListeners.clear();
    probes.display = {
      width: 800,
      height: 600,
      pixelRatio: 1,
      drawingWidth: 800,
      drawingHeight: 600,
      safeArea: { x: 0, y: 0, width: 800, height: 600 },
    };
    probes.sessionDispose.mockResolvedValue(ok(undefined));
  });

  it.each([
    'engine-worker',
    'render-worker',
  ] as const)('uses the startup budget for the first %s frame, then retains the steady deadline', async (tier) => {
    const { app, callbacks, frame } = await createRunningApp(tier, 2, undefined, 10_000);
    try {
      await vi.advanceTimersByTimeAsync(2_001);
      expect(app.lastError).toBeUndefined();
      listener()({
        ...completeMessage(frame),
        kind: tier === 'render-worker' ? 'simulation-complete' : 'frame-complete',
      });
      callbacks.at(-1)?.(16);
      expect(app.execution.report().frame).toMatchObject({ completed: 1, inFlight: 1 });
      await vi.advanceTimersByTimeAsync(2_001);
      expect(app.execution.report().fault).toMatchObject({
        code: 'app-execution-deadline-exceeded',
        detail: { phase: 'frame', timeoutMs: 2_000 },
      });
    } finally {
      await app.dispose();
    }
  });

  it.each([
    'engine-worker',
    'render-worker',
  ] as const)('retains a slow %s admission and accepts its late completion when the frame deadline is disabled', async (tier) => {
    const { app, callbacks, frame } = await createRunningApp(tier, 2, undefined, 10_000, null);
    try {
      listener()(completeMessage(frame));
      callbacks.at(-1)?.(16);
      const pending = probes.sessionPost.mock.calls.at(-1)?.[0] as ExecutionFrameMessage;
      const posted = probes.sessionPost.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_001);
      callbacks.at(-1)?.(120_017);
      expect(app.lastError).toBeUndefined();
      expect(app.execution.report().frame).toMatchObject({ completed: 1, inFlight: 1 });
      expect(probes.sessionPost.mock.calls).toHaveLength(posted);
      expect(probes.sessionDispose).not.toHaveBeenCalled();
      listener()(completeMessage(pending));
      expect(app.execution.report().frame.completed).toBe(2);
      expect(app.lastError).toBeUndefined();
    } finally {
      await app.dispose();
    }
    expect(probes.sessionDispose).toHaveBeenCalledTimes(1);
  });

  it('still bounds a first frame that never completes by the configured startup budget', async () => {
    const { app } = await createRunningApp('engine-worker', 2, undefined, 1_000);
    try {
      await vi.advanceTimersByTimeAsync(1_001);
      expect(app.execution.report().fault).toMatchObject({
        code: 'app-execution-deadline-exceeded',
        detail: { phase: 'frame', timeoutMs: 1_000 },
      });
      expect(probes.sessionDispose).toHaveBeenCalledTimes(1);
    } finally {
      await app.dispose();
    }
  });

  it('honors an unbounded startup without disabling the subsequent frame deadline', async () => {
    const { app, callbacks, frame } = await createRunningApp('engine-worker', 2, undefined, null);
    try {
      await vi.advanceTimersByTimeAsync(10_001);
      expect(app.lastError).toBeUndefined();
      listener()(completeMessage(frame));
      callbacks.at(-1)?.(16);
      await vi.advanceTimersByTimeAsync(2_001);
      expect(app.execution.report().fault).toMatchObject({
        code: 'app-execution-deadline-exceeded',
        detail: { phase: 'frame', timeoutMs: 2_000 },
      });
    } finally {
      await app.dispose();
    }
  });

  it('uses native display notifications for subsequent admissions and retires them with the host', async () => {
    const syncCanvas = vi.fn((_canvas: HTMLCanvasElement, display: DisplayFacts | undefined) => {
      if (display === undefined) throw new Error('missing native display');
      return { width: display.width, height: display.height };
    });
    const { app, callbacks, frame } = await createRunningApp('engine-worker', 2, syncCanvas);
    expect(syncCanvas.mock.calls[0]?.[1]).toBe(probes.display);
    expect(probes.displayReads).toHaveBeenCalledOnce();
    listener()(completeMessage(frame));
    callbacks.at(-1)?.(16);
    const second = frames().at(-1);
    if (second === undefined) throw new Error('missing second admission');
    expect(syncCanvas.mock.calls.at(-1)?.[1]).toBe(probes.display);
    const resized = { ...probes.display, width: 1200, height: 700 };
    for (const listener of probes.platformListeners)
      listener({ kind: 'display', display: resized });
    listener()(completeMessage(second));
    callbacks.at(-1)?.(32);
    expect(syncCanvas.mock.calls.at(-1)?.[1]).toBe(resized);
    expect(frames().at(-1)).toMatchObject({ canvasWidth: 1200, canvasHeight: 700 });
    expect(probes.displayReads).toHaveBeenCalledOnce();
    const third = frames().at(-1);
    if (third === undefined) throw new Error('missing third admission');
    listener()(completeMessage(third));
    probes.display = { ...probes.display, width: 640, height: 480 };
    listener()({ kind: 'surface-request', worldIdentity: frame.worldIdentity, requestId: 1 });
    expect(probes.sessionPost).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'surface-result',
        result: expect.objectContaining({ ok: true }),
      }),
      expect.any(Array),
    );
    app.pause().unwrap();
    app.resume().unwrap();
    callbacks.at(-1)?.(48);
    expect(frames().at(-1)).toMatchObject({ canvasWidth: 640, canvasHeight: 480 });
    expect(syncCanvas.mock.calls.at(-1)?.[1]).toBe(probes.display);
    expect(syncCanvas.mock.calls.at(-1)?.[0]).not.toBe(syncCanvas.mock.calls[0]?.[0]);
    expect(probes.displayReads).toHaveBeenCalledTimes(2);
    await app.dispose();
    expect(probes.platformListeners.size).toBe(0);
  });

  it('discards the hidden interval before admitting the resumed Worker frame', async () => {
    const { app, callbacks, frame } = await createRunningApp();
    const emit = listener();
    emit(completeMessage(frame));
    callbacks.at(-1)?.(16);
    emit(completeMessage(probes.sessionPost.mock.calls.at(-1)?.[0] as ExecutionFrameMessage));
    probes.visible = false;
    for (const listener of probes.platformListeners)
      listener({ kind: 'visibility', visible: false });
    probes.now = 50_000;
    probes.visible = true;
    for (const listener of probes.platformListeners)
      listener({ kind: 'visibility', visible: true });
    callbacks.at(-1)?.(50_016);
    const resumed = probes.sessionPost.mock.calls.at(-1)?.[0] as ExecutionFrameMessage;
    expect(resumed.deltaSeconds).toBe(0);
    expect(resumed.temporalReset).toBe(true);
    await app.dispose();
  });

  it('suspends pending admission while hidden and retains credit plus reset across late completion', async () => {
    const { app, callbacks, frame } = await createRunningApp();
    visibility(false);
    expect(app.execution.report().engine.health).toBe('idle');
    expect(probes.sessionPost).toHaveBeenCalledWith({ kind: 'input-clear' });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(app.lastError).toBeUndefined();
    visibility(true);
    callbacks.at(-1)?.(50_016);
    expect(frames()).toHaveLength(1);
    listener()(completeMessage(frame));
    callbacks.at(-1)?.(50_032);
    expect(frames().at(-1)).toMatchObject({ frameId: 2, deltaSeconds: 0, temporalReset: true });
    expect(app.execution.report().frame.highWater).toBe(1);
    await app.dispose();
    expect(probes.platformListeners.size).toBe(0);
    expect(probes.platformDispose).toHaveBeenCalledTimes(1);
  });

  it('cancels queued host callbacks and preserves an explicit pause through show', async () => {
    const { app, callbacks, frame } = await createRunningApp();
    listener()(completeMessage(frame));
    const stale = callbacks.at(-1);
    visibility(false);
    stale?.(50_000);
    expect(frames()).toHaveLength(1);
    app.pause().unwrap();
    visibility(true);
    expect(app.execution.report().engine.health).toBe('idle');
    stale?.(50_016);
    expect(frames()).toHaveLength(1);
    app.resume().unwrap();
    callbacks.at(-1)?.(50_032);
    expect(frames().at(-1)).toMatchObject({ frameId: 2, deltaSeconds: 0, temporalReset: true });
    await app.dispose();
  });

  it('starts hidden without admitting frames and cannot be restarted by show after stop', async () => {
    const { callbacks, raf } = makeRaf();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    probes.visible = false;
    const app = (
      await createWorkerExecutionApp({
        canvas: {} as HTMLCanvasElement,
        appOptions: { execution: { bootstrap: 'https://example.test/game.js' } },
        capabilities,
        selection: workerSelection({ render: false, kernels: false }),
      })
    ).unwrap();
    app.start().unwrap();
    expect(callbacks).toHaveLength(0);
    visibility(true);
    callbacks.at(-1)?.(60_000);
    expect(frames().at(-1)).toMatchObject({ frameId: 1, deltaSeconds: 0, temporalReset: true });
    visibility(false);
    app.stop().unwrap();
    visibility(true);
    callbacks.at(-1)?.(60_016);
    expect(frames()).toHaveLength(1);
    await app.dispose();
    expect(probes.platformDispose).toHaveBeenCalledTimes(1);
    expect(probes.sessionDispose).toHaveBeenCalledTimes(1);
  });

  it('rearms an unsubmitted frame deadline only after the host returns', async () => {
    const { app } = await createRunningApp();
    visibility(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(app.lastError).toBeUndefined();
    visibility(true);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(app.lastError).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(app.execution.report().fault?.code).toBe('app-execution-deadline-exceeded');
    expect(probes.platformDispose).toHaveBeenCalledTimes(1);
  });

  it('consumes one overdue browser tick immediately when simulation credit returns', async () => {
    const { app, callbacks, frame } = await createRunningApp('render-worker');
    callbacks[1]?.(16);
    expect(probes.sessionPost.mock.calls).toHaveLength(1);
    probes.now = 24;
    try {
      listener()({
        ...completeMessage(frame),
        kind: 'simulation-complete',
      } as EngineToHostMessage);
      expect(probes.sessionPost.mock.calls.at(-1)?.[0]).toMatchObject({
        kind: 'frame',
        frameId: 2,
        sampleTimeSeconds: 0.024,
      });
      expect(callbacks).toHaveLength(3);
      // Duplicate completion cannot turn the retained tick into extra work.
      listener()({
        ...completeMessage(frame),
        kind: 'simulation-complete',
      } as EngineToHostMessage);
      expect(probes.sessionPost.mock.calls).toHaveLength(2);
      expect(callbacks).toHaveLength(3);
    } finally {
      await app.dispose();
    }
  });

  it('does not carry an overdue browser tick across pause and resume', async () => {
    const { app, callbacks, frame } = await createRunningApp('render-worker');
    callbacks[1]?.(16);
    app.pause().unwrap();
    listener()({
      ...completeMessage(frame),
      kind: 'simulation-complete',
    } as EngineToHostMessage);
    app.resume().unwrap();
    expect(probes.sessionPost.mock.calls).toHaveLength(1);
    callbacks.at(-1)?.(48);
    expect(probes.sessionPost.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'frame',
      frameId: 2,
      deltaSeconds: 0,
      temporalReset: true,
    });
    await app.dispose();
  });

  it('waits for source publication capacity before issuing another simulation request', async () => {
    const { app, callbacks, frame } = await createRunningApp('render-worker');
    const emit = listener();
    emit({
      ...completeMessage(frame),
      kind: 'simulation-complete',
    } as EngineToHostMessage);
    callbacks.at(-1)?.(16);
    const next = frames().at(-1);
    if (next === undefined) throw new Error('Expected an admitted simulation frame');
    emit({
      ...completeMessage(next),
      kind: 'simulation-complete',
    } as EngineToHostMessage);
    callbacks.at(-1)?.(32);
    expect(frames()).toHaveLength(2); // Both publications are sealed; neither is submitted yet.
    const requestedTicks = callbacks.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(app.lastError).toBeUndefined();
    expect(callbacks).toHaveLength(requestedTicks);
    const pendingReason = {
      code: 'draw-terrain-missing',
      worldId: 0,
      entity: 42,
      section: 3,
    } as const;
    const picture = {
      ...completeMessage(frame),
      presentation: 'pending',
      presentationPendingReason: pendingReason,
    } as never;
    emit({ kind: 'render-submitted', epoch: 1, frame: picture });
    emit({ kind: 'render-complete', epoch: 0, frame: picture });
    emit({ kind: 'render-ready', epoch: 1 }); // Duplicate readiness cannot reopen a full source.
    expect(frames()).toHaveLength(2);
    probes.now = 3040;
    emit({ kind: 'render-complete', epoch: 1, frame: picture });
    expect(frames()).toHaveLength(3);
    const third = frames().at(-1);
    if (third === undefined) throw new Error('Expected an admitted simulation frame');
    expect(third).toMatchObject({ frameId: 3, deltaSeconds: 3.024, sampleTimeSeconds: 3.04 });
    emit({
      ...completeMessage(third),
      kind: 'simulation-complete',
    } as EngineToHostMessage);
    callbacks.at(-1)?.(3056);
    emit({ kind: 'render-complete', epoch: 1, frame: picture });
    expect(frames()).toHaveLength(3); // A duplicate picture completion returns no second credit.
    expect(probes.browserCompleted).toHaveBeenCalledTimes(1);
    expect(probes.browserCompleted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        presentation: 'pending',
        presentationPendingReason: pendingReason,
      }),
    );
    await app.dispose();
  });

  it.each([
    3, 4,
  ] as const)('admits exactly %i sealed publications while keeping one simulation credit and real completion retirement', async (capacity) => {
    const { app, callbacks, frame } = await createRunningApp('render-worker', capacity);
    const emit = listener();
    try {
      for (let id = 1; id <= capacity; id++) {
        const current = frames().at(-1);
        if (current === undefined) throw new Error('Missing simulation');
        expect(current.frameId).toBe(id);
        callbacks.at(-1)?.(id * 16 - 1);
        expect(frames()).toHaveLength(id); // Still only one World update in flight.
        emit({ ...completeMessage(current), kind: 'simulation-complete' } as EngineToHostMessage);
        if (id < capacity) expect(frames()).toHaveLength(id + 1);
      }
      expect(frames()).toHaveLength(capacity);
      callbacks.at(-1)?.(64);
      expect(frames()).toHaveLength(capacity);
      const picture = completeMessage(frame) as never;
      emit({ kind: 'render-submitted', epoch: 1, frame: picture });
      emit({ kind: 'render-complete', epoch: 0, frame: picture });
      expect(frames()).toHaveLength(capacity); // No source credit for submit or stale epoch.
      probes.now = 65;
      emit({ kind: 'render-complete', epoch: 1, frame: picture });
      expect(frames()).toHaveLength(capacity + 1);
      expect(frames().at(-1)?.frameId).toBe(capacity + 1);
      emit({ kind: 'render-complete', epoch: 1, frame: picture });
      expect(frames()).toHaveLength(capacity + 1);
    } finally {
      await app.dispose();
    }
  });

  it('retains a resume reset while publication capacity is full', async () => {
    const { app, callbacks, frame } = await createRunningApp('render-worker');
    const emit = listener();
    emit({
      ...completeMessage(frame),
      kind: 'simulation-complete',
    } as EngineToHostMessage);
    callbacks.at(-1)?.(16);
    const second = frames().at(-1);
    if (second === undefined) throw new Error('Expected the second sealed publication');
    emit({ ...completeMessage(second), kind: 'simulation-complete' } as EngineToHostMessage);
    app.pause().unwrap();
    app.resume().unwrap();
    callbacks.at(-1)?.(32);
    expect(frames()).toHaveLength(2);
    emit({ kind: 'render-complete', epoch: 1, frame: completeMessage(frame) as never });
    const resumed = frames().at(-1);
    if (resumed === undefined) throw new Error('Expected an admitted simulation frame');
    expect(resumed).toMatchObject({ frameId: 3, deltaSeconds: 0, temporalReset: true });
    emit({
      ...completeMessage(resumed),
      kind: 'simulation-complete',
    } as EngineToHostMessage);
    emit({ kind: 'render-complete', epoch: 1, frame: completeMessage(second) as never });
    callbacks.at(-1)?.(48);
    expect(frames()).toHaveLength(4);
    expect(frames().at(-1)?.temporalReset).not.toBe(true);
    await app.dispose();
  });

  it('does not regress completed frame 4 when old frame 1 arrives or block frame 5', async () => {
    const { app, callbacks, frame } = await createRunningApp('render-worker');
    const emit = listener();
    try {
      for (let frameId = 1; frameId <= 4; frameId++) {
        const current = frames().at(-1);
        if (current === undefined) throw new Error('Expected an admitted frame');
        expect(current.frameId).toBe(frameId);
        emit({ ...completeMessage(current), kind: 'simulation-complete' } as EngineToHostMessage);
        emit({
          kind: 'render-submitted',
          epoch: 1,
          frame: {
            kind: 'frame-submitted',
            worldIdentity: current.worldIdentity,
            frameId,
            deviceGeneration: 1,
          },
        });
        emit({ kind: 'render-complete', epoch: 1, frame: completeMessage(current) as never });
        if (frameId < 4) callbacks.at(-1)?.(frameId * 16);
      }
      emit({ kind: 'render-complete', epoch: 1, frame: completeMessage(frame) as never });
      emit({
        kind: 'render-submitted',
        epoch: 1,
        frame: {
          kind: 'frame-submitted',
          worldIdentity: frame.worldIdentity,
          frameId: 1,
          deviceGeneration: 1,
        },
      });
      expect(app.execution.report().render).toMatchObject({
        submittedFrame: 4,
        completedFrame: 4,
      });
      expect(probes.browserCompleted).toHaveBeenCalledTimes(4);
      callbacks.at(-1)?.(64);
      expect(frames().map((message) => message.frameId)).toEqual([1, 2, 3, 4, 5]);
      expect(app.lastError).toBeUndefined();
    } finally {
      await app.dispose();
    }
  });

  it('does not extend an outstanding frame deadline on duplicate render readiness', async () => {
    const { app } = await createRunningApp('render-worker');
    await vi.advanceTimersByTimeAsync(1500);
    listener()({ kind: 'render-ready', epoch: 1 });
    await vi.advanceTimersByTimeAsync(501);
    expect(app.execution.report().fault?.code).toBe('app-execution-deadline-exceeded');
    await app.dispose();
  });

  it.each([
    2, 3,
  ] as const)('reopens capacity %s admission only after the replacement renderer is ready', async (capacity) => {
    const { app, callbacks, frame } = await createRunningApp('render-worker', capacity);
    const emit = listener();
    emit({
      ...completeMessage(frame),
      kind: 'simulation-complete',
    } as EngineToHostMessage);
    emit({ kind: 'render-lost', epoch: 2, detail: 'replacement fixture' });
    emit({ kind: 'render-complete', epoch: 1, frame: completeMessage(frame) as never });
    emit({ kind: 'render-ready', epoch: 1 });
    emit({ kind: 'render-complete', epoch: 2, frame: completeMessage(frame) as never });
    await vi.advanceTimersByTimeAsync(3000);
    expect(frames()).toHaveLength(1);
    expect(app.lastError).toBeUndefined();
    probes.now = 3040;
    emit({ kind: 'render-ready', epoch: 2 });
    callbacks.at(-1)?.(3040); // Canvas replacement retires the previous platform tick.
    expect(frames()).toHaveLength(2);
    const resumed = frames().at(-1);
    if (resumed === undefined) throw new Error('Expected an admitted simulation frame');
    expect(resumed).toMatchObject({ frameId: 2, sampleTimeSeconds: 3.04 });
    emit({
      ...completeMessage(resumed),
      kind: 'simulation-complete',
    } as EngineToHostMessage);
    callbacks.at(-1)?.(3056);
    expect(frames()).toHaveLength(3);
    const successor = frames().at(-1);
    if (successor === undefined) throw new Error('Expected the replacement successor');
    emit({ ...completeMessage(successor), kind: 'simulation-complete' } as EngineToHostMessage);
    callbacks.at(-1)?.(3072);
    emit({ kind: 'render-ready', epoch: 2 });
    expect(frames()).toHaveLength(capacity + 1);
    await app.dispose();
    emit({ kind: 'render-complete', epoch: 2, frame: completeMessage(resumed) as never });
    expect(frames()).toHaveLength(capacity + 1);
  });

  it('projects the actual Render Worker backend and storage-buffer limit into the report', async () => {
    const { app } = await createRunningApp('render-worker');
    listener()({
      kind: 'render-ready',
      epoch: 1,
      capabilities: { backendKind: 'webgpu', compute: true, storageBuffer: false },
      limits: { maxStorageBuffersPerShaderStage: 0 },
    });

    expect(app.execution.report().render).toMatchObject({
      epoch: 1,
      state: 'alive',
      capabilities: { backendKind: 'webgpu', compute: true, storageBuffer: false },
      limits: { maxStorageBuffersPerShaderStage: 0 },
    });
    await app.dispose();
  });

  it('retains an in-flight simulation request through render loss and replacement readiness', async () => {
    const { app, callbacks, frame } = await createRunningApp('render-worker');
    const emit = listener();
    try {
      callbacks.at(-1)?.(16);
      emit({ kind: 'render-lost', epoch: 2, detail: 'loss before source update' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(app.lastError).toBeUndefined();
      expect(app.execution.report().frame).toMatchObject({ completed: 0, inFlight: 1 });

      emit({ kind: 'render-ready', epoch: 2 });
      callbacks.at(-1)?.(3040);
      expect(frames()).toEqual([frame]);
      probes.now = 3050;
      emit({
        ...completeMessage(frame),
        kind: 'simulation-complete',
      } as EngineToHostMessage);
      expect(frames()).toHaveLength(2);
      const next = frames().at(-1);
      if (next === undefined) throw new Error('Expected an admitted simulation frame');
      expect(next).toMatchObject({ frameId: 2, sampleTimeSeconds: 3.05 });
      emit({
        ...completeMessage(next),
        kind: 'simulation-complete',
      } as EngineToHostMessage);
      callbacks.at(-1)?.(3066);

      const picture = completeMessage(frame) as never;
      emit({ kind: 'render-complete', epoch: 1, frame: picture });
      emit({ kind: 'render-ready', epoch: 2 });
      expect(frames()).toHaveLength(2);
      emit({ kind: 'render-complete', epoch: 2, frame: picture });
      expect(frames()).toHaveLength(3);
      expect(frames().at(-1)?.frameId).toBe(3);
      expect(app.execution.report().render?.completedFrame).toBe(1);
      expect(app.lastError).toBeUndefined();
    } finally {
      await app.dispose();
    }
  });

  it('restores source capacity only after the complete paired World rebuild', async () => {
    const { app, callbacks, frame } = await createRunningApp('render-worker');
    const emit = listener();
    try {
      emit({
        kind: 'fault',
        source: 'world',
        worldIdentity: frame.worldIdentity,
        code: 'system-failed',
        expected: 'World update succeeds',
        hint: 'rebuild the poisoned World',
        detail: {},
        partialWrite: true,
        retryable: false,
      });
      const rebuilding = app.execution.rebuild();
      emit({ kind: 'render-ready', epoch: 1 });
      expect(app.execution.report().render?.state).toBe('rebuilding');
      expect(frames()).toEqual([frame]);
      emit({
        kind: 'rebuilt',
        previousWorldIdentity: frame.worldIdentity,
        worldIdentity: 'rebuilt-world',
      });
      expect((await rebuilding).ok).toBe(true);
      app.start().unwrap();
      callbacks.at(-1)?.(32);
      expect(frames()).toHaveLength(2);
      const fresh = frames().at(-1);
      if (fresh === undefined) throw new Error('Expected an admitted simulation frame');
      expect(fresh).toMatchObject({ frameId: 1, worldIdentity: 'rebuilt-world' });
      callbacks.at(-1)?.(48);

      emit({
        ...completeMessage(frame),
        kind: 'simulation-complete',
      } as EngineToHostMessage);
      const oldPicture = completeMessage(frame) as never;
      emit({ kind: 'render-complete', epoch: 1, frame: oldPicture });
      expect(frames()).toHaveLength(2);
      expect(app.execution.report().frame).toMatchObject({ completed: 0, inFlight: 1 });
      expect(app.execution.report().render?.completedFrame).toBe(0);

      probes.now = 56;
      emit({
        ...completeMessage(fresh),
        kind: 'simulation-complete',
      } as EngineToHostMessage);
      expect(frames()).toHaveLength(3);
      expect(frames().at(-1)).toMatchObject({ frameId: 2, worldIdentity: 'rebuilt-world' });
      const freshPicture = completeMessage(fresh) as never;
      emit({ kind: 'render-complete', epoch: 1, frame: freshPicture });
      expect(app.execution.report().render?.completedFrame).toBe(1);
      expect(app.execution.report().frame).toMatchObject({ completed: 1, inFlight: 1 });
      expect(frames()).toHaveLength(3);
    } finally {
      await app.dispose();
    }
  });

  it('does not inspect the ledger or read the callback for a disabled diagnostic tick', async () => {
    vi.stubGlobal('__forgeaxFramePhaseDiagnostics', {
      execution: {
        enabled: false,
        get emit() {
          throw new Error('disabled callback read');
        },
      },
    });
    const { app, callbacks } = await createRunningApp('render-worker');
    const inspect = vi.spyOn(FrameCreditLedger.prototype, 'inspect');
    try {
      callbacks.at(-1)?.(16); // Existing in-flight guard returns without inspect().
      expect(inspect).not.toHaveBeenCalled();
      expect(frames()).toHaveLength(1);
    } finally {
      inspect.mockRestore();
      await app.dispose();
    }
  });

  it('observes actual tick, ACK and admission identities without retaining a stale device or ledger', async () => {
    const events: ExecutionDiagnosticEvent[] = [];
    const execution = {
      enabled: true,
      failures: 0,
      emit: (event: ExecutionDiagnosticEvent) => events.push(event),
    };
    vi.stubGlobal('__forgeaxFramePhaseDiagnostics', { enabled: false, execution });
    const { app, callbacks, frame } = await createRunningApp('render-worker');
    const emit = listener();
    try {
      callbacks.at(-1)?.(15);
      expect(events.at(-1)).toMatchObject({
        event: 'host-admission',
        outcome: 'simulation-in-flight',
        frameId: null,
        deviceGeneration: null,
        frameDue: true,
        ledger: { submitted: 1, completed: 0, inFlight: 1 },
      });
      const blocked = events.at(-1);
      const simulation = {
        kind: 'simulation-complete',
        worldIdentity: frame.worldIdentity,
        frameId: frame.frameId,
        engineUpdateMs: 2,
        kernelWaitMs: 0,
      } as const;
      emit(simulation);
      expect(frames()).toHaveLength(2);
      const second = frames().at(-1);
      if (second === undefined) throw new Error('Missing admitted successor');
      emit({ ...simulation, frameId: second.frameId });
      callbacks.at(-1)?.(31);
      expect(events.at(-1)).toMatchObject({
        event: 'host-admission',
        outcome: 'render-credit',
        frameId: null,
        deviceGeneration: null,
        frameDue: true,
        capacity: 2,
        renderCompletedFrame: 0,
        ledger: { submitted: 2, completed: 2, inFlight: 0 },
      });
      const picture = { ...completeMessage(frame), deviceGeneration: 9 } as never;
      emit({ kind: 'render-complete', epoch: 0, frame: picture });
      expect(events.at(-1)).toMatchObject({
        event: 'host-ack-entry',
        frameId: 1,
        deviceGeneration: 9,
        messageRenderEpoch: 0,
        renderEpoch: 1,
      });
      expect(frames()).toHaveLength(2);
      emit({ kind: 'render-complete', epoch: 1, frame: picture });
      expect(frames()).toHaveLength(3);
      expect(events.at(-2)).toMatchObject({
        event: 'host-ack-accepted',
        frameId: 1,
        deviceGeneration: 9,
        renderCompletedFrame: 1,
      });
      expect(events.at(-1)).toMatchObject({
        event: 'host-admission',
        outcome: 'issued',
        frameId: 3,
        deviceGeneration: null,
        frameDue: false,
        ledger: { submitted: 3, completed: 2, inFlight: 1 },
      });
      expect(blocked).toMatchObject({ ledger: { submitted: 1, completed: 0, inFlight: 1 } });
      const accepted = events.filter((event) => event.event === 'host-ack-accepted').length;
      emit({ kind: 'render-complete', epoch: 1, frame: picture });
      emit({ ...simulation, frameId: 99, worldIdentity: 'foreign-world' });
      expect(events.at(-1)).toMatchObject({
        event: 'host-ack-entry',
        frameId: 99,
        worldIdentity: 'worker-world',
        messageWorldIdentity: 'foreign-world',
        deviceGeneration: null,
      });
      expect(events.filter((event) => event.event === 'host-ack-accepted')).toHaveLength(accepted);
      expect(execution.failures).toBe(0);
    } finally {
      await app.dispose();
    }
  });

  it('retains observer failure while leaving the existing due tick and source credit behavior intact', async () => {
    const execution = {
      enabled: true,
      failures: 0,
      emit: () => {
        throw new Error('collector failed');
      },
    };
    vi.stubGlobal('__forgeaxFramePhaseDiagnostics', { execution });
    const { app, callbacks, frame } = await createRunningApp();
    try {
      callbacks.at(-1)?.(16);
      listener()(completeMessage(frame));
      expect(frames()).toHaveLength(2);
      expect(frames().at(-1)).toMatchObject({ frameId: 2, deltaSeconds: 0.016 });
      expect(execution.failures).toBeGreaterThan(0);
      expect(app.lastError).toBeUndefined();
    } finally {
      await app.dispose();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('preserves elapsed time when render completion wakes a still-running simulation frame', async () => {
    const { app, callbacks, frame } = await createRunningApp('render-worker');
    const emit = listener();
    emit({
      ...completeMessage(frame),
      kind: 'simulation-complete',
    } as EngineToHostMessage);
    callbacks.at(-1)?.(16);
    const next = probes.sessionPost.mock.calls.at(-1)?.[0] as ExecutionFrameMessage;
    emit({ kind: 'render-complete', epoch: 1, frame: completeMessage(frame) as never });
    callbacks.at(-1)?.(32);
    expect(probes.sessionPost.mock.calls.at(-1)?.[0]).toBe(next);
    probes.now = 40;
    emit({
      ...completeMessage(next),
      kind: 'simulation-complete',
    } as EngineToHostMessage);
    expect(probes.sessionPost.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'frame',
      frameId: 3,
      deltaSeconds: 0.024,
      sampleTimeSeconds: 0.04,
    });
    await app.dispose();
  });

  it('settles rejected-frame credit before a throwing error listener and admits a real retry', async () => {
    const { app, callbacks, frame } = await createRunningApp();
    const unsubscribe = app.onError(() => {
      throw new Error('listener fixture');
    });
    expect(() =>
      listener()({
        ...completeMessage(frame),
        kind: 'simulation-complete',
        renderRejection: {
          code: 'frame-submit-rejected',
          expected: 'no queue acceptance',
          hint: 'retry',
          detail: { operation: 'draw', stage: 'submit', accepted: false },
        },
      } as EngineToHostMessage),
    ).toThrow('listener fixture');
    unsubscribe();
    expect(app.execution.report().frame.completed).toBe(1); // Simulation credit, not a Render receipt.
    expect(probes.browserCompleted).not.toHaveBeenCalled();
    callbacks.at(-1)?.(16);
    const next = probes.sessionPost.mock.calls.at(-1)?.[0] as ExecutionFrameMessage;
    expect(next).toMatchObject({ kind: 'frame', frameId: 2 });
    listener()(completeMessage(next));
    expect(app.execution.report().frame.completed).toBe(2);
    expect(probes.browserCompleted).toHaveBeenCalledTimes(1);
    expect(probes.sessionDispose).not.toHaveBeenCalled();
    await app.dispose();
  });

  it('retains the resume reset through a rejected picture until a successful retry', async () => {
    const { app, callbacks, frame } = await createRunningApp();
    listener()(completeMessage(frame));
    app.pause().unwrap();
    app.resume().unwrap();
    callbacks.at(-1)?.(16);
    const rejected = probes.sessionPost.mock.calls.at(-1)?.[0] as ExecutionFrameMessage;
    expect(rejected.temporalReset).toBe(true);
    listener()({
      ...completeMessage(rejected),
      kind: 'simulation-complete',
      renderRejection: {
        code: 'frame-submit-rejected',
        expected: 'no queue acceptance',
        hint: 'retry',
        detail: { operation: 'draw', stage: 'submit', accepted: false },
      },
    } as EngineToHostMessage);
    callbacks.at(-1)?.(32);
    const retried = probes.sessionPost.mock.calls.at(-1)?.[0] as ExecutionFrameMessage;
    expect(retried.temporalReset).toBe(true);
    listener()(completeMessage(retried));
    callbacks.at(-1)?.(48);
    expect(
      (probes.sessionPost.mock.calls.at(-1)?.[0] as ExecutionFrameMessage).temporalReset,
    ).not.toBe(true);
    await app.dispose();
  });

  it('still reports a fatal frame timeout when the Worker never submits', async () => {
    const { app } = await createRunningApp();

    await vi.advanceTimersByTimeAsync(2_001);

    expect(app.execution.report().fault?.code).toBe('app-execution-deadline-exceeded');
    expect(app.lastError?.code).toBe('app-system-update-failed');
    expect(app.execution.report().world.identity).toBeNull();
    expect(probes.sessionDispose).toHaveBeenCalledTimes(1);
  });

  it('rejects reentrant and later inspection after terminal owner loss without posting work', async () => {
    const { app } = await createRunningApp();
    const remoteEval = app.remoteEval;
    if (remoteEval === undefined) throw new Error('Worker App exposes remoteEval');
    const requests: ReturnType<typeof remoteEval>[] = [];
    const inspect = () => {
      const request = remoteEval('return 1', 'worker-world');
      void request.catch(() => undefined);
      requests.push(request);
    };
    app.onError(inspect);
    const posted = probes.sessionPost.mock.calls.length;
    try {
      await vi.advanceTimersByTimeAsync(2_001);
      inspect();
      expect(requests).toHaveLength(2);
      expect(probes.sessionPost).toHaveBeenCalledTimes(posted);
      for (const request of requests) {
        await expect(request).rejects.toBe(app.lastError);
        await expect(request.started).rejects.toBe(app.lastError);
        await expect(request.cancel()).resolves.toBe(true);
      }
    } finally {
      await app.dispose();
    }
  });

  it('clears only admission on submit and waits for the real completion before the next frame', async () => {
    const { app, callbacks, frame } = await createRunningApp();
    const onMessage = listener();

    onMessage({
      kind: 'frame-submitted',
      worldIdentity: frame.worldIdentity,
      frameId: frame.frameId,
      deviceGeneration: 1,
    });
    await vi.advanceTimersByTimeAsync(2_001);

    expect(app.lastError).toBeUndefined();
    expect(app.execution.report().frame).toMatchObject({
      submitted: 1,
      completed: 0,
      inFlight: 1,
    });
    // The next tick is already requested, but it cannot spend occupied credit.
    expect(callbacks).toHaveLength(2);

    onMessage(completeMessage(frame));

    expect(app.lastError).toBeUndefined();
    expect(app.execution.report().frame).toMatchObject({
      submitted: 1,
      completed: 1,
      inFlight: 0,
    });
    expect(callbacks).toHaveLength(2);
  });

  it('keeps a rejected receipt fatal after submission', async () => {
    const { app, frame } = await createRunningApp();
    const onMessage = listener();
    onMessage({
      kind: 'frame-submitted',
      worldIdentity: frame.worldIdentity,
      frameId: frame.frameId,
      deviceGeneration: 1,
    });
    onMessage({
      kind: 'fault',
      worldIdentity: frame.worldIdentity,
      source: 'runtime',
      code: 'queue-submit-failed',
      expected: 'the frame receipt completes',
      hint: 'inspect the retained GPU error',
      detail: { cause: 'fence rejected' },
      partialWrite: false,
      retryable: false,
    });

    expect(app.execution.report().fault?.code).toBe('queue-submit-failed');
    expect(app.lastError?.code).toBe('app-system-update-failed');
    expect(probes.sessionDispose).toHaveBeenCalledTimes(1);
  });

  it('does not let a duplicate old submission clear the next frame watchdog', async () => {
    const { app, callbacks, frame } = await createRunningApp();
    const onMessage = listener();
    onMessage({
      kind: 'frame-submitted',
      worldIdentity: frame.worldIdentity,
      frameId: frame.frameId,
      deviceGeneration: 1,
    });
    onMessage(completeMessage(frame));
    callbacks[1]?.(16);
    const nextFrame = probes.sessionPost.mock.calls[1]?.[0] as ExecutionFrameMessage;
    expect(nextFrame.frameId).toBe(frame.frameId + 1);

    onMessage({
      kind: 'frame-submitted',
      worldIdentity: frame.worldIdentity,
      frameId: frame.frameId,
      deviceGeneration: 1,
    });
    await vi.advanceTimersByTimeAsync(2_001);

    expect(app.execution.report().fault?.code).toBe('app-execution-deadline-exceeded');
    expect(app.execution.report().frame).toMatchObject({
      submitted: 2,
      completed: 1,
      inFlight: 1,
    });
  });
  function renderError(): Extract<EngineToHostMessage, { kind: 'render-error' }> {
    return {
      kind: 'render-error',
      identity: { source: 'current-source', epoch: 1 },
      worldIdentity: 'worker-world',
      error: {
        code: 'device-operation-failed',
        expected: 'valid GPU command',
        hint: 'inspect the GPU error',
        detail: {
          operation: 'renderer-event',
          cause: { code: 'gpu-validation-error', detail: { label: 'GPU fixture' } },
        },
      },
      renderer: {
        state: 'alive',
        frameId: 3,
        capabilities: { backendKind: 'wgpu-webgl2', compute: false, storageBuffer: false },
        limits: { maxStorageBuffersPerShaderStage: 0 },
      },
    };
  }

  it('retains and publishes admitted Renderer errors without changing health or frame admission', async () => {
    const { app } = await createRunningApp('render-worker');
    const observed = vi.fn();
    const off = app.onError(observed);
    const message = renderError();
    const before = app.execution.report();
    try {
      listener()({ ...message, identity: { ...message.identity, epoch: 0 } });
      listener()({ ...message, worldIdentity: 'old-world' });
      expect(observed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_900);
      listener()(message);
      expect(observed).toHaveBeenCalledTimes(1);
      expect(observed).toHaveBeenCalledWith(app.lastError);
      expect(app.lastError).toMatchObject({
        code: 'app-system-update-failed',
        detail: {
          cause: {
            ...message.error,
            renderIdentity: message.identity,
            worldIdentity: message.worldIdentity,
            renderer: message.renderer,
          },
        },
      });
      expect(app.execution.report()).toEqual(before);
      expect(probes.sessionDispose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(101);
      expect(app.execution.report().fault).toMatchObject({
        code: 'app-execution-deadline-exceeded',
        detail: { phase: 'frame', timeoutMs: 2_000 },
      });
      expect(app.lastError).toMatchObject({
        code: 'app-system-update-failed',
        detail: { cause: { phase: 'frame', timeoutMs: 2_000 } },
      });
      expect(observed).toHaveBeenCalledTimes(2);
    } finally {
      off();
      await app.dispose();
    }
  });

  it('retains the initial ready-to-listen error while the App is still idle', async () => {
    const message = { ...renderError(), omittedBeforeListenerCount: 2 };
    probes.pending.message = message;
    const { app } = await createRunningApp('render-worker');
    try {
      expect(app.lastError).toMatchObject({
        code: 'app-system-update-failed',
        detail: {
          cause: {
            ...message.error,
            renderIdentity: message.identity,
            worldIdentity: message.worldIdentity,
            renderer: message.renderer,
            omittedBeforeListenerCount: 2,
          },
        },
      });
      expect(probes.sessionDispose).not.toHaveBeenCalled();
    } finally {
      await app.dispose();
    }
  });

  it('observes errors while paused and fences disposed delivery', async () => {
    const { app } = await createRunningApp('render-worker');
    const observed = vi.fn();
    app.onError(observed);
    app.pause().unwrap();
    listener()(renderError());
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledWith(app.lastError);
    const retained = app.lastError;
    await app.dispose();
    listener()(renderError());
    expect(observed).toHaveBeenCalledTimes(1);
    expect(app.lastError).toBe(retained);
  });
});

describe('Worker inspection replies', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    probes.sessionListeners.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function inspect() {
    const { app } = await createRunningApp();
    const remoteEval = app.remoteEval;
    if (remoteEval === undefined) throw new Error('Worker App exposes remoteEval');
    const run = remoteEval('return 1', 'worker-world');
    const request = probes.sessionPost.mock.calls.at(-1)?.[0] as { readonly requestId: number };
    return { app, run, requestId: request.requestId, emit: listener() };
  }

  it('settles started and result from the same World', async () => {
    const { app, run, requestId, emit } = await inspect();
    emit({ kind: 'inspect-started', requestId, worldIdentity: 'worker-world' });
    await expect(run.started).resolves.toBeUndefined();
    emit({
      kind: 'inspect-result',
      requestId,
      worldIdentity: 'worker-world',
      result: { ok: true, value: 7 },
    });
    await expect(run).resolves.toBe(7);
    await app.dispose();
  });

  it('keeps an admitted cancel attached to the later result', async () => {
    const { app, run, requestId, emit } = await inspect();
    const cancelled = run.cancel();
    emit({ kind: 'inspect-canceled', requestId, worldIdentity: 'worker-world', admitted: true });
    await expect(cancelled).resolves.toBe(true);
    await expect(run.started).resolves.toBeUndefined();
    emit({
      kind: 'inspect-result',
      requestId,
      worldIdentity: 'worker-world',
      result: { ok: false, error: { code: 'live-eval-failed' } },
    });
    await expect(run).rejects.toMatchObject({ code: 'live-eval-failed' });
    await app.dispose();
  });

  it('rejects a cancel before admission without waiting for a result', async () => {
    const { app, run, requestId, emit } = await inspect();
    const cancelled = run.cancel();
    emit({ kind: 'inspect-canceled', requestId, worldIdentity: 'worker-world', admitted: false });
    await expect(cancelled).resolves.toBe(false);
    await expect(run).rejects.toMatchObject({ code: 'live-eval-cancelled-before-execution' });
    await expect(run.started).rejects.toMatchObject({
      code: 'live-eval-cancelled-before-execution',
    });
    await app.dispose();
  });

  it.each([
    'inspect-started',
    'inspect-canceled',
    'inspect-result',
  ] as const)('ends the request as stale when %s comes from another World', async (kind) => {
    const { app, run, requestId, emit } = await inspect();
    const cancelled = run.cancel();
    const base = { requestId, worldIdentity: 'rebuilt-world' };
    emit(
      kind === 'inspect-started'
        ? { kind, ...base }
        : kind === 'inspect-canceled'
          ? { kind, ...base, admitted: false }
          : { kind, ...base, result: { ok: true, value: 7 } },
    );
    await expect(cancelled).resolves.toBe(true);
    await expect(run).rejects.toMatchObject({ code: 'live-world-stale' });
    await expect(run.started).rejects.toMatchObject({ code: 'live-world-stale' });
    emit({
      kind: 'inspect-result',
      requestId,
      worldIdentity: 'worker-world',
      result: { ok: true, value: 7 },
    });
    await expect(run).rejects.toMatchObject({ code: 'live-world-stale' });
    await app.dispose();
  });
});
