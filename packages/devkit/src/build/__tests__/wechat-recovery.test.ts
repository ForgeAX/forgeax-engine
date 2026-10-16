import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { canvasAspectPlugin } from '@forgeax/engine-app';
import { createScriptablePackSourceSnapshot } from '@forgeax/engine-pack/source-node';
import type { BlitzUi, BlitzUiOptions } from '@forgeax/engine-ui-blitz';
import { afterEach, expect, it, vi } from 'vitest';
import { createVfxRuntimeHost } from '../../../../vfx-render/src/index.js';
import { gameVfxSource } from '../../game-vfx-source.js';
import type { ProjectFacts } from '../../types.js';
import { prepareWechatBuild } from '../wechat.js';

const { inspectUi } = (await import(
  new URL('../../../../ui/src/inspection.ts', import.meta.url).href
)) as typeof import('../../../../ui/src/inspection.js');

const { createBlitzUi } = (await import(
  new URL('../../../../ui-blitz/src/index.ts', import.meta.url).href
)) as typeof import('@forgeax/engine-ui-blitz');
const { createWechatPlatform, createWechatInputBackend, createWechatWgpuHost } = (await import(
  new URL('../../../../platform-wechat/src/index.ts', import.meta.url).href
)) as typeof import('@forgeax/engine-platform-wechat');
const wasm = await readFile(new URL('../../../../ui-blitz/pkg/ui_blitz_bg.wasm', import.meta.url));
// The real binding is realm-owned, just as it is in the generated module.
const wasmHost = {
  readWasm: async () => wasm,
  instantiate: (imports: WebAssembly.Imports) => WebAssembly.instantiate(wasm, imports),
};
const fontRoot = dirname(
  createRequire(import.meta.url).resolve('@fontsource-variable/noto-sans-sc/package.json'),
);
const [guideHtml, guideCss, guideLocalization, guideController] = await Promise.all([
  readFile(
    new URL('../../../../../templates/game-3d/assets/guide.ui.html', import.meta.url),
    'utf8',
  ),
  readFile(
    new URL('../../../../../templates/game-3d/assets/guide.ui.css', import.meta.url),
    'utf8',
  ),
  readFile(
    new URL('../../../../../templates/game-3d/assets/guide.ui.i18n.json', import.meta.url),
    'utf8',
  ),
  import(
    new URL('../../../../../templates/game-3d/assets/ui/guide-controller.ts', import.meta.url).href
  ),
]);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  vi.useRealTimers();
});

type FailurePoint = 'platform' | 'wgpu' | 'graphics' | 'app';
type Modal = {
  title: string;
  content: string;
  confirmText?: string;
  success?: (result: { confirm: boolean }) => void;
};

