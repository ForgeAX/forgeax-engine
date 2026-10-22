import { describe, expect, it, vi } from 'vitest';
import { startEngineWorker } from '../execution/engine-worker';
import type { EngineToHostMessage, HostToEngineMessage } from '../execution/protocol';
import { workerSelection } from './execution-fixtures';

class FakeWorker extends EventTarget {
  onmessage: ((event: MessageEvent<EngineToHostMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posts: Array<{
    readonly message: HostToEngineMessage;
    readonly transfer: readonly Transferable[];
  }> = [];
  readonly terminate = vi.fn();

  constructor(
    private readonly autoReady = true,
    private readonly startupMessages: readonly EngineToHostMessage[] = [],
    private readonly readyErrors: readonly Extract<
      EngineToHostMessage,
      { kind: 'render-error' }
    >[] = [],
  ) {
    super();
  }

  postMessage(message: HostToEngineMessage, transfer: Transferable[] = []): void {
    this.posts.push({ message, transfer });
    if (message.kind === 'dispose')
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent('message', { data: { kind: 'disposed' } })),
      );
    if (message.kind !== 'init') return;
    if (!this.autoReady) return;
    queueMicrotask(() => {
      for (const startupMessage of this.startupMessages) {
        this.onmessage?.({ data: startupMessage } as MessageEvent<EngineToHostMessage>);
      }
      this.onmessage?.({
        data: {
          kind: 'ready',
          worldIdentity: 'world-test',
          realm: 'worker',
          workerWebGpu: true,
        },
      } as MessageEvent<EngineToHostMessage>);
      for (const error of this.readyErrors)
        this.onmessage?.({ data: error } as MessageEvent<EngineToHostMessage>);
    });
  }
}

