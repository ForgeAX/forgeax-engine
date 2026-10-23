import { Worker as NodeWorker } from 'node:worker_threads';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { FixedTime, Time, Update, type World } from '@forgeax/engine-ecs';
import type { Context } from '@forgeax/engine-plugin';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExecutionBootstrapHost } from '../execution/bootstrap-entry';
import type {
  EngineToHostMessage,
  ExecutionFrameMessage,
  HostToEngineMessage,
} from '../execution/protocol';
import type { RenderWorkerInput, RenderWorkerOutput } from '../execution/render-worker-protocol';
import { workerSelection } from './execution-fixtures';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const state = vi.hoisted(() => ({
  rootGate: undefined as ReturnType<typeof deferred<void>> | undefined,
  rootEntered: undefined as ReturnType<typeof deferred<void>> | undefined,
  terminal: undefined as ReturnType<typeof deferred<EngineToHostMessage>> | undefined,
  disposed: undefined as
    | ReturnType<typeof deferred<Extract<EngineToHostMessage, { kind: 'disposed' }>>>
    | undefined,
  rootFailure: undefined as Error | undefined,
  kernelFailure: undefined as Error | undefined,
  world: undefined as World | undefined,
  terrain: undefined as ExecutionBootstrapHost | undefined,
  order: [] as string[],
  posts: [] as EngineToHostMessage[],
}));

// Only external boundaries are controlled. The actual Engine worker owner,
// Native Cordis installation, World and Render publisher execute unchanged.
vi.mock('@forgeax/engine-runtime/internal/renderer-host', async (original) => {
  const real = await original<typeof import('@forgeax/engine-runtime/internal/renderer-host')>();
  return {
    ...real,
    createPublicationAssets: async () =>
      new AssetRegistry({ shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }) }),
  };
});
vi.mock('../execution/bootstrap-entry', async (original) => {
  const real = await original<typeof import('../execution/bootstrap-entry')>();
  const { startNativePlugin } = await import('@forgeax/engine-plugin');
  return {
    ...real,
    prepareBootstrapEntry: async () => ({ ok: true, value: { root: { guid: 'fixture-root' } } }),
    activateExecutionRoot: async (context: Context) => {
      const result = await startNativePlugin(context, {
        name: 'fixture-root',
        inject: ['world', 'executionBootstrapHost'],
        async apply(ctx) {
          state.world = ctx.world;
          state.terrain = ctx.executionBootstrapHost;
          state.order.push('root-enter');
          state.rootEntered?.resolve();
          await state.rootGate?.promise;
          if (state.rootFailure !== undefined) throw state.rootFailure;
          ctx.world.insertResource('fixture-root-complete', true);
          ctx.effect(
            () => () => {
              state.order.push('root-cleanup');
            },
            'fixture/root',
          );
          if (state.kernelFailure !== undefined) {
            const executor = ctx.world.getResource('SharedKernelExecutor') as {
              warmup(kernel: unknown): void;
            };
            executor.warmup({});
          }
          state.order.push('root-active');
        },
      });
      if (!result.ok) throw result.error;
      return { fiber: result.value };
    },
  };
});
vi.mock('../execution/kernel-pool', () => ({
  createKernelPool: () => ({
    warmup() {},
    async ready() {
      state.order.push('kernel-ready');
      throw state.kernelFailure;
    },
    dispose() {
      state.order.push('kernel-cleanup');
    },
  }),
}));

/** Node-only adapter. The requested production URL/name remain recorded exactly;
 * its module body is the same checkout's actual App dist, never another Engine.
 * init readiness is controlled CPU transport, not a WebGPU or Game acceptance. */
