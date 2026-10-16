import { fileURLToPath } from 'node:url';
import { describe, expect, it, type TestContext, vi } from 'vitest';
import {
  beginLearnRenderTestLifecycle,
  disposeLearnRenderTestApp,
  exposeLearnRenderTestApp,
  learnRenderTestBootstrapStage,
  trackLearnRenderTestBootstrap,
  waitForLearnRenderTestBootstrap,
} from '../learn-render-test-lifecycle';
import { isSutAttributableCode, SUT_ATTRIBUTABLE_CODES } from '../onerror-gate';

const rendererReadyFailureCodes = [
  'manifest-malformed',
  'shader-not-found',
  'shader-compile-failed',
  'feature-not-enabled',
  'limit-exceeded',
  'webgpu-runtime-error',
] as const;

const rendererDrawFailureCodes = [
  'rhi-not-available',
  'webgpu-runtime-error',
  'render-system-empty-worlds',
  'render-system-owner-out-of-range',
  'render-system-no-camera',
  'render-system-multi-camera',
  'render-system-multi-light',
  'queue-submit-failed',
  'queue-write-buffer-out-of-bounds',
  'render-feature-registration-conflict',
  'render-feature-stage-failed',
  'render-feature-capability-missing',
  'render-feature-pass-order-conflict',
  'render-feature-preparation-failed',
  'render-feature-prepared-state-mismatch',
  'render-feature-draw-recording-failed',
] as const;

describe('SUT renderer error attribution', () => {
  it('attributes every documented Renderer.ready failure code', () => {
    for (const code of rendererReadyFailureCodes) {
      expect(SUT_ATTRIBUTABLE_CODES.has(code), code).toBe(true);
    }
  });

  it('attributes documented Renderer.draw and RenderFeature failures', () => {
    for (const code of rendererDrawFailureCodes) {
      expect(SUT_ATTRIBUTABLE_CODES.has(code), code).toBe(true);
    }
  });

  it('attributes every material contract rejection from the owning closed union', async () => {
    const { MATERIAL_ERROR_CODES } = await import(
      fileURLToPath(new URL('../../../../packages/types/src/material/errors.ts', import.meta.url))
    );
    for (const code of MATERIAL_ERROR_CODES) expect(isSutAttributableCode(code), code).toBe(true);
    for (const code of [
      'material-future-contract',
      'shader-module-future-contract',
      'gltf-material-future-contract',
    ])
      expect(isSutAttributableCode(code), code).toBe(true);
  });

  it('does not attribute environment lifecycle noise to the demo', () => {
    expect(isSutAttributableCode('device-lost')).toBe(false);
    expect(isSutAttributableCode('adapter-unavailable')).toBe(false);
    expect(isSutAttributableCode('unknown-environment-code')).toBe(false);
  });
});

describe('SUT failure stage evidence', () => {
  it.each([
    false,
    true,
  ])('reports the import stage before cleanup (broken sink: %s)', async (brokenSink) => {
    let body: (() => Promise<void>) | undefined;
    let cleanup: ((context: TestContext) => Promise<void>) | undefined;
    let budget: number | undefined;
    const order: string[] = [];
    const removeChild = vi.fn();
    const owner = { parentNode: { removeChild } } as unknown as HTMLCanvasElement;
    const failure = new Error('original SUT import failure');
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {
      order.push('diagnostic');
      if (brokenSink) throw new Error('diagnostic transport failed');
    });
    vi.stubGlobal('document', {
      createElement: () => owner,
      body: { appendChild() {} },
    });
    vi.stubGlobal('navigator', { gpu: {} });
    vi.resetModules();
    vi.doMock('vitest', () => ({
      afterEach: (hook: typeof cleanup) => {
        cleanup = hook;
      },
      describe: (_name: string, define: () => void) => define(),
      expect,
      it: (_name: string, run: typeof body, timeoutMs: number) => {
        body = run;
        budget = timeoutMs;
      },
    }));
    try {
      const { onerrorGate } = await import('../onerror-gate');
      onerrorGate('import-stage-fixture', async () => {
        throw failure;
      });
      if (body === undefined || cleanup === undefined) throw new Error('missing native gate hooks');
      expect(budget).toBe(30_000);
      await expect(body()).rejects.toBe(failure);
      exposeLearnRenderTestApp(
        {
          renderer: {
            dispose() {
              order.push('renderer-dispose');
            },
          },
          async dispose() {
            order.push('app-dispose');
          },
        },
        owner,
      );
      expect(learnRenderTestBootstrapStage(owner)?.name).toBe('importSut');
      await cleanup({ task: { result: { state: 'fail' } } } as TestContext);
      expect(order).toEqual(['diagnostic', 'app-dispose', 'renderer-dispose']);
      expect(logger).toHaveBeenCalledWith('[learn-render.onerror-failure]', expect.any(String));
      expect(JSON.parse(String(logger.mock.calls[0]?.[1]))).toEqual({
        sectionName: 'import-stage-fixture',
        stage: 'importSut',
        stageElapsedMs: expect.any(Number),
      });
      expect(learnRenderTestBootstrapStage(owner)).toBeUndefined();
      expect(removeChild).toHaveBeenCalledOnce();
      await cleanup({ task: { result: { state: 'fail' } } } as TestContext);
      expect(logger).toHaveBeenCalledOnce();
    } finally {
      await disposeLearnRenderTestApp(owner);
      logger.mockRestore();
      vi.unstubAllGlobals();
      vi.doUnmock('vitest');
      vi.resetModules();
    }
  });
});