async function generatedHost() {
  const directory = await mkdtemp(resolve(tmpdir(), 'forgeax-wechat-recovery-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await prepareWechatBuild(
    { name: 'Native startup recovery', roots: {} } as ProjectFacts,
    directory,
    {
      assets: new Map(),
      deferred: [],
      sourceInputs: new Map(),
      sourceSnapshot: createScriptablePackSourceSnapshot(),
      filesystemInputs: undefined,
    },
  );
  const [hostSource, entrySource] = await Promise.all([
    readFile(resolve(directory, 'wechat-main.ts'), 'utf8'),
    readFile(resolve(directory, 'wechat-entry.ts'), 'utf8'),
  ]);
  const unwrap = <T>(value: T) => ({ unwrap: () => value });
  const modals: Modal[] = [];
  const startupEvents = new EventTarget();
  const nativeListeners = new Map<string, Set<(event?: unknown) => void>>();
  const releases: string[] = [];
  const documents: BlitzUi[] = [];
  const errors: unknown[] = [];
  let executionFault: unknown = null;
  const createdCanvases: { width: number; height: number }[] = [];
  const usedCanvases: unknown[] = [];
  const wasmHosts: unknown[] = [];
  const uiSignals: AbortSignal[] = [];
  let uiWait: { stage: 'resource' | 'result'; enter(): void; ready: Promise<void> } | undefined;
  const waitForUi = async (stage: 'resource' | 'result') => {
    if (uiWait?.stage !== stage) return;
    const waiting = uiWait;
    uiWait = undefined;
    waiting.enter();
    await waiting.ready;
  };
  let fault: { point: FailurePoint; error: unknown } | undefined;
  let appId = 0;
  let appError: ((error: unknown) => void) | undefined;
  let completeFrame: (() => void) | undefined;
  let gameDisposed = 0;
  const rejectAt = (point: FailurePoint) => {
    if (fault?.point !== point) return;
    const error = fault.error;
    fault = undefined;
    throw error;
  };
  const wx = {
    createCanvas: () => {
      // Native WASM admission only: this context cannot render a frame.
      const context = { VERSION: 7938, getParameter: () => 'WebGL 2.0 (lifecycle contract)' };
      const canvas = { width: 600, height: 400, getContext: () => context };
      createdCanvases.push(canvas);
      return canvas;
    },
    getPerformance: () => ({ now: () => performance.now() }),
    getDeviceInfo: () => ({ platform: 'devtools' }),
    getWindowInfo: () => {
      rejectAt('platform');
      return { windowWidth: 600, windowHeight: 400, pixelRatio: 1 };
    },
    showModal: (modal: Modal) => {
      modals.push(modal);
      startupEvents.dispatchEvent(new Event('modal'));
    },
    showKeyboard() {},
    hideKeyboard() {},
  } as Record<string, unknown>;
  for (const event of [
    'Show',
    'Hide',
    'WindowResize',
    'DeviceOrientationChange',
    'TouchStart',
    'TouchMove',
    'TouchEnd',
    'TouchCancel',
    'KeyboardInput',
    'KeyboardConfirm',
    'KeyboardComplete',
  ]) {
    const listeners = new Set<(event?: unknown) => void>();
    nativeListeners.set(event, listeners);
    wx[`on${event}`] = (listener: (event?: unknown) => void) => listeners.add(listener);
    wx[`off${event}`] = (listener: (event?: unknown) => void) => listeners.delete(listener);
  }
  const scope = {
    createGameVfx: runInNewContext(
      `${gameVfxSource.replace(/^import .*;$/gm, '').replace('export function', 'function')}\ncreateGameVfx`,
      { createVfxRuntimeHost },
    ),
    inspectUi,
    AbortController,
    Error,
    Uint8Array,
    console: {
      info: vi.fn((label: string, detail: string) => {
        if (
          label === '[forgeax.wechat.startup]' &&
          detail.startsWith('{') &&
          JSON.parse(detail).phase === 'ready'
        )
          startupEvents.dispatchEvent(new Event('ready'));
      }),
      warn: vi.fn(),
      error: (...args: unknown[]) => errors.push(args),
    },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    cancelAnimationFrame: vi.fn(),
    wx,
    WXWebAssembly: {},
    nativeWgpu: {},
    createWechatWgpuHost: vi.fn(createWechatWgpuHost),
    installWechatStandards: () => ({ unwrap() {} }),
    createWechatPlatform,
    createWechatInputBackend,
    createWechatWasmHost: vi.fn(() => unwrap(wasmHost)),
    createWechatPackageFetcher: () => async (url: string) => {
      if (url.endsWith('/index.css')) await waitForUi('resource');
      const path = new URL(url).pathname.replace(/^\/ui-fonts\//, '');
      const bytes = await readFile(resolve(fontRoot, path));
      return { arrayBuffer: async () => Uint8Array.from(bytes).buffer };
    },
    createBlitzUi: async (options: BlitzUiOptions) => {
      wasmHosts.push(options.wasm);
      uiSignals.push(required(options.signal));
      options.signal?.addEventListener('abort', () => releases.push('ui'), { once: true });
      const ui = await createBlitzUi(options);
      documents.push(ui);
      await waitForUi('result');
      return ui;
    },
    gpuShaders: {},
    createWechatAudioBackend: () => ({ destroy: () => releases.push('audio') }),
    ensureReady: (async () => rejectAt('wgpu')) as (options: {
      initFn: () => Promise<unknown>;
    }) => Promise<unknown>,
    rhi: {},
    constructRuntimeRendererHost: async (canvas: unknown) => {
      rejectAt('graphics');
      usedCanvases.push(canvas);
      return {
        ok: true,
        value: {
          renderer: {
            inspect: () => ({ state: 'alive' }),
            dispose: () => releases.push('renderer'),
          },
          assets: {},
          initialization: Promise.resolve({ ok: true }),
        },
      };
    },
    forgeaxBundlerAdapter: () => ({}),
    canvasAspectPlugin,
    World: class {
      identity = `world-${++appId}`;
    },
    createCatalogSource: () => ({}),
    createApp: async (args: {
      world: { identity: string };
      renderer: unknown;
      onFrameSubmitted(detail: object): void;
      onFrameCompleted(detail: object): void;
    }) => {
      rejectAt('app');
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
      return unwrap({
        ...args,
        pluginContext: {},
        execution: { report: () => ({ engine: { health: 'running' }, fault: executionFault }) },
        onError: (listener: (error: unknown) => void) => {
          appError = listener;
          return () => {
            appError = undefined;
          };
        },
        start: () => unwrap(undefined),
        pause: () => unwrap(undefined),
        dispose: async () => {
          releases.push('app');
          return unwrap(undefined);
        },
      });
    },
    enginePrograms: () => ({}),
    runtimeBinding: { scopeId: 'native-recovery' },
    imports: {},
    programHost: {},
    inputBackendPlugin: () => ({}),
    inputPlugin: () => ({}),
    audioBackendPlugin: () => ({}),
    audioPlugin: () => ({}),
    loadGame: async () => ({
      activate: async ({ ui }: { ui: BlitzUi }) => {
        const channel = new MessageChannel();
        const guide = await guideController.createGuideUi(
          {
            guid: 'native-startup-guide',
            sourcePath: 'guide.ui.html',
            html: guideHtml,
            css: guideCss,
            localization: JSON.parse(guideLocalization),
          },
          {
            uiRoot: ui.document.querySelector('#game-ui'),
            port: channel.port1,
            controlMode: { read: () => 'touch', subscribe: () => () => {} },
          },
        );
        return {
          dispose: () => {
            guide.dispose();
            channel.port1.close();
            channel.port2.close();
            gameDisposed++;
            releases.push('game');
          },
        };
      },
    }),
  };
  const host = runInNewContext(
    `${hostSource
      .replace(/^import .*;$/gm, '')
      .replace('export function start(', 'function start(')
      .replace("import('./wechat-game.ts')", 'loadGame()')}
    const startHost = start;
    ({ start, stop: () => dispose?.(), inspect: () => globalThis.__forgeaxGameInspection?.renderer(),
      inspection: () => globalThis.__forgeaxGameInspection,
      diagnostic: () => globalThis.__forgeaxGameInspection?.error,
      entry: source => eval(source) })`,
    scope,
  ) as {
    start(reload?: () => void): Promise<void>;
    stop(): Promise<void>;
    inspection():
      | { ui: (request?: Parameters<typeof inspectUi>[1]) => ReturnType<typeof inspectUi> }
      | undefined;
    diagnostic(): unknown;
    inspect():
      | {
          generation: number;
          phase: string;
          completed: number;
          presented: number;
          startupError?: unknown;
        }
      | undefined;
    entry(source: string): void;
  };
  cleanup.push(() => host.stop());
  const entry = entrySource
    .replace(
      "import('@forgeax/engine/platform-wechat/standards')",
      'Promise.resolve({ installWechatStandards })',
    )
    .replace("import('./wechat-main.ts')", 'Promise.resolve({ start: startHost })');
  return {
    ...host,
    completeFrame: () => completeFrame?.(),
    startEntry: () => host.entry(entry),
    nextStartupEvent: (event: 'modal' | 'ready') =>
      new Promise<void>((resolve) =>
        startupEvents.addEventListener(event, () => resolve(), { once: true }),
      ),
    documents,
    modals,
    releases,
    errors,
    createdCanvases,
    usedCanvases,
    wasmHosts,
    scope,
    uiSignals,
    useNativeWgpu: async (mode: 'retry' | 'terminal') => {
      const { buildNativeWgpu } = await import(
        new URL('../../../../wgpu-wasm/scripts/native-build.mjs', import.meta.url).href
      );
      const loader = await import(
        new URL('../../../../rhi-wgpu/src/internal/wasm-loader.ts', import.meta.url).href
      );
      loader.__resetForTests();
      cleanup.push(async () => loader.__resetForTests());
      await mkdir(resolve(directory, 'node_modules/@forgeax'), { recursive: true });
      await symlink(
        fileURLToPath(new URL('../../../../engine', import.meta.url)),
        resolve(directory, 'node_modules/@forgeax/engine'),
      );
      // This generates JS bindings from existing verified bytes; it does not compile WASM.
      await buildNativeWgpu({ out: resolve(directory, 'native') });
      const native = await import(pathToFileURL(resolve(directory, 'native/wgpu-native.mjs')).href);
      const bytes = await readFile(resolve(directory, 'native/wgpu.wasm'));
      wx.getFileSystemManager = () => ({
        readCompressedFile: ({ success }: { success: (result: { data: ArrayBuffer }) => void }) =>
          success({ data: Uint8Array.from(bytes).buffer }),
      });
      const cause = new Error(
        mode === 'terminal' ? 'Native WASM start rejected' : 'Native WASM instantiate rejected',
      );
      const instantiate = vi.fn(async (_path: string, imports: WebAssembly.Imports) => {
        if (mode === 'retry' && instantiate.mock.calls.length === 1) throw cause;
        const result = await WebAssembly.instantiate(bytes, imports);
        return mode === 'retry'
          ? result
          : {
              ...result,
              instance: {
                exports: {
                  ...result.instance.exports,
                  __wbindgen_start() {
                    throw cause;
                  },
                },
              },
            };
      });
      scope.WXWebAssembly = { instantiate };
      scope.nativeWgpu = native;
      scope.ensureReady = loader.ensureRhiWgpuReady;
      return { instantiate, cause, native };
    },
    holdUi: (stage: 'resource' | 'result') => {
      let enter!: () => void;
      let finish!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        finish = resolve;
      });
      uiWait = { stage, enter, ready };
      return { entered, finish };
    },
    nativeCount: () =>
      [...nativeListeners.values()].reduce((sum, listeners) => sum + listeners.size, 0),
    fault: (point: FailurePoint, error: unknown) => {
      fault = { point, error };
    },
    gameDisposed: () => gameDisposed,
    failExecution: (error: unknown) => {
      executionFault = error;
      appError?.(error);
    },
  };
}

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected a generated Host resource');
  return value;
}

