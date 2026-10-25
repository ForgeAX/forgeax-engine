// Browser construction delegates to the same realm-neutral App assembly.
import {
  type AssetRegistry,
  createCatalogSource,
  validateAssetBudgetBytes,
} from '@forgeax/engine-assets-runtime';
import { type AudioBackend, createAudioIntentBackend } from '@forgeax/engine-audio';
import type { DebugDraw } from '@forgeax/engine-debug-draw';
import { createWorldContext, World, worldPlugin } from '@forgeax/engine-ecs';
import type { InputBackend } from '@forgeax/engine-input';
import type { Platform } from '@forgeax/engine-platform';
import { createBrowserPlatform } from '@forgeax/engine-platform-browser';
import type { Context, Fiber, Plugin } from '@forgeax/engine-plugin';
import { createProfiler } from '@forgeax/engine-profiler';
import type { Renderer } from '@forgeax/engine-render';
import type { RendererHostAssembly } from '@forgeax/engine-render/internal/construct-renderer';
import {
  attachRecorder,
  type CaptureFrameOptions,
  type RecorderAttachment,
} from '@forgeax/engine-rhi-debug';
import * as rhiWebgpu from '@forgeax/engine-rhi-webgpu';
import * as engineRuntimeModule from '@forgeax/engine-runtime';
import { createDevImportTransport, EngineEnvironmentError } from '@forgeax/engine-runtime';
import {
  constructRuntimeRendererHost,
  loadRhiPack,
} from '@forgeax/engine-runtime/internal/renderer-host';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type BuildAppArgs,
  buildApp,
  createFrameInspectionRef,
  type FrameInspectionRef,
  makeAppError,
  type PluginProjectionBridge,
  startRemoteServer,
} from './app-assembly';
import { type AssetRuntimeAssembly, createAssetRuntimeAssembly } from './assets-runtime-assembly';
import {
  publishBrowserFrameCompleted,
  publishBrowserFrameSubmitted,
  resetBrowserFrameProgress,
} from './browser-frame-signal';

export type { BrowserFrameProgress } from './browser-frame-signal';

import { canvasAspectPlugin } from './canvas-policy';
import {
  measureCanvasDrawingBuffer,
  observeCanvasDeviceLimit,
  refreshCanvasDeviceLimit,
  resetCanvasDeviceLimit,
  syncCanvasDrawingBuffer,
} from './canvas-sizing';

export { measureCanvasDrawingBuffer, syncCanvasDrawingBuffer } from './canvas-sizing';

import { APP_ERROR_HINTS, APP_EXPECTED, type AppError } from './errors';
import {
  activateExecutionRoot,
  createExecutionReport,
  type ExecutionCapabilities,
  type ExecutionSelection,
  executionBootstrapHostPlugin,
  type PreparedExecutionBootstrap,
  prepareBootstrapEntry,
  probeExecutionCapabilities,
  selectExecutionWorkers,
  unavailableExecutionCapabilities,
} from './execution';
import { normalizeExecutionBootstrapUrl } from './execution/bootstrap-url';
import { createLocalExecutionControl, type LocalExecutionControl } from './execution/control';
import { installCarriedGpuStub } from './execution/gpu-stub';
import { createWorkerExecutionApp } from './execution/host-controller';
import { attachInputAuto, type InputAttachHandle } from './internal/input-attach';
import { mainEngineProfile } from './internal/main-engine-profile';
import { resolveRemoteServeFlag } from './internal/remote-serve-flag';
import { remoteServerPlugin } from './internal/remote-server-plugin';
import {
  createRhiCapture,
  createRhiInstrumentation,
  mergeRhiInstrumentation,
  type RhiCapture,
  subscribeRhiCaptureSubmitted,
} from './internal/rhi-capture';
import { resolveRhiDebugFlag } from './internal/rhi-debug-flag';
import { createRenderFeatureHost, type RenderFeatureHost } from './renderer-plugin';
import type { App, BundlerOptions, CanvasAppError, CreateAppOptions, ExecutionApp } from './types';

type RendererBootstrapDiagnostic = {
  readonly name: string;
  readonly startedAt: number;
  readonly previousElapsedMs: number;
  readonly detail?: Readonly<Record<string, unknown>>;
};

function markRendererBootstrapStage(
  name: string,
  detail?: Readonly<Record<string, unknown>>,
): void {
  const host = globalThis as {
    __forgeaxRendererBootstrap?: RendererBootstrapDiagnostic;
  };
  const previous = host.__forgeaxRendererBootstrap;
  const now = Date.now();
  host.__forgeaxRendererBootstrap = {
    name,
    startedAt: now,
    previousElapsedMs: previous === undefined ? 0 : now - previous.startedAt,
    ...(detail === undefined ? {} : { detail }),
  };
}

function rhiDebugHostPlugin(dispose: () => void): Plugin {
  return {
    name: 'rhi-debug-host',
    apply(ctx) {
      ctx.effect(() => dispose, 'rhi-debug/host');
    },
  };
}

/**
 * createApp(canvas, opts?, bundler?) -- canvas thin wrapper SSOT (per
 * plan-strategy D-5). Resolves with Result.ok(app) on success; failure routes
 * through AppError | RhiError | EngineEnvironmentError per requirements AC-01.
 *
 * feat-20260608-create-app-param-surface-trim / M2 / D-3: the third arg is
 * `BundlerOptions` (importTransport + shaderManifestUrl + build) -- the SSOT for
 * host-injected build-tool emit knowledge. M3 demos collapse the third-arg
 * literal to `forgeaxBundlerAdapter()` exported by `virtual:forgeax/bundler`.
 *
 * M3 ships the path needed by AC-05 (auto input acquisition plus an ECS scan
 * plugin). M4 finalises the canvas-detached guard +
 * EngineEnvironmentError try/catch + onError default fallback.
 *
 * The host-engine contract defines the boundary between host (DOM, canvas, UI)
 * and engine (renderer, world, frame loop). Only the `createApp(canvas)` path
 * auto-wires the aspect-sync plugin. Native assemble hosts explicitly install
 * the same `canvasAspectPlugin`; bare `createRenderer` does not mutate World.
 *
 * @see {@link https://github.com/ForgeaX-Games/forgeax-engine/blob/main/docs/how-to/2026-06-18-host-engine-contract.md | Host-engine contract SSOT}
 */
