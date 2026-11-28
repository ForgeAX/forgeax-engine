// Browser construction delegates to the same realm-neutral App assembly.
import { validateAssetBudgetBytes } from '@forgeax/engine-assets-runtime';
import type { RenderAblation } from '@forgeax/engine-render';
import {
  assertTextureMipSkip,
  installRenderAblationDevtools,
} from '@forgeax/engine-render/internal/host-data';
import { ownPipelineLibrary } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { applyRenderConfiguration, type ConfiguredExecutionControl } from './configuration-apply';
import { createEngineConfigurationControl } from './configuration-control';
import { EngineConfigurationError } from './configuration-error';
import { type ConfiguredAppOptions, prepareConfiguredApp } from './configuration-host';
import { createEngineConfigurationStore } from './configuration-store';
import type { HostDeviceFacts } from './configuration-types';
import { hostAudioBindingError } from './host-audio';

export type { BrowserFrameProgress } from './browser-frame-signal';
export type { AppHostAdapter } from './types';

import {
  measureCanvasDrawingBufferAtRatio,
  resetCanvasDeviceLimit,
  setCanvasDeviceLimit,
  syncCanvasDrawingBuffer,
} from './canvas-sizing';

export { measureCanvasDrawingBuffer, syncCanvasDrawingBuffer } from './canvas-sizing';

import { APP_ERROR_HINTS, APP_EXPECTED, type AppError, makeAppError } from './errors';
import { normalizeExecutionBootstrapUrl } from './execution/bootstrap-url';
import { probeExecutionCapabilities } from './execution/capabilities';
import { installCarriedGpuStub } from './execution/gpu-stub';
import { createWorkerExecutionApp } from './execution/host-controller';
import { selectExecutionWorkers } from './execution/selector';
import type { ExecutionCapabilities, ExecutionSelection } from './execution/types';
import { createIdempotentRelease } from './internal/browser-bridge-release';
import type {
  App,
  AppHostAdapter,
  BrowserRemoteBridgeAdapter,
  BundlerOptions,
  CanvasAppError,
  CreateAppOptions,
  ExecutionApp,
} from './types';

function validateResourceBudgets(opts: CreateAppOptions | undefined): void {
  if (opts?.assetBudgetBytes !== undefined) validateAssetBudgetBytes(opts.assetBudgetBytes);
  if (opts?.textureMipSkip !== undefined) assertTextureMipSkip(opts.textureMipSkip);
}

/**
 * createApp(canvas, opts?, bundler?) -- canvas thin wrapper SSOT (per
 * plan-strategy D-5). Resolves with Result.ok(app) on success; failure routes
 * through AppError | RhiError | EngineEnvironmentError per requirements AC-01.
 *
 * feat-20260608-create-app-param-surface-trim / M2 / D-3: the third arg is
 * `AppHostAdapter` -- renderer construction uses its `BundlerOptions` fields,
 * while optional host capabilities stay at the App boundary. Hosts pass
 * `forgeaxBundlerAdapter()` from `virtual:forgeax/bundler` as the third arg.
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
 * @see {@link https://github.com/ForgeAX/forgeax-engine/blob/main/docs/how-to/2026-06-18-host-engine-contract.md | Host-engine contract SSOT}
 */
export function createApp(
  canvas: HTMLCanvasElement,
  opts: CreateAppOptions & { readonly execution: NonNullable<CreateAppOptions['execution']> },
  bundler?: AppHostAdapter,
): Promise<Result<ExecutionApp, CanvasAppError>>;

export function createApp(
  canvas: HTMLCanvasElement,
  opts?: CreateAppOptions,
  bundler?: AppHostAdapter,
): Promise<Result<App, CanvasAppError>>;

