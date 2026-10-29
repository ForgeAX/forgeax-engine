// Realm-neutral App assembly and frame/lifecycle ownership.
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { AudioBackend } from '@forgeax/engine-audio';
import type { DebugDraw } from '@forgeax/engine-debug-draw';
import { createWorldContext, type World } from '@forgeax/engine-ecs';
import type { InputBackend } from '@forgeax/engine-input';
import type { Platform } from '@forgeax/engine-platform';
import type { Context, Fiber, Plugin } from '@forgeax/engine-plugin';
import type { FrameReceipt, RenderError, Renderer, RenderFrameInput } from '@forgeax/engine-render';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { type AssetRuntimeAssembly, createAssetRuntimeAssembly } from './assets-runtime-assembly';
import type { AppErrorCode, AppErrorDetailFor } from './errors';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError } from './errors';
import {
  createExecutionFrameInspection,
  createExecutionReport,
  type ExecutionControl,
  type ExecutionFrameInspection,
  selectExecutionWorkers,
  unavailableExecutionCapabilities,
} from './execution';
import { createLocalExecutionControl } from './execution/control';
import { assembledEngineProfile } from './internal/assembled-engine-profile';
import { projectComponentIntrospection } from './internal/component-introspection';
import { ErrorFanoutRegistry } from './internal/error-fanout';
import { createFrameLoop } from './internal/frame-loop';
import { resolveRemoteServeFlag } from './internal/remote-serve-flag';
import { remoteServerPlugin } from './internal/remote-server-plugin';
import { bindRhiCaptureFrameDriver, type RhiCapture } from './internal/rhi-capture';
import { createAppObservation } from './observation';
import type { RuntimePackOptions } from './runtime-packs';
import type { App, AppAssembleArgs, AppDispatchError, AssembleAppError } from './types';

export function makeAppError<C extends AppErrorCode>(
  code: C,
  expected: string,
  hint: string,
  detail: AppErrorDetailFor<C>,
): AppError {
  return new AppError({ code, expected, hint, detail }) as AppError;
}

export interface FrameInspectionRef {
  current: () => ExecutionFrameInspection;
}

export function createFrameInspectionRef(): FrameInspectionRef {
  return { current: createExecutionFrameInspection };
}

export interface PluginProjectionBridge {
  current?: { readonly inspect: () => unknown };
  readonly inspect: () => unknown;
}

export async function startRemoteServer(
  world: World,
  renderer: Renderer,
  assets: AssetRegistry | undefined,
  rhiCapture: RhiCapture | undefined,
  profiler: import('@forgeax/engine-profiler').Profiler | undefined,
  execution: ExecutionControl,
  pluginContext: Context,
  imports: RuntimePackOptions['imports'],
  plugins?: unknown,
): Promise<{ readonly port: number; close(): Promise<void> } | undefined> {
  try {
    // A literal import is still pretransformed by Vite, even with @vite-ignore.
    // Keep this Node-only transport out of the browser's speculative module crawl.
    const specifier = '@forgeax/engine-remote/server';
    const remoteServerMod: typeof import('@forgeax/engine-remote/server') = await import(
      /* @vite-ignore */ specifier
    );
    const serverResult = await remoteServerMod.startServer({
      port: 0,
      host: '127.0.0.1',
      world,
      renderer,
      assets,
      introspection: projectComponentIntrospection(world.components.entries()),
      ...(rhiCapture !== undefined ? { rhiCapture } : {}),
      ...(profiler !== undefined ? { profiler } : {}),
      execution,
      simulation: { world, renderer, assets, pluginContext, rhiCapture, profiler, execution },
      importModule: (specifier) =>
        import(/* @vite-ignore */ imports?.[specifier]?.url ?? specifier),
      ...(plugins !== undefined ? { plugins } : {}),
    });
    if (serverResult.ok) return serverResult.value;
  } catch (_error) {
    // Dynamic import or server start failed; the app continues without remote.
  }
  return undefined;
}

