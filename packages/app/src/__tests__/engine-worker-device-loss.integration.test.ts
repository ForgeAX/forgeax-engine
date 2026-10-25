import { type Renderer, RendererOperationError, type RendererState } from '@forgeax/engine-render';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { executionBootstrapHostPlugin } from '../execution/bootstrap-entry';
import { workerSelection } from './execution-fixtures';

type RendererEventListener = Parameters<Renderer['subscribe']>[0];

const mocks = vi.hoisted(() => {
  const renderer = {
    state: vi.fn((): RendererState => 'device-lost'),
    inspect: vi.fn(() => ({
      profile: { renderPath: 'deferred' },
      perFramePassNames: ['lighting', 'ssr-compose'],
      capabilities: { backendKind: 'webgpu' },
      frame: { frameId: 7 },
    })),
    attach: vi.fn(() => ({ ok: true, value: {} })),
    draw: vi.fn(
      (_request: unknown): ReturnType<Renderer['draw']> => ({
        ok: true,
        value: {
          frameId: 1,
          deviceGeneration: 0,
          presentation: 'ready',
          completed: Promise.resolve({ ok: true, value: undefined }),
        },
      }),
    ),
    subscribe: vi.fn<(listener: RendererEventListener) => () => void>(),
    releaseSurface: vi.fn(() => ({ ok: true, value: undefined })),
    restoreSurface: vi.fn(() => ({ ok: true, value: undefined })),
    dispose: vi.fn(async () => ({ ok: true, value: undefined })),
  };
  return {
    renderer,
    bootstrapGate: undefined as Promise<void> | undefined,
    bootstrapEntered: false,
  };
});

vi.mock('@forgeax/engine-runtime/internal/renderer-host', () => ({
  constructRuntimeRendererHost: vi.fn(async () => ({
    ok: true,
    value: { renderer: mocks.renderer, assets: {}, featureHost: {} },
  })),
}));
vi.mock('../execution/bootstrap-entry', () => ({
  prepareBootstrapEntry: vi.fn(async () => {
    mocks.bootstrapEntered = true;
    await mocks.bootstrapGate;
    return { ok: true, value: { features: [], plugins: [] } };
  }),
  executionBootstrapHostPlugin: vi.fn(() => ({ name: 'bootstrap', inject: [], apply: () => {} })),
}));
vi.mock('../assets-runtime-assembly', () => ({
  createAssetRuntimeAssembly: vi.fn(() => ({
    ok: true,
    value: { registry: {}, dispose: vi.fn() },
  })),
}));
vi.mock('../renderer-plugin', () => ({ createRenderFeatureHost: vi.fn(() => ({})) }));
vi.mock('../execution/attached-world-swap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../execution/attached-world-swap')>()),
  commitAttachedWorld: vi.fn(async () => true),
}));
vi.mock('../internal/worker-engine-profile', () => ({ workerEngineProfile: vi.fn(() => ({})) }));
vi.mock('../execution/kernel-pool', () => ({
  createKernelPool: vi.fn(() => ({
    ready: async () => {},
    takeLastDispatch: () => undefined,
    dispose: () => {},
  })),
}));
vi.mock('@forgeax/engine-ecs', async (importOriginal) => {
  const original = await importOriginal<typeof import('@forgeax/engine-ecs')>();
  return {
    ...original,
    createWorldContext: vi.fn(async () => ({ fiber: { dispose: async () => {} } })),
  };
});

