// Main-thread App assembly is loaded after the browser selects its execution realm.
import { type AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { type AudioBackend, createAudioIntentBackend } from '@forgeax/engine-audio';
import type { DebugDrawSource } from '@forgeax/engine-debug-draw';
import { createWorldContext, World, worldPlugin } from '@forgeax/engine-ecs';
import type { InputBackend } from '@forgeax/engine-input';
import { PHYSICS_STARTUP_OPTIONS } from '@forgeax/engine-physics';
import type { Platform } from '@forgeax/engine-platform';
import { createBrowserPlatform } from '@forgeax/engine-platform-browser';
import type { Context, Fiber, Plugin } from '@forgeax/engine-plugin';
import { createProfiler } from '@forgeax/engine-profiler';
import type { Renderer } from '@forgeax/engine-render';
import type { RendererHostAssembly } from '@forgeax/engine-render/internal/construct-renderer';
import type { CaptureFrameOptions, RecorderAttachment } from '@forgeax/engine-rhi-debug';
import * as engineRuntimeModule from '@forgeax/engine-runtime';
import { createDevImportTransport, EngineEnvironmentError } from '@forgeax/engine-runtime';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type BuildAppArgs,
  buildApp,
  createFrameInspectionRef,
  type FrameInspectionRef,
  type PluginProjectionBridge,
  startRemoteServer,
} from './app-assembly';
import { type AssetRuntimeAssembly, createAssetRuntimeAssembly } from './assets-runtime-assembly';
import type { BrowserExecutionContext } from './browser';
import {
  publishBrowserFrameCompleted,
  publishBrowserFrameSubmitted,
  resetBrowserFrameProgress,
} from './browser-frame-signal';
import { canvasAspectPlugin } from './canvas-policy';
import {
  observeCanvasDeviceLimit,
  refreshCanvasDeviceLimit,
  syncCanvasDrawingBuffer,
} from './canvas-sizing';
import type { ConfiguredAppOptions } from './configuration-host';
import { APP_ERROR_HINTS, APP_EXPECTED, type AppError, makeAppError } from './errors';
import {
  activateExecutionRoot,
  createExecutionReport,
  executionBootstrapHostPlugin,
  type PreparedExecutionBootstrap,
  prepareBootstrapEntry,
  selectExecutionWorkers,
  unavailableExecutionCapabilities,
} from './execution';
import { createBrowserTaskPool } from './execution/browser-task-pool';
import { createLocalExecutionControl, type LocalExecutionControl } from './execution/control';
import { createAppHostAudio } from './host-audio';
import { createIdempotentRelease } from './internal/browser-bridge-release';
import { attachInputAuto, type InputAttachHandle } from './internal/input-attach';
import { mainEngineProfile } from './internal/main-engine-profile';
import { remoteServerPlugin } from './internal/remote-server-plugin';
import {
  createRhiCapture,
  createRhiInstrumentation,
  mergeRhiInstrumentation,
  type RhiCapture,
  subscribeRhiCaptureSubmitted,
} from './internal/rhi-capture';
import { levelServicePlugin } from './levels/level-service';
import { stageLocalAppLevels } from './levels/local-app-levels';
import { createRenderFeatureHost, type RenderFeatureHost } from './renderer-plugin';
import type {
  App,
  AppHostAdapter,
  BrowserRemoteBridgeAdapter,
  BundlerOptions,
  CanvasAppError,
  CreateAppOptions,
} from './types';

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

/** Programmer configuration: reject before any realm creates an AssetRegistry or Renderer. */
function browserRuntimePacks(options: ConfiguredAppOptions['runtimePacks']) {
  if (!options?.authored?.length || options.tasks !== undefined || typeof Worker !== 'function')
    return { options, dispose: () => {} };
  const tasks = createBrowserTaskPool();
  return { options: { ...options, tasks }, dispose: () => tasks.dispose() };
}