export async function createAppFromAssemble(
  args: AppAssembleArgs,
): Promise<Result<App, AssembleAppError>> {
  const assetAssemblyRequested =
    args.assets !== undefined ||
    args.assetCatalog !== undefined ||
    args.assetDecoders !== undefined ||
    args.pluginPrograms !== undefined ||
    args.runtimePacks !== undefined ||
    args.assetRuntimeBinding !== undefined;
  let assetAssembly: AssetRuntimeAssembly | undefined;
  if (assetAssemblyRequested) {
    const assetAssemblyResult = createAssetRuntimeAssembly(args.assets, {
      ...(args.assets === undefined ? {} : { registry: args.assets }),
      ...(args.assetCatalog === undefined ? {} : { catalogSource: args.assetCatalog }),
      ...(args.assetDecoders === undefined ? {} : { decoderContributions: args.assetDecoders }),
      ...(args.assetRuntimeBinding === undefined
        ? {}
        : { runtimeBinding: args.assetRuntimeBinding }),
    });
    if (!assetAssemblyResult.ok) return err(assetAssemblyResult.error);
    assetAssembly = assetAssemblyResult.value;
  }
  const assets = assetAssembly?.registry ?? args.assets;
  let pluginContext: Context;
  try {
    pluginContext = await createWorldContext(
      args.world,
      assembledEngineProfile({
        renderer: args.renderer,
        ...(assets === undefined ? {} : { assets }),
        ...(assetAssembly === undefined ? {} : { assetAssembly }),
        ...(args.pluginPrograms === undefined ? {} : { pluginPrograms: args.pluginPrograms }),
        ...(args.runtimePacks === undefined ? {} : { runtimePacks: args.runtimePacks }),
        extensions: args.plugins ?? [],
      }),
    );
  } catch (cause) {
    assetAssembly?.dispose();
    return err(
      makeAppError(
        'app-plugin-activation-failed',
        APP_EXPECTED['app-plugin-activation-failed'],
        APP_ERROR_HINTS['app-plugin-activation-failed'],
        { cause },
      ),
    );
  }

  const shouldStartRemote = resolveRemoteServeFlag(
    undefined,
    (globalThis as { process?: { env?: { FORGEAX_ENGINE_REMOTE_SERVE?: string } } }).process?.env,
  );
  const assembledAudioBackend = pluginContext.audio;
  const frameInspection = createFrameInspectionRef();
  const executionControl = createLocalExecutionControl(
    createExecutionReport(
      unavailableExecutionCapabilities('local assembly'),
      selectExecutionWorkers({
        workers: { engine: false },
        capabilities: unavailableExecutionCapabilities('local assembly'),
      }).unwrap(),
      args.world.execution,
    ),
    {
      ...(assembledAudioBackend === undefined
        ? {}
        : { audio: () => assembledAudioBackend.getState() }),
      world: () => args.world.execution,
      frame: () => frameInspection.current(),
    },
  );
  const remoteHandle = shouldStartRemote
    ? await startRemoteServer(
        args.world,
        args.renderer,
        assets,
        args.rhiCapture,
        args.profiler,
        executionControl,
        pluginContext,
        args.runtimePacks?.imports,
      )
    : undefined;
  if (remoteHandle !== undefined) await pluginContext.plugin(remoteServerPlugin(remoteHandle));

  const buildArgs: BuildAppArgs = {
    platform: args.platform,
    installAppPlugin: async (plugin) => pluginContext.plugin(plugin),
    renderer: args.renderer,
    ...(assets === undefined ? {} : { assets }),
    world: args.world,
    pluginContext,
    executionControl,
    frameInspection,
    ...(args.onFrameSubmitted === undefined ? {} : { onFrameSubmitted: args.onFrameSubmitted }),
    ...(args.onFrameCompleted === undefined ? {} : { onFrameCompleted: args.onFrameCompleted }),
    ...(args.rhiCapture === undefined ? {} : { rhiCapture: args.rhiCapture }),
    ...(remoteHandle !== undefined ? { remoteHandle } : {}),
  };

  const assembledInputBackend = pluginContext.input;
  if (assembledInputBackend !== undefined) {
    Object.assign(buildArgs, {
      inputBackend: assembledInputBackend,
    });
  }
  if (assembledAudioBackend !== undefined) {
    Object.assign(buildArgs, {
      audioBackend: assembledAudioBackend,
    });
  }
  if (args.silenceUnhandledErrors !== undefined) {
    Object.assign(buildArgs, { silenceUnhandledErrors: args.silenceUnhandledErrors });
  }
  // M2 / D-3: assemble form forwards the host-supplied draw-source pull.
  if (args.drawSource !== undefined) {
    Object.assign(buildArgs, { drawSource: args.drawSource });
  }
  if (args.profiler !== undefined) {
    Object.assign(buildArgs, { profiler: args.profiler });
  }
  const built = await buildApp(buildArgs);
  if (!built.ok) await pluginContext.fiber.dispose();
  return built;
}