describe('M4 / m4_t1 — Engine Worker frame admission fences device loss', () => {
  let receive: (event: MessageEvent<unknown>) => void = () => {};
  let worldIdentity = '';
  const pendingAdmissionListeners = new Set<RendererEventListener>();
  let bootstrapMessages: unknown[] = [];
  let bootstrapDrawCalls = 0;

  beforeAll(async () => {
    globalThis.postMessage = vi.fn();
    await import('../execution/engine-worker-runtime');
    receive = globalThis.onmessage as unknown as (event: MessageEvent<unknown>) => void;
    let finish: () => void = () => {};
    mocks.bootstrapGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const canvas = { width: 1, height: 1 } as unknown as OffscreenCanvas;
    receive({
      data: {
        kind: 'init',
        canvas,
        bootstrapUrl: 'test://bootstrap',
        workers: workerSelection({ render: false, kernels: false }),
        diagnostics: { geometryLane: 'direct' },
      },
    } as MessageEvent<unknown>);
    await vi.waitFor(() => expect(mocks.bootstrapEntered).toBe(true));

    receive({
      data: {
        kind: 'inspect',
        requestId: 100,
        worldIdentity: '',
        code: 'throw new Error("bootstrap must not execute");',
      },
    } as MessageEvent<unknown>);
    receive({
      data: { kind: 'inspect-cancel', requestId: 100, worldIdentity: '' },
    } as MessageEvent<unknown>);
    finish();
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'ready' }),
      ),
    );
    worldIdentity = (globalThis.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map(([message]) => message)
      .find((message) => message.kind === 'ready').worldIdentity;
    bootstrapMessages = (globalThis.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      ([message]) => message,
    );
    bootstrapDrawCalls = mocks.renderer.draw.mock.calls.length;
  });

  beforeEach(() => {
    mocks.renderer.subscribe.mockReset();
    mocks.renderer.subscribe.mockImplementation((listener) => {
      pendingAdmissionListeners.add(listener);
      return () => pendingAdmissionListeners.delete(listener);
    });
    mocks.renderer.state.mockReset();
    mocks.renderer.state.mockReturnValue('device-lost');
    mocks.renderer.attach.mockClear();
    mocks.renderer.draw.mockClear();
    mocks.bootstrapGate = undefined;
    mocks.bootstrapEntered = false;
    globalThis.postMessage = vi.fn();
  });

  afterEach(async () => {
    mocks.renderer.state.mockReturnValue('disposed');
    for (const listener of pendingAdmissionListeners)
      listener({ kind: 'state-changed', previous: 'device-lost', current: 'disposed' });
    await Promise.resolve();
    vi.restoreAllMocks();
  });

  function sendFrame(
    frameId = 1,
    size = { width: 1, height: 1 },
    targetWorld = worldIdentity,
    render?: false,
  ): void {
    receive({
      data: {
        kind: 'frame',
        worldIdentity: targetWorld,
        frameId,
        deltaSeconds: 1 / 60,
        ...(render === undefined ? {} : { render }),
        inputSample: {
          downKeys: new Set(),
          upKeys: new Set(),
          buttons: [false, false, false],
          movementX: 0,
          movementY: 0,
          wheelDelta: 0,
          focused: true,
          pointerLocked: false,
        },
        canvasWidth: size.width,
        canvasHeight: size.height,
      },
    } as MessageEvent<unknown>);
  }

  function expectFrameAdmissionBlocked(state: Exclude<RendererState, 'alive'>): void {
    mocks.renderer.state.mockReturnValue(state);
    mocks.renderer.attach.mockClear();
    mocks.renderer.draw.mockClear();

    sendFrame();

    expect(mocks.renderer.attach).not.toHaveBeenCalled();
    expect(mocks.renderer.draw).not.toHaveBeenCalled();
    expect(
      (globalThis.postMessage as ReturnType<typeof vi.fn>).mock.calls.some(
        ([message]) => message.kind === 'frame-complete',
      ),
    ).toBe(false);
  }

  it('does not admit inspections before bootstrap finishes and allows queued cancellation', () => {
    expect(bootstrapMessages).toContainEqual({
      kind: 'inspect-canceled',
      requestId: 100,
      worldIdentity: '',
      admitted: false,
    });
    expect(bootstrapMessages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'inspect-started' })]),
    );
    expect(bootstrapMessages).toContainEqual(
      expect.objectContaining({ kind: 'ready', worldIdentity }),
    );
    expect(bootstrapDrawCalls).toBe(0);
  });

  it('fences Host surface replies by World and request, retaining the live bootstrap getter', async () => {
    const resolveCanvas = vi
      .mocked(constructRuntimeRendererHost)
      .mock.calls.at(-1)?.[1]?.resolveRecoveryCanvas;
    expect(resolveCanvas).toBeTypeOf('function');
    if (resolveCanvas === undefined) return;
    const host = vi.mocked(executionBootstrapHostPlugin).mock.calls.at(-1)?.[0];
    const original = host?.canvas;
    const controller = new AbortController();
    const pending = resolveCanvas(controller.signal);
    const request = (globalThis.postMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(request).toMatchObject({ kind: 'surface-request', worldIdentity });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    const replacement = { width: 128, height: 48 } as unknown as OffscreenCanvas;
    receive({
      data: {
        kind: 'surface-result',
        requestId: request.requestId,
        worldIdentity: 'stale',
        result: { ok: true, value: replacement },
      },
    } as MessageEvent<unknown>);
    receive({
      data: {
        kind: 'surface-result',
        requestId: request.requestId + 1,
        worldIdentity,
        result: { ok: true, value: replacement },
      },
    } as MessageEvent<unknown>);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(host?.canvas).toBe(original);
    receive({
      data: {
        kind: 'surface-result',
        requestId: request.requestId,
        worldIdentity,
        result: { ok: true, value: replacement },
      },
    } as MessageEvent<unknown>);
    expect(await pending).toBe(replacement);
    expect(host?.canvas).toBe(replacement);
    expect(mocks.renderer.attach).not.toHaveBeenCalled();
  });

  it('abandons an aborted Host surface request and cannot adopt its late reply', async () => {
    const resolveCanvas = vi
      .mocked(constructRuntimeRendererHost)
      .mock.calls.at(-1)?.[1]?.resolveRecoveryCanvas;
    expect(resolveCanvas).toBeTypeOf('function');
    if (resolveCanvas === undefined) return;
    const host = vi.mocked(executionBootstrapHostPlugin).mock.calls.at(-1)?.[0];
    const original = host?.canvas;
    const abandoned = new AbortController();
    const old = resolveCanvas(abandoned.signal);
    const rejected = expect(old).rejects.toMatchObject({ code: 'app-not-started' });
    const oldRequest = (globalThis.postMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    abandoned.abort();
    await rejected;
    const current = new AbortController();
    const pending = resolveCanvas(current.signal);
    const request = (globalThis.postMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(request.requestId).toBeGreaterThan(oldRequest.requestId);
    const replacement = { width: 96, height: 64 } as unknown as OffscreenCanvas;
    receive({
      data: {
        kind: 'surface-result',
        requestId: oldRequest.requestId,
        worldIdentity,
        result: { ok: true, value: replacement },
      },
    } as MessageEvent<unknown>);
    expect(host?.canvas).toBe(original);
    const failure = structuredClone({
      ok: false,
      error: {
        code: 'app-system-update-failed',
        expected: 'surface transfer',
        hint: 'inspect Host',
        detail: { cause: 'transfer rejected' },
      },
    });
    const failureCheck = expect(pending).rejects.toBe(failure.error);
    receive({
      data: {
        kind: 'surface-result',
        requestId: request.requestId,
        worldIdentity,
        result: failure,
      },
    } as MessageEvent<unknown>);
    await failureCheck;
    expect(host?.canvas).toBe(original);
  });

  it('does not update or post frame-complete while the renderer is device-lost', () => {
    expectFrameAdmissionBlocked('device-lost');
  });

  it('does not update or post frame-complete while the renderer is recovering', () => {
    expectFrameAdmissionBlocked('recovering');
  });

  it('does not update or post frame-complete while the renderer is faulted', () => {
    expectFrameAdmissionBlocked('faulted');
  });

  it('does not update or post frame-complete after the renderer is disposed', () => {
    expectFrameAdmissionBlocked('disposed');
  });
  it('retries a lost receipt after explicit recovery without advancing the World twice', async () => {
    const { World } = await import('@forgeax/engine-ecs');
    const update = vi.spyOn(World.prototype, 'update');
    const listeners = new Set<RendererEventListener>();
    mocks.renderer.subscribe.mockImplementation((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    let lose!: (
      result: Awaited<import('@forgeax/engine-render').FrameReceipt['completed']>,
    ) => void;
    const pending = new Promise<
      Awaited<import('@forgeax/engine-render').FrameReceipt['completed']>
    >((resolve) => {
      lose = resolve;
    });
    mocks.renderer.state.mockReturnValue('alive');
    mocks.renderer.draw.mockReturnValueOnce({
      ok: true,
      value: { frameId: 1, deviceGeneration: 0, presentation: 'ready', completed: pending },
    });
    mocks.renderer.draw.mockReturnValueOnce({
      ok: true,
      value: {
        frameId: 2,
        deviceGeneration: 1,
        presentation: 'ready',
        completed: Promise.resolve({ ok: true, value: undefined }),
      },
    });
    sendFrame();
    await vi.waitFor(() => expect(mocks.renderer.draw).toHaveBeenCalledTimes(1));
    mocks.renderer.state.mockReturnValue('device-lost');
    lose({
      ok: false,
      error: new RendererOperationError('device-operation-failed', {
        operation: 'complete-frame',
        frameId: 1,
        deviceGeneration: 0,
        cause: {
          code: 'device-lost',
          expected: 'the submitted device remains alive',
          hint: 'recover the renderer',
          detail: { code: 'device-lost' },
        },
      }),
    });
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    expect(update).toHaveBeenCalledTimes(1);
    expect(globalThis.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'fault' }),
    );
    expect(globalThis.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'frame-complete' }),
    );
    mocks.renderer.state.mockReturnValue('alive');
    for (const listener of listeners)
      listener({ kind: 'state-changed', previous: 'recovering', current: 'alive' });
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'frame-complete', frameId: 1, deviceGeneration: 1 }),
      ),
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(mocks.renderer.draw).toHaveBeenCalledTimes(2);
    for (const call of mocks.renderer.draw.mock.calls)
      expect(call[0]).toHaveProperty('geometryLane', 'direct');
    expect(listeners.size).toBe(0);
    update.mockRestore();
  });
  it.each([
    'faulted',
    'disposed',
  ] as const)('retires the pending recovery listener when the Renderer becomes %s', async (terminal) => {
    const listeners = new Set<RendererEventListener>();
    mocks.renderer.subscribe.mockImplementation((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    mocks.renderer.state.mockReturnValue('alive');
    mocks.renderer.draw.mockReturnValueOnce({
      ok: true,
      value: {
        frameId: 3,
        deviceGeneration: 1,
        presentation: 'ready',
        completed: Promise.resolve({
          ok: false,
          error: new RendererOperationError('device-operation-failed', {
            operation: 'complete-frame',
            frameId: 3,
            deviceGeneration: 1,
            cause: {
              code: 'device-lost',
              expected: 'submitted device stays alive',
              hint: 'recover the renderer',
              detail: { code: 'device-lost' },
            },
          }),
        }),
      },
    });
    sendFrame(2);
    mocks.renderer.state.mockReturnValue('device-lost');
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    mocks.renderer.state.mockReturnValue(terminal);
    for (const listener of listeners)
      listener({ kind: 'state-changed', previous: 'device-lost', current: terminal });
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'fault' }),
      ),
    );
    expect(globalThis.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'frame-complete' }),
    );
    expect(listeners.size).toBe(0);
  });
  it.each([
    ['device-lost', 3],
    ['recovering', 4],
  ] as const)('retains a frame admitted while %s until explicit recovery', async (state, frameId) => {
    const { World } = await import('@forgeax/engine-ecs');
    const update = vi.spyOn(World.prototype, 'update');
    mocks.renderer.state.mockReturnValue(state);
    mocks.renderer.draw.mockReturnValueOnce({
      ok: true,
      value: {
        frameId: 4,
        deviceGeneration: 2,
        presentation: 'ready',
        completed: Promise.resolve({ ok: true, value: undefined }),
      },
    });
    sendFrame(frameId);
    await vi.waitFor(() => expect(pendingAdmissionListeners.size).toBe(1));
    expect(update).not.toHaveBeenCalled();
    expect(mocks.renderer.draw).not.toHaveBeenCalled();
    expect(globalThis.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'frame-complete' }),
    );
    mocks.renderer.state.mockReturnValue('alive');
    for (const listener of pendingAdmissionListeners)
      listener({ kind: 'state-changed', previous: state, current: 'alive' });
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'frame-complete', frameId, deviceGeneration: 2 }),
      ),
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(mocks.renderer.draw).toHaveBeenCalledTimes(1);
    expect(pendingAdmissionListeners.size).toBe(0);
  });

  it('answers a current World inspection without receiving another frame', async () => {
    mocks.renderer.state.mockReturnValue('alive');
    receive({
      data: { kind: 'inspect', requestId: 101, worldIdentity, code: 'return world.identity;' },
    } as MessageEvent<unknown>);
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith({
        kind: 'inspect-result',
        requestId: 101,
        worldIdentity,
        result: { ok: true, value: worldIdentity },
      }),
    );
    expect(globalThis.postMessage).toHaveBeenCalledWith({
      kind: 'inspect-started',
      requestId: 101,
      worldIdentity,
    });
    expect(mocks.renderer.draw).not.toHaveBeenCalled();
  });

  it('answers a stable World inspection while the submitted GPU receipt remains pending', async () => {
    mocks.renderer.state.mockReturnValue('alive');
    let finish: () => void = () => {};
    const completed = new Promise<{ ok: true; value: undefined }>((resolve) => {
      finish = () => resolve({ ok: true, value: undefined });
    });
    mocks.renderer.draw.mockReturnValueOnce({
      ok: true,
      value: { frameId: 1, deviceGeneration: 0, presentation: 'ready', completed },
    });
    sendFrame(5);
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'frame-submitted', frameId: 5 }),
      ),
    );
    try {
      receive({
        data: { kind: 'inspect', requestId: 102, worldIdentity, code: 'return world.identity;' },
      } as MessageEvent<unknown>);
      await vi.waitFor(() =>
        expect(globalThis.postMessage).toHaveBeenCalledWith({
          kind: 'inspect-result',
          requestId: 102,
          worldIdentity,
          result: { ok: true, value: worldIdentity },
        }),
      );
      expect(mocks.renderer.draw).toHaveBeenCalledOnce();
      expect(
        (globalThis.postMessage as ReturnType<typeof vi.fn>).mock.calls.some(
          ([message]) => message.kind === 'frame-complete',
        ),
      ).toBe(false);
    } finally {
      finish();
      await vi.waitFor(() =>
        expect(globalThis.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'frame-complete', frameId: 5 }),
        ),
      );
    }
  });

  function inspect(requestId: number, code = 'return world.identity;'): void {
    receive({ data: { kind: 'inspect', requestId, worldIdentity, code } } as MessageEvent<unknown>);
  }

  it('reads the actual local Renderer through the public execution script root without a draw', async () => {
    mocks.renderer.state.mockReturnValue('alive');
    inspect(150, 'return await execution.inspectRenderer();');
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'inspect-result',
          requestId: 150,
          worldIdentity,
          result: { ok: true, value: { ok: true, value: mocks.renderer.inspect() } },
        }),
      ),
    );
    expect(mocks.renderer.draw).not.toHaveBeenCalled();
  });

  it('returns the original aborted read failure through the public execution script root', async () => {
    mocks.renderer.state.mockReturnValue('alive');
    inspect(
      151,
      'const controller = new AbortController(); controller.abort(); return await execution.inspectRenderer({signal: controller.signal});',
    );
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'inspect-result',
          requestId: 151,
          worldIdentity,
          result: {
            ok: true,
            value: {
              ok: false,
              error: expect.objectContaining({
                code: 'app-renderer-inspection-unavailable',
                detail: { reason: 'cancelled' },
              }),
            },
          },
        }),
      ),
    );
    expect(mocks.renderer.draw).not.toHaveBeenCalled();
  });

  it('can inspect a stable World after device loss without admitting a frame', async () => {
    inspect(103);
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith({
        kind: 'inspect-result',
        requestId: 103,
        worldIdentity,
        result: { ok: true, value: worldIdentity },
      }),
    );
    expect(mocks.renderer.draw).not.toHaveBeenCalled();
  });

  it('keeps an already admitted asynchronous inspection attached after cancellation', async () => {
    let finish: () => void = () => {};
    let entered = false;
    const barrier = new Promise<void>((resolve) => {
      finish = resolve;
    });
    Object.defineProperty(globalThis, '__workerInspectionBarrier', {
      configurable: true,
      value: {
        barrier,
        enter: () => {
          entered = true;
        },
      },
    });
    try {
      inspect(
        104,
        'globalThis.__workerInspectionBarrier.enter(); await globalThis.__workerInspectionBarrier.barrier; return world.identity;',
      );
      await vi.waitFor(() => expect(entered).toBe(true));
      receive({
        data: { kind: 'inspect-cancel', requestId: 104, worldIdentity },
      } as MessageEvent<unknown>);
      expect(globalThis.postMessage).toHaveBeenCalledWith({
        kind: 'inspect-canceled',
        requestId: 104,
        worldIdentity,
        admitted: true,
      });
      finish();
      await vi.waitFor(() =>
        expect(globalThis.postMessage).toHaveBeenCalledWith({
          kind: 'inspect-result',
          requestId: 104,
          worldIdentity,
          result: { ok: true, value: worldIdentity },
        }),
      );
    } finally {
      finish();
      Reflect.deleteProperty(globalThis, '__workerInspectionBarrier');
    }
  });

  it('fences evaluator import against rebuild and cancels requests queued during the transition', async () => {
    mocks.renderer.state.mockReturnValue('alive');
    let finish: () => void = () => {};
    mocks.bootstrapGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const oldIdentity = worldIdentity;
    inspect(105, 'throw new Error("retired World must not execute");');
    // Even an already loaded evaluator yields at await before script execution.
    receive({ data: { kind: 'rebuild', worldIdentity } } as MessageEvent<unknown>);
    inspect(106);
    receive({
      data: { kind: 'inspect-cancel', requestId: 106, worldIdentity },
    } as MessageEvent<unknown>);
    expect(globalThis.postMessage).toHaveBeenCalledWith({
      kind: 'inspect-canceled',
      requestId: 106,
      worldIdentity,
      admitted: false,
    });
    expect(globalThis.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'inspect-started', requestId: 106 }),
    );
    try {
      await vi.waitFor(() =>
        expect(globalThis.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'inspect-result',
            requestId: 105,
            result: { ok: false, error: expect.objectContaining({ code: 'live-world-stale' }) },
          }),
        ),
      );
      await vi.waitFor(() => expect(mocks.bootstrapEntered).toBe(true));
      inspect(109, 'throw new Error("queued retired World must not execute");');
    } finally {
      finish();
    }
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'rebuilt', previousWorldIdentity: oldIdentity }),
      ),
    );
    worldIdentity = (globalThis.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map(([message]) => message)
      .find((message) => message.kind === 'rebuilt').worldIdentity;
    expect(worldIdentity).not.toBe(oldIdentity);
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'inspect-result',
          requestId: 109,
          worldIdentity,
          result: {
            ok: false,
            error: expect.objectContaining({
              code: 'live-world-stale',
              detail: { expected: oldIdentity, actual: worldIdentity },
            }),
          },
        }),
      ),
    );
    expect(globalThis.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'inspect-started', requestId: 109 }),
    );
    inspect(107);
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith({
        kind: 'inspect-result',
        requestId: 107,
        worldIdentity,
        result: { ok: true, value: worldIdentity },
      }),
    );
    expect(mocks.renderer.draw).not.toHaveBeenCalled();
  });

  it('updates input extent before World update and rejects stale frame dimensions', async () => {
    const { World } = await import('@forgeax/engine-ecs');
    const host = vi.mocked(executionBootstrapHostPlugin).mock.calls.at(-1)?.[0];
    if (host === undefined) throw new Error('Expected current Worker bootstrap Host');
    const original = World.prototype.update;
    const observed: unknown[] = [];
    vi.spyOn(World.prototype, 'update').mockImplementation(function (
      this: InstanceType<typeof World>,
      delta,
    ) {
      observed.push(host.drawingBufferSize());
      return original.call(this, delta);
    });
    mocks.renderer.state.mockReturnValue('alive');
    sendFrame(100, { width: 640.9, height: 360.9 });
    await vi.waitFor(() => expect(observed).toEqual([{ width: 640, height: 360 }]));
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'frame-complete', frameId: 100 }),
      ),
    );
    sendFrame(100, { width: 99, height: 99 });
    sendFrame(101, { width: 99, height: 99 }, 'retired-world');
    await Promise.resolve();
    expect(host.drawingBufferSize()).toEqual({ width: 640, height: 360 });
    expect(observed).toHaveLength(1);
    sendFrame(101, { width: 1280, height: 720 });
    await vi.waitFor(() => expect(observed).toHaveLength(2));
    expect(observed[1]).toEqual({ width: 1280, height: 720 });
    expect(host.drawingBufferSize()).toEqual({ width: 1280, height: 720 });
  });

  it('updates an update-only frame without a draw and settles it as simulation-complete', async () => {
    const { World } = await import('@forgeax/engine-ecs');
    const update = vi.spyOn(World.prototype, 'update');
    mocks.renderer.state.mockReturnValue('alive');
    sendFrame(200, undefined, undefined, false);
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'simulation-complete', frameId: 200 }),
      ),
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(mocks.renderer.draw).not.toHaveBeenCalled();
    // The settled update-only frame is retired: a replay is stale, the next frame draws.
    sendFrame(200);
    sendFrame(201);
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'frame-complete', frameId: 201 }),
      ),
    );
    expect(update).toHaveBeenCalledTimes(2);
    expect(mocks.renderer.draw).toHaveBeenCalledTimes(1);
    update.mockRestore();
  });

  it('does not execute a script if disposal happens during evaluator import', async () => {
    globalThis.close = vi.fn();
    inspect(108, 'throw new Error("disposed World must not execute");');
    receive({ data: { kind: 'dispose' } } as MessageEvent<unknown>);
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'inspect-result',
          requestId: 108,
          result: { ok: false, error: expect.objectContaining({ code: 'live-world-stale' }) },
        }),
      ),
    );
    await vi.waitFor(() => expect(globalThis.close).toHaveBeenCalledOnce());
    expect(mocks.renderer.draw).not.toHaveBeenCalled();
  });
});