describe('Engine Worker thick bootstrap channel', () => {
  it('delivers Render readiness posted before the Engine handshake completes', async () => {
    const renderReady = {
      kind: 'render-ready',
      epoch: 1,
      capabilities: { backendKind: 'webgpu', compute: true, storageBuffer: true },
      limits: { maxStorageBuffersPerShaderStage: 8 },
    } as const;
    const worker = new FakeWorker(true, [renderReady]);
    const started = await startEngineWorker({
      canvas: { transferControlToOffscreen: () => ({}) } as unknown as HTMLCanvasElement,
      bootstrapUrl: 'https://example.test/bootstrap.js',
      timeoutMs: 100,
      workers: workerSelection({ engine: true, render: true, kernels: false }),
      workerFactory: () => worker as unknown as Worker,
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const received: EngineToHostMessage[] = [];
    started.value.listen((message) => received.push(message));
    try {
      expect(received).toContainEqual(renderReady);
    } finally {
      await started.value.dispose();
    }
  });

  it('transfers bootstrap data and the realm MessagePort with the canvas', async () => {
    const pipelineLibrary = {
      version: 1 as const,
      backend: 'webgpu' as const,
      shaders: [],
      bindGroupLayouts: [],
      pipelineLayouts: [],
      renderPipelines: [],
      computePipelines: [],
    };
    const worker = new FakeWorker();
    const offscreen = {} as OffscreenCanvas;
    const transferControlToOffscreen = vi.fn(() => offscreen);
    const channel = new MessageChannel();
    const started = await startEngineWorker({
      canvas: { transferControlToOffscreen } as unknown as HTMLCanvasElement,
      bootstrapUrl: 'https://example.test/bootstrap.js',
      bootstrapData: { gameId: 'sample' },
      dynamicGeometryMeshBudgetBytes: 512 * 1024 * 1024,
      assetBudgetBytes: 6 * 1024 * 1024 * 1024,
      pipelineLibrary,
      bootstrapPort: channel.port2,
      assetCatalog: {
        url: '/__pack/scopes/sample/7/catalog.json',
        expectedScope: { scopeId: 'sample', generation: 7 },
      },
      build: 'build-test',
      timeoutMs: 100,
      workers: workerSelection({ engine: true, render: false, kernels: false }),
      workerFactory: () => worker as unknown as Worker,
    });

    expect(started.ok).toBe(true);
    expect(transferControlToOffscreen).toHaveBeenCalledOnce();
    expect(worker.posts[0]?.message).toMatchObject({
      kind: 'init',
      startupTimeoutMs: 100,
      bootstrapData: { gameId: 'sample' },
      dynamicGeometryMeshBudgetBytes: 512 * 1024 * 1024,
      assetBudgetBytes: 6 * 1024 * 1024 * 1024,
      pipelineLibrary,
      bootstrapPort: channel.port2,
      assetCatalog: {
        url: '/__pack/scopes/sample/7/catalog.json',
        expectedScope: { scopeId: 'sample', generation: 7 },
      },
      build: 'build-test',
    });
    expect(worker.posts[0]?.transfer).toEqual([offscreen, channel.port2]);
    started.ok && (await started.value.dispose()).unwrap();
    channel.port1.close();
  });

  it('rejects non-cloneable data before Worker creation or canvas transfer', async () => {
    const workerFactory = vi.fn();
    const transferControlToOffscreen = vi.fn();
    const started = await startEngineWorker({
      canvas: { transferControlToOffscreen } as unknown as HTMLCanvasElement,
      bootstrapUrl: 'https://example.test/bootstrap.js',
      bootstrapData: { callback: (() => {}) as never },
      timeoutMs: 100,
      workers: workerSelection({ engine: true, render: false, kernels: false }),
      workerFactory,
    });

    expect(started.ok).toBe(false);
    expect(workerFactory).not.toHaveBeenCalled();
    expect(transferControlToOffscreen).not.toHaveBeenCalled();
  });

  it('allows an Engine Worker handshake to exceed the default when timeout is disabled', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(false);
    try {
      const pending = startEngineWorker({
        canvas: { transferControlToOffscreen: () => ({}) } as unknown as HTMLCanvasElement,
        bootstrapUrl: 'https://example.test/bootstrap.js',
        timeoutMs: null,
        workers: workerSelection({ engine: true, render: false, kernels: false }),
        workerFactory: () => worker as unknown as Worker,
      });
      await vi.advanceTimersByTimeAsync(30_001);
      expect(worker.terminate).not.toHaveBeenCalled();
      worker.onmessage?.({
        data: {
          kind: 'ready',
          worldIdentity: 'world-test',
          realm: 'worker',
          workerWebGpu: true,
        },
      } as MessageEvent<EngineToHostMessage>);
      const started = await pending;
      expect(started.ok).toBe(true);
      expect(worker.posts[0]?.message).toMatchObject({ kind: 'init', startupTimeoutMs: null });
      if (started.ok) worker.terminate();
    } finally {
      vi.useRealTimers();
    }
  });
});

function renderError(): Extract<EngineToHostMessage, { kind: 'render-error' }> {
  return {
    kind: 'render-error',
    identity: { source: 'actual-render-source', epoch: 1 },
    worldIdentity: 'world-test',
    error: {
      code: 'device-operation-failed',
      expected: 'valid GPU command',
      hint: 'inspect the original GPU error',
      detail: { operation: 'renderer-event', cause: { code: 'gpu-validation-error' } },
    },
    renderer: {
      state: 'alive',
      frameId: 3,
      capabilities: { backendKind: 'wgpu-webgl2', compute: false, storageBuffer: false },
      limits: { maxStorageBuffersPerShaderStage: 0 },
    },
  };
}

async function startRenderSession(worker: FakeWorker) {
  return startEngineWorker({
    canvas: { transferControlToOffscreen: () => ({}) } as unknown as HTMLCanvasElement,
    bootstrapUrl: 'https://example.test/bootstrap.js',
    timeoutMs: 100,
    workers: workerSelection({ engine: true, render: true, kernels: false }),
    workerFactory: () => worker as unknown as Worker,
  });
}

it('retains the first ready-to-listen Renderer error and declares omitted errors', async () => {
  const first = renderError();
  const worker = new FakeWorker(true, [], [first, first, first]);
  const started = await startRenderSession(worker);
  expect(started.ok).toBe(true);
  if (!started.ok) throw started.error;
  try {
    const observed = vi.fn();
    const unsubscribe = started.value.listen(observed);
    expect(observed).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledWith({ ...first, omittedBeforeListenerCount: 2 });
    worker.onmessage?.({ data: first } as MessageEvent<EngineToHostMessage>);
    expect(observed).toHaveBeenLastCalledWith(first);
    expect(observed).toHaveBeenCalledTimes(2);
    unsubscribe();
    const second = vi.fn();
    started.value.listen(second);
    expect(second).not.toHaveBeenCalled();
  } finally {
    (await started.value.dispose()).unwrap();
  }
});

it('rejects a pre-ready Renderer error with full producer guidance', async () => {
  const worker = new FakeWorker(false);
  const pending = startRenderSession(worker);
  const failure = renderError();
  worker.onmessage?.({ data: failure } as MessageEvent<EngineToHostMessage>);
  const started = await pending;
  expect(started.ok).toBe(false);
  if (started.ok) {
    (await started.value.dispose()).unwrap();
    throw new Error('Pre-ready Renderer error was ignored');
  }
  expect(started.error).toMatchObject({
    code: 'app-execution-bootstrap-failed',
    detail: {
      cause: {
        ...failure.error,
        renderIdentity: failure.identity,
        worldIdentity: failure.worldIdentity,
        renderer: failure.renderer,
      },
    },
  });
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('retires retained and late Renderer delivery when the session is disposed', async () => {
  const worker = new FakeWorker(true, [], [renderError()]);
  const started = await startRenderSession(worker);
  expect(started.ok).toBe(true);
  if (!started.ok) throw started.error;
  const shutdown = started.value.dispose();
  worker.onmessage?.({ data: renderError() } as MessageEvent<EngineToHostMessage>);
  const observed = vi.fn();
  started.value.listen(observed);
  expect(observed).not.toHaveBeenCalled();
  (await shutdown).unwrap();
});

it('retires Host-owned Kernel Workers on lane disposal and Engine disposal', async () => {
  const kernels: Array<{
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }> = [];
  vi.stubGlobal(
    'Worker',
    class {
      readonly postMessage = vi.fn();
      readonly terminate = vi.fn();
      constructor() {
        kernels.push(this);
      }
    },
  );
  const worker = new FakeWorker();
  const channels = [new MessageChannel(), new MessageChannel()];
  const started = await startEngineWorker({
    canvas: { transferControlToOffscreen: () => ({}) } as unknown as HTMLCanvasElement,
    bootstrapUrl: 'https://example.test/bootstrap.js',
    timeoutMs: 100,
    workers: workerSelection({ engine: true, render: false, kernels: true }),
    workerFactory: () => worker as unknown as Worker,
  });
  if (!started.ok) throw started.error;
  try {
    for (const [workerId, channel] of channels.entries())
      worker.onmessage?.({
        data: {
          kind: 'kernel-worker',
          workerId,
          port: channel.port2,
        },
      } as unknown as MessageEvent<EngineToHostMessage>);
    expect(kernels).toHaveLength(2);
    const connect = kernels[0]?.postMessage.mock.calls[0]?.[0] as
      | { readonly kind: string; readonly port: MessagePort }
      | undefined;
    const transfer = kernels[0]?.postMessage.mock.calls[0]?.[1] as Transferable[] | undefined;
    expect(connect?.kind).toBe('kernel-connect');
    expect(connect?.port).toBe(channels[0]?.port2);
    expect(transfer).toHaveLength(1);
    expect(transfer?.[0]).toBe(channels[0]?.port2);
    worker.onmessage?.({
      data: { kind: 'kernel-retire', workerId: 0 },
    } as MessageEvent<EngineToHostMessage>);
    expect(kernels[0]?.terminate).toHaveBeenCalledOnce();
    expect(kernels[1]?.terminate).not.toHaveBeenCalled();
    (await started.value.dispose()).unwrap();
    expect(kernels[0]?.terminate).toHaveBeenCalledOnce();
    expect(kernels[1]?.terminate).toHaveBeenCalledOnce();
    const lateClose = vi.fn();
    worker.onmessage?.({
      data: { kind: 'kernel-worker', workerId: 2, port: { close: lateClose } },
    } as unknown as MessageEvent<EngineToHostMessage>);
    expect(lateClose).toHaveBeenCalledOnce();
    expect(kernels).toHaveLength(2);
  } finally {
    await started.value.dispose();
    for (const channel of channels) {
      channel.port1.close();
      channel.port2.close();
    }
    vi.unstubAllGlobals();
  }
});

it('preserves Kernel Worker creation failure through the existing startup fault', async () => {
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new Error('native Kernel unavailable');
      }
    },
  );
  const worker = new FakeWorker(false);
  const channel = new MessageChannel();
  try {
    const pending = startEngineWorker({
      canvas: { transferControlToOffscreen: () => ({}) } as unknown as HTMLCanvasElement,
      bootstrapUrl: 'https://example.test/bootstrap.js',
      timeoutMs: 100,
      workers: workerSelection({ engine: true, render: false, kernels: true }),
      workerFactory: () => worker as unknown as Worker,
    });
    worker.onmessage?.({
      data: { kind: 'kernel-worker', workerId: 0, port: channel.port2 },
    } as unknown as MessageEvent<EngineToHostMessage>);
    expect(await pending).toMatchObject({
      ok: false,
      error: {
        code: 'app-execution-bootstrap-failed',
        detail: { cause: { message: 'Error: native Kernel unavailable' } },
      },
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  } finally {
    channel.port1.close();
    channel.port2.close();
    vi.unstubAllGlobals();
  }
});