export function createApp(
  canvas: HTMLCanvasElement,
  opts: CreateAppOptions & { readonly execution: NonNullable<CreateAppOptions['execution']> },
  bundler?: BundlerOptions,
): Promise<Result<ExecutionApp, CanvasAppError>>;

export function createApp(
  canvas: HTMLCanvasElement,
  opts?: CreateAppOptions,
  bundler?: BundlerOptions,
): Promise<Result<App, CanvasAppError>>;

/** Construct a browser-owned World, Renderer, input and native platform. */
export async function createApp(
  canvas: HTMLCanvasElement,
  opts?: CreateAppOptions,
  bundler?: BundlerOptions,
): Promise<Result<App | ExecutionApp, CanvasAppError>> {
  // Canvas-detached fail-fast guard (AC-08). isConnected returns false when
  // the canvas is not in the document tree, including a freshly created canvas
  // without appendChild. Returning before createRenderer avoids async adapter /
  // device / shader work that would only fail later.
  if (!canvas.isConnected) {
    return err(
      makeAppError(
        'app-canvas-detached',
        'canvas.isConnected === true at createApp(canvas) entry',
        'append the canvas to the document tree before calling createApp; or use the assemble entry createApp({ renderer, world }) when the host already manages canvas lifetime',
        {},
      ),
    );
  }

  // The DOM canvas starts with a 300x150 drawing buffer even when CSS lays it
  // out at a different size. Set the physical buffer before the renderer
  // configures its swap chain; the same helper runs before each frame so a CSS
  // resize remains visible to both rendering and camera policy.
  // Programmer configuration: reject before any realm creates an AssetRegistry.
  if (opts?.assetBudgetBytes !== undefined) validateAssetBudgetBytes(opts.assetBudgetBytes);
  // Before capability probing and backend selection, so every ambient WebGPU
  // reader in this realm observes the same stub.
  installCarriedGpuStub(opts);
  resetCanvasDeviceLimit(canvas);
  syncCanvasDrawingBuffer(canvas);

  let executionContext: BrowserExecutionContext | undefined;
  let preparedExecutionBootstrap: PreparedExecutionBootstrap | undefined;
  if (opts?.execution !== undefined) {
    const selected = await selectBrowserExecution(canvas, opts, opts.execution, bundler);
    if (!selected.ok) return err(selected.error);
    executionContext = selected.value.context;
    if (executionContext.selection.engine.enabled) {
      return startWorkerExecutionApp(canvas, opts, bundler, executionContext);
    }
    const local = await prepareLocalExecution(
      selected.value.bootstrapUrl,
      opts,
      opts.execution,
      bundler,
    );
    if (!local.ok) return err(local.error);
    preparedExecutionBootstrap = local.value.bootstrap;
    opts = local.value.options;
    bundler = local.value.bundler;
  }

  const rendering = await constructBrowserRendering(
    canvas,
    opts,
    bundler,
    preparedExecutionBootstrap,
  );
  if (!rendering.ok) return err(rendering.error);
  const { renderer, assets, assetAssembly } = rendering.value;
  // App owns the optional capture capability and its frame transaction.
  let rhiDebug = rendering.value.rhiDebug;
  const cleanupRhiDebugHost = (): void => {
    const debug = rhiDebug;
    rhiDebug = undefined;
    releaseRhiDebugHost(debug);
  };
  const rhiCapture = rhiDebug?.capture;

  // Resolve whether the remote eval server should start. The actual
  // startServer call is deferred until World creation because the server
  // needs a live World reference.
  const shouldStartRemote = readRemoteServeFlag();

  let debugDraw: DebugDraw | undefined;

  // The canvas form owns world lifetime, in contrast to the assemble form
  // where the host owns it.
  const world = new World(opts?.time !== undefined ? { time: opts.time } : {});
  const frameInspection = createFrameInspectionRef();

  const { handle: inputHandle, backend: inputBackend } = acquireAppInput(canvas, opts);
  let pluginContext: Context;
  const ownedAppFibers: Fiber[] = [];
  const disposeAppContext = async (): Promise<void> => {
    try {
      if (opts?.context === undefined) {
        await pluginContext.fiber.dispose();
        return;
      }
      await disposeFibersInReverse(ownedAppFibers);
    } finally {
      opts?.execution?.bootstrapPort?.close();
    }
  };
  const installAppPlugin = async (plugin: Plugin): Promise<Fiber> => {
    const fiber = await pluginContext.plugin(plugin);
    if (opts?.context !== undefined) ownedAppFibers.push(fiber);
    return fiber;
  };
  const pluginPrograms = preparedExecutionBootstrap?.pluginPrograms ?? opts?.pluginPrograms;
  const runtimePacks = preparedExecutionBootstrap?.runtimePacks ?? opts?.runtimePacks;
  const profile = mainEngineProfile({
    renderer,
    assetAssembly,
    pluginPrograms,
    runtimePacks,
    rendererDebugDrawHost: rendering.value.debugDrawHost,
    rendererFeatureHost: rendering.value.featureHost,
    assets,
    animation: opts?.animation,
    input: inputBackend,
    inputDispose: inputHandle?.cleanup,
    inputMap: opts?.inputMap,
    onDebugDrawReady: (value) => {
      debugDraw = value;
    },
    extensions: [
      ...browserHostServicePlugins(opts),
      rhiDebugHostPlugin(cleanupRhiDebugHost),
      ...browserUserPlugins(canvas, renderer, opts, preparedExecutionBootstrap, inputBackend),
      canvasDeviceLimitPlugin(canvas, renderer),
      canvasAspectPlugin(() => {
        syncCanvasDrawingBuffer(canvas);
        return canvas;
      }),
    ],
  });
  try {
    pluginContext = await activateAppPluginContext(world, profile, opts?.context, ownedAppFibers);
  } catch (cause) {
    opts?.execution?.bootstrapPort?.close();
    cleanupRhiDebugHost();
    assetAssembly?.dispose();
    await disposeFibersInReverse(ownedAppFibers);
    return err(pluginActivationError(cause));
  }
  const rootActivation = await activateBootstrapRoot(
    pluginContext,
    preparedExecutionBootstrap,
    opts,
    ownedAppFibers,
    disposeAppContext,
  );
  if (!rootActivation.ok) return err(rootActivation.error);
  // A borrowed plugin scope need not inject this optional App capability.
  const audioBackend = pluginContext.get('audio');

  const executionControl = createBrowserExecutionControl(
    executionContext,
    world,
    frameInspection,
    audioBackend,
  );

  // Remote eval server auto-start (deferred until World is available).
  // Dynamic import keeps @forgeax/engine-app free of static dep on
  // @forgeax/engine-remote. Component reflection crosses this boundary as
  // JSON-safe host data; app does not own any component.
  // The generated DevKit host mounts its project root after App creation.
  // Keep one mutable projection reference so Remote can inspect the eventual
  // live Fiber tree without introducing another lifecycle/state owner.
  const pluginProjection = createPluginProjectionBridge();
  (globalThis as { __forgeaxPluginProjection?: PluginProjectionBridge }).__forgeaxPluginProjection =
    pluginProjection;
  const remoteHandle = shouldStartRemote
    ? await startRemoteServer(
        world,
        renderer,
        assets,
        rhiCapture,
        opts?.profiler,
        executionControl,
        pluginContext,
        runtimePacks?.imports,
        pluginProjection,
      )
    : undefined;
  if (remoteHandle !== undefined) await installAppPlugin(remoteServerPlugin(remoteHandle));

  const platform = await installBrowserPlatform(canvas, opts?.platform, installAppPlugin);
  if (!platform.ok) {
    await disposeAppContext();
    return err(platform.error);
  }

  const buildArgs: BuildAppArgs = {
    platform: platform.value,
    installAppPlugin,
    renderer,
    assets,
    world,
    pluginContext,
    disposePluginContext: disposeAppContext,
    executionControl,
    frameInspection,
    geometryLane: opts?.execution?.diagnostics?.geometryLane,
    onFrameSubmitted: (event) =>
      publishBrowserFrameSubmitted(canvas, { ...event, worldIdentity: world.identity }),
    onFrameCompleted: (event) =>
      publishBrowserFrameCompleted(canvas, { ...event, worldIdentity: world.identity }),
    inputBackend,
    wireOnLockErrorDispatch:
      inputHandle === undefined
        ? undefined
        : (dispatch: (err: AppError) => void) => {
            inputHandle.setOnErrorDispatch(dispatch);
          },
    audioBackend,
    silenceUnhandledErrors: opts?.silenceUnhandledErrors,
    // M2 / D-3: canvas form forwards the host-supplied draw-source pull.
    drawSource: opts?.drawSource,
    profiler: opts?.profiler,
    rhiCapture,
    debugDraw,
    remoteHandle,
  };

  // The aspect-sync sidecar belongs to the canvas path because it owns the DOM
  // canvas. It runs as an Update system so it shares World scheduling semantics.
  resetBrowserFrameProgress(canvas);
  await installAppPlugin(browserFrameSignalPlugin(canvas, renderer));
  const built = await buildApp(buildArgs);
  if (!built.ok) {
    await disposeAppContext();
    return built;
  }
  // DEV-only browser execution bridge for the persistent DevKit owner. A browser cannot host the
  // Node WS server that @forgeax/engine-remote/server needs, so the running
  // engine would be unreachable from a CLI in a real dev browser. Instead the
  // page dials OUT to a loopback relay and runs the ws-free eval core against
  // the live world/renderer/assets/rhiCapture.
  //
  // OPT-IN via VITE_FORGEAX_ENGINE_BRIDGE=1 (set by scripts/dev-live.mjs), NOT
  // on-by-default: a page that dials a relay which is not running makes the
  // BROWSER itself log "WebSocket connection failed" to the console — noise a
  // JS catch cannot suppress — which trips every zero-console-error browser
  // smoke (collectathon / hello-*). So a plain `pnpm --filter <app> dev` (and
  // CI) stays silent; only dev-live.mjs, which also launches the relay, turns
  // it on. Additive: the Node startServer path above and app.remote are untouched.
  const bridgePort = browserEngineBridgePort();
  if (bridgePort !== undefined) {
    await installAppPlugin(
      browserRemoteBridgePlugin(bridgePort, built.value, pluginProjection, rhiCapture, opts),
    );
  }
  // The public capture entry must already belong to the App frame driver.
  // Publishing during renderer initialization would allow a bare recorder
  // snapshot to overlap the first frame's resource uploads.
  if (rhiDebug !== undefined) publishRhiDebugHost(rhiDebug);
  return built;
}