it('keeps an entered game available after native keyboard transport failure and permits retry', async () => {
  const host = await generatedHost();
  await host.start();
  await vi.waitFor(() => expect(host.inspect()?.phase).toBe('ready'));
  host.completeFrame();
  const ui = required(host.documents.at(-1));
  const loading = required(ui.document.querySelector<HTMLElement>('#forgeax-loading'));
  await vi.waitFor(() => expect(loading.style.display).toBe('none'));
  const gameRoot = required(ui.document.querySelector('#game-ui'));
  const shadow = required(gameRoot.firstElementChild?.shadowRoot);
  const tap = (element: Element) => {
    const box = element.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    for (const phase of ['down', 'up'] as const)
      ui.input.pointer({
        phase,
        pointerId: 1,
        pointerType: 'touch',
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
      });
  };
  tap(required(shadow.querySelector('[data-ui-part="vase-toggle"]')));
  const field = required(shadow.querySelector<HTMLInputElement>('input[name="height"]'));
  const value = field.value;
  const cause = new Error('Native keyboard unavailable');
  host.scope.wx.showKeyboard = ({ fail }: { fail(cause: unknown): void }) => fail(cause);
  tap(field);
  expect(host.inspect()).toMatchObject({ phase: 'ready' });
  expect(host.inspect()?.startupError).toBeUndefined();
  expect(host.scope.console.warn).toHaveBeenCalledWith(
    'ForgeaX native input failed',
    expect.objectContaining({ detail: { operation: 'wx.showKeyboard', cause } }),
  );
  expect(field.value).toBe(value);
  expect(required(ui.document.querySelector<HTMLElement>('#forgeax-fatal')).style.display).not.toBe(
    'grid',
  );
  const reopen = vi.fn();
  host.scope.wx.showKeyboard = reopen;
  tap(field);
  expect(reopen).toHaveBeenCalledWith(expect.objectContaining({ defaultValue: value }));
  expect(host.inspect()?.phase).toBe('ready');
});