class CpuModuleWorker {
  static instances: CpuModuleWorker[] = [];
  static ctorAttempts = 0;
  static failModule = false;
  static ctorFailure: Error | undefined;
  readonly thread: NodeWorker;
  readonly loaded = deferred<{ moduleUrl: string; gpuCalls: number }>();
  readonly exited = deferred<number>();
  readonly posts: RenderWorkerInput[] = [];
  readonly moduleErrors: string[] = [];
  readonly errorEvents: Event[] = [];
  readonly propagatedErrors: string[] = [];
  private readonly errorTarget = new EventTarget();
  readonly listeners = new Set<(event: MessageEvent<RenderWorkerOutput>) => void>();
  onmessage: ((event: MessageEvent<RenderWorkerOutput>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    CpuModuleWorker.ctorAttempts++;
    if (CpuModuleWorker.ctorFailure !== undefined) throw CpuModuleWorker.ctorFailure;
    const moduleUrl = new URL('../../dist/render-worker-runtime.mjs', import.meta.url).href;
    this.thread = new NodeWorker(
      new URL('./fixtures/render-worker-module-cpu.mjs', import.meta.url),
      {
        workerData: { moduleUrl, failModule: CpuModuleWorker.failModule },
      },
    );
    CpuModuleWorker.instances.push(this);
    // Immediate settled handler; retained failure is also reported through onerror.
    void this.loaded.promise.catch(() => undefined);
    this.thread.on(
      'message',
      (message: {
        fixture: string;
        moduleUrl: string;
        gpuCalls: number;
        data: RenderWorkerOutput;
      }) => {
        if (message.fixture === 'loaded') this.loaded.resolve(message);
        if (message.fixture === 'product') {
          const event = new MessageEvent<RenderWorkerOutput>('message', { data: message.data });
          for (const listener of this.listeners) listener(event);
          this.onmessage?.(event);
        }
      },
    );
    this.errorTarget.addEventListener('error', (event) => this.onerror?.(event as ErrorEvent));
    this.thread.on('error', (error) => {
      // Real Node module error plus cancelable EventTarget dispatch. Ancestor
      // propagation is modeled here; the separate browser fixture proves it natively.
      const event = new Event('error', { cancelable: true });
      Object.defineProperty(event, 'message', { value: error.message });
      this.moduleErrors.push(error.message);
      this.errorEvents.push(event);
      if (this.errorTarget.dispatchEvent(event)) this.propagatedErrors.push(error.message);
      this.loaded.resolve({ moduleUrl, gpuCalls: -1 });
    });
    this.thread.on('exit', (code) => this.exited.resolve(code));
  }
  openModuleGate(): void {
    this.thread.postMessage({ fixture: 'load' });
  }
  postMessage(message: RenderWorkerInput, transfer: Transferable[] = []): void {
    this.posts.push(message.kind === 'draw' ? structuredClone(message) : message);
    if (message.kind === 'init') {
      state.order.push('child-init');
      expect(state.world?.getResource('fixture-root-complete')).toBe(true);
    }
    // The fixture canvas is CPU-only; publication buffers cross the actual
    // Node transport with ownership transfer, as they do in the browser.
    this.thread.postMessage(
      message,
      transfer.filter(
        (value): value is ArrayBuffer | MessagePort =>
          value instanceof ArrayBuffer || value instanceof MessagePort,
      ),
    );
  }
  submit(frameId: number): void {
    this.thread.postMessage({ fixture: 'submit', frameId });
  }
  complete(frameId: number): void {
    this.thread.postMessage({ fixture: 'complete', frameId });
  }
  addEventListener(
    _name: string,
    listener: (event: MessageEvent<RenderWorkerOutput>) => void,
  ): void {
    this.listeners.add(listener);
  }
  removeEventListener(
    _name: string,
    listener: (event: MessageEvent<RenderWorkerOutput>) => void,
  ): void {
    this.listeners.delete(listener);
  }
  terminate(): void {
    void this.thread.terminate();
  }
}
let receive: ((event: MessageEvent<HostToEngineMessage>) => void) | null;

beforeEach(() => {
  vi.resetModules();
  state.rootGate = deferred<void>();
  state.rootEntered = deferred<void>();
  state.terminal = deferred<EngineToHostMessage>();
  state.disposed = deferred<Extract<EngineToHostMessage, { kind: 'disposed' }>>();
  state.rootFailure = undefined;
  state.kernelFailure = undefined;
  state.world = undefined;
  state.terrain = undefined;
  state.order = [];
  state.posts = [];
  CpuModuleWorker.instances = [];
  CpuModuleWorker.ctorAttempts = 0;
  CpuModuleWorker.failModule = false;
  CpuModuleWorker.ctorFailure = undefined;
  receive = null;
  vi.stubGlobal('onmessage', null);
  vi.stubGlobal('Worker', CpuModuleWorker);
  vi.stubGlobal('close', () => undefined);
  vi.stubGlobal('postMessage', (message: EngineToHostMessage) => {
    state.posts.push(message);
    if (message.kind === 'ready' || message.kind === 'fault') state.terminal?.resolve(message);
    if (message.kind === 'disposed') state.disposed?.resolve(message);
  });
});
afterEach(async () => {
  // Preserve failing assertions while settling only this fixture's owned workers.
  state.rootGate?.resolve();
  if (receive !== null && receive !== undefined) {
    await state.terminal?.promise;
    receive({ data: { kind: 'dispose' } } as MessageEvent<HostToEngineMessage>);
    await state.disposed?.promise;
  }
  for (const worker of CpuModuleWorker.instances) {
    worker.terminate();
    await worker.exited.promise;
    expect(worker.thread.threadId).toBe(-1);
  }
  vi.unstubAllGlobals();
  receive = null;
});
async function launch(kernels = false): Promise<void> {
  await import('../execution/engine-worker-runtime');
  receive = globalThis.onmessage as typeof receive;
  receive?.({
    data: {
      kind: 'init',
      startupTimeoutMs: 30_000,
      canvas: {},
      bootstrapUrl: 'fixture://root',
      workers: workerSelection({ engine: true, render: true, kernels }),
    },
  } as MessageEvent<HostToEngineMessage>);
  await state.rootEntered?.promise;
}
function worker(): CpuModuleWorker {
  expect(CpuModuleWorker.instances).toHaveLength(1);
  expect(CpuModuleWorker.ctorAttempts).toBe(1);
  const child = CpuModuleWorker.instances[0];
  if (child === undefined)
    throw new Error('Fixture expected the asserted single CPU module worker');
  return child;
}

it('bounds World updates by sealed publications, including pictures not yet submitted', async () => {
  await launch();
  const child = worker();
  child.openModuleGate();
  await child.loaded.promise;
  state.rootGate?.resolve();
  expect(await state.terminal?.promise).toMatchObject({ kind: 'ready' });
  const world = state.world;
  if (world === undefined || receive === null) throw new Error('Missing live Engine World');
  let updates = 0;
  world
    .addSystem(Update, { name: 'count-source-updates', queries: [], fn: () => void updates++ })
    .unwrap();
  const send = (frameId: number): void => {
    const message: ExecutionFrameMessage = {
      kind: 'frame',
      worldIdentity: world.identity,
      frameId,
      deltaSeconds: 1 / 60,
      sampleTimeSeconds: frameId / 60,
      canvasWidth: 32,
      canvasHeight: 32,
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
    };
    receive?.({ data: message } as MessageEvent<HostToEngineMessage>);
  };
  const completions = () => state.posts.filter((message) => message.kind === 'simulation-complete');
  const pictures = () =>
    child.posts.filter((message) => message.kind === 'draw').map((message) => message.frameId);
  const faults = () => state.posts.filter((message) => message.kind === 'fault');
  const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
  // Render notices reach the Host on the session port, not through the Engine.
  const hostPort = state.posts.find((message) => message.kind === 'render-host-port');
  if (hostPort?.kind !== 'render-host-port') throw new Error('Missing Render Host port');
  const notices: EngineToHostMessage[] = [];
  hostPort.port.onmessage = (event: MessageEvent<EngineToHostMessage>) =>
    void notices.push(event.data);
  const noticed = (kind: 'render-submitted' | 'render-complete', frameId: number) =>
    notices.some(
      (message) =>
        message.kind === kind && message.epoch === 1 && message.frame.frameId === frameId,
    );
  send(1);
  await vi.waitFor(() => expect(completions()).toHaveLength(1));
  send(2);
  await vi.waitFor(() => expect(completions()).toHaveLength(2));
  expect(pictures()).toEqual([1, 2]);
  expect(notices).toEqual([]);
  const elapsed = world.getResource(Time).elapsed;
  const fixedTick = world.getResource(FixedTime).tick;

  // Host credit can return before this Engine processes the completion it
  // carries. A third request with two sealed publications waits for that
  // completion instead of updating the World or faulting a correctly paced Host.
  send(3);
  await drain();
  expect(updates).toBe(2);
  expect(world.getResource(Time).elapsed).toBe(elapsed);
  expect(world.getResource(FixedTime).tick).toBe(fixedTick);
  expect(completions()).toHaveLength(2);
  expect(faults()).toEqual([]);

  child.submit(1);
  await vi.waitFor(() => expect(noticed('render-submitted', 1)).toBe(true));
  await drain();
  expect(updates).toBe(2);
  expect(state.posts.some((message) => message.kind === 'render-submitted')).toBe(false);

  // A duplicate request while the first waits is still ignored once capacity returns.
  send(3);
  child.complete(1);
  await vi.waitFor(() => expect(noticed('render-complete', 1)).toBe(true));
  await vi.waitFor(() => expect(completions()).toHaveLength(3));
  await drain();
  expect(updates).toBe(3);
  expect(world.getResource(FixedTime).tick).toBe(fixedTick + 1);
  expect(pictures()).toEqual([1, 2, 3]);
  expect(completions().at(-1)).toMatchObject({
    frameId: 3,
  });
  expect(state.posts.some((message) => message.kind === 'render-complete')).toBe(false);
  expect(faults()).toEqual([]);
  expect(world.execution.health).toBe('healthy');
});

it('loads the actual child module during a deferred Native root, without init or World publisher', async () => {
  await launch();
  const child = worker(); // RED on baseline: no worker exists until the root finishes.
  const world = state.world;
  if (world === undefined)
    throw new Error('Fixture expected the World installed before Native root entry');
  const count = world.inspect().scheduleSystemCount(world.scheduleToken('Update'));
  expect(child.url.href).toBe(
    new URL('../execution/render-worker-runtime.mjs', import.meta.url).href,
  );
  expect(child.options).toEqual({ type: 'module', name: 'forgeax-render' });
  expect(child.posts).toEqual([]);
  expect(await state.terrain?.querySubmittedTerrainHeight?.({} as never)).toMatchObject({
    ok: false,
    error: { detail: { field: 'Worker' } },
  });
  child.openModuleGate();
  expect(await child.loaded.promise).toMatchObject({ gpuCalls: 0 });
  expect(child.posts).toEqual([]);
  expect(world.inspect().scheduleSystemCount(world.scheduleToken('Update'))).toBe(count);
  state.rootGate?.resolve();
  expect(await state.terminal?.promise).toMatchObject({ kind: 'ready' });
  expect(CpuModuleWorker.instances).toHaveLength(1);
  expect(CpuModuleWorker.ctorAttempts).toBe(1);
  expect(child.posts.filter((message) => message.kind === 'init')).toHaveLength(1);
  expect(state.order.indexOf('root-active')).toBeLessThan(state.order.indexOf('child-init'));
  receive?.({ data: { kind: 'dispose' } } as MessageEvent<HostToEngineMessage>);
  expect(await state.disposed?.promise).toEqual({ kind: 'disposed' });
  await child.exited.promise;
  expect(child.thread.threadId).toBe(-1);
  expect(child.posts.filter((message) => message.kind === 'dispose')).toHaveLength(1);
  receive = null; // The actual owner already completed its initialized shutdown.
});

it('retains a real early module error until the original start boundary', async () => {
  CpuModuleWorker.failModule = true;
  await launch();
  const child = worker();
  child.openModuleGate();
  await child.loaded.promise;
  expect(child.errorEvents[0]?.defaultPrevented).toBe(true);
  expect(child.propagatedErrors).toEqual([]);
  expect(state.posts.some((message) => message.kind === 'fault')).toBe(false);
  state.rootGate?.resolve();
  expect(await state.terminal?.promise).toMatchObject({
    kind: 'fault',
    detail: { code: 'render-worker-failed', detail: 'fixture-early-module-failure' },
  });
  expect(child.posts).toEqual([]);
});

it('preserves the original root failure over an early constructor failure', async () => {
  CpuModuleWorker.ctorFailure = new Error('fixture-constructor-failure');
  state.rootFailure = new Error('fixture-root-failure');
  await launch();
  state.rootGate?.resolve();
  const terminal = await state.terminal?.promise;
  expect(terminal).toMatchObject({ kind: 'fault', detail: { code: 'plugin-startup-failed' } });
  expect(JSON.stringify(terminal)).toContain('fixture-root-failure');
  expect(JSON.stringify(terminal)).not.toContain('fixture-constructor-failure');
  expect(CpuModuleWorker.instances).toEqual([]);
  expect(CpuModuleWorker.ctorAttempts).toBe(1);
});

it('retains the exact constructor error when the Native root succeeds', async () => {
  CpuModuleWorker.ctorFailure = new Error('fixture-constructor-failure');
  await launch();
  state.rootGate?.resolve();
  expect(await state.terminal?.promise).toMatchObject({
    kind: 'fault',
    detail: { message: 'fixture-constructor-failure' },
  });
  expect(CpuModuleWorker.instances).toEqual([]);
  expect(CpuModuleWorker.ctorAttempts).toBe(1);
});

it('cleans a still-uninitialized real module worker on root failure without fake disposal ACK', async () => {
  state.rootFailure = new Error('fixture-root-failure');
  await launch();
  const child = worker();
  state.rootGate?.resolve();
  expect(await state.terminal?.promise).toMatchObject({ kind: 'fault' });
  await child.exited.promise;
  expect(child.thread.threadId).toBe(-1);
  expect(child.posts).toEqual([]); // No init/dispose: the real module gate never opened.
});

it('preserves kernel-ready failure precedence and disposes the staged uninitialized worker', async () => {
  state.kernelFailure = new Error('fixture-kernel-failure');
  await launch(true);
  const child = worker();
  state.rootGate?.resolve();
  expect(await state.terminal?.promise).toMatchObject({
    kind: 'fault',
    detail: { message: 'fixture-kernel-failure' },
  });
  await child.exited.promise;
  expect(child.posts).toEqual([]);
  expect(state.order).toContain('kernel-cleanup');
});

it('preserves the Native root error over an actual early module failure and retains its raw cause', async () => {
  CpuModuleWorker.failModule = true;
  state.rootFailure = new Error('fixture-root-failure');
  await launch();
  const child = worker();
  child.openModuleGate();
  await child.loaded.promise;
  state.rootGate?.resolve();
  const terminal = await state.terminal?.promise;
  expect(terminal).toMatchObject({ kind: 'fault', detail: { code: 'plugin-startup-failed' } });
  expect(JSON.stringify(terminal)).toContain('fixture-root-failure');
  expect(JSON.stringify(terminal)).not.toContain('fixture-early-module-failure');
  expect(child.moduleErrors).toEqual(['fixture-early-module-failure']);
  expect(child.errorEvents[0]?.defaultPrevented).toBe(true);
  expect(child.propagatedErrors).toEqual([]);
  await child.exited.promise;
  expect(child.posts).toEqual([]);
});

it('cancels a queued staged event even after its owned worker was disposed', async () => {
  state.rootFailure = new Error('fixture-root-failure');
  await launch();
  const child = worker();
  const stagedHandler = child.onerror;
  expect(typeof stagedHandler).toBe('function');
  state.rootGate?.resolve();
  expect(await state.terminal?.promise).toMatchObject({ kind: 'fault' });
  await child.exited.promise;
  const stale = new Event('error', { cancelable: true });
  Object.defineProperty(stale, 'message', { value: 'fixture-stale-module-error' });
  stagedHandler?.(stale as ErrorEvent);
  expect(stale.defaultPrevented).toBe(true);
  expect(child.posts).toEqual([]);
});

it('keeps explicit repeated module preload idempotent', async () => {
  const { SourceRenderWorker } = await import('../execution/source-render-worker');
  const { World } = await import('@forgeax/engine-ecs');
  const owner = new SourceRenderWorker(
    new World(),
    new AssetRegistry({ shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }) }),
    { startupTimeoutMs: 30_000, bootstrapUrl: 'fixture://root' } as never,
    () => undefined,
  );
  try {
    owner.preloadModule();
    owner.preloadModule();
    expect(CpuModuleWorker.instances).toHaveLength(1);
    expect(CpuModuleWorker.ctorAttempts).toBe(1);
    expect(CpuModuleWorker.instances[0]?.posts).toEqual([]);
  } finally {
    await owner.dispose();
  }
});