type BrowserExecutionContext = {
  readonly capabilities: ExecutionCapabilities;
  readonly selection: ExecutionSelection;
};

/** Options that only the execution bootstrap module may construct in its realm. */
function realmBoundExecutionOptionError(
  opts: CreateAppOptions,
  bundler: BundlerOptions | undefined,
  moduleUrl: string,
): AppError | undefined {
  const realmBoundOption = [
    ['platform', opts.platform],
    ['features', opts.features],
    ['plugins', opts.plugins],
    ['pluginPrograms', opts.pluginPrograms],
    ['runtimePacks', opts.runtimePacks],
    ['rhi', opts.rhi],
    ['rhiInstrumentation', opts.rhiInstrumentation],
    ['gpuPassTiming', opts.gpuPassTiming],
    ['shadowWorkload', opts.shadowWorkload],
    ['ssrIdentity', opts.ssrIdentity],
    ['captureReflectionFallbackReadback', opts.captureReflectionFallbackReadback],
    ['drawSource', opts.drawSource],
    ['bundler.importTransport', bundler?.importTransport],
  ].find(([, value]) => value !== undefined)?.[0];
  if (realmBoundOption === undefined) return undefined;
  return makeAppError(
    'app-execution-bootstrap-failed',
    APP_EXPECTED['app-execution-bootstrap-failed'],
    APP_ERROR_HINTS['app-execution-bootstrap-failed'],
    {
      phase: 'prepare',
      moduleUrl,
      cause: new TypeError(
        `${realmBoundOption} must be constructed by the execution bootstrap module`,
      ),
    },
  );
}

