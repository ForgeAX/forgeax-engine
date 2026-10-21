import type { EngineToHostMessage, ExecutionInitMessage } from '../../execution/protocol';

// Dedicated-browser-Worker fixture. Imports the actual owning class and actual
// Native Cordis/World; only the failing child module URL is a controlled boundary.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ kind: string; mode?: string }>) => void) | null;
  postMessage(value: unknown): void;
  close(): void;
};
const BrowserWorker = globalThis.Worker;
let gpuCalls = 0;
Object.defineProperty(navigator, 'gpu', {
  configurable: true,
  value: {
    requestAdapter() {
      gpuCalls++;
      throw new Error('Unexpected fixture GPU request');
    },
  },
});
let releaseRoot!: () => void;
const rootGate = new Promise<void>((resolve) => {
  releaseRoot = resolve;
});
const children: ErrorModuleWorker[] = [];
let owner: import('../../execution/source-render-worker').SourceRenderWorker | undefined;
let context: import('@forgeax/engine-plugin').Context | undefined;
let terminal: Promise<void> | undefined;
let parentErrors = 0;
let fixtureMode: string | undefined;

class ErrorModuleWorker extends BrowserWorker {
  readonly requestedUrl: string;
  readonly requestedOptions: WorkerOptions | undefined;
  readonly inputs: unknown[] = [];
  terminateCalls = 0;
  constructor(url: string | URL, options?: WorkerOptions) {
    super(new URL('./render-worker-module-error.mjs', import.meta.url), options);
    this.requestedUrl = String(url);
    this.requestedOptions = options;
    children.push(this);
    this.addEventListener('error', (event) => {
      // Observe in a later task: a callback microtask checkpoint can precede
      // the owner's later onerror handler in the same native event dispatch.
      setTimeout(
        () =>
          scope.postMessage({
            kind: 'child-error',
            message: event.message,
            cancelable: event.cancelable,
            defaultPrevented: event.defaultPrevented,
          }),
        0,
      );
    });
  }
  override postMessage(message: unknown, transfer: Transferable[]): void;
  override postMessage(message: unknown, options?: StructuredSerializeOptions): void;
  override postMessage(
    message: unknown,
    transferOrOptions: Transferable[] | StructuredSerializeOptions = [],
  ): void {
    this.inputs.push(message);
    if (Array.isArray(transferOrOptions)) super.postMessage(message, transferOrOptions);
    else super.postMessage(message, transferOrOptions);
  }
  override terminate(): void {
    this.terminateCalls++;
    super.terminate();
  }
}
globalThis.Worker = ErrorModuleWorker;
// Do not cancel here. The explicit uncanceled negative must be able to reach
// the parent Document's Worker.onerror through this native nested Worker chain.
globalThis.addEventListener('error', (event) => {
  parentErrors++;
  scope.postMessage({ kind: 'parent-error', message: event.message });
});

async function run(mode: string): Promise<void> {
  if (mode === 'fixture-fails') throw new Error('fixture-controlled-startup-failure');
  if (mode === 'cleanup-fails' || mode === 'never-replies') {
    scope.postMessage({ kind: 'fixture-started' });
    return;
  }
  const [
    { SourceRenderWorker },
    { World, createWorldContext },
    { AssetRegistry },
    { ShaderRegistry },
    { startNativePlugin },
    { serializableDetail },
  ] = await Promise.all([
    import('../../execution/source-render-worker'),
    import('@forgeax/engine-ecs'),
    import('@forgeax/engine-assets-runtime'),
    import('@forgeax/engine-shader'),
    import('@forgeax/engine-plugin'),
    import('../../execution/worker-error'),
  ]);
  if (mode === 'uncanceled') {
    // No product handler: prove that this real transport exposes propagation.
    new ErrorModuleWorker(new URL('../../execution/render-worker-runtime.mjs', import.meta.url), {
      type: 'module',
      name: 'forgeax-render',
    });
    return;
  }
  const world = new World();
  context = await createWorldContext(world);
  owner = new SourceRenderWorker(
    world,
    new AssetRegistry({ shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }) }),
    { startupTimeoutMs: 30_000, bootstrapUrl: 'fixture://native-root' } as ExecutionInitMessage,
    (_message: EngineToHostMessage) => undefined,
  );
  owner.preloadModule();
  const started = await startNativePlugin(context, {
    name: 'fixture-native-root',
    inject: ['world'],
    async apply(ctx) {
      scope.postMessage({ kind: 'root-enter' });
      await rootGate;
      if (mode === 'root-fails') throw new Error('fixture-native-root-failure');
      ctx.world.insertResource('fixture-root-active', true);
    },
  });
  let primary: unknown;
  if (!started.ok) primary = started.error;
  else {
    try {
      await owner.start(new OffscreenCanvas(1, 1));
    } catch (cause) {
      primary = cause;
    }
  }
  scope.postMessage({
    kind: 'terminal',
    primary: serializableDetail(primary),
    parentErrors,
    gpuCalls,
    rootActive:
      world.hasResource('fixture-root-active') && world.getResource('fixture-root-active'),
    childCount: children.length,
    child:
      children[0] === undefined
        ? undefined
        : {
            requestedUrl: children[0].requestedUrl,
            requestedOptions: children[0].requestedOptions,
            inputs: children[0].inputs,
          },
  });
}

scope.onmessage = (event) => {
  if (event.data.kind === 'run') {
    fixtureMode = event.data.mode ?? 'root-fails';
    terminal = run(fixtureMode).catch((cause: unknown) => {
      scope.postMessage({ kind: 'fixture-failed', message: String(cause) });
    });
  } else if (event.data.kind === 'release-root') releaseRoot();
  else if (event.data.kind === 'dispose') {
    releaseRoot();
    void (async () => {
      try {
        await terminal;
        if (fixtureMode === 'cleanup-fails') throw new Error('fixture-controlled-cleanup-failure');
        await owner?.dispose();
        await context?.fiber.dispose();
        for (const child of children) child.terminate();
        scope.postMessage({
          kind: 'cleaned',
          gpuCalls,
          children: children.map((child) => ({ terminateCalls: child.terminateCalls })),
        });
      } catch (cause) {
        scope.postMessage({ kind: 'cleanup-failed', message: String(cause) });
      } finally {
        scope.close();
      }
    })();
  }
};