function retired(ui: BlitzUi) {
  const owner = (
    ui.document as unknown as {
      realm: {
        listenerNodes: Set<unknown>;
        focusListeners: Set<unknown>;
        nodes: Map<unknown, unknown>;
      };
    }
  ).realm;
  expect([owner.listenerNodes.size, owner.focusListeners.size, owner.nodes.size]).toEqual([
    0, 0, 0,
  ]);
}

it.each([
  'wgpu',
  'graphics',
  'app',
] as const)('retires real WASM consumers after %s failure and recovery', async (point) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const host = await generatedHost();
  const failure = new Error('Native adapter initialization rejected', {
    cause: { code: 'adapter-unavailable' },
  });
  host.fault(point, failure);
  await expect(host.start()).rejects.toBe(failure);
  retired(required(host.documents[0]));
  expect(host.nativeCount()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  await host.start();
  await vi.waitFor(() => expect(host.inspect()?.phase).toBe('ready'));
  const inspection = required(host.inspection());
  const snapshot = inspection.ui({ selector: 'input', styles: ['display', 'font-size'] });
  if (!snapshot.ok) throw snapshot.error;
  expect(snapshot.value.nodes.map((node) => node.attributes.name)).toEqual([
    'height',
    'radius',
    'sides',
  ]);
  expect(snapshot.value.nodes.map((node) => node.control?.value)).toEqual(['2.4', '0.75', '32']);
  expect(snapshot.value.nodes.every((node) => node.source?.guid === 'native-startup-guide')).toBe(
    true,
  );
  expect(snapshot.value.truncated).toBe(false);
  expect(host.documents.at(-1)?.paint(0)).not.toBeNull();
  await host.stop();
  expect(inspection.ui()).toMatchObject({ ok: false, error: { code: 'inspection-failed' } });
  expect(host.gameDisposed()).toBe(1);
  expect(host.releases.slice(-5)).toEqual(['game', 'app', 'renderer', 'audio', 'ui']);
  retired(required(host.documents[1]));
  expect(host.nativeCount()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  'retry',
  'terminal',
] as const)('preserves native WASM %s semantics through generated Reload', async (mode) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const host = await generatedHost();
  const native = await host.useNativeWgpu(mode);
  const waiting = host.holdUi('result');
  const shown = host.nextStartupEvent('modal');
  host.startEntry();
  await waiting.entered;
  // Native UI, fonts and WASM may outlive waitFor's default one-second poll.
  // Observe the generated Host's real events within the unchanged test deadline.
  await vi.advanceTimersByTimeAsync(1_001);
  expect(host.inspect()?.phase).toBe('ui-wasm-and-fonts');
  expect(host.modals).toHaveLength(0);
  expect(native.instantiate).not.toHaveBeenCalled();
  waiting.finish();
  await shown;
  expect(host.modals).toHaveLength(1);
  const first = host.inspect()?.startupError;
  expect(first).toMatchObject({ code: 'wgpu-native-initialization-failed', cause: native.cause });
  const reloading = host.holdUi('result');
  const reloaded = host.nextStartupEvent(mode === 'terminal' ? 'modal' : 'ready');
  host.modals[0]?.success?.({ confirm: true });
  await reloading.entered;
  await vi.advanceTimersByTimeAsync(1_001);
  expect(host.inspect()?.phase).toBe('ui-wasm-and-fonts');
  expect(host.modals).toHaveLength(1);
  expect(native.instantiate).toHaveBeenCalledOnce();
  reloading.finish();
  await reloaded;
  if (mode === 'terminal') {
    expect(host.modals).toHaveLength(2);
    expect(host.inspect()?.startupError).toBe(first);
    expect(host.modals[1]?.content).toContain(native.cause.message);
    expect(native.instantiate).toHaveBeenCalledOnce();
    expect(host.nativeCount()).toBe(0);
  } else {
    expect(host.inspect()?.phase).toBe('ready');
    const shader = native.native.parse(
      '@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
    );
    shader.free();
    const restarted = host.nextStartupEvent('ready');
    await host.start();
    await restarted;
    expect(host.inspect()?.phase).toBe('ready');
    expect(native.instantiate).toHaveBeenCalledTimes(2);
    expect(host.inspect()).toMatchObject({ completed: 0, presented: 0 });
  }
  expect(host.createdCanvases).toHaveLength(1);
  expect(host.scope.createWechatWgpuHost).toHaveBeenCalledOnce();
}, 30_000);

