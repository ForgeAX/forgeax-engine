// @vitest-environment jsdom
import { runInNewContext } from 'node:vm';
import { canvasAspectPlugin } from '@forgeax/engine-app';
import { AssetRegistry, assetsPlugin } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { Context, Plugin } from '@forgeax/engine-plugin';
import { inspectPluginFiber } from '@forgeax/engine-plugin';
import { Camera, orthographic, perspective, type RendererOptions } from '@forgeax/engine-render';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import {
  createRenderFeatureHost,
  type RenderFeatureFrameInput,
  runRenderFeatureFrame,
} from '../../../../render/src/features/host.js';
import { VFX_GPU_RUNTIME_RESOURCE_KEY } from '../../../../vfx/src/index.js';
import { createVfxRuntimeHost } from '../../../../vfx-render/src/index.js';
import { gameVfxSource } from '../../game-vfx-source.js';
import type { ProjectFacts } from '../../types.js';
import { wechatHostSource } from '../wechat.js';

const primary = {
  code: 'plugin-startup-failed',
  expected: 'the root and all required startup descendants to become ACTIVE',
  hint: 'repair the activation owner',
  detail: { reason: 'timeout', cleanup: 'completed' },
};
const cleanupError = {
  code: 'device-operation-failed',
  detail: { operation: 'renderer-event', cause: { code: 'render-system-no-camera' } },
};