/** DEV-only relay port; undefined unless dev-live explicitly opts in. */
function browserEngineBridgePort(): string | undefined {
  if (
    typeof import.meta !== 'undefined' &&
    (import.meta as { env?: { DEV?: boolean; VITE_FORGEAX_ENGINE_BRIDGE?: string } }).env?.DEV ===
      true &&
    (import.meta as { env?: { VITE_FORGEAX_ENGINE_BRIDGE?: string } }).env
      ?.VITE_FORGEAX_ENGINE_BRIDGE === '1'
  ) {
    return (
      (import.meta as { env?: { VITE_FORGEAX_ENGINE_BRIDGE_PORT?: string } }).env
        ?.VITE_FORGEAX_ENGINE_BRIDGE_PORT ?? '5733'
    );
  }
  return undefined;
}

/** The selected Engine Worker owns the World; this realm only hosts its canvas. */
async function startWorkerExecutionApp(
  canvas: HTMLCanvasElement,
  opts: CreateAppOptions,
  bundler: BundlerOptions | undefined,
  context: BrowserExecutionContext,
): Promise<Result<ExecutionApp, CanvasAppError>> {
  const workerApp = await createWorkerExecutionApp({
    canvas,
    appOptions: opts,
    syncCanvas: (currentCanvas, display) =>
      measureCanvasDrawingBuffer(
        currentCanvas,
        undefined,
        typeof currentCanvas.ownerDocument.defaultView?.ResizeObserver === 'function'
          ? display
          : undefined,
      ),
    ...(bundler !== undefined ? { bundler } : {}),
    capabilities: context.capabilities,
    selection: context.selection,
  });
  if (!workerApp.ok || workerApp.value.remoteEval === undefined) return workerApp;
  const bridgePort = browserEngineBridgePort();
  if (bridgePort === undefined) return workerApp;
  return ok(
    await withBrowserExecutionBridge(workerApp.value, workerApp.value.remoteEval, bridgePort),
  );
}

async function withBrowserExecutionBridge(
  workerExecutionApp: ExecutionApp,
  execute: NonNullable<ExecutionApp['remoteEval']>,
  port: string,
): Promise<ExecutionApp> {
  const bridge = await import('./internal/browser-remote-bridge');
  const teardown = await bridge.installBrowserExecutionBridge({
    execute,
    readStatus: () => {
      const execution = workerExecutionApp.execution.report();
      return {
        worldIdentity: execution.world.identity,
        execution,
        workers: execution.workers,
      };
    },
    port,
    ...(workerExecutionApp.clearInput === undefined
      ? {}
      : { clearInput: workerExecutionApp.clearInput }),
    ...(workerExecutionApp.beginInputLease === undefined
      ? {}
      : { beginInputLease: workerExecutionApp.beginInputLease }),
    ...(workerExecutionApp.finishProfiler === undefined
      ? {}
      : { finishProfiler: workerExecutionApp.finishProfiler }),
  });
  // The worker path returns a realm-local App before the browser bridge
  // is installed. Tie the bridge to that App's existing lifecycle so a
  // stopped worker cannot leave a reconnecting socket behind.
  const stop = workerExecutionApp.stop;
  return {
    ...workerExecutionApp,
    stop: () => {
      const result = stop();
      teardown();
      return result;
    },
  };
}

/** The same structured diagnostics apply when the selected realm stays local. */
function withLocalExecutionDiagnostics(
  opts: CreateAppOptions,
  execution: CreateAppExecution,
): CreateAppOptions {
  const diagnostics = execution.diagnostics;
  let next: CreateAppOptions = opts;
  if (diagnostics?.shadowWorkload === true) next = { ...next, shadowWorkload: true };
  if (diagnostics?.profiler === true && next.profiler === undefined) {
    next = { ...next, profiler: createProfiler() };
  }
  if (diagnostics?.gpuPassTiming !== undefined) {
    next = { ...next, gpuPassTiming: diagnostics.gpuPassTiming };
  }
  return next;
}

type CreateAppExecution = NonNullable<CreateAppOptions['execution']>;

/** Normalize the bootstrap, reject realm-bound options and select the execution Workers. */
async function selectBrowserExecution(
  canvas: HTMLCanvasElement,
  opts: CreateAppOptions,
  execution: CreateAppExecution,
  bundler: BundlerOptions | undefined,
): Promise<
  Result<{ readonly bootstrapUrl: string; readonly context: BrowserExecutionContext }, AppError>
> {
  const normalizedBootstrap = normalizeExecutionBootstrapUrl(execution.bootstrap);
  if (!normalizedBootstrap.ok) return err(normalizedBootstrap.error);
  const bootstrapUrl = normalizedBootstrap.value;
  const realmBound = realmBoundExecutionOptionError(opts, bundler, bootstrapUrl);
  if (realmBound !== undefined) return err(realmBound);
  const capabilities = await probeExecutionCapabilities(
    canvas,
    execution.startupTimeoutMs,
    opts.gpuStub !== undefined,
  );
  const selected = selectExecutionWorkers({
    workers: execution.workers ?? {},
    capabilities,
  });
  if (!selected.ok) return err(selected.error);
  return ok({ bootstrapUrl, context: { capabilities, selection: selected.value } });
}

/** A selected local realm runs the bootstrap module in this App's own World. */
async function prepareLocalExecution(
  bootstrapUrl: string,
  opts: CreateAppOptions,
  execution: CreateAppExecution,
  bundler: BundlerOptions | undefined,
): Promise<
  Result<
    {
      readonly bootstrap: PreparedExecutionBootstrap;
      readonly options: CreateAppOptions;
      readonly bundler: BundlerOptions | undefined;
    },
    AppError
  >
