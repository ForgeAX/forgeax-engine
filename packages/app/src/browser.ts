// Browser construction delegates to the same realm-neutral App assembly.
import {
  type AssetRegistry,
  createCatalogSource,
  validateAssetBudgetBytes,
} from '@forgeax/engine-assets-runtime';
import { createAudioIntentBackend } from '@forgeax/engine-audio';
import type { DebugDraw } from '@forgeax/engine-debug-draw';
import { createWorldContext, World, worldPlugin } from '@forgeax/engine-ecs';
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
  makeAppError,
  type PluginProjectionBridge,
  startRemoteServer,
} from './app-assembly';
import { type AssetRuntimeAssembly, createAssetRuntimeAssembly } from './assets-runtime-assembly';
import {
  publishBrowserFrameCompleted,
  publishBrowserFrameSubmitted,
  resetBrowserFrameSubmitted,
} from './browser-frame-signal';
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
  executionBootstrapHostPlugin,
  type PreparedExecutionBootstrap,
  prepareBootstrapEntry,
  probeExecutionCapabilities,
  selectExecutionWorkers,
  unavailableExecutionCapabilities,
} from './execution';
import { normalizeExecutionBootstrapUrl } from './execution/bootstrap-url';
import { createLocalExecutionControl } from './execution/control';
import { installCarriedGpuStub } from './execution/gpu-stub';
import { createWorkerExecutionApp } from './execution/host-controller';
import { attachInputAuto } from './internal/input-attach';
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
  // M4: 4-step thin wrapper per plan-strategy D-5.
  //
  // Step 1: canvas-detached fail-fast guard (AC-08). isConnected returns
  //   false when the canvas is not in the document tree, including freshly
  //   document.createElement('canvas') without appendChild. Returning
  //   Result.err here short-circuits before createRenderer fires off any
  //   async adapter / device / shader work that would only fail later.
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

  let executionBootstrapUrl: string | undefined;
  if (opts?.execution !== undefined) {
    const normalizedBootstrap = normalizeExecutionBootstrapUrl(opts.execution.bootstrap);
    if (!normalizedBootstrap.ok) return err(normalizedBootstrap.error);
    executionBootstrapUrl = normalizedBootstrap.value;
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
    if (realmBoundOption !== undefined) {
      return err(
        makeAppError(
          'app-execution-bootstrap-failed',
          APP_EXPECTED['app-execution-bootstrap-failed'],
          APP_ERROR_HINTS['app-execution-bootstrap-failed'],
          {
            phase: 'prepare',
            moduleUrl: executionBootstrapUrl,
            cause: new TypeError(
              `${realmBoundOption} must be constructed by the execution bootstrap module`,
            ),
          },
        ),
      );
    }
  }

  let executionContext:
    | {
        readonly capabilities: import('./execution').ExecutionCapabilities;
        readonly selection: import('./execution').ExecutionSelection;
      }
    | undefined;
  let preparedExecutionBootstrap: PreparedExecutionBootstrap | undefined;
  if (opts?.execution !== undefined) {
    const capabilities = await probeExecutionCapabilities(
      canvas,
      opts.execution.startupTimeoutMs,
      opts.gpuStub !== undefined,
    );
    const selected = selectExecutionWorkers({
      workers: opts.execution.workers ?? {},
      capabilities,
    });
    if (!selected.ok) return err(selected.error);
    executionContext = { capabilities, selection: selected.value };
    if (selected.value.engine.enabled) {
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
        capabilities,
        selection: selected.value,
      });
      if (
        workerApp.ok &&
        typeof import.meta !== 'undefined' &&
        (import.meta as { env?: { DEV?: boolean; VITE_FORGEAX_ENGINE_BRIDGE?: string } }).env
          ?.DEV === true &&
        (import.meta as { env?: { VITE_FORGEAX_ENGINE_BRIDGE?: string } }).env
          ?.VITE_FORGEAX_ENGINE_BRIDGE === '1' &&
        workerApp.value.remoteEval !== undefined
      ) {
        const bridgePort =
          (import.meta as { env?: { VITE_FORGEAX_ENGINE_BRIDGE_PORT?: string } }).env
            ?.VITE_FORGEAX_ENGINE_BRIDGE_PORT ?? '5733';
        const bridge = await import('./internal/browser-remote-bridge');
        const teardown = await bridge.installBrowserExecutionBridge({
          execute: workerApp.value.remoteEval,
          readStatus: () => {
            const execution = workerApp.value.execution.report();
            return {
              worldIdentity: execution.world.identity,
              execution,
              workers: execution.workers,
            };
          },
          port: bridgePort,
          ...(workerApp.value.clearInput === undefined
            ? {}
            : { clearInput: workerApp.value.clearInput }),
          ...(workerApp.value.beginInputLease === undefined
            ? {}
            : { beginInputLease: workerApp.value.beginInputLease }),
          ...(workerApp.value.finishProfiler === undefined
            ? {}
            : { finishProfiler: workerApp.value.finishProfiler }),
        });
        // The worker path returns a realm-local App before the browser bridge
        // is installed. Tie the bridge to that App's existing lifecycle so a
        // stopped worker cannot leave a reconnecting socket behind.
        const workerExecutionApp = workerApp.value;
        const stop = workerExecutionApp.stop;
        return ok({
          ...workerExecutionApp,
          stop: () => {
            const result = stop();
            teardown();
            return result;
          },
        });
      }
      return workerApp;
    }
    if (executionBootstrapUrl === undefined) {
      throw new Error('execution bootstrap URL was not normalized');
    }
    const prepared = await prepareBootstrapEntry(
      executionBootstrapUrl,
      opts.execution.bootstrapData,
    );
    if (!prepared.ok) return err(prepared.error);
    preparedExecutionBootstrap = prepared.value;
    // The same structured diagnostics apply when the selected realm stays local.
    const diagnostics = opts.execution.diagnostics;
    if (diagnostics?.shadowWorkload === true) opts = { ...opts, shadowWorkload: true };
    if (diagnostics?.profiler === true && opts.profiler === undefined) {
      opts = { ...opts, profiler: createProfiler() };
    }
    if (diagnostics?.gpuPassTiming !== undefined) {
      opts = { ...opts, gpuPassTiming: diagnostics.gpuPassTiming };
    }
    const runtimeBinding = opts.execution?.assetCatalog?.runtimeBinding;
    if (runtimeBinding !== undefined) {
      bundler = { ...bundler, importTransport: createDevImportTransport(runtimeBinding) };
    }
  }

  // Step 2: createRenderer try/catch -> Result.err(EngineEnvironmentError)
  //   (AC-01 / research section 2.2). createRenderer throws at
  //   createRenderer.ts:400 / :429 (rhi pack load failure /
  //   all WebGPU channels unavailable); we forward the original
  //   EngineEnvironmentError instance verbatim to preserve the
  //   .detail.webgpuError surface. RhiError instances raised mid-
  //   construction are also forwarded -- the AppError | RhiError leg of
  //   the union covers them. Any other unexpected throw is also
  //   forwarded to keep the contract honest (AI users walk the union
  //   discriminant rather than parse error.message strings).
  // feat-20260608 / M2 / D-3: CreateAppOptions stops `extends RendererOptions`,
  // so the RHI escape hatch (rhi) is
  // forwarded explicitly. Build a RendererOptions object out of just those
  // fields when present; an empty {} keeps createRenderer on its default path.
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

  // FORGEAX_ENGINE_RHI_DEBUG=1 attaches the recorder at the Runtime backend
  // seam. Render remains the owner of device/surface lifecycle; App only owns
  // the optional capture capability and its frame transaction.
  let rhiAttachment: RecorderAttachment | undefined;
  let rhiCapture: RhiCapture | undefined;
  let rhiDebugGlobal:
    | {
        captureFrame(
          options?: CaptureFrameOptions,
          onSubmitted?: () => void,
        ): ReturnType<RhiCapture['captureFrame']>;
      }
    | undefined;
  const cleanupRhiDebugHost = (): void => {
    const host = globalThis as { __forgeax?: typeof rhiDebugGlobal };
    if (host.__forgeax === rhiDebugGlobal) delete host.__forgeax;
    rhiDebugGlobal = undefined;
    const attachment = rhiAttachment;
    rhiAttachment = undefined;
    if (attachment !== undefined) void attachment.dispose();
  };
  // Read FORGEAX_ENGINE_RHI_DEBUG from two sources (plan-strategy D-4):
  //   - browser: import.meta.env, statically replaced by the
  //     vite-plugin-rhi-debug `define` hook. The `typeof import.meta !==
  //     'undefined'` prefix short-circuits under dawn-node, where import.meta
  //     itself can be undefined (C5).
  //   - dawn-node: globalThis.process.env (no vite define on the native path).
  // resolveRhiDebugFlag (internal/rhi-debug-flag) is the SSOT for the `??`
  // precedence; the source bags are computed inline here so the
  // typeof-import.meta prefix stays at the call site. Keeps this file
  // @types/node-free (engine-app ships ESM into both browser + dawn-node;
  // same pattern as runtime/src/render-system-record.ts:isMeshSsboDevMode).
  // Keep the Vite define key in a direct property expression. Wrapping
  // `import.meta` in a structural cast hides the token from Vite's define
  // pass, so production builds retain the debug-only dynamic chunks even when
  // the Preview host explicitly sets the flag to `0`. Optional chaining keeps
  // the package safe on the Dawn/Node path where `import.meta.env` is absent.
  const importMetaEnv =
    typeof import.meta !== 'undefined'
      ? { FORGEAX_ENGINE_RHI_DEBUG: import.meta.env?.FORGEAX_ENGINE_RHI_DEBUG }
      : undefined;
  // A browser production build must be able to erase the entire recorder
  // branch. The `undefined` arm preserves Dawn/Node's process.env fallback;
  // Vite replaces the direct property with `"0"` or `"1"`, making this outer
  // guard a literal false/true before Rollup sees the debug-only imports.
  const browserBuildRhiDebugFlag =
    typeof import.meta !== 'undefined' ? import.meta.env?.FORGEAX_ENGINE_RHI_DEBUG : undefined;
  const processEnv = (globalThis as { process?: { env?: { FORGEAX_ENGINE_RHI_DEBUG?: string } } })
    .process?.env;
  const rhiDebugFlag = resolveRhiDebugFlag(importMetaEnv, processEnv);
  const nav: { gpu?: unknown } | undefined =
    typeof globalThis !== 'undefined'
      ? (globalThis as { navigator?: { gpu?: unknown } }).navigator
      : undefined;
  const hasWebGPU = nav !== undefined && 'gpu' in nav && nav.gpu !== undefined;
  if (
    (browserBuildRhiDebugFlag === undefined || browserBuildRhiDebugFlag === '1') &&
    rhiDebugFlag === '1'
  ) {
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
    const attached = attachRecorder({
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
    });
    if (!attached.ok) throw new Error(attached.error.hint);
    rhiAttachment = attached.value;
    rhiCapture = createRhiCapture(attached.value);
    const capture = rhiCapture;
    rhiDebugGlobal = {
      async captureFrame(options, onSubmitted) {
        const release =
          onSubmitted === undefined
            ? undefined
            : subscribeRhiCaptureSubmitted(capture, onSubmitted);
        try {
          return await capture.captureFrame(options);
        } finally {
          release?.();
        }
      },
    };
    Object.assign(rendererOpts, {
      rhi: attached.value.backend.rhi,
      rhiInstrumentation: mergeRhiInstrumentation(
        createRhiInstrumentation(attached.value),
        rendererOpts.rhiInstrumentation,
      ),
    });
    markRendererBootstrapStage('rhi-debug-attached');
  }

  let renderer: Renderer;
  let rendererDebugDrawHost: RendererHostAssembly['debugDrawHost'];
  let rendererFeatureHost: RenderFeatureHost;
  let assets: AssetRegistry | undefined;
  let assetAssembly: AssetRuntimeAssembly | undefined;
  try {
    markRendererBootstrapStage('renderer-host-start');
    const constructed = await constructRuntimeRendererHost(canvas, rendererOpts, bundler);
    if (!constructed.ok) throw constructed.error;
    const initialized = await constructed.value.initialization;
    if (!initialized.ok) {
      constructed.value.renderer.dispose();
      throw initialized.error;
    }
    renderer = constructed.value.renderer;
    await preparedExecutionBootstrap?.configureRenderer?.(renderer);
    refreshCanvasDeviceLimit(canvas, renderer);
    rendererDebugDrawHost = constructed.value.debugDrawHost;
    rendererFeatureHost = createRenderFeatureHost(constructed.value.featureHost);
    assets = constructed.value.assets;
    markRendererBootstrapStage('renderer-initialized');
  } catch (e: unknown) {
    markRendererBootstrapStage('renderer-host-failed', {
      message: e instanceof Error ? e.message : String(e),
    });
    cleanupRhiDebugHost();
    if (e instanceof EngineEnvironmentError) return err(e);
    const detail = e instanceof Error ? e : new Error(String(e));
    return err(
      new EngineEnvironmentError('renderer construction failed', {
        webgpuError: detail,
      }),
    );
  }

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
    assets !== undefined ||
    opts?.assets !== undefined ||
    catalogSource !== undefined ||
    opts?.assetDecoders !== undefined ||
    opts?.pluginPrograms !== undefined ||
    opts?.runtimePacks !== undefined ||
    runtimeBinding !== undefined;
  if (assetAssemblyRequested) {
    const assetAssemblyResult = createAssetRuntimeAssembly(assets, {
      ...(opts?.assets === undefined ? {} : { registry: opts.assets }),
      ...(catalogSource === undefined ? {} : { catalogSource }),
      ...(opts?.assetDecoders === undefined ? {} : { decoderContributions: opts.assetDecoders }),
      ...(runtimeBinding === undefined ? {} : { runtimeBinding }),
    });
    if (!assetAssemblyResult.ok) {
      cleanupRhiDebugHost();
      await renderer.dispose();
      return err(assetAssemblyResult.error);
    }
    assetAssembly = assetAssemblyResult.value;
    assets = assetAssembly.registry;
  }

  // Step 2.4 decision: resolve whether the remote eval server should start
  // (feat-20260629-inspector-two-layer-model M4 / w20). Dual-source gating
  // mirrors the rhi-debug-flag pattern. The actual startServer call is
  // deferred to after World creation (Step 3) because the server needs
  // a live World reference.
  const shouldStartRemote = resolveRemoteServeFlag(
    typeof import.meta !== 'undefined'
      ? (import.meta as { env?: { DEV?: boolean } }).env?.DEV
      : undefined,
    (globalThis as { process?: { env?: { FORGEAX_ENGINE_REMOTE_SERVE?: string } } }).process?.env,
  );

  let debugDraw: DebugDraw | undefined;

  // Step 3: new World() -- the canvas form owns world lifetime, in
  // contrast to the assemble form where the host owns it.
  const world = new World(opts?.time !== undefined ? { time: opts.time } : {});
  const frameInspection = createFrameInspectionRef();
  // Step 3.1 (M2 plugin-system-unify / D-4): app-layer side effects that the
  // plugins consume via pre-injected world resources.
  //
  // Animation keeps durable clip GUIDs in graph payloads. The canvas default
  // plugin receives the renderer-owned GUID catalogue as a lookup bridge; it
  // still projects payloads into this World through the animation owner.
  // transform + animation system registration lives in the plugins (default set).

  // A normal canvas app owns its browser acquisition. An embedding host that
  // shares this physical canvas with another world supplies its routed view via
  // opts.input; createApp then consumes that one boundary instead of attaching a
  // second listener set. The host owns the supplied backend's lifetime.
  const inputHandle = opts?.input === undefined ? attachInputAuto(canvas, opts) : undefined;
  const inputBackend = opts?.input ?? inputHandle?.backend;
  const userPlugins =
    preparedExecutionBootstrap === undefined
      ? (opts?.plugins ?? [])
      : [
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
  let pluginContext: Context;
  const ownedAppFibers: Fiber[] = [];
  const disposeAppContext = async (): Promise<void> => {
    try {
      if (opts?.context === undefined) {
        await pluginContext.fiber.dispose();
        return;
      }
      for (const fiber of ownedAppFibers.reverse()) await fiber.dispose();
    } finally {
      opts?.execution?.bootstrapPort?.close();
    }
  };
  const installAppPlugin = async (plugin: Plugin): Promise<Fiber> => {
    const fiber = await pluginContext.plugin(plugin);
    if (opts?.context !== undefined) ownedAppFibers.push(fiber);
    return fiber;
  };
  const localProfiler = opts?.profiler;
  const pluginPrograms = preparedExecutionBootstrap?.pluginPrograms ?? opts?.pluginPrograms;
  const runtimePacks = preparedExecutionBootstrap?.runtimePacks ?? opts?.runtimePacks;
  const hostAudioFactory = opts?.execution?.createHostAudio;
  const profile = mainEngineProfile({
    renderer,
    ...(assetAssembly === undefined ? {} : { assetAssembly }),
    ...(pluginPrograms === undefined ? {} : { pluginPrograms }),
    ...(runtimePacks === undefined ? {} : { runtimePacks }),
    rendererDebugDrawHost,
    rendererFeatureHost,
    assets,
    ...(opts?.animation === undefined ? {} : { animation: opts.animation }),
    ...(inputBackend === undefined ? {} : { input: inputBackend }),
    ...(inputHandle === undefined ? {} : { inputDispose: inputHandle.cleanup }),
    ...(opts?.inputMap === undefined ? {} : { inputMap: opts.inputMap }),
    onDebugDrawReady: (value) => {
      debugDraw = value;
    },
    extensions: [
      ...(hostAudioFactory === undefined
        ? []
        : [
            {
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
            },
          ]),
      ...(localProfiler === undefined || opts?.context !== undefined
        ? []
        : [
            {
              name: 'app-profiler',
              provide: 'profiler',
              apply(ctx: Context) {
                ctx.provide('profiler', localProfiler);
              },
            },
          ]),
      rhiDebugHostPlugin(cleanupRhiDebugHost),
      ...userPlugins,
      {
        name: 'canvas-device-limit',
        apply(ctx: Context) {
          ctx.effect(() => observeCanvasDeviceLimit(canvas, renderer), 'app/canvas-device-limit');
        },
      },
      canvasAspectPlugin(() => {
        syncCanvasDrawingBuffer(canvas);
        return canvas;
      }),
    ],
  });
  try {
    if (opts?.context === undefined) {
      pluginContext = await createWorldContext(world, profile);
    } else {
      pluginContext = opts.context;
      await installAppPlugin(worldPlugin(world));
      for (const plugin of profile) await installAppPlugin(plugin);
    }
  } catch (cause) {
    opts?.execution?.bootstrapPort?.close();
    cleanupRhiDebugHost();
    assetAssembly?.dispose();
    if (opts?.context !== undefined) {
      for (const fiber of ownedAppFibers.reverse()) await fiber.dispose();
    }
    return err(
      makeAppError(
        'app-plugin-activation-failed',
        APP_EXPECTED['app-plugin-activation-failed'],
        APP_ERROR_HINTS['app-plugin-activation-failed'],
        { cause },
      ),
    );
  }
  if (preparedExecutionBootstrap?.root) {
    try {
      const root = await activateExecutionRoot(pluginContext, preparedExecutionBootstrap.root, {
        ...(opts?.execution?.startupTimeoutMs === undefined
          ? {}
          : { timeoutMs: opts.execution.startupTimeoutMs }),
      });
      ownedAppFibers.push(root.fiber);
    } catch (cause) {
      let failure = cause;
      try {
        await disposeAppContext();
      } catch (cleanup) {
        failure = { activation: cause, cleanup };
      }
      return err(
        makeAppError(
          'app-plugin-activation-failed',
          APP_EXPECTED['app-plugin-activation-failed'],
          APP_ERROR_HINTS['app-plugin-activation-failed'],
          { cause: failure },
        ),
      );
    }
  }
  // A borrowed plugin scope need not inject this optional App capability.
  const audioBackend = pluginContext.get('audio');

  const executionControl = createLocalExecutionControl(
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

  // Step 3.3: Remote eval server auto-start (deferred from Step 2.4 so
  // World is available). Dynamic import keeps @forgeax/engine-app free
  // of static dep on @forgeax/engine-remote. Component reflection crosses
  // this boundary as JSON-safe host data; app does not own any component.
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

  const platformResult =
    opts?.platform === undefined ? createBrowserPlatform(canvas) : ok(opts.platform);
  if (!platformResult.ok) {
    await disposeAppContext();
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
  if (opts?.platform === undefined) {
    await installAppPlugin({
      name: 'browser-platform',
      apply(ctx) {
        ctx.effect(() => () => platform.dispose());
      },
    });
  }

  const buildArgs: BuildAppArgs = {
    platform,
    installAppPlugin,
    renderer,
    assets,
    world,
    pluginContext,
    disposePluginContext: disposeAppContext,
    executionControl,
    frameInspection,
    ...(opts?.execution?.diagnostics?.geometryLane === undefined
      ? {}
      : { geometryLane: opts.execution.diagnostics.geometryLane }),
    onFrameSubmitted: (event) =>
      publishBrowserFrameSubmitted(canvas, { ...event, worldIdentity: world.identity }),
    onFrameCompleted: (event) =>
      publishBrowserFrameCompleted(canvas, { ...event, worldIdentity: world.identity }),
    ...(inputBackend !== undefined ? { inputBackend } : {}),
    ...(inputHandle === undefined
      ? {}
      : {
          wireOnLockErrorDispatch: (dispatch: (err: AppError) => void) => {
            inputHandle.setOnErrorDispatch(dispatch);
          },
        }),
  };
  if (audioBackend !== undefined) {
    Object.assign(buildArgs, {
      audioBackend,
    });
  }
  if (opts?.silenceUnhandledErrors !== undefined) {
    Object.assign(buildArgs, { silenceUnhandledErrors: opts.silenceUnhandledErrors });
  }
  // M2 / D-3: canvas form forwards the host-supplied draw-source pull.
  if (opts?.drawSource !== undefined) {
    Object.assign(buildArgs, { drawSource: opts.drawSource });
  }
  if (opts?.profiler !== undefined) {
    Object.assign(buildArgs, { profiler: opts.profiler });
  }
  if (rhiCapture !== undefined) {
    Object.assign(buildArgs, { rhiCapture });
  }
  if (debugDraw !== undefined) {
    Object.assign(buildArgs, { debugDraw });
  }
  if (remoteHandle !== undefined) {
    Object.assign(buildArgs, { remoteHandle });
  }

  // The aspect-sync sidecar belongs to the canvas path because it owns the DOM
  // canvas. It runs as an Update system so it shares World scheduling semantics.
  resetBrowserFrameSubmitted(canvas);
  await installAppPlugin({
    name: 'forgeax:browser-frame-signal',
    apply(ctx) {
      ctx.effect(() => {
        const unsubscribe = renderer.subscribe((event) => {
          if (event.kind === 'error' && renderer.state() !== 'alive')
            resetBrowserFrameSubmitted(canvas);
        });
        return () => {
          unsubscribe();
          resetBrowserFrameSubmitted(canvas);
        };
      });
    },
  });
  const built = await buildApp(buildArgs);
  if (!built.ok) {
    await disposeAppContext();
    return built;
  }
  if (built.ok) {
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
    // it on. Production DCE's the whole block (import.meta.env.DEV === false).
    // Additive: the Node startServer path above and app.remote are untouched.
    if (
      typeof import.meta !== 'undefined' &&
      (import.meta as { env?: { DEV?: boolean; VITE_FORGEAX_ENGINE_BRIDGE?: string } }).env?.DEV ===
        true &&
      (import.meta as { env?: { VITE_FORGEAX_ENGINE_BRIDGE?: string } }).env
        ?.VITE_FORGEAX_ENGINE_BRIDGE === '1'
    ) {
      const bridgePort =
        (import.meta as { env?: { VITE_FORGEAX_ENGINE_BRIDGE_PORT?: string } }).env
          ?.VITE_FORGEAX_ENGINE_BRIDGE_PORT ?? '5733';
      await installAppPlugin({
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
            simulation: built.value,
            ...(opts?.profiler !== undefined ? { profiler: opts.profiler } : {}),
            execution: built.value.execution,
            port: bridgePort,
          });
          ctx.effect(() => teardown, 'remote/browser-bridge');
        },
      });
    }
  }
  // The public capture entry must already belong to the App frame driver.
  // Publishing during renderer initialization would allow a bare recorder
  // snapshot to overlap the first frame's resource uploads.
  if (rhiDebugGlobal !== undefined)
    (globalThis as { __forgeax?: typeof rhiDebugGlobal }).__forgeax = rhiDebugGlobal;
  return built;
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
