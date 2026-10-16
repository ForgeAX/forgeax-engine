import { describe, expect, it } from 'vitest';
import { createApp, measureCanvasDrawingBuffer } from '@forgeax/engine-app/browser';
import { workerSelection } from '../src/__tests__/execution-fixtures';
import type { InputBackendSample } from '@forgeax/engine-input';
import { startEngineWorker, type EngineWorkerSession } from '../src/execution/engine-worker';
import type {
  EngineToHostMessage,
  ExecutionFrameCompletion,
  ExecutionFrameMessage,
} from '../src/execution/protocol';

function waitForAspect(port: MessagePort, expected: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      port.removeEventListener('message', onMessage);
      reject(new Error(`worker did not report aspect ${expected}`));
    }, 5_000);
    const onMessage = (event: MessageEvent<{ kind?: string; aspect?: number }>): void => {
      if (event.data.kind !== 'camera-aspect') return;
      if (Math.abs((event.data.aspect ?? 0) - expected) > 1e-4) return;
      window.clearTimeout(timeout);
      port.removeEventListener('message', onMessage);
      resolve();
    };
    port.addEventListener('message', onMessage);
    port.start();
  });
}

function waitForFrameCompletion(
  session: EngineWorkerSession,
  frameId: number,
  expectedWidth: number,
  expectedHeight: number,
): Promise<ExecutionFrameCompletion> {
  return new Promise((resolve, reject) => {
    let off = (): void => undefined;
    const timeout = window.setTimeout(() => {
      off();
      reject(new Error(`worker did not report barrel frame ${frameId}`));
    }, 10_000);
    off = session.listen((message) => {
      if (message.kind !== 'frame-complete' || message.frameId !== frameId) return;
      window.clearTimeout(timeout);
      off();
      try {
        expect(message.barrelDistortion).toMatchObject({
          width: expectedWidth,
          height: expectedHeight,
          centerX: 0.5,
          centerY: 0.5,
        });
        expect(message.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
        expect(message.barrelDistortion?.camera).toBeDefined();
        resolve(message);
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe('Engine Worker canvas resize', () => {
  it.each([
    false,
    true,
  ])('discards hidden time through the real Worker World with render worker %s', async (render) => {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:64px;height:64px';
    document.body.append(canvas);
    const channel = new MessageChannel();
    const deltas: number[] = [];
    channel.port1.onmessage = (event) => {
      if (event.data.kind === 'camera-aspect') deltas.push(event.data.deltaSeconds);
    };
    const result = await createApp(
      canvas,
      {
        silenceUnhandledErrors: true,
        execution: {
          bootstrap: new URL('./worker-resize-bootstrap.ts', import.meta.url),
          bootstrapPort: channel.port2,
          workers: { engine: true, render, kernels: false },
          startupTimeoutMs: 90_000,
        },
      },
      { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href },
    );
    try {
      const app = result.unwrap();
      expect(app.execution.report().engine.realm).toBe('worker');
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      app.start().unwrap();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(deltas).toEqual([]);
      window.dispatchEvent(new PageTransitionEvent('pageshow'));
      await expect.poll(() => deltas.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
      expect(deltas[0]).toBe(0);
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      expect(app.execution.report().engine.health).toBe('idle');
      await expect.poll(() => app.execution.report().frame.inFlight, { timeout: 10_000 }).toBe(0);
      // Let the ordered feedback from the last admitted real frame reach this port.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const hiddenCount = deltas.length;
      const submitted = app.execution.report().frame.submitted;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(deltas).toHaveLength(hiddenCount);
      expect(app.execution.report().frame.submitted).toBe(submitted);
      window.dispatchEvent(new PageTransitionEvent('pageshow'));
      await expect.poll(() => deltas.length, { timeout: 10_000 }).toBeGreaterThan(hiddenCount + 1);
      expect(deltas[hiddenCount]).toBe(0);
      expect(app.execution.report().frame.highWater).toBe(1);
      app.pause().unwrap();
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      window.dispatchEvent(new PageTransitionEvent('pageshow'));
      expect(app.execution.report().engine.health).toBe('idle');
      expect(app.lastError).toBeUndefined();
      (await app.dispose()).unwrap();
      window.dispatchEvent(new PageTransitionEvent('pageshow'));
      expect(app.execution.report().engine.health).toBe('stopped');
    } finally {
      if (result.ok) {
        (await result.value.dispose()).unwrap();
        result.value.canvas?.remove();
      }
      window.dispatchEvent(new PageTransitionEvent('pageshow'));
      channel.port1.close();
      canvas.remove();
    }
  }, 120_000);

  it('transports CSS resize to the OffscreenCanvas and camera aspect', async () => {
    if (
      typeof Worker === 'undefined' ||
      typeof OffscreenCanvas === 'undefined' ||
      navigator.gpu === undefined
    )
      return;

    const canvas = document.createElement('canvas');
    canvas.style.width = '320px';
    canvas.style.height = '180px';
    document.body.appendChild(canvas);
    const channel = new MessageChannel();
    const started = await startEngineWorker({
      canvas,
      bootstrapUrl: new URL('./worker-resize-bootstrap.ts', import.meta.url).href,
      bootstrapPort: channel.port2,
      // Renderer assembly in this browser group is a real WebGPU worker
      // bootstrap, not a mocked handshake.  The previous 10 s bound was
      // shorter than the observed cold-start on the shared 8c/16g runner and
      // turned scheduler contention into a false product failure.  Keep the
      // execution deadline bounded, but give the worker one cold compile
      // window before declaring the handshake dead.
      timeoutMs: 30_000,
      workers: workerSelection({ engine: true, render: false, kernels: false }),
      workerFactory: () =>
        new Worker(new URL('../src/execution/engine-worker-runtime.ts', import.meta.url), {
          type: 'module',
          name: 'forgeax-resize-test',
        }),
    });
    const startupDetail = started.ok ? undefined : started.error.detail;
    const startupCause = startupDetail?.cause as { name?: string; message?: string } | undefined;
    expect(
      started.ok,
      started.ok
        ? undefined
        : `${started.error.code}: ${started.error.hint}; phase=${startupDetail?.phase}; cause=${startupCause?.name ?? 'unknown'}:${startupCause?.message ?? JSON.stringify(startupCause)}`,
    ).toBe(true);
    if (!started.ok) {
      channel.port1.close();
      canvas.remove();
      return;
    }
    const session = started.value;
    const sample: InputBackendSample = {
      downKeys: new Set(),
      upKeys: new Set(),
      buttons: [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
      pointerLocked: false,
    };
    const sendFrame = (frameId: number): void => {
      const size = measureCanvasDrawingBuffer(canvas, 1);
      const frame = {
        kind: 'frame' as const,
        worldIdentity: session.ready.worldIdentity,
        frameId,
        deltaSeconds: 1 / 60,
        inputSample: sample,
        canvasWidth: size.width,
        canvasHeight: size.height,
      } satisfies ExecutionFrameMessage;
      session.post(frame);
    };
    channel.port1.start();
    try {
      const firstSize = measureCanvasDrawingBuffer(canvas, 1);
      const firstCompletion = waitForFrameCompletion(session, 1, firstSize.width, firstSize.height);
      sendFrame(1);
      await waitForAspect(channel.port1, 320 / 180);
      const firstReceipt = await firstCompletion;
      expect(firstReceipt.barrelDistortion?.width).toBe(firstSize.width);
      expect(firstReceipt.barrelDistortion?.height).toBe(firstSize.height);

      canvas.style.width = '400px';
      canvas.style.height = '200px';
      const resizedSize = measureCanvasDrawingBuffer(canvas, 1);
      const resizedCompletion = waitForFrameCompletion(
        session,
        2,
        resizedSize.width,
        resizedSize.height,
      );
      sendFrame(2);
      await waitForAspect(channel.port1, 2);
      const resizedReceipt = await resizedCompletion;
      expect(resizedReceipt.barrelDistortion?.width).toBe(resizedSize.width);
      expect(resizedReceipt.barrelDistortion?.height).toBe(resizedSize.height);
      expect(resizedReceipt.barrelDistortion?.camera).toBeDefined();

      // Keep the same Worker realm alive while the host alternates its CSS
      // size. Each completion is a real submitted frame, so this observes
      // replacement of the display mapping without recreating a synthetic
      // receipt or detaching the renderer between resizes.
      canvas.style.width = '320px';
      canvas.style.height = '180px';
      const restoredSize = measureCanvasDrawingBuffer(canvas, 1);
      const restoredCompletion = waitForFrameCompletion(
        session,
        3,
        restoredSize.width,
        restoredSize.height,
      );
      sendFrame(3);
      await waitForAspect(channel.port1, 320 / 180);
      const restoredReceipt = await restoredCompletion;
      expect(restoredReceipt.barrelDistortion?.width).toBe(restoredSize.width);
      expect(restoredReceipt.barrelDistortion?.height).toBe(restoredSize.height);

      canvas.style.width = '400px';
      canvas.style.height = '200px';
      const secondResizeSize = measureCanvasDrawingBuffer(canvas, 1);
      const secondResizeCompletion = waitForFrameCompletion(
        session,
        4,
        secondResizeSize.width,
        secondResizeSize.height,
      );
      sendFrame(4);
      await waitForAspect(channel.port1, 2);
      const secondResizeReceipt = await secondResizeCompletion;
      expect(secondResizeReceipt.barrelDistortion?.width).toBe(secondResizeSize.width);
      expect(secondResizeReceipt.barrelDistortion?.height).toBe(secondResizeSize.height);

      let lateCompletionCount = 0;
      const offLateCompletion = session.listen((message) => {
        if (message.kind === 'frame-complete' && message.frameId === 5) lateCompletionCount += 1;
      });

      // Hold one real Worker delivery at the host boundary.  The old test
      // disposed immediately after post(frame 5), which only proved that no
      // completion happened during the wait; frame 5 itself might never have
      // reached the Worker.  This wrapper captures the actual completion
      // event, leaves the Engine session's handler untouched for all other
      // messages, and releases the captured event only after disposal.
      const worker = session.worker;
      const engineOnMessage = worker.onmessage;
      expect(engineOnMessage).toBeTypeOf('function');
      let capturedCompletion: MessageEvent<EngineToHostMessage> | undefined;
      let resolveCaptured: () => void = () => undefined;
      const captured = new Promise<void>((resolve) => {
        resolveCaptured = resolve;
      });
      worker.onmessage = (event: MessageEvent<EngineToHostMessage>) => {
        if (event.data.kind === 'frame-complete' && event.data.frameId === 5) {
          capturedCompletion = event;
          resolveCaptured();
          return;
        }
        engineOnMessage?.call(worker, event);
      };
      sendFrame(5);
      await captured;
      expect(capturedCompletion?.data).toMatchObject({ kind: 'frame-complete', frameId: 5 });
      session.dispose();

      // Deliver the real, previously captured completion after the owning
      // session is retired.  The listener set must already be empty, so the
      // stale frame cannot republish its display mapping.
      engineOnMessage?.call(worker, capturedCompletion as MessageEvent<EngineToHostMessage>);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
      expect(lateCompletionCount).toBe(0);
      offLateCompletion();
    } finally {
      // The dispose assertion above owns the live session; this call remains
      // idempotent and protects the cleanup path if an earlier assertion fails.
      session.dispose();
      channel.port1.close();
      canvas.remove();
    }
  }, 45_000);
});