> {
  const prepared = await prepareBootstrapEntry(bootstrapUrl, execution.bootstrapData);
  if (!prepared.ok) return err(prepared.error);
  const options = withLocalExecutionDiagnostics(opts, execution);
  const runtimeBinding = options.execution?.assetCatalog?.runtimeBinding;
  return ok({
    bootstrap: prepared.value,
    options,
    bundler:
      runtimeBinding === undefined
        ? bundler
        : { ...bundler, importTransport: createDevImportTransport(runtimeBinding) },
  });
}

// CreateAppOptions stops `extends RendererOptions`, so the RHI escape hatch
// and renderer policies are forwarded explicitly. An empty {} keeps
// createRenderer on its default path.
function rendererOptionsFor(
  opts: CreateAppOptions | undefined,
  preparedExecutionBootstrap: PreparedExecutionBootstrap | undefined,
): import('@forgeax/engine-render').RendererOptions {
  const rendererOpts: import('@forgeax/engine-render').RendererOptions = {};
  if (opts?.rhi !== undefined) {
    Object.assign(rendererOpts, { rhi: opts.rhi });
  }
  if (opts?.profiler !== undefined) {
    Object.assign(rendererOpts, { profiler: opts.profiler });
  }
  const rendererFeatures = preparedExecutionBootstrap?.features ?? opts?.features;
  if (rendererFeatures !== undefined) {
    Object.assign(rendererOpts, { features: rendererFeatures });
  }
  if (opts?.standardProfile !== undefined) {
    Object.assign(rendererOpts, { standardProfile: opts.standardProfile });
  }
  if (opts?.pipelineLibrary !== undefined)
    Object.assign(rendererOpts, { pipelineLibrary: opts.pipelineLibrary });
  if (opts?.backgroundPipelineLibrary !== undefined)
    Object.assign(rendererOpts, { backgroundPipelineLibrary: opts.backgroundPipelineLibrary });
  if (opts?.outputColorSpace !== undefined) {
    Object.assign(rendererOpts, { outputColorSpace: opts.outputColorSpace });
  }
  if (opts?.dynamicGeometryMeshBudgetBytes !== undefined) {
    Object.assign(rendererOpts, {
      dynamicGeometryMeshBudgetBytes: opts.dynamicGeometryMeshBudgetBytes,
    });
  }
  if (opts?.assetBudgetBytes !== undefined) {
    Object.assign(rendererOpts, { assetBudgetBytes: opts.assetBudgetBytes });
  }
  if (opts?.rhiInstrumentation !== undefined) {
    Object.assign(rendererOpts, { rhiInstrumentation: opts.rhiInstrumentation });
  }
  if (opts?.shadowWorkload === true) Object.assign(rendererOpts, { shadowWorkload: true });
  if (opts?.gpuPassTiming !== undefined) {
    Object.assign(rendererOpts, { gpuPassTiming: opts.gpuPassTiming });
  }
  if (opts?.captureReflectionFallbackReadback !== undefined) {
    Object.assign(rendererOpts, {
      captureReflectionFallbackReadback: opts.captureReflectionFallbackReadback,
    });
  }
  const ssrIdentity = preparedExecutionBootstrap?.ssrIdentity ?? opts?.ssrIdentity;
  if (ssrIdentity !== undefined) {
    Object.assign(rendererOpts, { ssrIdentity });
  }
  return rendererOpts;
}

type RhiDebugGlobal = {
  captureFrame(
    options?: CaptureFrameOptions,
    onSubmitted?: () => void,
  ): ReturnType<RhiCapture['captureFrame']>;
};

/** The optional recorder attachment and the capture entry App publishes for it. */
interface RhiDebugHost {
  readonly attachment: RecorderAttachment;
  readonly capture: RhiCapture;
  readonly global: RhiDebugGlobal;
}

// Read FORGEAX_ENGINE_RHI_DEBUG from two sources (plan-strategy D-4):
//   - browser: import.meta.env, statically replaced by the
//     vite-plugin-rhi-debug `define` hook. The `typeof import.meta !==
//     'undefined'` prefix short-circuits under dawn-node, where import.meta
//     itself can be undefined (C5).
//   - dawn-node: globalThis.process.env (no vite define on the native path).
// resolveRhiDebugFlag (internal/rhi-debug-flag) is the SSOT for the `??`
// precedence. Keeps this file @types/node-free (engine-app ships ESM into both
// browser + dawn-node). Keep the Vite define key in a direct property
// expression; optional chaining keeps the package safe on the Dawn/Node path
// where `import.meta.env` is absent.
function readRhiDebugFlag(): string | undefined {
  const importMetaEnv =
    typeof import.meta !== 'undefined'
      ? { FORGEAX_ENGINE_RHI_DEBUG: import.meta.env?.FORGEAX_ENGINE_RHI_DEBUG }
      : undefined;
  const processEnv = (globalThis as { process?: { env?: { FORGEAX_ENGINE_RHI_DEBUG?: string } } })
    .process?.env;
  return resolveRhiDebugFlag(importMetaEnv, processEnv);
}

type RecorderInput = Parameters<typeof attachRecorder>[0];

