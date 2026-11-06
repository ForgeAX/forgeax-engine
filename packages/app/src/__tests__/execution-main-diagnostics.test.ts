import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Context } from '@forgeax/engine-plugin';
import type { createProfiler } from '@forgeax/engine-profiler';
import type { RendererHostAssembly } from '@forgeax/engine-runtime/internal/renderer-host';
import { ok } from '@forgeax/engine-types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../browser';
import { prepareBootstrapEntry } from '../execution/bootstrap-entry';
import type { RuntimePackAssembly } from '../runtime-packs.js';
import { ssrIdentityFixture } from './execution-fixtures';

const constructRuntimeRendererHost = vi.hoisted(() => vi.fn());
const executionHostTestDoubles = vi.hoisted(() => ({
  probeCapabilities: vi.fn(),
  createWorkerApp: vi.fn(),
}));
vi.mock('@forgeax/engine-runtime/internal/renderer-host', () => ({
  constructRuntimeRendererHost,
  loadRhiPack: vi.fn(),
}));
vi.mock('../execution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../execution')>()),
  probeExecutionCapabilities: executionHostTestDoubles.probeCapabilities,
}));
vi.mock('../execution/host-controller', () => ({
  createWorkerExecutionApp: executionHostTestDoubles.createWorkerApp,
}));
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  const unavailable = { available: false, reason: 'fixture' };
  executionHostTestDoubles.probeCapabilities.mockReset().mockResolvedValue({
    worker: unavailable,
    offscreenCanvas: unavailable,
    workerAnimationFrame: unavailable,
    workerWebGpu: unavailable,
    crossOriginIsolated: unavailable,
    sharedArrayBuffer: unavailable,
    atomicsWait: unavailable,
  });
  executionHostTestDoubles.createWorkerApp.mockReset();
});