export async function createApp(
  canvas: HTMLCanvasElement,
  opts?: CreateAppOptions,
  bundler?: AppHostAdapter,
): Promise<Result<App | ExecutionApp, CanvasAppError>> {
  if (!canvas.isConnected) return createConfiguredBrowserApp(canvas, opts, bundler);
  const audioBindingFailure = hostAudioBindingError(opts, bundler);
  if (audioBindingFailure !== undefined) return err(audioBindingFailure);
  const host =
    bundler?.configurationHost ??
    createBrowserConfigurationHost(globalThis.location?.pathname ?? '/');
  const prepared = await prepareConfiguredApp(opts, host);
  if (!prepared.ok) return prepared;
  const startup = prepared.value?.startup;
  if (startup === undefined || opts?.configuration === undefined)
    return createConfiguredBrowserApp(canvas, prepared.value, bundler);
  let app: App | ExecutionApp | undefined;
  const control = createEngineConfigurationControl(opts.configuration, startup, {
    ...(host.store === undefined ? {} : { store: host.store }),
    apply: async (plan) => {
      const current = app;
      if (current === undefined)
        return err(
          new EngineConfigurationError('configuration-stale', {
            path: 'configuration',
            reason: 'App construction is incomplete',
          }),
        );
      const execution = current.execution as Partial<ConfiguredExecutionControl>;
      if (execution.applyConfiguration !== undefined)
        return execution.applyConfiguration(plan, control.inspect().applied.revision);
      return applyRenderConfiguration((current as App).renderer, plan);
    },
  });
  const result = await createConfiguredBrowserApp(
    canvas,
    { ...prepared.value, configurationObserver: control.observe },
    bundler,
  );
  if (!result.ok) {
    control.dispose();
    return result;
  }
  app = result.value;
  const dispose = app.dispose.bind(app);
  Object.assign(app, {
    configuration: control,
    dispose() {
      control.dispose();
      return dispose();
    },
  });
  return result;
}

/** An explicit stable project identity prevents saved choices leaking between generated projects. */
export function createBrowserConfigurationHost(
  projectId: string,
): import('./configuration-host').EngineConfigurationHost {
  const key = `forgeax:quality:${projectId}`;
  return {
    readDeviceFacts: browserDeviceFacts,
    store: createEngineConfigurationStore({
      read: () => globalThis.localStorage?.getItem(key),
      write: (bytes) => globalThis.localStorage?.setItem(key, bytes),
    }),
  };
}

function browserDeviceFacts(): HostDeviceFacts {
  const agent = globalThis.navigator?.userAgent ?? '';
  const platform = /iPhone|iPad|iPod/.test(agent)
    ? 'ios'
    : /Android/.test(agent)
      ? 'android'
      : /Windows/.test(agent)
        ? 'windows'
        : /Macintosh|Mac OS/.test(agent)
          ? 'macos'
          : /Linux/.test(agent)
            ? 'linux'
            : 'unknown';
  return { platform, runtime: 'browser' };
}

async function createConfiguredBrowserApp(
  canvas: HTMLCanvasElement,
  opts?: ConfiguredAppOptions,
  bundler?: AppHostAdapter,
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

  opts = ownAppPipelineInputs(opts);

  // The DOM canvas starts with a 300x150 drawing buffer even when CSS lays it
  // out at a different size. Set the physical buffer before the renderer
  // configures its swap chain; the same helper runs before each frame so a CSS
  // resize remains visible to both rendering and camera policy.
  // Programmer configuration: reject before any realm creates an AssetRegistry.
  validateResourceBudgets(opts);
  // Before capability probing and backend selection, so every ambient WebGPU
  // reader in this realm observes the same stub.
  installCarriedGpuStub(opts);
  // Diagnostic ablation is realm-wide and must apply before the first sizing.
  applyRenderAblationOption(opts?.renderAblation);
  resetCanvasDeviceLimit(canvas);
  syncCanvasDrawingBuffer(canvas, undefined, opts?.canvasPixelRatio);

  const execution = opts?.execution;
  const selected =
    execution === undefined || opts === undefined
      ? undefined
      : await selectBrowserExecution(canvas, opts, execution, bundler);
  if (selected !== undefined && !selected.ok) return err(selected.error);
  if (opts !== undefined && selected?.ok && selected.value.context.selection.engine.enabled)
    return startWorkerExecutionApp(canvas, opts, bundler, selected.value.context);

  const { createLocalBrowserApp } = await import('./browser-local');
  return createLocalBrowserApp(canvas, opts, bundler, selected?.value);
}