/** The usable backend the recorder wraps, with the startup adapter probe consumed once. */
async function recordableBackend(
  rendererOpts: import('@forgeax/engine-render').RendererOptions,
): Promise<RecorderInput> {
  const nav: { gpu?: unknown } | undefined =
    typeof globalThis !== 'undefined'
      ? (globalThis as { navigator?: { gpu?: unknown } }).navigator
      : undefined;
  const hasWebGPU = nav !== undefined && 'gpu' in nav && nav.gpu !== undefined;
  // A GPU entry can exist while requestAdapter() returns null. Runtime
  // normally retries with wgpu/WebGL2 in that case; the recorder-injected
  // RHI is explicit, so select the usable backend before wrapping it.
  const explicitRhi = rendererOpts.rhi;
  let nativeAdapter =
    explicitRhi === undefined && hasWebGPU ? await rhiWebgpu.requestAdapter() : undefined;
  const realBackend = (explicitRhi !== undefined
    ? { rhi: explicitRhi, ...explicitRhi }
    : nativeAdapter?.ok
      ? rhiWebgpu
      : await import('@forgeax/engine-rhi-wgpu')) as unknown as Record<string, unknown>;
  if (explicitRhi === undefined && !nativeAdapter?.ok && 'ensureReady' in realBackend) {
    await (realBackend.ensureReady as () => Promise<unknown>)();
  }
  const pack = loadRhiPack(realBackend);
  if (pack.createShaderModule === undefined) {
    throw new Error('RHI-debug requires a backend createShaderModule capability');
  }
  return {
    // Consume the probe for startup only. Recovery must request a fresh
    // adapter from the same backend after the previous generation is lost.
    rhi: nativeAdapter?.ok
      ? {
          ...pack.rhi,
          requestAdapter: async (...args) => {
            const initialAdapter = nativeAdapter;
            nativeAdapter = undefined;
            return initialAdapter ?? pack.rhi.requestAdapter(...args);
          },
        }
      : pack.rhi,
    createShaderModule: pack.createShaderModule,
    ...(pack.createShaderModuleImmediate === undefined
      ? {}
      : { createShaderModuleImmediate: pack.createShaderModuleImmediate }),
  };
}

/** Route renderer options through an attached recorder and expose its capture. */
function adoptRhiDebugRecorder(
  rendererOpts: import('@forgeax/engine-render').RendererOptions,
  attachment: RecorderAttachment,
): RhiDebugHost {
  const capture = createRhiCapture(attachment);
  const global: RhiDebugGlobal = {
    async captureFrame(options, onSubmitted) {
      const release =
        onSubmitted === undefined ? undefined : subscribeRhiCaptureSubmitted(capture, onSubmitted);
      try {
        return await capture.captureFrame(options);
      } finally {
        release?.();
      }
    },
  };
  Object.assign(rendererOpts, {
    rhi: attachment.backend.rhi,
    rhiInstrumentation: mergeRhiInstrumentation(
      createRhiInstrumentation(attachment),
      rendererOpts.rhiInstrumentation,
    ),
  });
  markRendererBootstrapStage('rhi-debug-attached');
  return { attachment, capture, global };
}

function releaseRhiDebugHost(debug: RhiDebugHost | undefined): void {
  const host = globalThis as { __forgeax?: RhiDebugGlobal };
  const global = debug === undefined ? undefined : debug.global;
  if (host.__forgeax === global) delete host.__forgeax;
  if (debug !== undefined) void debug.attachment.dispose();
}

function publishRhiDebugHost(debug: RhiDebugHost): void {
  (globalThis as { __forgeax?: RhiDebugGlobal }).__forgeax = debug.global;
}

interface BrowserRendererHost {
  readonly renderer: Renderer;
  readonly debugDrawHost: RendererHostAssembly['debugDrawHost'];
  readonly featureHost: RenderFeatureHost;
  readonly assets: AssetRegistry | undefined;
}

// createRenderer failures resolve as Result.err(EngineEnvironmentError)
// (AC-01 / research section 2.2): rhi pack load failure or all WebGPU
// channels unavailable forward the original EngineEnvironmentError instance
// verbatim to preserve the .detail.webgpuError surface. Any other unexpected
// throw is also forwarded to keep the contract honest (AI users walk the union
// discriminant rather than parse error.message strings).
async function constructBrowserRendererHost(
  canvas: HTMLCanvasElement,
  rendererOpts: import('@forgeax/engine-render').RendererOptions,
  bundler: BundlerOptions | undefined,
  preparedExecutionBootstrap: PreparedExecutionBootstrap | undefined,
): Promise<Result<BrowserRendererHost, EngineEnvironmentError>> {
  try {
    markRendererBootstrapStage('renderer-host-start');
    const constructed = await constructRuntimeRendererHost(canvas, rendererOpts, bundler);
    if (!constructed.ok) throw constructed.error;
    const initialized = await constructed.value.initialization;
    if (!initialized.ok) {
      constructed.value.renderer.dispose();
      throw initialized.error;
    }
    const renderer = constructed.value.renderer;
    await preparedExecutionBootstrap?.configureRenderer?.(renderer);
    refreshCanvasDeviceLimit(canvas, renderer);
    const host: BrowserRendererHost = {
      renderer,
      debugDrawHost: constructed.value.debugDrawHost,
      featureHost: createRenderFeatureHost(constructed.value.featureHost),
      assets: constructed.value.assets,
    };
    markRendererBootstrapStage('renderer-initialized');
    return ok(host);
  } catch (e: unknown) {
    markRendererBootstrapStage('renderer-host-failed', {
      message: e instanceof Error ? e.message : String(e),
    });
    if (e instanceof EngineEnvironmentError) return err(e);
    const detail = e instanceof Error ? e : new Error(String(e));
    return err(
      new EngineEnvironmentError('renderer construction failed', {
        webgpuError: detail,
      }),
    );
  }
}

interface BrowserRendering extends BrowserRendererHost {
  readonly assetAssembly: AssetRuntimeAssembly | undefined;
  readonly rhiDebug: RhiDebugHost | undefined;
}