describe('SUT error observation window', () => {
  it.each([
    'delayed callback',
    'late error',
  ] as const)('uses elapsed quiet time with a %s', async (scenario) => {
    let body: (() => Promise<void>) | undefined;
    let cleanup: ((context: TestContext) => Promise<void>) | undefined;
    const owner = { parentNode: { removeChild() {} } } as unknown as HTMLCanvasElement;
    vi.stubGlobal('document', {
      createElement: () => owner,
      body: { appendChild() {} },
    });
    vi.stubGlobal('navigator', { gpu: {} });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const schedule = setTimeout;
    if (scenario === 'delayed callback') {
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        ...[callback, delay, ...args]: Parameters<typeof setTimeout>
      ) => schedule(callback, delay === 50 ? 1_000 : delay, ...args)) as typeof setTimeout);
    }
    vi.resetModules();
    vi.doMock('vitest', () => ({
      afterEach: (hook: typeof cleanup) => {
        cleanup = hook;
      },
      describe: (_name: string, define: () => void) => define(),
      expect,
      it: (_name: string, run: typeof body, timeoutMs: number) => {
        body = run;
        expect(timeoutMs).toBe(30_000);
      },
    }));
    let completion: Promise<void> | undefined;
    try {
      const { onerrorGate } = await import('../onerror-gate');
      onerrorGate('quiet-window-fixture', async () => {
        if (scenario !== 'late error') return;
        const errors = (globalThis as unknown as { __learnRenderErrors: Array<{ code: string }> })
          .__learnRenderErrors;
        schedule(() => errors.push({ code: 'device-lost' }), 450);
        schedule(() => errors.push({ code: 'shader-compile-failed' }), 800);
      });
      if (body === undefined || cleanup === undefined) throw new Error('missing native gate hooks');
      let settled = false;
      let failure: unknown;
      completion = body().then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          failure = error;
        },
      );
      if (scenario === 'delayed callback') {
        await vi.advanceTimersByTimeAsync(1_000);
        expect(settled).toBe(true);
        expect(failure).toBeUndefined();
      } else {
        await vi.advanceTimersByTimeAsync(550);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(800);
        expect(settled).toBe(true);
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toContain('shader-compile-failed');
      }
    } finally {
      await vi.runAllTimersAsync();
      await completion;
      await cleanup?.({ task: { result: { state: 'pass' } } } as TestContext);
      vi.restoreAllMocks();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.doUnmock('vitest');
      vi.resetModules();
    }
  });
});