export interface BuildAppArgs {
  readonly geometryLane?: RenderFrameInput['geometryLane'] | undefined;
  readonly installAppPlugin: (plugin: Plugin) => Promise<Fiber>;
  readonly platform: Platform;
  readonly renderer: Renderer;
  readonly assets?: AssetRegistry | undefined;
  readonly world: World;
  readonly pluginContext: Context;
  readonly disposePluginContext?: () => Promise<void>;
  readonly inputBackend?: InputBackend | undefined;
  /**
   * M2 D-4: callback that buildApp calls after creating the ErrorFanoutRegistry
   * dispatch function. The input handle's onLockError callback needs the dispatch
   * function to fan out 'app-pointer-lock-failed' errors, but the dispatch function
   * is created inside buildApp (after the input handle is already constructed).
   * This callback bridges the gap.
   */
  readonly wireOnLockErrorDispatch?: ((dispatch: (err: AppError) => void) => void) | undefined;
  readonly audioBackend?: AudioBackend | undefined;
  readonly silenceUnhandledErrors?: boolean | undefined;
  /** Optional App-owned RHI capture capability. */
  readonly rhiCapture?: RhiCapture | undefined;
  /** feat-20260615 debug-draw M5: DebugDraw instance created by createDebugDrawOnReady. */
  readonly debugDraw?: DebugDraw | undefined;
  /** feat-20260629 M4 / w20: remote eval server handle from createAppFromCanvas. */
  readonly remoteHandle?: { readonly port: number; close(): Promise<void> } | undefined;
  /**
   * feat-20260709-editor-world-partition-editorworld-super-composite / M2 / D-3:
   * per-frame draw-source pull forwarded verbatim into the frame-loop. Absent =>
   * the allocation-free primary-World path. Both createApp forms (canvas + assemble) forward
   * it from their respective options object.
   */
  readonly drawSource?: import('./types').DrawSource | undefined;
  readonly profiler?: import('@forgeax/engine-profiler').Profiler | undefined;
  readonly executionControl?: import('./execution/control').LocalExecutionControl;
  /** Mutable indirection lets the pre-loop execution control observe its owner. */
  readonly frameInspection?: FrameInspectionRef;
  /** Canvas-form projection of the Renderer frame-submitted event. */
  readonly onFrameSubmitted?: (event: {
    readonly frameId: number;
    readonly deviceGeneration: number;
    readonly graphGeneration?: number;
    readonly receipt: FrameReceipt;
    readonly barrelDistortion?: import('@forgeax/engine-render').BarrelDistortionMapping;
    readonly worldIdentity?: string;
  }) => void;
  /** Canvas-form projection after the receipt's completion Result succeeds. */
  readonly onFrameCompleted?: (event: {
    readonly frameId: number;
    readonly deviceGeneration: number;
    readonly presentation: import('@forgeax/engine-render').FramePresentation;
    readonly presentationPendingReason?: import('@forgeax/engine-render').FramePresentationPendingReason;
    readonly worldIdentity?: string;
    readonly barrelDistortion?: import('@forgeax/engine-render').BarrelDistortionMapping;
  }) => void;
}

/**
 * Internal builder shared by both overloads. Wires the frame-loop +
 * listener-registry onError and returns the App handle. Effectful ownership
 * has already moved into pluginContext before this boundary runs.
 */