export async function createLocalBrowserApp(
  canvas: HTMLCanvasElement,
  opts: ConfiguredAppOptions | undefined,
  bundler: AppHostAdapter | undefined,
  selected?: { readonly bootstrapUrl: string; readonly context: BrowserExecutionContext },
): Promise<Result<App, CanvasAppError>> {
  let preparedExecutionBootstrap: PreparedExecutionBootstrap | undefined;
  if (selected !== undefined && opts?.execution !== undefined) {
    const local = await prepareLocalExecution(selected.bootstrapUrl, opts, opts.execution, bundler);
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
  const shouldStartRemote = bundler?.remoteServe === true;

  let debugDraw: DebugDrawSource | undefined;

  // The canvas form owns world lifetime, in contrast to the assemble form
  // where the host owns it.
  const world = new World(opts?.time !== undefined ? { time: opts.time } : {});
  const localLevels = stageLocalAppLevels(world, assets, renderer);
  const physics = opts?.startup?.settings.simulation?.physics;
  if (physics !== undefined) world.insertResource(PHYSICS_STARTUP_OPTIONS, physics);
  const frameInspection = createFrameInspectionRef();

  const { handle: inputHandle, backend: inputBackend } = acquireAppInput(canvas, opts);
  let pluginContext: Context;
  const ownedAppFibers: Fiber[] = [];
  const runtimePacks = browserRuntimePacks(
    preparedExecutionBootstrap?.runtimePacks ?? opts?.runtimePacks,
  );
  const disposeAppContext = async (): Promise<void> => {
    localLevels.owner.stopRequests();
    try {
      if (opts?.context === undefined) {
        await pluginContext.fiber.dispose();
        return;
      }
      await disposeFibersInReverse(ownedAppFibers);
    } finally {
      runtimePacks.dispose();
      opts?.execution?.bootstrapPort?.close();
    }
  };
  const installAppPlugin = async (plugin: Plugin): Promise<Fiber> => {
    const fiber = await pluginContext.plugin(plugin);
    if (opts?.context !== undefined) ownedAppFibers.push(fiber);
    return fiber;
  };
  const pluginPrograms = preparedExecutionBootstrap?.pluginPrograms ?? opts?.pluginPrograms;
  const profile = mainEngineProfile({
    renderer,
    assetAssembly,
    pluginPrograms,
    runtimePacks: runtimePacks.options,
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
      levelServicePlugin(localLevels.owner.service),
      ...browserHostServicePlugins(opts, bundler),
      rhiDebugHostPlugin(cleanupRhiDebugHost),
      ...browserUserPlugins(canvas, renderer, opts, preparedExecutionBootstrap, inputBackend),
      canvasDeviceLimitPlugin(canvas, renderer, opts?.canvasPixelRatio),
      canvasAspectPlugin(() => {
        syncCanvasDrawingBuffer(canvas, undefined, opts?.canvasPixelRatio);
        return canvas;
      }),
    ],
  });
  try {
    pluginContext = await activateAppPluginContext(world, profile, opts?.context, ownedAppFibers);
  } catch (cause) {
    localLevels.owner.stopRequests();
    opts?.execution?.bootstrapPort?.close();
    cleanupRhiDebugHost();
    assetAssembly?.dispose();
    runtimePacks.dispose();
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
    selected?.context,
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
  let releaseBrowserBridge: (() => void) | undefined;
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
        runtimePacks.options?.imports,
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
    localLevels,
    platform: platform.value,
    installAppPlugin,
    renderer,
    assets,
    world,
    pluginContext,
    disposePluginContext: disposeAppContext,
    onTerminal: () => releaseBrowserBridge?.(),
    executionControl,
    frameInspection,
    geometryLane: opts?.execution?.diagnostics?.geometryLane,
    onFrameSubmitted: (event) => {
      opts?.configurationObserver?.('submitted', {
        ...event,
        ...(event.receipt === undefined ? {} : { presentation: event.receipt.presentation }),
      });
      publishBrowserFrameSubmitted(canvas, { ...event, worldIdentity: world.identity });
    },
    onFrameCompleted: (event) => {
      opts?.configurationObserver?.('completed', event);
      publishBrowserFrameCompleted(canvas, { ...event, worldIdentity: world.identity });
      opts?.onFrameCompleted?.(event);
    },
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
    sceneAdmission: opts?.sceneAdmission,
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
  // Optional browser execution bridge for the persistent DevKit owner. A browser cannot host the
  // Node WS server that @forgeax/engine-remote/server needs, so the running
  // engine would be unreachable from a CLI in a real dev browser. Instead the
  // page dials OUT to a loopback relay and runs the ws-free eval core against
  // the live world/renderer/assets/rhiCapture.
  //
  // The host adapter enables this only when its relay is available. A page that
  // dials a relay which is not running makes the
  // BROWSER itself log "WebSocket connection failed" to the console — noise a
  // JS catch cannot suppress — which trips every zero-console-error browser
  // smoke. The host owns relay startup and opts in only for pages that it owns.
  // Additive: the Node startServer path above and app.remote are untouched.
  const browserBridge = bundler?.browserRemoteBridge;
  if (browserBridge !== undefined) {
    await installAppPlugin(
      browserRemoteBridgePlugin(
        browserBridge,
        built.value,
        pluginProjection,
        rhiCapture,
        opts,
        (release) => {
          releaseBrowserBridge = release;
        },
      ),
    );
  }
  // The public capture entry must already belong to the App frame driver.
  // Publishing during renderer initialization would allow a bare recorder
  // snapshot to overlap the first frame's resource uploads.
  if (rhiDebug !== undefined) publishRhiDebugHost(rhiDebug);
  return built;
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

/** A selected local realm runs the bootstrap module in this App's own World. */
async function prepareLocalExecution(
  bootstrapUrl: string,
  opts: ConfiguredAppOptions,
  execution: CreateAppExecution,
  bundler: AppHostAdapter | undefined,
): Promise<
  Result<
    {
      readonly bootstrap: PreparedExecutionBootstrap;
      readonly options: ConfiguredAppOptions;
      readonly bundler: AppHostAdapter | undefined;
    },
    AppError
  >
> {
  const prepared = await prepareBootstrapEntry(
    bootstrapUrl,
    execution.bootstrapData,
    execution.localBootstrap,
    opts.startup,
  );
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
  opts: ConfiguredAppOptions | undefined,
  preparedExecutionBootstrap: PreparedExecutionBootstrap | undefined,
): import('@forgeax/engine-render').RendererOptions {
  const rendererOpts: import('@forgeax/engine-render').RendererOptions = {
    ...(opts?.sceneMaxRenderShortSide === undefined
      ? {}
      : { maxRenderShortSide: opts.sceneMaxRenderShortSide }),
  };
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
  const forwardRendererPolicies = (
    opts: CreateAppOptions | undefined,
    rendererOpts: import('@forgeax/engine-render').RendererOptions,
  ) => {
    if (opts?.pipelineLibrary !== undefined)
      Object.assign(rendererOpts, { pipelineLibrary: opts.pipelineLibrary });
    if (opts?.backgroundPipelineLibrary !== undefined)
      Object.assign(rendererOpts, { backgroundPipelineLibrary: opts.backgroundPipelineLibrary });
    if (opts?.backgroundPipelineLibraryConcurrency !== undefined) {
      Object.assign(rendererOpts, {
        backgroundPipelineLibraryConcurrency: opts.backgroundPipelineLibraryConcurrency,
      });
    }
    if (opts?.viewportHitWarmup === true) Object.assign(rendererOpts, { viewportHitWarmup: true });
    if (opts?.viewportOutput !== undefined)
      Object.assign(rendererOpts, { viewportOutput: opts.viewportOutput });
    if (opts?.outputColorSpace !== undefined) {
      Object.assign(rendererOpts, { outputColorSpace: opts.outputColorSpace });
    }
    if (opts?.renderBackend !== undefined) {
      Object.assign(rendererOpts, { renderBackend: opts.renderBackend });
    }
    if (opts?.staticShadowBudgetBytes !== undefined)
      Object.assign(rendererOpts, { staticShadowBudgetBytes: opts.staticShadowBudgetBytes });
    if (opts?.dynamicGeometryMeshBudgetBytes !== undefined) {
      Object.assign(rendererOpts, {
        dynamicGeometryMeshBudgetBytes: opts.dynamicGeometryMeshBudgetBytes,
      });
    }
    if (opts?.featureTextureReadbackBudgetBytes !== undefined) {
      Object.assign(rendererOpts, {
        featureTextureReadbackBudgetBytes: opts.featureTextureReadbackBudgetBytes,
      });
    }
    if (opts?.assetBudgetBytes !== undefined) {
      Object.assign(rendererOpts, { assetBudgetBytes: opts.assetBudgetBytes });
    }
    if (opts?.textureMipSkip !== undefined) {
      Object.assign(rendererOpts, { textureMipSkip: opts.textureMipSkip });
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
  };
  forwardRendererPolicies(opts, rendererOpts);
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
  canvasPixelRatio: number | undefined,
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
    if (rendererOpts.standardProfile?.quality === undefined)
      await preparedExecutionBootstrap?.configureRenderer?.(renderer);
    refreshCanvasDeviceLimit(canvas, renderer, canvasPixelRatio);
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
  bundler: AppHostAdapter | undefined,
  preparedExecutionBootstrap: PreparedExecutionBootstrap | undefined,
): Promise<Result<BrowserRendering, CanvasAppError>> {
  const rendererOpts = rendererOptionsFor(opts, preparedExecutionBootstrap);
  // The host explicitly supplies this optional capability. Tool adapters own
  // the decision to make it available; renderer lifecycle remains here.
  let rhiDebug: RhiDebugHost | undefined;
  if (bundler?.attachRhiRecorder !== undefined) {
    const attachment = await bundler.attachRhiRecorder(rendererOpts);
    rhiDebug = adoptRhiDebugRecorder(rendererOpts, attachment);
  }
  const host = await constructBrowserRendererHost(
    canvas,
    rendererOpts,
    bundler,
    preparedExecutionBootstrap,
    opts?.canvasPixelRatio,
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
function browserHostServicePlugins(
  opts: ConfiguredAppOptions | undefined,
  adapter: AppHostAdapter | undefined,
): Plugin[] {
  const plugins: Plugin[] = [];
  if (
    adapter?.createHostAudio !== undefined ||
    opts?.execution?.createHostAudio !== undefined ||
    opts?.startup?.settings.audio !== undefined
  ) {
    plugins.push({
      name: 'execution-host-audio',
      provide: 'audio',
      apply(ctx: Context) {
        const consumer = createAppHostAudio(opts, adapter);
        ctx.effect(() => () => consumer.dispose(), 'execution/host-audio');
        ctx.provide(
          'audio',
          createAudioIntentBackend({
            ...opts?.startup?.settings.audio?.publication,
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
  opts: ConfiguredAppOptions | undefined,
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

function canvasDeviceLimitPlugin(
  canvas: HTMLCanvasElement,
  renderer: Renderer,
  pixelRatio: number | undefined,
): Plugin {
  return {
    name: 'canvas-device-limit',
    apply(ctx: Context) {
      ctx.effect(
        () => observeCanvasDeviceLimit(canvas, renderer, pixelRatio),
        'app/canvas-device-limit',
      );
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
  bridgeAdapter: BrowserRemoteBridgeAdapter,
  app: App,
  pluginProjection: PluginProjectionBridge,
  rhiCapture: RhiCapture | undefined,
  opts: CreateAppOptions | undefined,
  ownRelease: (release: () => void) => void,
): Plugin {
  return {
    name: 'browser-remote-bridge',
    inject: ['world', 'renderer', 'assets'],
    async apply(ctx) {
      if (ctx.renderer === undefined || ctx.assets === undefined) {
        throw new Error('browser remote bridge requires renderer and assets services');
      }
      const release = createIdempotentRelease(
        await bridgeAdapter.installLocalBridge({
          world: ctx.world,
          renderer: ctx.renderer,
          assets: ctx.assets,
          runtimeModule: engineRuntimeModule,
          ...(rhiCapture !== undefined ? { rhiCapture } : {}),
          plugins: pluginProjection,
          simulation: app,
          ...(opts?.profiler !== undefined ? { profiler: opts.profiler } : {}),
          execution: app.execution,
          port: bridgeAdapter.port,
        }),
      );
      ownRelease(release);
      bridgeAdapter.registerDispose(release);
      ctx.effect(() => release, 'remote/browser-bridge');
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