describe('SUT GPU lifecycle', () => {
  it('disposes and clears the registered app exactly once', async () => {
    let appDisposeCount = 0;
    let rendererDisposeCount = 0;
    const owner = {};
    await beginLearnRenderTestLifecycle(owner);
    exposeLearnRenderTestApp(
      {
        renderer: {
          dispose() {
            rendererDisposeCount += 1;
          },
        },
        async dispose() {
          appDisposeCount += 1;
        },
      },
      owner,
    );

    await disposeLearnRenderTestApp(owner);
    await disposeLearnRenderTestApp(owner);

    expect(appDisposeCount).toBe(1);
    expect(rendererDisposeCount).toBe(1);
  });

  it('disposes a late app from a completed test instead of retaining it', async () => {
    let rendererDisposeCount = 0;
    const oldOwner = {};
    const currentOwner = {};
    await beginLearnRenderTestLifecycle(oldOwner);
    await disposeLearnRenderTestApp(oldOwner);
    await beginLearnRenderTestLifecycle(currentOwner);

    exposeLearnRenderTestApp(
      {
        renderer: {
          dispose() {
            rendererDisposeCount += 1;
          },
        },
        async dispose() {},
      },
      oldOwner,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rendererDisposeCount).toBe(1);
    await disposeLearnRenderTestApp(currentOwner);
  });

  it('waits for stale disposal before allowing the next owner to start', async () => {
    let releaseDispose!: () => void;
    let disposalStarted = false;
    const oldOwner = {};
    const nextOwner = {};
    await beginLearnRenderTestLifecycle(oldOwner);
    exposeLearnRenderTestApp(
      {
        renderer: {
          dispose() {},
        },
        dispose() {
          disposalStarted = true;
          return new Promise<void>((resolve) => {
            releaseDispose = resolve;
          });
        },
      },
      oldOwner,
    );

    const nextBegin = beginLearnRenderTestLifecycle(nextOwner);
    await Promise.resolve();
    expect(disposalStarted).toBe(true);
    let nextOwnerReady = false;
    void nextBegin.then(() => {
      nextOwnerReady = true;
    });
    await Promise.resolve();
    expect(nextOwnerReady).toBe(false);

    releaseDispose();
    await nextBegin;
    expect(nextOwnerReady).toBe(true);
    await disposeLearnRenderTestApp(nextOwner);
  });

  it('waits for a late old-owner disposal and propagates its failure', async () => {
    const oldOwner = {};
    const currentOwner = {};
    const nextOwner = {};
    const failure = new Error('late plugin cleanup failed');
    await beginLearnRenderTestLifecycle(oldOwner);
    await disposeLearnRenderTestApp(oldOwner);
    await beginLearnRenderTestLifecycle(currentOwner);

    exposeLearnRenderTestApp(
      {
        renderer: {
          dispose() {},
        },
        async dispose() {
          return { ok: false, error: failure };
        },
      },
      oldOwner,
    );

    await expect(beginLearnRenderTestLifecycle(nextOwner)).rejects.toBe(failure);
    await disposeLearnRenderTestApp(nextOwner);
  });

  it('waits for the tracked bootstrap before admitting the next owner', async () => {
    let releaseBootstrap!: () => void;
    let releaseAppDispose!: () => void;
    const oldOwner = {};
    const nextOwner = {};
    await beginLearnRenderTestLifecycle(oldOwner);

    const lateApp = {
      renderer: {
        dispose() {},
      },
      dispose() {
        return new Promise<void>((resolve) => {
          releaseAppDispose = resolve;
        });
      },
    };
    const bootstrap = new Promise<void>((resolve) => {
      releaseBootstrap = () => {
        exposeLearnRenderTestApp(lateApp, oldOwner);
        resolve();
      };
    });
    trackLearnRenderTestBootstrap(bootstrap, oldOwner);

    const nextBegin = beginLearnRenderTestLifecycle(nextOwner);
    await Promise.resolve();
    let nextOwnerReady = false;
    void nextBegin.then(() => {
      nextOwnerReady = true;
    });
    await Promise.resolve();
    expect(nextOwnerReady).toBe(false);

    releaseBootstrap();
    await Promise.resolve();
    expect(nextOwnerReady).toBe(false);
    releaseAppDispose();
    await nextBegin;
    expect(nextOwnerReady).toBe(true);
    await disposeLearnRenderTestApp(nextOwner);
  });

  it('waits for a tracked bootstrap before disposing the current app', async () => {
    let releaseBootstrap!: () => void;
    let appDisposeCount = 0;
    let rendererDisposeCount = 0;
    const owner = {};
    await beginLearnRenderTestLifecycle(owner);

    const bootstrap = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    trackLearnRenderTestBootstrap(bootstrap, owner);
    exposeLearnRenderTestApp(
      {
        renderer: {
          dispose() {
            rendererDisposeCount += 1;
          },
        },
        async dispose() {
          appDisposeCount += 1;
        },
      },
      owner,
    );

    let waitDone = false;
    const waiting = waitForLearnRenderTestBootstrap(owner).then(() => {
      waitDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(waitDone).toBe(false);
    expect(appDisposeCount).toBe(0);
    expect(rendererDisposeCount).toBe(0);

    releaseBootstrap();
    await waiting;
    expect(appDisposeCount).toBe(0);
    expect(rendererDisposeCount).toBe(0);

    await disposeLearnRenderTestApp(owner);
    expect(appDisposeCount).toBe(1);
    expect(rendererDisposeCount).toBe(1);
    await disposeLearnRenderTestApp(owner);
    expect(appDisposeCount).toBe(1);
    expect(rendererDisposeCount).toBe(1);
  });

  it('retains an app when a real smoke bootstrap has no test owner', async () => {
    let disposalStarted = false;
    let releaseDispose!: () => void;
    const owner = {};
    const app = {
      renderer: { dispose() {} },
      dispose() {
        disposalStarted = true;
        return new Promise<void>((resolve) => {
          releaseDispose = resolve;
        });
      },
    };

    trackLearnRenderTestBootstrap(Promise.resolve(), owner);
    exposeLearnRenderTestApp(app, owner);
    await Promise.resolve();

    expect(disposalStarted).toBe(false);

    const disposing = disposeLearnRenderTestApp(owner);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposalStarted).toBe(true);
    releaseDispose();
    await disposing;
  });

  it('disposes a late app while its tracked bootstrap is still pending', async () => {
    let releaseBootstrap!: () => void;
    let appDisposeCount = 0;
    let rendererDisposeCount = 0;
    const owner = {};
    await beginLearnRenderTestLifecycle(owner);

    const bootstrap = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    trackLearnRenderTestBootstrap(bootstrap, owner);

    const teardown = disposeLearnRenderTestApp(owner);
    await Promise.resolve();
    exposeLearnRenderTestApp(
      {
        renderer: {
          dispose() {
            rendererDisposeCount += 1;
          },
        },
        async dispose() {
          appDisposeCount += 1;
        },
      },
      owner,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(appDisposeCount).toBe(1);
    expect(rendererDisposeCount).toBe(1);

    releaseBootstrap();
    await teardown;
    await disposeLearnRenderTestApp(owner);
    expect(appDisposeCount).toBe(1);
    expect(rendererDisposeCount).toBe(1);
    await disposeLearnRenderTestApp(owner);
    expect(appDisposeCount).toBe(1);
    expect(rendererDisposeCount).toBe(1);
  });

  it('propagates a tracked bootstrap rejection through the wait API', async () => {
    const owner = {};
    const failure = new Error('bootstrap wait failed');
    await beginLearnRenderTestLifecycle(owner);
    trackLearnRenderTestBootstrap(Promise.reject(failure), owner);

    await expect(waitForLearnRenderTestBootstrap(owner)).rejects.toBe(failure);
    await disposeLearnRenderTestApp(owner);
  });

  it('fails the final teardown when a tracked bootstrap rejects', async () => {
    const owner = {};
    const failure = new Error('bootstrap cleanup failed');
    await beginLearnRenderTestLifecycle(owner);
    trackLearnRenderTestBootstrap(Promise.reject(failure), owner);

    await expect(disposeLearnRenderTestApp(owner)).rejects.toBe(failure);
    await disposeLearnRenderTestApp(owner);
  });

  it('fails closed on an App disposal Result.err while releasing the renderer', async () => {
    let rendererDisposeCount = 0;
    const owner = {};
    const failure = new Error('plugin cleanup failed');
    await beginLearnRenderTestLifecycle(owner);
    exposeLearnRenderTestApp(
      {
        renderer: {
          dispose() {
            rendererDisposeCount += 1;
          },
        },
        async dispose() {
          return { ok: false, error: failure };
        },
      },
      owner,
    );

    await expect(disposeLearnRenderTestApp(owner)).rejects.toBe(failure);
    expect(rendererDisposeCount).toBe(1);
    await disposeLearnRenderTestApp(owner);
  });

  it('fails closed when App disposal rejects with undefined', async () => {
    let rendererDisposeCount = 0;
    const owner = {};
    await beginLearnRenderTestLifecycle(owner);
    exposeLearnRenderTestApp(
      {
        renderer: {
          dispose() {
            rendererDisposeCount += 1;
          },
        },
        async dispose() {
          throw undefined;
        },
      },
      owner,
    );

    await expect(disposeLearnRenderTestApp(owner)).rejects.toBeUndefined();
    expect(rendererDisposeCount).toBe(1);
    await disposeLearnRenderTestApp(owner);
  });
});