export async function buildApp(args: BuildAppArgs): Promise<Result<App, AppError | RhiError>> {
  const {
    renderer,
    assets,
    world,
    pluginContext,
    inputBackend,
    audioBackend,
    silenceUnhandledErrors,
    rhiCapture,
    debugDraw,
    remoteHandle,
    profiler,
  } = args;
  const frameInspection = args.frameInspection ?? createFrameInspectionRef();

  // Physics is a Context service; the App exposes the active provider without
  // storing a second mutable slot.
  function readPhysicsWorld():
    | import('@forgeax/engine-physics').PhysicsWorld
    | import('@forgeax/engine-physics').PhysicsWorld2D
    | undefined {
    return pluginContext.get('physics');
  }
  // M4 (w11): listener registry replaces the M3 inline Set so console.error
  // fallback + duplicate-add no-op + unsubscribe handle behaviour matches
  // packages/runtime/src/createRenderer.ts:532-566 LostListenerRegistry
  // (plan-strategy D-9). silenceUnhandledErrors threads through verbatim.
  const fanout = new ErrorFanoutRegistry(
    silenceUnhandledErrors !== undefined ? { silenceUnhandledErrors } : {},
  );
  let lastError: AppDispatchError | undefined;
  const execution =
    args.executionControl ??
    createLocalExecutionControl(
      createExecutionReport(
        unavailableExecutionCapabilities('local assembly'),
        selectExecutionWorkers({
          workers: { engine: false },
          capabilities: unavailableExecutionCapabilities('local assembly'),
        }).unwrap(),
        world.execution,
      ),
      {
        ...(audioBackend === undefined ? {} : { audio: () => audioBackend.getState() }),
        world: () => world.execution,
        frame: () => frameInspection.current(),
      },
    );

  function dispatch(e: AppDispatchError): void {
    lastError = e;
    fanout.fire(e);
  }

  // M2 D-4: wire the input handle's onLockError callback to the error fan-out.
  // The dispatch function is created here; the input handle was created earlier
  // in createAppFromCanvas and passed to buildApp with a wireOnLockErrorDispatch
  // callback that calls setOnErrorDispatch on the handle.
  if (args.wireOnLockErrorDispatch) {
    args.wireOnLockErrorDispatch(dispatch);
  }

  const observation = createAppObservation(world, renderer, execution);
  const captureSubmittedListeners = new Set<(receipt: FrameReceipt) => void>();
  const loopOpts: Parameters<typeof createFrameLoop>[0] = {
    world,
    renderer,
    platform: args.platform,
    onError: dispatch,
    onStateChange: (state) =>
      execution.setEngineHealth(state === 'running' || state === 'stopped' ? state : 'idle'),
    beforeDraw: observation.prepareFrame,
    pacer: execution.framePacer,
    ...(args.geometryLane === undefined ? {} : { geometryLane: args.geometryLane }),
  };
  if (args.onFrameSubmitted !== undefined || rhiCapture !== undefined) {
    Object.assign(loopOpts, {
      onSubmitted: (receipt: FrameReceipt) => {
        for (const listener of captureSubmittedListeners) listener(receipt);
        args.onFrameSubmitted?.({
          frameId: receipt.frameId,
          deviceGeneration: receipt.deviceGeneration,
          ...(receipt.shadowWorkload === undefined
            ? {}
            : { shadowWorkload: receipt.shadowWorkload }),
          ...(receipt.graphGeneration === undefined
            ? {}
            : { graphGeneration: receipt.graphGeneration }),
          receipt,
          ...(receipt.barrelDistortion === undefined
            ? {}
            : { barrelDistortion: receipt.barrelDistortion }),
          worldIdentity: world.identity,
        });
      },
    });
  }
  if (args.onFrameCompleted !== undefined) {
    Object.assign(loopOpts, {
      onCompleted: (receipt: FrameReceipt) =>
        args.onFrameCompleted?.({
          frameId: receipt.frameId,
          deviceGeneration: receipt.deviceGeneration,
          ...(receipt.shadowWorkload === undefined
            ? {}
            : { shadowWorkload: receipt.shadowWorkload }),
          // A receipt produced by the current Render contract always carries
          // presentation. If a legacy adapter omits it, do not turn an
          // unproven frame into startup success.
          presentation: receipt.presentation ?? 'pending',
          ...(receipt.barrelDistortion === undefined
            ? {}
            : { barrelDistortion: receipt.barrelDistortion }),
          ...(receipt.presentation !== 'pending' || receipt.presentationPendingReason === undefined
            ? {}
            : { presentationPendingReason: receipt.presentationPendingReason }),
          worldIdentity: world.identity,
        }),
    });
  }
  // M2 / D-3: forward the optional draw-source pull into the frame-loop. Absent
  // => the loop keeps the allocation-free primary-World draw path.
  if (args.drawSource !== undefined) {
    Object.assign(loopOpts, { drawSource: args.drawSource });
  }
  if (profiler !== undefined) {
    Object.assign(loopOpts, { profiler });
  }
  const loop = createFrameLoop(loopOpts);
  let resumeAfterHostShow = false;
  frameInspection.current = loop.inspect;
  if (rhiCapture !== undefined) {
    bindRhiCaptureFrameDriver(rhiCapture, {
      subscribeSubmitted(listener) {
        captureSubmittedListeners.add(listener);
        return () => captureSubmittedListeners.delete(listener);
      },
      getState: () => loop.getState(),
      pause: () => {
        const result = loop.pause();
        if (result.ok) execution.setEngineHealth('idle');
        return result;
      },
      resume: () => {
        const result = loop.resume();
        if (result.ok) execution.setEngineHealth('running');
        return result;
      },
      stepFrame: (deltaSeconds) => loop.stepFrame(deltaSeconds),
    });
  }
  // M4 (w13) device-lost internal subscription. R-1 timing contract:
  // app.start() arms the rAF handle BEFORE this listener subscribes, so
  // a synchronous late-attach replay of a persisted device-lost event
  // (LostListenerRegistry replay -- runtime/src/renderer.ts:337-345)
  // hits a frame-loop with a real rAF handle to cancel (M2 setStopped
  // tolerates pendingFrameId === 0 as a no-op so even pre-rAF replays
  // do not NPE). The subscription remains active across pause / resume;
  // unsubscribe runs only on stop / disposal (charter P3:
  // device-lost is a terminal lifecycle signal, not a transient blip).
  let rendererUnsubscribe: (() => void) | undefined;
  let resumeAfterSurfaceRestore = false;
  let surfaceSuspended = false;

  function resumeWhenAvailable(): Result<void, AppError> {
    if (loop.getState() === 'paused') {
      if (surfaceSuspended) {
        resumeAfterSurfaceRestore = true;
        return ok(undefined);
      }
      if (args.platform.visible() === false) {
        resumeAfterHostShow = true;
        return ok(undefined);
      }
    }
    return loop.resume();
  }

  function subscribeRendererErrors(): void {
    if (rendererUnsubscribe !== undefined) {
      return;
    }
    rendererUnsubscribe = renderer.subscribe((event) => {
      if (event.kind === 'frame-submitted') return;
      if (event.kind !== 'error') return;
      const e: RenderError = event.error;
      dispatch(e);
    });
  }

  function unsubscribeRendererErrors(): void {
    if (rendererUnsubscribe !== undefined) {
      rendererUnsubscribe();
      rendererUnsubscribe = undefined;
    }
  }

  const stub: App = {
    renderer,
    ...(assets === undefined ? {} : { assets }),
    world,
    execution,
    observation,
    async releaseSurfacePreserveWorld(): Promise<Result<void, RhiError | RenderError>> {
      if (loop.getState() === 'running') {
        const paused = loop.pause();
        if (!paused.ok) {
          return err(
            new RhiError({
              code: 'rhi-not-available',
              expected: 'running App pauses before releasing its presentation surface',
              hint: paused.error.hint,
            }),
          );
        }
        resumeAfterSurfaceRestore = true;
        execution.setEngineHealth('idle');
      }
      if (resumeAfterHostShow) {
        resumeAfterSurfaceRestore = true;
        resumeAfterHostShow = false;
      }
      surfaceSuspended = true;
      // A surface handoff can be requested by an Update system while the
      // current frame is still in progress. Let that frame reach renderer.draw
      // before unconfiguring the surface; pause() only cancels the next rAF.
      await Promise.resolve();
      // A submitted frame may still use the presentation surface. Wait for its
      // completion before unconfiguring that surface.
      await loop.drainFrameReceipts();
      const released = renderer.releaseSurface();
      if (!released.ok) {
        surfaceSuspended = false;
        if (resumeAfterSurfaceRestore) {
          resumeAfterSurfaceRestore = false;
          const resumed = resumeWhenAvailable();
          if (!resumed.ok) dispatch(resumed.error);
        }
      }
      return released.ok ? ok(undefined) : err(released.error);
    },
    async restoreSurface(): Promise<Result<void, RhiError | RenderError>> {
      const restored = renderer.restoreSurface();
      if (!restored.ok) return err(restored.error);
      surfaceSuspended = false;
      if (resumeAfterSurfaceRestore) {
        resumeAfterSurfaceRestore = false;
        const resumed = resumeWhenAvailable();
        if (!resumed.ok) {
          return err(
            new RhiError({
              code: 'rhi-not-available',
              expected: 'paused App resumes after restoring its presentation surface',
              hint: resumed.error.hint,
            }),
          );
        }
      }
      return ok(undefined);
    },
    pluginContext,
    ...(inputBackend !== undefined ? { input: inputBackend } : {}),
    ...(audioBackend !== undefined ? { audio: audioBackend } : {}),
    get physics():
      | import('@forgeax/engine-physics').PhysicsWorld
      | import('@forgeax/engine-physics').PhysicsWorld2D
      | undefined {
      return readPhysicsWorld();
    },
    start(): Result<void, AppError> {
      // R-1: arm the rAF handle FIRST (loop.start schedules raf(tick))
      // and only THEN subscribe to renderer events. If the renderer
      // late-attach replays a persisted device-lost event during the
      // subscribe call, the loop is already armed and can retain the error.
      const r = loop.start();
      if (r.ok) {
        execution.setEngineHealth('running');
        subscribeRendererErrors();
        if (surfaceSuspended || args.platform.visible() === false) {
          if (surfaceSuspended) resumeAfterSurfaceRestore = true;
          else resumeAfterHostShow = true;
          const paused = loop.pause();
          if (!paused.ok) return paused;
          inputBackend?.clear?.();
          execution.setEngineHealth('idle');
        }
      }
      return r;
    },
    stop(): Result<void, AppError> {
      resumeAfterHostShow = false;
      resumeAfterSurfaceRestore = false;
      const r = loop.stop();
      if (loop.getState() === 'stopped') {
        observation.release();
        execution.setEngineHealth('stopped');
      }
      unsubscribeRendererErrors();
      return r;
    },
    async dispose(): Promise<Result<void, AppError>> {
      resumeAfterHostShow = false;
      resumeAfterSurfaceRestore = false;
      const state = loop.getState();
      const stopped = state === 'running' || state === 'paused' ? loop.stop() : ok(undefined);
      if (state === 'idle') loop.setStopped();
      await loop.drainFrameReceipts();
      await (args.disposePluginContext?.() ?? pluginContext.fiber.dispose());
      observation.release();
      unsubscribeRendererErrors();
      execution.setEngineHealth('stopped');
      return stopped;
    },
    pause(): Result<void, AppError> {
      resumeAfterHostShow = false;
      resumeAfterSurfaceRestore = false;
      const r = loop.pause();
      if (loop.getState() === 'paused') execution.setEngineHealth('idle');
      return r;
    },
    resume(): Result<void, AppError> {
      return resumeWhenAvailable();
    },
    stepFrame(deltaSeconds, options): Result<void, AppDispatchError> {
      return loop.stepFrame(deltaSeconds, options?.render ?? true);
    },
    onError(cb: (e: AppDispatchError) => void): () => void {
      return fanout.add(cb);
    },
    setDrawSource(drawSource): void {
      loop.setDrawSource(drawSource);
    },
    /**
     * Most recent dispatched error retained for host self-inspection.
     */
    get lastError(): AppDispatchError | undefined {
      return lastError;
    },
    ...(rhiCapture !== undefined ? { rhiCapture } : {}),
    ...(debugDraw !== undefined ? { debugDraw } : {}),
    ...(remoteHandle !== undefined ? { remote: remoteHandle } : {}),
  };

  {
    const subscribed = args.platform.subscribe((event) => {
      // Native events can arrive while stopped App resources are still draining.
      if (loop.getState() === 'stopped') return;
      if (event.kind === 'visibility') {
        if (!event.visible) {
          inputBackend?.clear?.();
          if (loop.getState() === 'running') {
            resumeAfterHostShow = true;
            const paused = loop.pause();
            execution.setEngineHealth('idle');
            if (!paused.ok) dispatch(paused.error);
          }
        } else if (resumeAfterHostShow) {
          inputBackend?.clear?.();
          resumeAfterHostShow = false;
          if (loop.getState() === 'paused') {
            const resumed = resumeWhenAvailable();
            if (!resumed.ok) dispatch(resumed.error);
          }
        }
      } else if (event.kind === 'memory-pressure') {
        assets?.trimReadCache();
      } else if (event.kind === 'surface-lost') {
        resumeAfterHostShow = false;
        resumeAfterSurfaceRestore = false;
        if (loop.getState() === 'running') loop.pause();
        execution.setEngineHealth('idle');
        dispatch(
          makeAppError(
            'app-system-update-failed',
            'the host display remains available for frame submission',
            'inspect the native surface failure and recover its owning Renderer before resuming',
            { cause: event.cause },
          ),
        );
      }
    });
    if (!subscribed.ok) {
      loop.setStopped();
      observation.release();
      return err(
        makeAppError(
          'app-system-update-failed',
          'the host lifecycle subscription is acquired before App start',
          'inspect detail.cause and recreate the native host lease',
          { cause: subscribed.error },
        ),
      );
    }
    await args.installAppPlugin({
      name: 'platform-events',
      apply(ctx) {
        ctx.effect(() => subscribed.value, 'app/platform-events');
      },
    });
  }
  return ok(stub);
}