it.each([
  'resource',
  'result',
] as const)('cancels pending UI %s work and retires late completion before retry', async (stage) => {
  const host = await generatedHost();
  const waiting = host.holdUi(stage);
  const starting = host.start();
  await waiting.entered;
  const pendingInspection = required(host.inspection());
  expect(pendingInspection.ui()).toMatchObject({ ok: false, error: { code: 'inspection-failed' } });
  expect(host.uiSignals[0]?.aborted).toBe(false);
  await host.stop();
  expect(host.uiSignals[0]?.aborted).toBe(true);
  expect(host.nativeCount()).toBe(0);
  waiting.finish();
  await starting;
  for (const ui of host.documents) retired(ui);
  expect(host.inspect()).toBeUndefined();
  expect(host.usedCanvases).toHaveLength(0);
  expect(host.modals).toHaveLength(0);
  expect(host.errors).toEqual([]);
  await host.start();
  await vi.waitFor(() => expect(host.inspect()?.phase).toBe('ready'));
  expect(pendingInspection.ui()).toMatchObject({ ok: false, error: { code: 'inspection-failed' } });
  expect(host.createdCanvases).toHaveLength(1);
  expect(host.documents.at(-1)?.paint(0)).not.toBeNull();
});

it('retains the first native display canvas even when Platform admission fails', async () => {
  const host = await generatedHost();
  const cause = new Error('Native display read failed');
  host.fault('platform', cause);
  await expect(host.start()).rejects.toMatchObject({ detail: { cause } });
  await host.start();
  await vi.waitFor(() => expect(host.inspect()?.phase).toBe('ready'));
  expect(host.createdCanvases).toHaveLength(1);
  expect(host.usedCanvases[0]).toBe(host.createdCanvases[0]);
});