/** Renderer realm: renderer options, optional recorder, renderer host and asset runtime. */
async function constructBrowserRendering(
  canvas: HTMLCanvasElement,
  opts: CreateAppOptions | undefined,
  bundler: BundlerOptions | undefined,
  preparedExecutionBootstrap: PreparedExecutionBootstrap | undefined,
): Promise<Result<BrowserRendering, CanvasAppError>> {
  const rendererOpts = rendererOptionsFor(opts, preparedExecutionBootstrap);
  // FORGEAX_ENGINE_RHI_DEBUG=1 attaches the recorder at the Runtime backend
  // seam. Render remains the owner of device/surface lifecycle.
  // A browser production build must be able to erase the entire recorder
  // branch. The `undefined` arm preserves Dawn/Node's process.env fallback;
  // Vite replaces the direct property with `"0"` or `"1"`, making this outer
  // guard a literal false/true before Rollup sees the debug-only imports.
  // Keep the Vite define key in a direct property expression: wrapping
  // `import.meta` in a structural cast hides the token from Vite's define pass.
  const browserBuildRhiDebugFlag =
    typeof import.meta !== 'undefined' ? import.meta.env?.FORGEAX_ENGINE_RHI_DEBUG : undefined;
  const rhiDebugFlag = readRhiDebugFlag();
  let rhiDebug: RhiDebugHost | undefined;
  if (
    (browserBuildRhiDebugFlag === undefined || browserBuildRhiDebugFlag === '1') &&
    rhiDebugFlag === '1'
  ) {
    const attached = attachRecorder(await recordableBackend(rendererOpts));
    if (!attached.ok) throw new Error(attached.error.hint);
    rhiDebug = adoptRhiDebugRecorder(rendererOpts, attached.value);
  }
  const host = await constructBrowserRendererHost(
    canvas,
    rendererOpts,
    bundler,
    preparedExecutionBootstrap,
  );
  if (!host.ok) {
    releaseRhiDebugHost(rhiDebug);
    return err(host.error);
  }
  const assembled = assembleBrowserAssets(host.value.assets, opts);
  if (!assembled.ok) {
    releaseRhiDebugHost(rhiDebug);
    await host.value.renderer.dispose();
    return err(assembled.error);
  }
  const assetAssembly = assembled.value;
  return ok({
    ...host.value,
    assets: assetAssembly === undefined ? host.value.assets : assetAssembly.registry,
    assetAssembly,
    rhiDebug,
  });
}

/** An App-owned asset runtime is assembled only when some asset source is requested. */
function assembleBrowserAssets(
  rendererAssets: AssetRegistry | undefined,
  opts: CreateAppOptions | undefined,
): ReturnType<typeof createAssetRuntimeAssembly> | Result<undefined, never> {
  const executionCatalog = opts?.execution?.assetCatalog;
  const catalogSource =
    opts?.assetCatalog ??
    (executionCatalog === undefined
      ? undefined
      : createCatalogSource({
          url: executionCatalog.url,
          ...(executionCatalog.expectedScope === undefined
            ? {}
            : { expectedScope: executionCatalog.expectedScope }),
        }));
  const runtimeBinding = opts?.assetRuntimeBinding ?? executionCatalog?.runtimeBinding;
  const assetAssemblyRequested =
    rendererAssets !== undefined ||
    opts?.assets !== undefined ||
    catalogSource !== undefined ||
    opts?.assetDecoders !== undefined ||
    opts?.pluginPrograms !== undefined ||
    opts?.runtimePacks !== undefined ||
    runtimeBinding !== undefined;
  if (!assetAssemblyRequested) return ok(undefined);
  return createAssetRuntimeAssembly(rendererAssets, {
    ...(opts?.assets === undefined ? {} : { registry: opts.assets }),
    ...(catalogSource === undefined ? {} : { catalogSource }),
    ...(opts?.assetDecoders === undefined ? {} : { decoderContributions: opts.assetDecoders }),
    ...(runtimeBinding === undefined ? {} : { runtimeBinding }),
  });
}

/** Dual-source gating mirrors the rhi-debug flag (feat-20260629 M4 / w20). */
function readRemoteServeFlag(): boolean {
  return resolveRemoteServeFlag(
    typeof import.meta !== 'undefined'
      ? (import.meta as { env?: { DEV?: boolean } }).env?.DEV
      : undefined,
    (globalThis as { process?: { env?: { FORGEAX_ENGINE_REMOTE_SERVE?: string } } }).process?.env,
  );
}

// A normal canvas app owns its browser acquisition. An embedding host that
// shares this physical canvas with another world supplies its routed view via
// opts.input; createApp then consumes that one boundary instead of attaching a
// second listener set. The host owns the supplied backend's lifetime.
function acquireAppInput(
  canvas: HTMLCanvasElement,
  opts: CreateAppOptions | undefined,
): { readonly handle: InputAttachHandle | undefined; readonly backend: InputBackend | undefined } {
  if (opts?.input !== undefined) return { handle: undefined, backend: opts.input };
  const handle = attachInputAuto(canvas, opts);
  return { handle, backend: handle.backend };
}

/** Host-realm services the profile provides before user plugins. */
function browserHostServicePlugins(opts: CreateAppOptions | undefined): Plugin[] {
  const plugins: Plugin[] = [];
  const hostAudioFactory = opts?.execution?.createHostAudio;
  if (hostAudioFactory !== undefined) {
    plugins.push({
      name: 'execution-host-audio',
      provide: 'audio',
      apply(ctx: Context) {
        const consumer = hostAudioFactory();
        ctx.effect(() => () => consumer.dispose(), 'execution/host-audio');
        ctx.provide(
          'audio',
          createAudioIntentBackend({
            emit: (intent) => consumer.consume(intent),
            state: () => consumer.state(),
          }),
        );
      },
    });
  }
  const localProfiler = opts?.profiler;
  if (localProfiler !== undefined && opts?.context === undefined) {
    plugins.push({
      name: 'app-profiler',
      provide: 'profiler',
      apply(ctx: Context) {
        ctx.provide('profiler', localProfiler);
      },
    });
  }
  return plugins;
}

/** User plugins come from the local options, or from the prepared bootstrap module. */
function browserUserPlugins(
  canvas: HTMLCanvasElement,
  renderer: Renderer,
  opts: CreateAppOptions | undefined,
  preparedExecutionBootstrap: PreparedExecutionBootstrap | undefined,
  inputBackend: InputBackend | undefined,
): readonly Plugin[] {
  if (preparedExecutionBootstrap === undefined) return opts?.plugins ?? [];
  return [
    executionBootstrapHostPlugin(
      {
        canvas,
        drawingBufferSize: () => ({ width: canvas.width, height: canvas.height }),
        renderTargets: renderer,
        ...(opts?.execution?.bootstrapPort === undefined
          ? {}
          : { port: opts.execution.bootstrapPort }),
        setPointerLockAllowed: (allowed) => inputBackend?.setPointerLockAllowed?.(allowed),
      },
      renderer,
    ),
    ...(preparedExecutionBootstrap.plugins ?? []),
  ];
}