// Real child module/transport negative; no Renderer or GPU is initialized.
it('returns an explicit pre-ready inspection failure from the actual child module', async () => {
  const child = new CpuModuleWorker(
    new URL('../execution/render-worker-runtime.mjs', import.meta.url),
    { type: 'module', name: 'forgeax-render' },
  );
  try {
    child.openModuleGate();
    const loaded = await child.loaded.promise;
    expect(loaded).toMatchObject({ gpuCalls: 0 });
    expect(loaded.moduleUrl).toBe(
      new URL('../../dist/render-worker-runtime.mjs', import.meta.url).href,
    );
    const replies: RenderWorkerOutput[] = [];
    child.addEventListener('message', (event) => replies.push(event.data));
    child.postMessage({
      kind: 'inspect',
      requestId: 501,
      identity: { source: 'pre-ready', epoch: 1 },
      worldIdentity: 'not-initialized',
    });
    await vi.waitFor(() =>
      expect(replies).toContainEqual(
        expect.objectContaining({
          kind: 'inspect-result',
          requestId: 501,
          result: expect.objectContaining({ ok: false }),
        }),
      ),
    );
    expect(child.posts.some((row) => row.kind === 'init' || row.kind === 'draw')).toBe(false);
  } finally {
    child.postMessage({ kind: 'dispose' });
    await child.exited.promise;
    expect(child.thread.threadId).toBe(-1);
  }
});