/** Install a diagnostic render ablation; invalid configuration is a programmer error. */
function applyRenderAblationOption(option: RenderAblation | string | undefined): void {
  if (option === undefined) return;
  const devtools = installRenderAblationDevtools();
  const applied = devtools.set(option);
  if (!applied.ok) throw applied.error;
}

export interface BrowserExecutionContext {
  readonly capabilities: ExecutionCapabilities;
  readonly selection: ExecutionSelection;
}

/** Reject host values that cannot be carried into the selected execution realm. */
function realmBoundExecutionOptionError(
  opts: CreateAppOptions,
  bundler: BundlerOptions | undefined,
  moduleUrl: string,
): AppError | undefined {
  const realmBoundOptions = [
    ['platform', opts.platform],
    ['features', opts.features],
    ['plugins', opts.plugins],
    ['pluginPrograms', opts.pluginPrograms],
    ['runtimePacks', opts.runtimePacks],
    ['rhi', opts.rhi],
    ['rhiInstrumentation', opts.rhiInstrumentation],
    ['gpuPassTiming', opts.gpuPassTiming],
    ['renderAblation', opts.renderAblation],
    ['shadowWorkload', opts.shadowWorkload],
    ['ssrIdentity', opts.ssrIdentity],
    ['captureReflectionFallbackReadback', opts.captureReflectionFallbackReadback],
    ['viewportOutput', opts.viewportOutput],
    ['sceneAdmission', opts.sceneAdmission],
    ['bundler.importTransport', bundler?.importTransport],
    ['bundler.readShaderManifest', bundler?.readShaderManifest],
  ] as const;
  const realmBoundOption = realmBoundOptions.find(([, value]) => value !== undefined)?.[0];
  if (realmBoundOption === undefined) return undefined;
  const hint =
    realmBoundOption === 'bundler.readShaderManifest'
      ? 'Set bundler.shaderManifestUrl to the manifest URL; a host reader callback cannot cross the execution realm boundary'
      : APP_ERROR_HINTS['app-execution-bootstrap-failed'];
  return makeAppError(
    'app-execution-bootstrap-failed',
    APP_EXPECTED['app-execution-bootstrap-failed'],
    hint,
    {
      phase: 'prepare',
      moduleUrl,
      realmBoundOption,
      cause: new TypeError(
        realmBoundOption === 'bundler.readShaderManifest'
          ? 'bundler.readShaderManifest is a host callback; provide bundler.shaderManifestUrl for the execution realm'
          : `${realmBoundOption} must be constructed by the execution bootstrap module`,
      ),
    },
  );
}

/** The selected Engine Worker owns the World; this realm only hosts its canvas. */
async function startWorkerExecutionApp(
  canvas: HTMLCanvasElement,
  opts: ConfiguredAppOptions,
  bundler: AppHostAdapter | undefined,
  context: BrowserExecutionContext,
): Promise<Result<ExecutionApp, CanvasAppError>> {
  const workerApp = await createWorkerExecutionApp({
    canvas,
    appOptions: opts,
    syncCanvas: (currentCanvas, display) =>
      measureCanvasDrawingBufferAtRatio(
        currentCanvas,
        opts.canvasPixelRatio,
        typeof currentCanvas.ownerDocument.defaultView?.ResizeObserver === 'function'
          ? display
          : undefined,
      ),
    renderDeviceLimit: setCanvasDeviceLimit,
    ...(bundler !== undefined ? { bundler } : {}),
    capabilities: context.capabilities,
    selection: context.selection,
  });
  if (!workerApp.ok || workerApp.value.remoteEval === undefined) return workerApp;
  const bridge = bundler?.browserRemoteBridge;
  if (bridge === undefined) return workerApp;
  return ok(await withBrowserExecutionBridge(workerApp.value, workerApp.value.remoteEval, bridge));
}