function canvasDeviceLimitPlugin(canvas: HTMLCanvasElement, renderer: Renderer): Plugin {
  return {
    name: 'canvas-device-limit',
    apply(ctx: Context) {
      ctx.effect(() => observeCanvasDeviceLimit(canvas, renderer), 'app/canvas-device-limit');
    },
  };
}

/** Own a fresh World context, or install into the borrowed one and record the owned Fibers. */
async function activateAppPluginContext(
  world: World,
  profile: readonly Plugin[],
  borrowed: Context | undefined,
  ownedAppFibers: Fiber[],
): Promise<Context> {
  if (borrowed === undefined) return createWorldContext(world, profile);
  ownedAppFibers.push(await borrowed.plugin(worldPlugin(world)));
  for (const plugin of profile) ownedAppFibers.push(await borrowed.plugin(plugin));
  return borrowed;
}

async function disposeFibersInReverse(fibers: Fiber[]): Promise<void> {
  for (const fiber of fibers.reverse()) await fiber.dispose();
}

function pluginActivationError(cause: unknown): AppError {
  return makeAppError(
    'app-plugin-activation-failed',
    APP_EXPECTED['app-plugin-activation-failed'],
    APP_ERROR_HINTS['app-plugin-activation-failed'],
    { cause },
  );
}

/** Activate the prepared bootstrap root; a failure releases the whole App context. */
async function activateBootstrapRoot(
  pluginContext: Context,
  preparedExecutionBootstrap: PreparedExecutionBootstrap | undefined,
  opts: CreateAppOptions | undefined,
  ownedAppFibers: Fiber[],
  disposeAppContext: () => Promise<void>,
): Promise<Result<void, AppError>> {
  if (!preparedExecutionBootstrap?.root) return ok(undefined);
  try {
    const root = await activateExecutionRoot(pluginContext, preparedExecutionBootstrap.root, {
      ...(opts?.execution?.startupTimeoutMs === undefined
        ? {}
        : { timeoutMs: opts.execution.startupTimeoutMs }),
    });
    ownedAppFibers.push(root.fiber);
    return ok(undefined);
  } catch (cause) {
    let failure = cause;
    try {
      await disposeAppContext();
    } catch (cleanup) {
      failure = { activation: cause, cleanup };
    }
    return err(pluginActivationError(failure));
  }
}

function createBrowserExecutionControl(
  executionContext: BrowserExecutionContext | undefined,
  world: World,
  frameInspection: FrameInspectionRef,
  audioBackend: AudioBackend | undefined,
): LocalExecutionControl {
  return createLocalExecutionControl(
    executionContext === undefined
      ? createExecutionReport(
          unavailableExecutionCapabilities('local assembly'),
          selectExecutionWorkers({
            workers: { engine: false },
            capabilities: unavailableExecutionCapabilities('local assembly'),
          }).unwrap(),
          world.execution,
        )
      : createExecutionReport(
          executionContext.capabilities,
          executionContext.selection,
          world.execution,
        ),
    {
      ...(audioBackend === undefined ? {} : { audio: () => audioBackend.getState() }),
      world: () => world.execution,
      frame: () => frameInspection.current(),
    },
  );
}

/** A supplied platform stays host-owned; the default browser platform is App-owned. */
async function installBrowserPlatform(
  canvas: HTMLCanvasElement,
  supplied: Platform | undefined,
  installAppPlugin: (plugin: Plugin) => Promise<Fiber>,
): Promise<Result<Platform, AppError>> {
  if (supplied !== undefined) return ok(supplied);
  const platformResult = createBrowserPlatform(canvas);
  if (!platformResult.ok) {
    return err(
      makeAppError(
        'app-system-update-failed',
        'native browser host facts and frame scheduling are available',
        'inspect detail.cause and restore the canvas Window before creating the App',
        { cause: platformResult.error },
      ),
    );
  }
  const platform = platformResult.value;
  await installAppPlugin({
    name: 'browser-platform',
    apply(ctx) {
      ctx.effect(() => () => platform.dispose());
    },
  });
  return ok(platform);
}

function browserFrameSignalPlugin(canvas: HTMLCanvasElement, renderer: Renderer): Plugin {
  return {
    name: 'forgeax:browser-frame-signal',
    apply(ctx) {
      ctx.effect(() => {
        const unsubscribe = renderer.subscribe((event) => {
          if (event.kind === 'error' && renderer.state() !== 'alive')
            resetBrowserFrameProgress(canvas);
        });
        return () => {
          unsubscribe();
          resetBrowserFrameProgress(canvas);
        };
      });
    },
  };
}

function browserRemoteBridgePlugin(
  port: string,
  app: App,
  pluginProjection: PluginProjectionBridge,
  rhiCapture: RhiCapture | undefined,
  opts: CreateAppOptions | undefined,
): Plugin {
  return {
    name: 'browser-remote-bridge',
    inject: ['world', 'renderer', 'assets'],
    async apply(ctx) {
      if (ctx.renderer === undefined || ctx.assets === undefined) {
        throw new Error('browser remote bridge requires renderer and assets services');
      }
      const bridge = await import('./internal/browser-remote-bridge');
      const teardown = await bridge.installBrowserRemoteBridge({
        world: ctx.world,
        renderer: ctx.renderer,
        assets: ctx.assets,
        runtimeModule: engineRuntimeModule,
        ...(rhiCapture !== undefined ? { rhiCapture } : {}),
        plugins: pluginProjection,
        simulation: app,
        ...(opts?.profiler !== undefined ? { profiler: opts.profiler } : {}),
        execution: app.execution,
        port,
      });
      ctx.effect(() => teardown, 'remote/browser-bridge');
    },
  };
}

function createPluginProjectionBridge(): PluginProjectionBridge {
  const bridge: PluginProjectionBridge = {
    inspect: () =>
      bridge.current?.inspect() ?? {
        desired: [],
        live: [],
        liveState: 'unavailable',
      },
  };
  return bridge;
}