it('puts the actual native Platform cause above recovery guidance and preserves inspection details', async () => {
  const host = await generatedHost();
  const failure = Object.assign(new Error('Isolated native platform failure'), {
    code: 'startup-recovery-probe',
    detail: { boundary: 'platform', once: true },
  });
  host.fault('platform', failure);
  host.startEntry();
  await vi.waitFor(() => expect(host.modals).toHaveLength(1));
  expect(host.modals[0]?.content).toBe(
    'Isolated native platform failure\n\nTap Reload to try again. If it fails again, close and reopen the game.',
  );
  expect(host.modals[0]?.confirmText).toBe('Reload');
  expect(JSON.parse(JSON.stringify(host.diagnostic()))).toMatchObject({
    code: 'platform-operation-failed',
    detail: {
      operation: 'wx.getWindowInfo',
      cause: {
        name: 'Error',
        message: failure.message,
        code: failure.code,
        detail: failure.detail,
      },
    },
  });
});

it('bounds native modal text while retaining the full primary and cleanup failures', async () => {
  const host = await generatedHost();
  const primary = new Error(`Display initialization failed. ${'Full native details. '.repeat(40)}`);
  const cleanup = new Error('Cleanup detail retained for inspection');
  host.fault(
    'wgpu',
    new AggregateError([primary, cleanup], 'Host startup failed', { cause: primary }),
  );
  host.startEntry();
  await vi.waitFor(() => expect(host.modals).toHaveLength(1));
  const content = required(host.modals[0]?.content);
  expect(content.startsWith('Display initialization failed.')).toBe(true);
  expect(content.length).toBeLessThanOrEqual(240);
  expect(content).not.toContain(cleanup.message);
  const diagnostic = host.diagnostic();
  expect(diagnostic).toMatchObject({
    name: 'AggregateError',
    message: 'Host startup failed',
    cause: { message: primary.message },
    errors: ['[circular]', { message: cleanup.message }],
  });
});