async function host(
  activate: (emitError: (error: unknown) => void) => Promise<unknown>,
  rhiDebug = false,
) {
  let drawSource: (() => unknown) | undefined;
  let inputAllowed = true;
  const audioOwners: { destroy: ReturnType<typeof vi.fn> }[] = [];
  const releases: string[] = [];
  const captureLifecycle: string[] = [];
  const graphicsOptions: RendererOptions[] = [];
  const createGameVfx = vi.fn(
    runInNewContext(
      `${gameVfxSource.replace(/^import .*;$/gm, '').replace('export function', 'function')}\ncreateGameVfx`,
      { createVfxRuntimeHost },
    ),
  );
  const captures: { captureFrame(): Promise<unknown>; dispose(): Promise<{ ok: true }> }[] = [];
  const backend = {};
  const nativeRhi = {};
  const createShaderModule = vi.fn();
  const createShaderModuleImmediate = vi.fn();
  const instrument = {};
  const listeners = new Set<(error: unknown) => void>();
  const emitError = (error: unknown) => {
    for (const listener of listeners) listener(error);
  };
  const unwrap = <T>(value: T) => ({ unwrap: () => value });
  const canvas = { width: 1, height: 1 };
  const displayListeners = new Set<(event: unknown) => void>();
  let pluginContext: Context | undefined;
  let world: World | undefined;
  let executionFault: unknown = null;
  let completeFrame: (() => void) | undefined;
  const platform = {
    canvas,
    display: () => unwrap({ width: 1280, height: 720, pixelRatio: 1 }),
    now: () => unwrap(performance.now()),
    visible: () => true,
    subscribe: (listener: (event: unknown) => void) => {
      displayListeners.add(listener);
      return unwrap(() => displayListeners.delete(listener));
    },
    dispose: () => {},
  };
  const renderer = {
    inspect: () => ({ state: 'alive' }),
    dispose: () => {
      captureLifecycle.push('renderer');
    },
  };
  const app = {
    rhiCapture: undefined as unknown,
    renderer,
    pluginContext: {},
    world: { identity: 'world-1' },
    execution: { report: () => ({ engine: { health: 'running' }, fault: executionFault }) },
    onError(listener: (error: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => unwrap(undefined),
    pause: () => unwrap(undefined),
    dispose: async () => {
      await pluginContext?.fiber.dispose();
      releases.push('app');
      captureLifecycle.push('app');
      return unwrap(undefined);
    },
  };
  const source = wechatHostSource({ name: 'Native startup' } as ProjectFacts, '/native', rhiDebug)
    .replace(/^import .*;$/gm, '')
    .replace('export function start(', 'function start(')
    .replace("import('./wechat-game.ts')", 'loadGame()');
  const running = runInNewContext(
    `${source}\n({ start, stop: () => dispose?.(), inspect: () => globalThis.__forgeaxGameInspection.renderer(), inspection: () => globalThis.__forgeaxGameInspection })`,
    {
      canvasAspectPlugin,
      inspectPluginFiber,
      createGameVfx,
      AbortController,
      console: { info: vi.fn(), error: vi.fn() },
      setTimeout,
      clearTimeout,
      wx: { createCanvas: () => canvas },
      WXWebAssembly: {},
      createWechatPlatform: () => unwrap(platform),
      createWechatWasmHost: () => unwrap({}),
      createWechatWgpuHost: () => unwrap({}),
      createWechatPackageFetcher: () => async () => ({
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
      createBlitzUi: async ({ html }: { html: string }) => {
        document.open();
        document.write(html);
        document.close();
        return { document, resize: () => {}, dispose: () => {} };
      },
      gpuShaders: {},
      createWechatInputBackend: () =>
        unwrap({
          detach: () => {},
          setInputAllowed: (allowed: boolean) => {
            inputAllowed = allowed;
          },
        }),
      createWechatAudioBackend: () => {
        const audio = {
          destroy: vi.fn(() => {
            releases.push('audio');
          }),
        };
        audioOwners.push(audio);
        return audio;
      },
      ensureReady: async () => {
        captureLifecycle.push('ready');
      },
      rhi: nativeRhi,
      createShaderModule,
      createShaderModuleImmediate,
      attachRecorder: (selected: unknown) => {
        expect(captureLifecycle.at(-1)).toBe('ready');
        expect(selected).toEqual({
          rhi: nativeRhi,
          createShaderModule,
          createShaderModuleImmediate,
        });
        let finish: ((value: unknown) => void) | undefined;
        const recorder = {
          backend: { rhi: backend },
          captureFrame: () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
          dispose: async () => {
            captureLifecycle.push('recorder');
            finish?.({ ok: false, error: { code: 'capture-unavailable' } });
            return { ok: true as const };
          },
        };
        captures.push(recorder);
        return { ok: true, value: recorder };
      },
      createRhiCapture: (recorder: unknown) => recorder,
      createRhiInstrumentation: () => instrument,
      constructRuntimeRendererHost: async (_canvas: unknown, options: RendererOptions) => {
        graphicsOptions.push(options);
        if (rhiDebug) {
          expect(options.rhi).toBe(backend);
          expect(options.rhiInstrumentation).toBe(instrument);
        }
        return {
          ok: true,
          value: {
            renderer,
            assets: new AssetRegistry({
              shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
            }),
            initialization: Promise.resolve({ ok: true }),
          },
        };
      },
      forgeaxBundlerAdapter: () => ({}),
      World,
      createCatalogSource: () => ({}),
      createApp: async (args: {
        world: World;
        assets: AssetRegistry;
        plugins: Plugin[];
        drawSource?: () => unknown;
        rhiCapture?: unknown;
        onFrameSubmitted(detail: object): void;
        onFrameCompleted(detail: object): void;
      }) => {
        world = args.world;
        executionFault = null;
        completeFrame = () => {
          const detail = {
            worldIdentity: args.world.identity,
            deviceGeneration: 1,
            frameId: 1,
            presentation: 'ready',
          };
          args.onFrameSubmitted(detail);
          args.onFrameCompleted(detail);
        };
        pluginContext = await createWorldContext(world, [
          assetsPlugin(args.assets),
          ...args.plugins,
        ]);
        app.pluginContext = pluginContext;
        app.world = world;
        drawSource = args.drawSource;
        app.rhiCapture = args.rhiCapture;
        return unwrap(app);
      },
      enginePrograms: () => ({}),
      runtimeBinding: { scopeId: 'native-test' },
      imports: {},
      programHost: {},
      inputBackendPlugin: () => ({ name: 'test-input-backend', apply() {} }),
      inputPlugin: () => ({ name: 'test-input', apply() {} }),
      audioBackendPlugin: (backend: unknown) => ({
        name: 'test-audio-backend',
        backend,
        apply() {},
      }),
      audioPlugin: () => ({ name: 'test-audio', apply() {} }),
      loadGame: async () => ({ activate: () => activate(emitError) }),
    },
  ) as {
    start(): Promise<void>;
    stop(): Promise<void>;
    inspect(): { phase: string; execution?: unknown; startupError?: unknown };
    inspection():
      | {
          plugins(): { fibers: ReturnType<typeof inspectPluginFiber>[]; truncated: boolean };
          rhiCapture?: { captureFrame(): Promise<unknown> };
        }
      | undefined;
  };
  await running.start();
  return {
    ...running,
    emitError,
    failExecution(error: unknown) {
      executionFault = error;
      emitError(error);
    },
    completeFrame: () => completeFrame?.(),
    drawSource: () => drawSource?.(),
    inputAllowed: () => inputAllowed,
    audioOwners,
    releases,
    captures,
    captureLifecycle,
    graphicsOptions,
    createGameVfx,
    context: () => pluginContext,
    world: () => {
      if (world === undefined) throw new Error('Host World is missing');
      return world;
    },
    display: (width: number, height: number, pixelRatio = 1) => {
      for (const listener of displayListeners)
        listener({ kind: 'display', display: { width, height, pixelRatio } });
    },
  };
}

describe('native Host startup failure ownership', () => {
  it('projects actual native Fiber states and missing services through the existing inspection owner', async () => {
    const running = await host(async () => ({ dispose: async () => {} }));
    try {
      await vi.waitFor(() => expect(running.inspect().phase).toBe('ready'));
      running.context()?.plugin({ name: 'await-native-service', inject: ['absent'], apply() {} });
      const plugins = running.inspection()?.plugins();
      expect(plugins?.truncated).toBe(false);
      expect(plugins?.fibers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'await-native-service',
            state: 'pending',
            missingServices: ['absent'],
          }),
          expect.objectContaining({ name: 'test-input', state: 'active', missingServices: [] }),
        ]),
      );
    } finally {
      await running.stop();
    }
  });

  it('attaches the same native VFX owner before game activation and replaces it after Host retirement', async () => {
    const running = await host(async () => ({ dispose: async () => {} }));
    const firstWorld = running.world();
    try {
      expect(running.createGameVfx).toHaveBeenCalledTimes(1);
      expect(firstWorld.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)).toBe(true);
      const first = running.createGameVfx.mock.results[0]?.value;
      expect(running.graphicsOptions[0]?.features).toEqual([first.feature]);
      const selectedView = {
        position: new Float32Array([3, 4, 5]),
        right: new Float32Array([1, 0, 0]),
        up: new Float32Array([0, 1, 0]),
        viewProjection: new Float32Array(16),
      };
      const extracted = first.feature
        .extract({
          worlds: [firstWorld],
          owner: 0,
          frameNumber: 1,
          views: [{ identity: 'main', selectedView }],
        })
        .unwrap();
      expect(extracted.worlds[0].camera).toBe(selectedView);
      const featureHost = createRenderFeatureHost([first.feature]).unwrap();
      const empty = runRenderFeatureFrame(featureHost, [
        {
          identity: 'main',
          render: true,
          worlds: [firstWorld],
          owner: 0,
          frameNumber: 2,
          selectedView,
          caps: { compute: false, indirectDrawing: false } as RenderFeatureFrameInput['caps'],
        },
      ]);
      expect(empty.frame.errors).toEqual([]);
      expect(
        empty.frame.plans.every(
          ({ plan }) => plan.resources.length === 0 && plan.passes.length === 0,
        ),
      ).toBe(true);
      expect(empty.preparedResourceBatches).toEqual([]);
      empty.onAborted();
      featureHost.dispose();
      await running.start();
      expect(firstWorld.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)).toBe(false);
      expect(running.world().hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)).toBe(true);
      expect(running.createGameVfx).toHaveBeenCalledTimes(2);
      const second = running.createGameVfx.mock.results[1]?.value;
      expect(second.feature).not.toBe(first.feature);
      expect(running.graphicsOptions[1]?.features).toEqual([second.feature]);
    } finally {
      await running.stop();
    }
    expect(running.world().hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)).toBe(false);
  });

  it('updates ordinary perspective cameras across native orientation changes and retires the policy', async () => {
    const running = await host(async () => ({ dispose: async () => {} }));
    const world = running.world();
    const camera = world
      .spawn({ component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) })
      .unwrap();
    const fixed = world
      .spawn({ component: Camera, data: perspective({ fov: 1, aspect: 1.25, autoAspect: false }) })
      .unwrap();
    const ortho = world
      .spawn({ component: Camera, data: orthographic({ left: -2, right: 2, bottom: -1, top: 1 }) })
      .unwrap();
    const orthoBefore = world.get(ortho, Camera).unwrap();
    try {
      for (const [width, height] of [
        [844, 390],
        [390, 844],
        [844, 390],
      ] as const) {
        running.display(width, height, 3);
        world.update(1 / 60).unwrap();
        expect(world.get(camera, Camera).unwrap().aspect).toBeCloseTo(width / height, 6);
        expect(world.get(fixed, Camera).unwrap().aspect).toBe(1.25);
        expect(world.get(ortho, Camera).unwrap()).toEqual(orthoBefore);
      }
    } finally {
      await running.stop();
    }
    expect(world.inspect().systems.map((system) => system.name)).not.toContain(
      'app-sync-camera-aspect',
    );
  });

  it('omits recorder code and capture fields from ordinary publication', () => {
    const source = wechatHostSource({ name: 'Published game' } as ProjectFacts, '/native');
    expect(source).not.toMatch(/attachRecorder|rhiCapture|rhiInstrumentation|engine\/rhi-debug/);
  });

  it('shares the diagnostic recorder and releases a pending old capture before replacement', async () => {
    const running = await host(async () => ({ dispose: async () => {} }), true);
    try {
      await vi.waitFor(() => expect(running.inspect().phase).toBe('ready'));
      const old = running.inspection()?.rhiCapture;
      if (old === undefined) throw new Error('diagnostic capture is missing');
      expect(old).toBe(running.captures[0]);
      const pending = old.captureFrame();
      await running.start();
      await vi.waitFor(() => expect(running.inspect().phase).toBe('ready'));
      expect(await pending).toMatchObject({ ok: false, error: { code: 'capture-unavailable' } });
      expect(running.inspection()?.rhiCapture).toBe(running.captures[1]);
      expect(running.captureLifecycle).toEqual(['ready', 'app', 'renderer', 'recorder', 'ready']);
    } finally {
      await running.stop();
    }
    expect(running.inspection()).toBeUndefined();
    expect(running.captureLifecycle.slice(-3)).toEqual(['app', 'renderer', 'recorder']);
  });

  it('replaces one native audio owner after each App retirement and destroys it on Host stop', async () => {
    const running = await host(async () => ({ dispose: async () => {} }));
    try {
      await vi.waitFor(() => expect(running.inspect().phase).toBe('ready'));
      expect(running.audioOwners).toHaveLength(1);
      expect(running.audioOwners[0]?.destroy).not.toHaveBeenCalled();
      await running.start();
      await vi.waitFor(() => expect(running.inspect().phase).toBe('ready'));
      expect(running.audioOwners).toHaveLength(2);
      expect(running.audioOwners[0]?.destroy).toHaveBeenCalledTimes(1);
      expect(running.audioOwners[1]?.destroy).not.toHaveBeenCalled();
      expect(running.releases).toEqual(['app', 'audio']);
    } finally {
      await running.stop();
      await running.stop();
    }
    expect(running.audioOwners[1]?.destroy).toHaveBeenCalledTimes(1);
    expect(running.releases).toEqual(['app', 'audio', 'app', 'audio']);
  });

  it('admits a scene only after activation commits, then withdraws it on failure', async () => {
    let commit!: (game: unknown) => void;
    const running = await host(
      () =>
        new Promise((resolve) => {
          commit = resolve;
        }),
    );
    try {
      await vi.waitFor(() => expect(running.inspect().phase).toBe('scene'));
      expect(running.drawSource()).toBeNull();
      expect(running.inputAllowed()).toBe(false);
      commit({ dispose: async () => {} });
      await vi.waitFor(() => expect(running.inspect().phase).toBe('ready'));
      expect(running.drawSource()).toBeUndefined();
      running.failExecution(cleanupError);
      expect(running.drawSource()).toBeNull();
    } finally {
      commit({ dispose: async () => {} });
      await running.stop();
    }
  });

  it('preserves activation rejection ahead of App errors emitted by its cleanup', async () => {
    const running = await host(async (emitError) => {
      // Native plugin activation disposes children before its promise rejects.
      // Removing Camera emits this App error while the original result is pending.
      emitError(cleanupError);
      await Promise.resolve();
      throw primary;
    });
    try {
      await vi.waitFor(() => expect(running.inspect().phase).toBe('failed'));
      const failure = running.inspect().startupError as {
        cause?: unknown;
        detail?: { appErrors?: unknown[] };
      };
      expect(failure.cause ?? failure).toBe(primary);
      expect(failure.detail?.appErrors).toEqual([cleanupError]);
      const details = document.querySelector('#forgeax-fatal-details')?.textContent ?? '';
      expect(details).toContain('plugin-startup-failed');
      expect(details).toContain('reason: timeout');
      expect(details).toContain('render-system-no-camera');
      expect(details.indexOf('plugin-startup-failed')).toBeLessThan(
        details.indexOf('render-system-no-camera'),
      );
    } finally {
      await running.stop();
    }
  });

  it('retains an unaccompanied activation failure without wrapping it', async () => {
    const running = await host(async () => {
      throw primary;
    });
    try {
      await vi.waitFor(() => expect(running.inspect().phase).toBe('failed'));
      expect(running.inspect().startupError).toBe(primary);
    } finally {
      await running.stop();
    }
  });

  it('does not commit successful activation after an App startup error', async () => {
    const running = await host(async (emitError) => {
      emitError(cleanupError);
      return { dispose: async () => {} };
    });
    try {
      await vi.waitFor(() => expect(running.inspect().phase).toBe('failed'));
      expect(running.inspect().startupError).toBe(cleanupError);
      expect(document.querySelector('#forgeax-fatal-details')?.textContent).toContain(
        'render-system-no-camera',
      );
    } finally {
      await running.stop();
    }
  });

  it('requires an App execution fault after entry and retains its first cause', async () => {
    const running = await host(async () => ({ dispose: async () => {} }));
    try {
      await vi.waitFor(() => expect(running.inspect().phase).toBe('ready'));
      running.completeFrame();
      await vi.waitFor(() => expect(running.inputAllowed()).toBe(true));
      running.emitError({ code: 'app-pointer-lock-failed' });
      running.emitError(cleanupError);
      expect(running.inspect()).toMatchObject({ phase: 'ready' });
      expect(running.inspect().startupError).toBeUndefined();
      expect(running.drawSource()).toBeUndefined();
      expect(running.inputAllowed()).toBe(true);
      running.failExecution(cleanupError);
      expect(running.inspect()).toMatchObject({ phase: 'failed', startupError: cleanupError });
      expect(running.drawSource()).toBeNull();
      expect(running.inputAllowed()).toBe(false);
      expect(document.querySelector('#forgeax-fatal-message')?.textContent).toBe(
        'The game stopped because execution failed.',
      );
      running.emitError({ code: 'cleanup-failed' });
      expect(running.inspect().startupError).toBe(cleanupError);
      expect(document.querySelector('#forgeax-fatal-details')?.textContent).not.toContain(
        'cleanup-failed',
      );
    } finally {
      await running.stop();
    }
  });
});