it.each([
  false,
  true,
])('constructs the local Renderer with optional bootstrap SSR identity: %s', async (provided) => {
  const renderer = {
    state: () => 'alive',
    inspect: () => ({}),
    attach: () => ({ ok: true, value: { dispose() {} } }),
    subscribe: () => () => {},
    dispose: vi.fn(),
    releaseSurface: () => ({ ok: true, value: undefined }),
    restoreSurface: () => ({ ok: true, value: undefined }),
  };
  constructRuntimeRendererHost.mockClear();
  constructRuntimeRendererHost.mockResolvedValue({
    ok: true,
    value: {
      renderer,
      initialization: Promise.resolve(
        ok(undefined),
      ) satisfies RendererHostAssembly['initialization'],
    },
  });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const bootstrap = `data:text/javascript,${encodeURIComponent(`
    const identity=${JSON.stringify(ssrIdentityFixture)};
    export default () => (${provided ? '{ssrIdentity:identity}' : '{}'});
  `)}`;
  const prepared = await prepareBootstrapEntry(bootstrap, undefined);
  if (!prepared.ok) throw prepared.error;
  const canvas = {
    tagName: 'CANVAS',
    isConnected: true,
    width: 64,
    height: 64,
    clientWidth: 64,
    clientHeight: 64,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  const result = await createApp(canvas, {
    input: { sample: vi.fn(), detach: vi.fn() },
    execution: { bootstrap, workers: { engine: false, render: false, kernels: false } },
  });
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
  if (!result.ok) return;
  try {
    expect(constructRuntimeRendererHost).toHaveBeenCalledTimes(1);
    const options = constructRuntimeRendererHost.mock.calls[0]?.[1];
    if (provided) expect(options.ssrIdentity).toBe(prepared.value.ssrIdentity);
    else expect(options).not.toHaveProperty('ssrIdentity');
  } finally {
    await result.value.dispose();
  }
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
});

it('keeps top-level SSR identity realm-bound when execution is configured', async () => {
  constructRuntimeRendererHost.mockClear();
  const canvas = {
    tagName: 'CANVAS',
    isConnected: true,
    width: 64,
    height: 64,
    clientWidth: 64,
    clientHeight: 64,
  } as unknown as HTMLCanvasElement;
  const result = await createApp(canvas, {
    ssrIdentity: ssrIdentityFixture,
    execution: {
      bootstrap: 'data:text/javascript,export default () => ({})',
      workers: { engine: false, render: false, kernels: false },
    },
  });
  expect(result).toMatchObject({ ok: false, error: { code: 'app-execution-bootstrap-failed' } });
  expect(constructRuntimeRendererHost).not.toHaveBeenCalled();
});

it('releases the Worker browser bridge on terminal stop, not idle stop or pause', async () => {
  const available = { available: true, reason: 'fixture' };
  executionHostTestDoubles.probeCapabilities.mockResolvedValue({
    worker: available,
    offscreenCanvas: available,
    workerAnimationFrame: available,
    workerWebGpu: available,
    crossOriginIsolated: available,
    sharedArrayBuffer: available,
    atomicsWait: available,
  });
  let workerState: 'idle' | 'running' | 'paused' | 'stopped' = 'idle';
  let workerApp: object;
  const baseStart = vi.fn(() => {
    workerState = 'running';
    return ok(undefined);
  });
  const basePause = vi.fn(() => {
    workerState = 'paused';
    return ok(undefined);
  });
  const baseResume = vi.fn(() => {
    workerState = 'running';
    return ok(undefined);
  });
  const baseStop = vi.fn(function (this: unknown) {
    expect(this).toBe(workerApp);
    if (workerState !== 'running' && workerState !== 'paused') {
      return { ok: false, error: { code: 'app-not-started' } as never };
    }
    workerState = 'stopped';
    return ok(undefined);
  });
  const baseDispose = vi.fn(async function (this: unknown) {
    expect(this).toBe(workerApp);
    workerState = 'stopped';
    return ok(undefined);
  });
  workerApp = {
    execution: { report: () => ({}) },
    remoteEval: vi.fn(),
    start: baseStart,
    pause: basePause,
    resume: baseResume,
    stop: baseStop,
    dispose: baseDispose,
  };
  executionHostTestDoubles.createWorkerApp.mockResolvedValue(ok(workerApp as never));

  const teardown = vi.fn();
  let hostDispose: (() => void) | undefined;
  const bridge = {
    port: '5733',
    installExecutionBridge: vi.fn(async () => teardown),
    installLocalBridge: vi.fn(async () => teardown),
    registerDispose: vi.fn((dispose: () => void) => {
      hostDispose = dispose;
    }),
  };
  const canvas = {
    tagName: 'CANVAS',
    isConnected: true,
    width: 64,
    height: 64,
    clientWidth: 64,
    clientHeight: 64,
  } as unknown as HTMLCanvasElement;
  const result = await createApp(
    canvas,
    {
      execution: {
        bootstrap: 'https://example.test/engine-bootstrap.js',
        workers: { engine: true, render: false, kernels: false },
      },
    },
    { browserRemoteBridge: bridge },
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;

  expect(result.value.stop()).toMatchObject({ ok: false, error: { code: 'app-not-started' } });
  expect(teardown).not.toHaveBeenCalled();
  expect(result.value.start()).toMatchObject({ ok: true });
  expect(result.value.pause()).toMatchObject({ ok: true });
  expect(teardown).not.toHaveBeenCalled();
  expect(result.value.resume()).toMatchObject({ ok: true });
  expect(teardown).not.toHaveBeenCalled();
  expect(result.value.stop()).toMatchObject({ ok: true });
  expect(teardown).toHaveBeenCalledOnce();

  await result.value.dispose();
  hostDispose?.();
  hostDispose?.();
  result.value.stop();

  expect(baseDispose).toHaveBeenCalledOnce();
  expect(baseStart).toHaveBeenCalledOnce();
  expect(basePause).toHaveBeenCalledOnce();
  expect(baseResume).toHaveBeenCalledOnce();
  expect(baseStop).toHaveBeenCalledTimes(3);
  expect(teardown).toHaveBeenCalledOnce();
});

it('keeps the local browser bridge through idle stop and pause, then releases on terminal stop', async () => {
  const renderer = {
    state: () => 'alive',
    inspect: () => ({}),
    attach: () => ({ ok: true, value: { dispose() {} } }),
    subscribe: () => () => {},
    dispose: vi.fn(),
    releaseSurface: () => ({ ok: true, value: undefined }),
    restoreSurface: () => ({ ok: true, value: undefined }),
  };
  const assets = new AssetRegistry({ shaderRegistry: {} as never });
  constructRuntimeRendererHost.mockResolvedValue({
    ok: true,
    value: {
      renderer,
      assets,
      initialization: Promise.resolve(
        ok(undefined),
      ) satisfies RendererHostAssembly['initialization'],
    },
  });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const canvas = {
    tagName: 'CANVAS',
    isConnected: true,
    width: 64,
    height: 64,
    clientWidth: 64,
    clientHeight: 64,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  const teardown = vi.fn();
  let hostDispose: (() => void) | undefined;
  const bridge = {
    port: '5733',
    installExecutionBridge: vi.fn(async () => teardown),
    installLocalBridge: vi.fn(async () => teardown),
    registerDispose: vi.fn((dispose: () => void) => {
      hostDispose = dispose;
    }),
  };

  const result = await createApp(
    canvas,
    { input: { sample: vi.fn(), detach: vi.fn() } },
    { browserRemoteBridge: bridge },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  expect(result.value.stop()).toMatchObject({ ok: false, error: { code: 'app-not-started' } });
  expect(teardown).not.toHaveBeenCalled();
  result.value.start().unwrap();
  result.value.pause().unwrap();
  expect(teardown).not.toHaveBeenCalled();
  result.value.resume().unwrap();
  result.value.stop().unwrap();
  expect(teardown).toHaveBeenCalledOnce();

  await result.value.dispose();
  hostDispose?.();
  hostDispose?.();
  assets.dispose();

  expect(bridge.installLocalBridge).toHaveBeenCalledOnce();
  expect(teardown).toHaveBeenCalledOnce();
  expect(renderer.dispose).toHaveBeenCalledOnce();
});

it('rejects a Worker shader manifest reader with a URL-based recovery hint', async () => {
  const available = { available: true, reason: 'fixture' };
  executionHostTestDoubles.probeCapabilities.mockResolvedValue({
    worker: available,
    offscreenCanvas: available,
    workerAnimationFrame: available,
    workerWebGpu: available,
    crossOriginIsolated: available,
    sharedArrayBuffer: available,
    atomicsWait: available,
  });
  executionHostTestDoubles.createWorkerApp.mockResolvedValue(ok({ remoteEval: vi.fn() } as never));
  const canvas = {
    tagName: 'CANVAS',
    isConnected: true,
    width: 64,
    height: 64,
    clientWidth: 64,
    clientHeight: 64,
  } as unknown as HTMLCanvasElement;
  const readShaderManifest = vi.fn(async () => '{}');
  const result = await createApp(
    canvas,
    {
      execution: {
        bootstrap: 'https://example.test/engine-bootstrap.js',
        workers: { engine: true, render: false, kernels: false },
      },
    },
    {
      shaderManifestUrl: 'https://example.test/shaders.json',
      readShaderManifest,
    },
  );

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'app-execution-bootstrap-failed',
      detail: {
        phase: 'prepare',
        realmBoundOption: 'bundler.readShaderManifest',
      },
    },
  });
  if (!result.ok) {
    expect(result.error.hint).toContain('shaderManifestUrl');
    expect(result.error.detail.cause).toMatchObject({
      message: expect.stringContaining('shaderManifestUrl'),
    });
  }
  expect(readShaderManifest).not.toHaveBeenCalled();
});

it.each([
  false,
  true,
])('preserves execution diagnostics with engine/render workers disabled: %s', async (enabled) => {
  let frame: FrameRequestCallback | undefined;
  const draw = vi.fn((_request: unknown) => ({
    ok: true,
    value: {
      frameId: 1,
      deviceGeneration: 0,
      presentation: 'ready',
      completed: Promise.resolve({ ok: true, value: undefined }),
    },
  }));
  const renderer = {
    draw,
    state: () => 'alive',
    inspect: () => ({}),
    attach: () => ({ ok: true, value: { dispose() {} } }),
    subscribe: () => () => {},
    dispose() {},
    releaseSurface: () => ({ ok: true, value: undefined }),
    restoreSurface: () => ({ ok: true, value: undefined }),
  };
  constructRuntimeRendererHost.mockResolvedValue({
    ok: true,
    value: {
      renderer,
      assets: undefined,
      initialization: Promise.resolve(
        ok(undefined),
      ) satisfies RendererHostAssembly['initialization'],
    },
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    frame = undefined;
  });
  const bootstrap = `data:text/javascript,${encodeURIComponent(`export default () => ({ plugins: [{
    name: 'observe-profiler', inject: ['world'], apply(ctx) {
      ctx.world.insertResource('observedProfiler', ctx.get('profiler') ?? null);
    }
  }] })`)}`;
  const canvas = {
    tagName: 'CANVAS',
    isConnected: true,
    width: 64,
    height: 64,
    clientWidth: 64,
    clientHeight: 64,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  const timing = {};
  const result = await createApp(canvas, {
    input: {
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
      detach: vi.fn(),
    },
    execution: {
      bootstrap,
      workers: { engine: false, render: false, kernels: false },
      diagnostics: {
        profiler: enabled,
        ...(enabled ? { gpuPassTiming: timing, geometryLane: 'direct' } : {}),
      },
    },
  });
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
  if (!result.ok) return;
  const app = result.value;
  try {
    if (!('world' in app) || !(app.world instanceof World)) throw new Error('Expected local World');
    const options = constructRuntimeRendererHost.mock.calls.at(-1)?.[1];
    const observed = app.world.getResource<ReturnType<typeof createProfiler> | null>(
      'observedProfiler',
    );
    if (enabled) {
      expect(options.profiler).toBeDefined();
      expect(observed).toBe(options.profiler);
      expect(options.gpuPassTiming).toBe(timing);
      if (observed == null) throw new Error('Missing local profiler');
      const started = observed.startCapture({ frameLimit: 1, eventLimit: 64 });
      expect(started.ok).toBe(true);
      if (started.ok) expect(started.value.finish().ok).toBe(true);
    } else {
      expect(options.profiler).toBeUndefined();
      expect(options.gpuPassTiming).toBeUndefined();
      expect(observed).toBeNull();
    }
    app.start().unwrap();
    for (let frameIndex = 0; frameIndex < 2; frameIndex++) {
      const tick = frame;
      frame = undefined;
      if (tick === undefined) throw new Error('missing scheduled frame');
      tick(performance.now());
      await Promise.resolve();
      const request = draw.mock.calls.at(-1)?.[0];
      if (enabled) expect(request).toHaveProperty('geometryLane', 'direct');
      else expect(request).not.toHaveProperty('geometryLane');
    }
    expect(draw).toHaveBeenCalledTimes(2);
  } finally {
    await app.dispose();
  }
});

it.each([
  false,
  true,
])('cleans the renderer, asset provider and producer after a bootstrap root failure (borrowed context: %s)', async (borrowed) => {
  const renderer = {
    state: () => 'alive',
    inspect: () => ({}),
    attach: () => ({ ok: true, value: { dispose() {} } }),
    subscribe: () => () => {},
    dispose: vi.fn(),
    releaseSurface: () => ({ ok: true, value: undefined }),
    restoreSurface: () => ({ ok: true, value: undefined }),
  };
  const assets = new AssetRegistry({ shaderRegistry: {} as never });
  constructRuntimeRendererHost.mockResolvedValue({
    ok: true,
    value: {
      renderer,
      assets,
      initialization: Promise.resolve(
        ok(undefined),
      ) satisfies RendererHostAssembly['initialization'],
    },
  });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const key = '__runtimePackFailedRoot';
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals[key];
  const parent = new Context();
  parent.provide('unrelated', true);
  const bootstrap = `data:text/javascript,${encodeURIComponent(`export default () => ({
    pluginPrograms: { sessionId: 'test', contextId: 'engine', sessionGeneration: 1, target: 'engine', tools: new Map(), definitions: new Map(), programs: new Map() },
    runtimePacks: { scopeId: 'test' },
    plugins: [{ inject: ['runtimePacks'], apply(ctx) { globalThis.${key} = ctx.runtimePacks; } }],
    root: { guid: '01900000-0000-7000-8000-000000009999' }
  })`)}`;
  const canvas = {
    tagName: 'CANVAS',
    isConnected: true,
    width: 64,
    height: 64,
    clientWidth: 64,
    clientHeight: 64,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  try {
    const result = await createApp(canvas, {
      ...(borrowed ? { context: parent } : {}),
      input: { sample: vi.fn(), detach: vi.fn() },
      assetCatalog: createCatalogSource({ entries: [] }),
      execution: { bootstrap, workers: { engine: false, render: false, kernels: false } },
    });
    expect(assets.hasCatalogSource).toBe(false);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    const runtime = globals[key] as RuntimePackAssembly;
    expect(runtime).toBeDefined();
    expect(
      await runtime.producer.admit({
        source: {
          schemaVersion: '3.0.0',
          packageId: '01900000-0000-7000-8000-000000000401',
          assets: {},
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'runtime-pack-cancelled' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'app-plugin-activation-failed' } });
    expect(parent.get('unrelated')).toBe(true);
  } finally {
    await parent.fiber.dispose();
    delete globals[key];
  }
});

vi.mock('@forgeax/engine-platform-browser', () => import('./platform-fixture'));