async function withBrowserExecutionBridge(
  workerExecutionApp: ExecutionApp,
  execute: NonNullable<ExecutionApp['remoteEval']>,
  bridge: BrowserRemoteBridgeAdapter,
): Promise<ExecutionApp> {
  const release = createIdempotentRelease(
    await bridge.installExecutionBridge({
      execute,
      readStatus: () => {
        const execution = workerExecutionApp.execution.report();
        return {
          worldIdentity: execution.world.identity,
          execution,
          workers: execution.workers,
        };
      },
      port: bridge.port,
      ...(workerExecutionApp.clearInput === undefined
        ? {}
        : { clearInput: workerExecutionApp.clearInput }),
      ...(workerExecutionApp.beginInputLease === undefined
        ? {}
        : { beginInputLease: workerExecutionApp.beginInputLease }),
      ...(workerExecutionApp.finishProfiler === undefined
        ? {}
        : { finishProfiler: workerExecutionApp.finishProfiler }),
    }),
  );
  bridge.registerDispose(release);
  // The worker path returns a realm-local App before the browser bridge
  // is installed. Tie the bridge to that App's existing lifecycle so a
  // stopped worker cannot leave a reconnecting socket behind.
  const stop = workerExecutionApp.stop;
  const dispose = workerExecutionApp.dispose;
  return {
    ...workerExecutionApp,
    stop: () => {
      const result = stop.call(workerExecutionApp);
      if (result.ok) release();
      return result;
    },
    dispose: async () => {
      try {
        return await dispose.call(workerExecutionApp);
      } finally {
        release();
      }
    },
  };
}

type CreateAppExecution = NonNullable<CreateAppOptions['execution']>;

/** Normalize the bootstrap, reject realm-bound options and select the execution Workers. */
async function selectBrowserExecution(
  canvas: HTMLCanvasElement,
  opts: ConfiguredAppOptions,
  execution: CreateAppExecution,
  bundler: AppHostAdapter | undefined,
): Promise<
  Result<
    { readonly bootstrapUrl: string; readonly context: BrowserExecutionContext },
    CanvasAppError
  >
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
    bundler?.workerScriptDelivery === 'embedded',
  );
  const selected = selectExecutionWorkers({
    workers: execution.workers ?? {},
    capabilities,
  });
  if (!selected.ok) return err(selected.error);
  if (!selected.value.engine.enabled && opts.startup?.settings.execution?.taskWorkers !== undefined)
    return err(
      new EngineConfigurationError('configuration-domain-unavailable', {
        path: 'settings.execution.taskWorkers',
        reason: 'the task dispatcher requires a selected Engine Worker',
      }),
    );
  return ok({ bootstrapUrl, context: { capabilities, selection: selected.value } });
}

function ownAppPipelineInputs(opts: CreateAppOptions | undefined): CreateAppOptions | undefined {
  if (opts === undefined) return undefined;
  return {
    ...opts,
    ...(opts.pipelineLibrary === undefined
      ? {}
      : { pipelineLibrary: ownPipelineLibrary(opts.pipelineLibrary) }),
    ...(opts.backgroundPipelineLibrary === undefined
      ? {}
      : { backgroundPipelineLibrary: ownPipelineLibrary(opts.backgroundPipelineLibrary) }),
  };
}

// Browser host capabilities share the browser entry without loading local rendering.
export { assembleAssetRuntime } from './asset-runtime-catalog';
export { EngineConfigurationError, withEngineSettings } from './configuration';
export { createRendererInspectionError } from './errors';
export { activateExecutionRoot } from './execution/project-root';
export { gameHostPlugin } from './game-context';
export { createBrowserGameSaves, createRecordGameSaves } from './game-saves';
export { assembleRuntimePacks } from './runtime-packs';