it('offers native Reload after early bootstrap failures and reuses the generated Host owner', async () => {
  const host = await generatedHost();
  const failure = new Error('Native adapter initialization rejected', {
    cause: { code: 'adapter-unavailable' },
  });
  host.fault('wgpu', failure);
  host.startEntry();
  await vi.waitFor(() => expect(host.modals).toHaveLength(1));
  expect(host.modals[0]).toMatchObject({ confirmText: 'Reload', success: expect.any(Function) });
  expect(host.modals[0]?.content).toContain(failure.message);
  expect(host.diagnostic()).toMatchObject({ cause: { code: 'adapter-unavailable' } });
  expect(host.nativeCount()).toBe(0);
  host.modals[0]?.success?.({ confirm: true });
  await vi.waitFor(() => expect(host.inspect()?.phase).toBe('ready'));
  expect(host.inspect()).toMatchObject({ generation: 2, completed: 0, presented: 0 });
  expect(host.createdCanvases).toHaveLength(1);
  expect(host.wasmHosts[1]).toBe(host.wasmHosts[0]);
  expect(host.scope.createWechatWasmHost).toHaveBeenCalledOnce();
  const recovered = required(host.documents.at(-1));
  host.failExecution({ code: 'game-stopped', detail: { cause: 'runtime failure' } });
  const replacement: Record<string, unknown> = {
    code: 'adapter-unavailable',
    detail: { reason: 'replacement failed' },
  };
  replacement.cause = replacement;
  host.fault('graphics', replacement);
  const reload = required(recovered.document.querySelector('#forgeax-fatal-reload'));
  const box = reload.getBoundingClientRect();
  for (const phase of ['down', 'up'] as const)
    recovered.input.pointer({
      phase,
      pointerId: 1,
      pointerType: 'touch',
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });
  await vi.waitFor(() => expect(host.modals).toHaveLength(2));
  expect(host.modals[1]?.content).toContain('replacement failed');
  expect(host.diagnostic()).toMatchObject({ cause: '[circular]' });
  expect(host.gameDisposed()).toBe(1);
  expect(host.nativeCount()).toBe(0);
  for (const ui of host.documents) retired(ui);
  host.modals[1]?.success?.({ confirm: true });
  await vi.waitFor(() => expect(host.inspect()?.phase).toBe('ready'));
  expect(host.inspect()).toMatchObject({ generation: 4, completed: 0, presented: 0 });
  expect(host.createdCanvases).toHaveLength(1);
  expect(host.scope.createWechatWasmHost).toHaveBeenCalledOnce();
});
