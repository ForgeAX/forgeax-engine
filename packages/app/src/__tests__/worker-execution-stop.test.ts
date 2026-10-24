import { createHostAudioConsumer } from '@forgeax/engine-audio-webaudio';
import { attachBrowserInputBackend } from '@forgeax/engine-input';
import { platformError as nativePlatformError } from '@forgeax/engine-platform';
import { createBrowserPlatform } from '@forgeax/engine-platform-browser';
import { err, ok } from '@forgeax/engine-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors';
import type { EngineToHostMessage } from '../execution/protocol';
import { workerSelection } from './execution-fixtures';

type SessionListener = (message: EngineToHostMessage) => void;

const probes = vi.hoisted(() => {
  const sessionListeners: SessionListener[] = [];
  return {
    audioDispose: vi.fn(),
    platformDispose: vi.fn(),
    inputDetach: vi.fn(),
    inputClear: vi.fn(),
    pointerAllowed: vi.fn(),
    inputAllowed: vi.fn(),
    sessionDispose: vi.fn(),
    sessionListen: vi.fn((listener: SessionListener) => {
      sessionListeners.push(listener);
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
        now: () => ok(performance.now()),
        visible: () => true,
        requestFrame: (callback: () => void) => {
          const id = requestAnimationFrame(callback);
          return ok(() => cancelAnimationFrame(id));
        },
        subscribe: () => ok(() => {}),
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

vi.mock('@forgeax/engine-input', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@forgeax/engine-input')>()),
  attachBrowserInputBackend: vi.fn(() => {
    const detach = (() => probes.inputDetach()) as typeof probes.inputDetach & {
      backend: import('@forgeax/engine-input').InputBackend;
    };
    detach.backend = {
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
      detach: probes.inputDetach,
      clear: vi.fn(() => probes.inputClear()),
      setPointerLockAllowed: vi.fn((allowed: boolean) => probes.pointerAllowed(allowed)),
      setInputAllowed: vi.fn((allowed: boolean) => probes.inputAllowed(allowed)),
    };
    return detach;
  }),
}));

vi.mock('@forgeax/engine-audio-webaudio', () => ({
  createHostAudioConsumer: vi.fn(() => ({
    consume: vi.fn(),
    dispose: probes.audioDispose,
    state: () => ({ contextState: 'suspended', activeSourceCount: 0, lastError: null }),
  })),
}));

import { startEngineWorker } from '../execution/engine-worker';
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

describe('Worker ExecutionApp terminal stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    probes.sessionListeners.length = 0;
    probes.sessionDispose.mockResolvedValue(ok(undefined));
  });

  it.each([
    'throw',
    'result',
  ])('releases the platform after a Worker startup %s and preserves the primary failure', async (mode) => {
    const failure = new AppError({
      code: 'app-execution-bootstrap-failed',
      expected: 'fixture',
      hint: 'fixture',
      detail: {
        phase: 'bootstrap',
        moduleUrl: 'https://example.test/game.js',
        cause: new Error('worker startup'),
      },
    });
    const options = {
      canvas: {} as HTMLCanvasElement,
      appOptions: { execution: { bootstrap: 'https://example.test/game.js' } },
      capabilities,
      selection: workerSelection({ render: false, kernels: false }),
    };
    for (const cleanupFails of [false, true]) {
      if (mode === 'throw') vi.mocked(startEngineWorker).mockRejectedValueOnce(failure);
      else vi.mocked(startEngineWorker).mockResolvedValueOnce(err(failure));
      const cleanupFailure = new Error('native cleanup');
      if (cleanupFails)
        probes.platformDispose.mockImplementationOnce(() => {
          throw cleanupFailure;
        });
      const result = createWorkerExecutionApp(options);
      if (cleanupFails) {
        await expect(result).rejects.toMatchObject({
          cause: failure,
          errors: [failure, cleanupFailure],
        });
      } else if (mode === 'throw') await expect(result).rejects.toBe(failure);
      else expect(await result).toMatchObject({ ok: false, error: failure });
    }
    expect(probes.platformDispose).toHaveBeenCalledTimes(2);
    expect(probes.sessionDispose).not.toHaveBeenCalled();
  });

  it.each([
    'old-dispose',
    'new-subscribe',
  ])('retires the newly acquired platform when replacement fails at %s', async (failureAt) => {
    const replacement = { transferControlToOffscreen: vi.fn() } as unknown as HTMLCanvasElement;
    const canvas = {
      cloneNode: () => replacement,
      replaceWith: vi.fn(),
    } as unknown as HTMLCanvasElement;
    const app = (
      await createWorkerExecutionApp({
        canvas,
        appOptions: { execution: { bootstrap: 'https://example.test/game.js' } },
        capabilities,
        selection: workerSelection({ render: false, kernels: false }),
      })
    ).unwrap();
    const current = vi.mocked(createBrowserPlatform).mock.results.at(-1)?.value.unwrap();
    if (!current) throw new Error('missing platform');
    const nextDispose = vi.fn();
    const failure = nativePlatformError('platform-operation-failed', {
      operation: failureAt,
      cause: new Error(failureAt),
    }).error;
    vi.mocked(createBrowserPlatform).mockReturnValueOnce(
      ok({
        ...current,
        dispose: nextDispose,
        ...(failureAt === 'new-subscribe' ? { subscribe: () => err(failure) } : {}),
      }),
    );
    if (failureAt === 'old-dispose')
      probes.platformDispose.mockImplementationOnce(() => {
        throw failure;
      });
    probes.sessionListeners[0]?.({
      kind: 'surface-request',
      worldIdentity: 'worker-world',
      requestId: 1,
    });
    expect(probes.sessionPost).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'surface-result',
        result: expect.objectContaining({ ok: false }),
      }),
    );
    expect(nextDispose).toHaveBeenCalledTimes(1);
    expect(replacement.transferControlToOffscreen).not.toHaveBeenCalled();
    await app.dispose();
  });

  it('forwards Host composite controls to its physical input backend', async () => {
    const result = await createWorkerExecutionApp({
      canvas: {} as HTMLCanvasElement,
      appOptions: { execution: { bootstrap: 'https://example.test/game.js' } },
      capabilities,
      selection: workerSelection({ render: false, kernels: false }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    try {
      result.value.input?.clear?.();
      result.value.input?.setPointerLockAllowed?.(false);
      result.value.input?.setInputAllowed?.(false);
      expect(probes.inputClear).toHaveBeenCalled();
      expect(probes.pointerAllowed).toHaveBeenCalledWith(false);
      expect(probes.inputAllowed).toHaveBeenCalledWith(false);
    } finally {
      await result.value.dispose();
    }
  });

  it.each([
    false,
    true,
  ])('rebuilds with a fresh Host surface when render worker is %s', async (render) => {
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const offscreen = {} as OffscreenCanvas;
    const replacement = {
      transferControlToOffscreen: vi.fn(() => offscreen),
    } as unknown as HTMLCanvasElement;
    const canvas = {
      cloneNode: vi.fn(() => replacement),
      replaceWith: vi.fn(),
    } as unknown as HTMLCanvasElement;
    const result = await createWorkerExecutionApp({
      canvas,
      appOptions: { execution: { bootstrap: 'https://example.test/game.js' } },
      capabilities,
      selection: workerSelection({ render, kernels: false }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      const oldClear = vi.mocked(attachBrowserInputBackend).mock.results.at(-1)?.value
        .backend.clear;
      expect(oldClear).toBeDefined();
      const invalid = await result.value.execution.rebuild();
      expect(invalid.ok).toBe(false);
      expect(canvas.cloneNode).not.toHaveBeenCalled();
      probes.sessionListeners[0]?.({
        kind: 'fault',
        source: 'world',
        worldIdentity: 'worker-world',
        code: 'app-system-update-failed',
        expected: 'World update succeeds',
        hint: 'rebuild the poisoned World',
        detail: {},
        partialWrite: true,
        retryable: false,
      });
      const rebuilding = result.value.execution.rebuild();
      expect(result.value.execution.rebuild()).toBe(rebuilding);
      expect(canvas.cloneNode).toHaveBeenCalledExactlyOnceWith(false);
      expect(canvas.replaceWith).toHaveBeenCalledExactlyOnceWith(replacement);
      expect(replacement.transferControlToOffscreen).toHaveBeenCalledTimes(1);
      expect(probes.platformDispose).toHaveBeenCalledTimes(1);
      expect(result.value.canvas).toBe(replacement);
      expect(probes.sessionPost).toHaveBeenCalledWith(
        { kind: 'rebuild', worldIdentity: 'worker-world', canvas: offscreen },
        [offscreen],
      );
      probes.sessionListeners[0]?.({
        kind: 'rebuilt',
        previousWorldIdentity: 'worker-world',
        worldIdentity: 'fresh-world',
      });
      expect((await rebuilding).ok).toBe(true);
      expect(result.value.execution.report().world.identity).toBe('fresh-world');
      const currentClear = vi.mocked(attachBrowserInputBackend).mock.results.at(-1)?.value
        .backend.clear;
      expect(currentClear).not.toBe(oldClear);
      vi.clearAllMocks();
      result.value.input?.clear?.();
      expect(currentClear).toHaveBeenCalledOnce();
      expect(oldClear).not.toHaveBeenCalled();
    } finally {
      await result.value.dispose();
    }
  });

  it('replaces the Engine presentation surface only for its live World', async () => {
    const offscreen = {} as OffscreenCanvas;
    const replacement = {
      transferControlToOffscreen: vi.fn(() => offscreen),
    } as unknown as HTMLCanvasElement;
    const canvas = {
      cloneNode: vi.fn(() => replacement),
      replaceWith: vi.fn(),
    } as unknown as HTMLCanvasElement;
    const clear = vi.fn();
    const result = await createWorkerExecutionApp({
      canvas,
      appOptions: {
        input: { clear, sample: () => ({}) } as never,
        execution: { bootstrap: 'https://example.test/game.js' },
      },
      capabilities,
      selection: workerSelection({ render: false, kernels: false }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      const before = result.value.execution.report();
      canvas.forgeaxFrameProgress = {
        submitted: { frameId: 7, deviceGeneration: 1 },
      };
      probes.sessionListeners[0]?.({
        kind: 'surface-request',
        requestId: 1,
        worldIdentity: 'old-world',
      });
      expect(canvas.cloneNode).not.toHaveBeenCalled();
      expect(probes.sessionPost).toHaveBeenLastCalledWith({
        kind: 'surface-result',
        requestId: 1,
        worldIdentity: 'old-world',
        result: expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'app-not-started' }),
        }),
      });
      probes.sessionListeners[0]?.({
        kind: 'surface-request',
        requestId: 2,
        worldIdentity: 'worker-world',
      });
      expect(canvas.cloneNode).toHaveBeenCalledExactlyOnceWith(false);
      expect(canvas.replaceWith).toHaveBeenCalledExactlyOnceWith(replacement);
      expect(replacement.transferControlToOffscreen).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledTimes(1);
      expect(canvas.forgeaxFrameProgress).toBeUndefined();
      expect(result.value.canvas).toBe(replacement);
      expect(result.value.execution.report()).toEqual(before);
      expect(probes.sessionPost).toHaveBeenLastCalledWith(
        {
          kind: 'surface-result',
          requestId: 2,
          worldIdentity: 'worker-world',
          result: { ok: true, value: offscreen },
        },
        [offscreen],
      );
      // A duplicate transport reply/request cannot transfer another canvas.
      probes.sessionListeners[0]?.({
        kind: 'surface-request',
        requestId: 2,
        worldIdentity: 'worker-world',
      });
      expect(canvas.cloneNode).toHaveBeenCalledTimes(1);
    } finally {
      await result.value.dispose();
    }
  });

  it('keeps the commanded pointer-lock gate on a replacement presentation surface', async () => {
    const replacement = {
      transferControlToOffscreen: vi.fn(() => ({}) as OffscreenCanvas),
    } as unknown as HTMLCanvasElement;
    const canvas = {
      cloneNode: vi.fn(() => replacement),
      replaceWith: vi.fn(),
    } as unknown as HTMLCanvasElement;
    const result = await createWorkerExecutionApp({
      canvas,
      appOptions: { execution: { bootstrap: 'https://example.test/game.js' } },
      capabilities,
      selection: workerSelection({ render: false, kernels: false }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      probes.sessionListeners[0]?.({
        kind: 'host-control',
        command: 'set-pointer-lock-allowed',
        allowed: false,
      });
      probes.pointerAllowed.mockClear();
      probes.sessionListeners[0]?.({
        kind: 'surface-request',
        requestId: 1,
        worldIdentity: 'worker-world',
      });
      expect(vi.mocked(attachBrowserInputBackend).mock.calls.at(-1)?.[0]).toBe(replacement);
      expect(probes.pointerAllowed).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await result.value.dispose();
    }
  });

  it('keeps a closed input gate on a replacement presentation surface', async () => {
    const replacement = {
      transferControlToOffscreen: vi.fn(() => ({}) as OffscreenCanvas),
    } as unknown as HTMLCanvasElement;
    const canvas = {
      cloneNode: vi.fn(() => replacement),
      replaceWith: vi.fn(),
    } as unknown as HTMLCanvasElement;
    const result = await createWorkerExecutionApp({
      canvas,
      appOptions: { execution: { bootstrap: 'https://example.test/game.js' } },
      capabilities,
      selection: workerSelection({ render: false, kernels: false }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      result.value.input?.setInputAllowed?.(false);
      probes.inputAllowed.mockClear();
      probes.sessionListeners[0]?.({
        kind: 'surface-request',
        requestId: 1,
        worldIdentity: 'worker-world',
      });
      expect(vi.mocked(attachBrowserInputBackend).mock.calls.at(-1)?.[0]).toBe(replacement);
      expect(probes.inputAllowed).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await result.value.dispose();
    }
  });

  it('rejects an Engine surface request in a split Render execution', async () => {
    const canvas = { cloneNode: vi.fn(), replaceWith: vi.fn() } as unknown as HTMLCanvasElement;
    const result = await createWorkerExecutionApp({
      canvas,
      appOptions: { execution: { bootstrap: 'https://example.test/game.js' } },
      capabilities,
      selection: workerSelection({ render: true, kernels: false }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      probes.sessionListeners[0]?.({
        kind: 'surface-request',
        requestId: 1,
        worldIdentity: 'worker-world',
      });
      expect(canvas.cloneNode).not.toHaveBeenCalled();
      expect(probes.sessionPost).toHaveBeenLastCalledWith({
        kind: 'surface-result',
        requestId: 1,
        worldIdentity: 'worker-world',
        result: expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'app-not-started' }),
        }),
      });
    } finally {
      await result.value.dispose();
    }
  });

  it('transports the Animation-owned cadence through Host worker startup', async () => {
    const result = await createWorkerExecutionApp({
      canvas: {} as HTMLCanvasElement,
      appOptions: {
        animation: { cadence: 'fixed' },
        execution: { bootstrap: 'https://example.test/game.js' },
      },
      capabilities,
      selection: workerSelection({ render: false, kernels: false }),
    });
    expect(result.ok).toBe(true);
    expect(vi.mocked(startEngineWorker).mock.calls[0]?.[0]).toMatchObject({
      animation: { cadence: 'fixed' },
    });
    if (result.ok) await result.value.dispose();
  });

  it('recreates the supplied Host audio owner on rebuild and disposes the old generation', async () => {
    const owners = Array.from({ length: 2 }, () => ({
      ...createHostAudioConsumer(),
      dispose: vi.fn(),
    }));
    const factory = vi.fn(() => {
      const owner = owners[factory.mock.calls.length - 1];
      if (!owner) throw new Error('unexpected Host generation');
      return owner;
    });
    const result = await createWorkerExecutionApp({
      canvas: {} as HTMLCanvasElement,
      appOptions: {
        execution: { bootstrap: 'https://example.test/game.js', createHostAudio: factory },
      },
      capabilities,
      selection: workerSelection({ render: false, kernels: false }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    probes.sessionListeners[0]?.({
      kind: 'rebuilt',
      previousWorldIdentity: 'worker-world',
      worldIdentity: 'fresh-world',
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(owners[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(result.value.execution.report().world.identity).toBe('fresh-world');
    await result.value.dispose();
    expect(owners[1]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('returns a structured factory failure and releases the started Worker and input owner', async () => {
    const result = await createWorkerExecutionApp({
      canvas: {} as HTMLCanvasElement,
      appOptions: {
        execution: {
          bootstrap: 'https://example.test/game.js',
          createHostAudio: () => {
            throw new Error('effect factory failed');
          },
        },
      },
      capabilities,
      selection: workerSelection({ render: false, kernels: false }),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'app-plugin-activation-failed' } });
    expect(probes.inputDetach).toHaveBeenCalledTimes(1);
    expect(probes.sessionDispose).toHaveBeenCalledTimes(1);
    expect(probes.platformDispose).toHaveBeenCalledTimes(1);
  });

  it('cleans every host owner once when stopped while paused and cannot restart', async () => {
    const raf = vi.fn(() => 7);
    const cancelRaf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', cancelRaf);

    const result = await createWorkerExecutionApp({
      canvas: {} as HTMLCanvasElement,
      appOptions: { execution: { bootstrap: 'https://example.test/game.js' } } as never,
      capabilities,
      selection: workerSelection({ render: false, kernels: false }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.start().ok).toBe(true);
    expect(raf).toHaveBeenCalledTimes(1);
    expect(result.value.pause().ok).toBe(true);
    expect(cancelRaf).toHaveBeenCalledTimes(1);

    result.value.canvas.forgeaxFrameProgress = {
      submitted: { frameId: 7, deviceGeneration: 1 },
    };
    expect(result.value.stop().ok).toBe(true);
    expect(result.value.canvas.forgeaxFrameProgress).toBeUndefined();
    expect(probes.inputDetach).toHaveBeenCalledTimes(1);
    expect(probes.audioDispose).toHaveBeenCalledTimes(1);
    expect(probes.sessionDispose).toHaveBeenCalledTimes(1);
    expect(raf).toHaveBeenCalledTimes(1);
    expect(cancelRaf).toHaveBeenCalledTimes(1);

    const restart = result.value.start();
    expect(restart.ok).toBe(false);
    if (!restart.ok) expect(restart.error.code).toBe('app-not-started');
    expect(raf).toHaveBeenCalledTimes(1);
  });

  it('retains the existing terminal fault identity for host inspection', async () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 7),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const result = await createWorkerExecutionApp({
      canvas: {} as HTMLCanvasElement,
      appOptions: { execution: { bootstrap: 'https://example.test/game.js' } } as never,
      capabilities,
      selection: workerSelection({ render: false, kernels: false }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.value.canvas.forgeaxFrameProgress = {
      submitted: { frameId: 1, deviceGeneration: 1 },
    };
    let observed: unknown;
    result.value.onError((error) => {
      observed = error;
    });
    const listener = probes.sessionListeners[0];
    expect(listener).toBeTypeOf('function');

    listener?.({
      kind: 'fault',
      worldIdentity: 'worker-world',
      source: 'world',
      code: 'app-system-update-failed',
      expected: 'worker world update succeeds',
      hint: 'inspect the retained cause',
      detail: { cause: 'worker boom' },
      partialWrite: true,
      retryable: false,
    });

    expect(result.value.lastError).toBe(observed);
    expect(result.value.lastError).toMatchObject({
      code: 'app-system-update-failed',
      detail: { cause: { cause: 'worker boom' } },
    });
    expect(result.value.canvas.forgeaxFrameProgress).toBeUndefined();
  });
});
