import { createHostAudioConsumer, type HostAudioConsumer } from '@forgeax/engine-audio-webaudio';
import { attachBrowserInputBackend, type InputBackend } from '@forgeax/engine-input';
import {
  type DisplayFacts,
  type PlatformEvent,
  type PlatformRelease,
  releasePlatformResources,
} from '@forgeax/engine-platform';
import { createBrowserPlatform } from '@forgeax/engine-platform-browser';
import { beginLoadTimeline, err, ok, type Result } from '@forgeax/engine-types';
import {
  publishBrowserFrameCompleted,
  publishBrowserFrameSubmitted,
  resetBrowserFrameProgress,
} from '../browser-frame-signal';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError, type AppError as AppErrorType } from '../errors';
import { ErrorFanoutRegistry } from '../internal/error-fanout';
import { browserInputOptions } from '../internal/input-attach';
import type { AppStepFrameOptions, BundlerOptions, CanvasDrawingBufferSize } from '../types';
import {
  APP_PHASE_CATALOG,
  type AppDispatchError,
  type CreateAppOptions,
  type ExecutionApp,
} from '../types';
import { normalizeExecutionBootstrapUrl } from './bootstrap-url';
import { cloneExecutionReport } from './control';
import { emitExecutionDiagnostic, executionDiagnosticSink } from './diagnostic-events';
import { type EngineWorkerSession, startEngineWorker } from './engine-worker';
import { forwardGpuStub } from './gpu-stub';
import { createMeasurementSeries } from './measurement';
import {
  type EngineToHostMessage,
  type ExecutionFaultMessage,
  type ExecutionFrameMessage,
  FrameCreditLedger,
} from './protocol';
import { createExecutionReport, executionAudioReport } from './report';
import type {
  ExecutionCapabilities,
  ExecutionControl,
  ExecutionReport,
  ExecutionSelection,
} from './types';

function forwardPipelineLibraries(
  options: CreateAppOptions,
): Pick<CreateAppOptions, 'pipelineLibrary' | 'backgroundPipelineLibrary'> {
  return {
    ...(options.pipelineLibrary === undefined ? {} : { pipelineLibrary: options.pipelineLibrary }),
    ...(options.backgroundPipelineLibrary === undefined
      ? {}
      : { backgroundPipelineLibrary: options.backgroundPipelineLibrary }),
  };
}

export interface CreateWorkerExecutionAppOptions {
  readonly canvas: HTMLCanvasElement;
  readonly appOptions: CreateAppOptions;
  /** Host-owned resize policy applied before each frame sent to the worker. */
  readonly syncCanvas?: (
    canvas: HTMLCanvasElement,
    display: DisplayFacts | undefined,
  ) => CanvasDrawingBufferSize;
  readonly bundler?: BundlerOptions;
  readonly capabilities: ExecutionCapabilities;
  readonly selection: ExecutionSelection;
}

/** One Engine Worker reply variant, selected by its closed `kind`. */
type HostMessage<K extends EngineToHostMessage['kind']> = Extract<
  EngineToHostMessage,
  { readonly kind: K }
>;

function lifecycleError(code: 'app-not-started' | 'app-already-running'): AppErrorType {
  return new AppError({
    code,
    expected: APP_EXPECTED[code],
    hint: APP_ERROR_HINTS[code],
    detail: {},
  });
}

function runtimeError(message: ExecutionFaultMessage): AppErrorType {
  if (message.code === 'shared-kernel-failed' && message.worldIdentity !== null) {
    return new AppError({
      code: 'app-execution-kernel-failed',
      expected: APP_EXPECTED['app-execution-kernel-failed'],
      hint: APP_ERROR_HINTS['app-execution-kernel-failed'],
      detail: {
        kernelName: (message.detail as { kernelName?: string })?.kernelName ?? 'unknown',
        worldIdentity: message.worldIdentity,
        cause: message.detail,
      },
    });
  }
  return new AppError({
    code: 'app-system-update-failed',
    expected: APP_EXPECTED['app-system-update-failed'],
    hint: APP_ERROR_HINTS['app-system-update-failed'],
    detail: { cause: message.detail },
  });
}

function platformError(cause: unknown): AppErrorType {
  return new AppError({
    code: 'app-system-update-failed',
    expected: 'native browser host facts and frame scheduling remain available',
    hint: 'inspect detail.cause and restore the canvas Window before recreating the App',
    detail: { cause },
  });
}

function releaseAfterFailure(cause: unknown, release: () => void): void {
  try {
    release();
  } catch (cleanupCause) {
    throw new AggregateError([cause, cleanupCause], 'Worker Host operation and cleanup failed', {
      cause,
    });
  }
}

export async function createWorkerExecutionApp(
  options: CreateWorkerExecutionAppOptions,
): Promise<Result<ExecutionApp, AppErrorType>> {
  const executionOptions = options.appOptions.execution;
  if (executionOptions === undefined) throw new Error('execution options are required');
  const normalizedBootstrap = normalizeExecutionBootstrapUrl(executionOptions.bootstrap);
  if (!normalizedBootstrap.ok) return normalizedBootstrap;
  const bootstrapUrl = normalizedBootstrap.value;
  const binding = options.appOptions.assetRuntimeBinding;
  const assetCatalog =
    executionOptions.assetCatalog ??
    (binding === undefined
      ? undefined
      : {
          url: binding.catalogUrl,
          expectedScope: { scopeId: binding.scopeId, generation: binding.generation },
          runtimeBinding: binding,
        });
  const startupTimeoutMs =
    executionOptions.startupTimeoutMs === undefined ? 10_000 : executionOptions.startupTimeoutMs;
  const frameTimeoutMs =
    executionOptions.frameTimeoutMs === undefined ? 2_000 : executionOptions.frameTimeoutMs;
  const syncCanvas = options.syncCanvas;
  let canvas = options.canvas;
  const initialPlatform = createBrowserPlatform(canvas);
  if (!initialPlatform.ok) return err(platformError(initialPlatform.error));
  let platform = initialPlatform.value;
  let releasePlatformEvents: PlatformRelease | undefined;
  let display: DisplayFacts | undefined;
  let renderEpoch = 1;
  let lastSurfaceRequestId = 0;
  let started: Awaited<ReturnType<typeof startEngineWorker>>;
  // Main-realm view of Worker boot: spawn, module load, realm creation and ready.
  const endWorkerBoot = beginLoadTimeline('boot', 'engine-worker');
  try {
    resetBrowserFrameProgress(canvas);
    started = await startEngineWorker({
      canvas: canvas,
      bootstrapUrl,
      ...(executionOptions.bootstrapData === undefined
        ? {}
        : { bootstrapData: executionOptions.bootstrapData }),
      ...(executionOptions.bootstrapPort === undefined
        ? {}
        : { bootstrapPort: executionOptions.bootstrapPort }),
      ...(assetCatalog === undefined ? {} : { assetCatalog }),
      ...(options.bundler?.shaderManifestUrl !== undefined
        ? { shaderManifestUrl: options.bundler.shaderManifestUrl }
        : {}),
      ...(options.bundler?.build !== undefined ? { build: options.bundler.build } : {}),
      ...(options.appOptions.time !== undefined ? { time: options.appOptions.time } : {}),
      ...(options.appOptions.animation === undefined
        ? {}
        : { animation: options.appOptions.animation }),
      ...(executionOptions.diagnostics === undefined
        ? {}
        : { diagnostics: executionOptions.diagnostics }),
      ...forwardGpuStub(options.appOptions),
      ...forwardPipelineLibraries(options.appOptions),
      ...(options.appOptions.outputColorSpace === undefined
        ? {}
        : { outputColorSpace: options.appOptions.outputColorSpace }),
      ...(options.appOptions.dynamicGeometryMeshBudgetBytes === undefined
        ? {}
        : { dynamicGeometryMeshBudgetBytes: options.appOptions.dynamicGeometryMeshBudgetBytes }),
      ...(options.appOptions.assetBudgetBytes === undefined
        ? {}
        : { assetBudgetBytes: options.appOptions.assetBudgetBytes }),
      timeoutMs: startupTimeoutMs,
      workers: options.selection,
    });
  } catch (cause) {
    releaseAfterFailure(cause, () => platform.dispose());
    throw cause;
  }
  endWorkerBoot(undefined, { ok: started.ok });
  if (!started.ok) {
    releaseAfterFailure(started.error, () => platform.dispose());
    return started;
  }

  const session: EngineWorkerSession = started.value;
  const profiler = options.appOptions.profiler;
  const phaseCatalogRegistration = profiler?.registerPhaseCatalog('app', APP_PHASE_CATALOG);
  let releasePhaseCatalog =
    phaseCatalogRegistration?.ok === true ? phaseCatalogRegistration.value : undefined;
  const fanout = new ErrorFanoutRegistry(
    options.appOptions.silenceUnhandledErrors === undefined
      ? {}
      : { silenceUnhandledErrors: options.appOptions.silenceUnhandledErrors },
  );
  const attachInput = () =>
    options.appOptions.input === undefined
      ? attachBrowserInputBackend(canvas, {
          ...browserInputOptions(options.appOptions),
          onLockError: (detail) =>
            fanout.fire(
              new AppError({
                code: 'app-pointer-lock-failed',
                expected: APP_EXPECTED['app-pointer-lock-failed'],
                hint: APP_ERROR_HINTS['app-pointer-lock-failed'],
                detail,
              }),
            ),
        })
      : undefined;
  // The game commands the pointer-lock gate once and the startup owner the
  // input gate; a replacement canvas gets a fresh backend whose gates default
  // to open, so both commands must survive it.
  let pointerLockAllowed = true;
  let inputAllowed = true;
  const attachGatedInput = () => {
    const handle = attachInput();
    if (!pointerLockAllowed) handle?.backend.setPointerLockAllowed?.(false);
    if (!inputAllowed) handle?.backend.setInputAllowed?.(false);
    return handle;
  };
  let inputHandle = attachGatedInput();
  const physicalInput: InputBackend = {
    sample: () => {
      if (inputHandle === undefined) throw new Error('Host input was detached');
      return inputHandle.backend.sample();
    },
    clear: () => inputHandle?.backend.clear?.(),
    setPointerLockAllowed: (allowed) => {
      pointerLockAllowed = allowed;
      inputHandle?.backend.setPointerLockAllowed?.(allowed);
    },
    setInputAllowed: (allowed) => {
      inputAllowed = allowed;
      inputHandle?.backend.setInputAllowed?.(allowed);
    },
    detach: () => inputHandle?.backend.detach(),
  };
  // Resolve the decorator lazily so lightweight test hosts that provide only
  // the physical browser backend remain valid; production input exports it.
  let compositeFactory: typeof import('@forgeax/engine-input').makeCompositeBackend | undefined;
  try {
    const inputModule = (await import(
      '@forgeax/engine-input'
    )) as typeof import('@forgeax/engine-input');
    compositeFactory = inputModule.makeCompositeBackend;
  } catch {
    // Minimal test hosts may intentionally expose only the physical backend.
  }
  const input: InputBackend = options.appOptions.input ??
    (inputHandle === undefined
      ? undefined
      : typeof compositeFactory === 'function'
        ? compositeFactory(physicalInput)
        : physicalInput) ?? {
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
      detach: () => {},
    };

  // The Worker owns its own synthetic-input state.  A bridge disconnect can
  // therefore revoke that state without closing the browser or terminating
  // the Worker; the next admitted frame observes the release edges.
  const clearWorkerInput = (): void => {
    try {
      session.post({ kind: 'input-clear' });
    } catch {
      // The session is already terminal; there is no live Worker state left.
    }
  };
  const beginWorkerInputLease = (): void => {
    try {
      session.post({ kind: 'input-lease-open' });
    } catch {
      // The session is already terminal; no future lease can be admitted.
    }
  };
  const finishWorkerProfiler = (expected?: {
    readonly worldIdentity?: string;
    readonly captureId?: string;
  }): void => {
    try {
      session.post({ kind: 'profile-finish', ...(expected ?? {}) });
    } catch {
      // Diagnostic cleanup is best effort and never changes App lifecycle.
    }
  };
  const clearHostInjectedInput = (): void => {
    if (inputHandle === undefined) return;
    const value = input as {
      revokeInjectedLease?: () => void;
      clearInjected?: () => void;
    };
    value.revokeInjectedLease?.();
    if (value.revokeInjectedLease === undefined) value.clearInjected?.();
  };

  const initialReport = createExecutionReport(options.capabilities, options.selection);
  let report: ExecutionReport = {
    ...initialReport,
    ...(options.selection.render.enabled
      ? { render: { epoch: 1, state: 'alive' as const, submittedFrame: 0, completedFrame: 0 } }
      : {}),
    world: { ...initialReport.world, identity: session.ready.worldIdentity },
  };
  let state: 'idle' | 'running' | 'paused' | 'stopped' | 'faulted' = 'idle';
  let ledger = new FrameCreditLedger(session.ready.worldIdentity);
  let cancelHostFrame: PlatformRelease | undefined;
  // One due browser tick can wait for Worker credit without another refresh wait.
  let frameDue = false;
  let lastTimestamp: number | undefined;
  // A pre-pause completion cannot acknowledge the next frame's history reset.
  let temporalResetAfterFrame: number | undefined;
  let resumeAfterHostShow = false;
  let frameDeadline: ReturnType<typeof setTimeout> | undefined;
  type FrameAdmission = {
    readonly session: EngineWorkerSession;
    readonly worldIdentity: string;
    readonly frameId: number;
  };
  let frameAdmission: FrameAdmission | undefined;
  let lastError: AppDispatchError | undefined;
  let rebuildResolve: ((result: Result<ExecutionReport, AppErrorType>) => void) | undefined;
  let rebuildInFlight: Promise<Result<ExecutionReport, AppErrorType>> | undefined;
  const hostFrameMeasurements = createMeasurementSeries();
  const engineMeasurements = createMeasurementSeries();
  const kernelMeasurements = createMeasurementSeries();
  const audioMeasurements = createMeasurementSeries();
  let musicFeedbackMs = 0;
  const createAudio = executionOptions.createHostAudio ?? createHostAudioConsumer;
  let audio: HostAudioConsumer;
  const rejectedAudioPublications = new Map<
    string,
    import('@forgeax/engine-audio').AudioClipIdentity
  >();
  try {
    audio = createAudio();
  } catch (cause) {
    let failureCause = cause;
    try {
      releaseAfterFailure(cause, () =>
        releasePlatformResources([
          () => inputHandle?.(),
          () => releasePhaseCatalog?.(),
          () => platform.dispose(),
        ]),
      );
    } catch (failure) {
      failureCause = failure;
    }
    const disposed = await session.dispose();
    if (!disposed.ok)
      failureCause = new AggregateError(
        [failureCause, disposed.error],
        'Worker Host startup and cleanup failed',
        { cause: failureCause },
      );
    return err(
      new AppError({
        code: 'app-plugin-activation-failed',
        expected: APP_EXPECTED['app-plugin-activation-failed'],
        hint: APP_ERROR_HINTS['app-plugin-activation-failed'],
        detail: { cause: failureCause },
      }),
    );
  }
  let frameSentAt = 0;
  let profilerCaptureId: string | undefined;
  let profilerFrameId = 0;
  let frameProfile = profiler?.activeSession();
  let profileFrameOpen = false;
  let hostFrameOpen = false;
  let nextInspectionId = 1;
  // Promise settlement is idempotent, so a request keeps no settled flag.
  interface PendingInspection {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
    readonly startedResolve: () => void;
    readonly startedReject: (error: unknown) => void;
    readonly worldIdentity: string;
    cancelResolve: ((admitted: boolean) => void) | undefined;
  }
  const pendingInspections = new Map<number, PendingInspection>();

  const rejectPendingInspections = (error: unknown): void => {
    for (const pending of pendingInspections.values()) {
      pending.reject(error);
      pending.startedReject(error);
      pending.cancelResolve?.(false);
    }
    pendingInspections.clear();
  };

  const setEngineHealth = (health: ExecutionReport['engine']['health']): void => {
    report = {
      ...report,
      engine: { ...report.engine, health },
      ...(health === 'stopped' && report.render !== undefined
        ? { render: { ...report.render, state: 'stopped' as const } }
        : {}),
    };
  };

  const finishProfile = (): void => {
    if (hostFrameOpen) frameProfile?.endPhase();
    if (profileFrameOpen) frameProfile?.endFrame();
    frameProfile = undefined;
    profileFrameOpen = false;
    hostFrameOpen = false;
    try {
      profiler?.activeSession()?.finish();
    } catch {}
    releasePhaseCatalog?.();
    releasePhaseCatalog = undefined;
  };

  const clearFrameAdmissionWatchdog = (expected?: FrameAdmission): void => {
    if (
      expected !== undefined &&
      (frameAdmission === undefined ||
        frameAdmission.session !== expected.session ||
        frameAdmission.worldIdentity !== expected.worldIdentity ||
        frameAdmission.frameId !== expected.frameId)
    ) {
      return;
    }
    if (frameDeadline !== undefined) clearTimeout(frameDeadline);
    frameDeadline = undefined;
    frameAdmission = undefined;
  };

  const cancelFrame = (): void => {
    frameDue = false;
    const release = cancelHostFrame;
    cancelHostFrame = undefined;
    release?.();
  };
  const releasePlatform = (): void => {
    const release = releasePlatformEvents;
    releasePlatformEvents = undefined;
    releasePlatformResources([cancelFrame, () => release?.(), () => platform.dispose()]);
  };

  let disposal: ReturnType<EngineWorkerSession['dispose']> | undefined;
  const disposeSession = () => {
    resetBrowserFrameProgress(canvas);
    rebuildResolve?.(err(lifecycleError('app-not-started')));
    rebuildResolve = undefined;
    rebuildInFlight = undefined;
    if (disposal === undefined) {
      let cleanupError: AppErrorType | undefined;
      try {
        releasePlatform();
      } catch (cause) {
        cleanupError = platformError(cause);
      }
      disposal = session.dispose().then((result) => {
        if (cleanupError === undefined) return result;
        return err(
          result.ok
            ? cleanupError
            : platformError(
                new AggregateError([cleanupError, result.error], 'Worker Host cleanup failed'),
              ),
        );
      });
    }
    return disposal;
  };

  const terminalFault = (message: ExecutionFaultMessage): void => {
    cancelFrame();
    if (message.partialWrite) resetBrowserFrameProgress(canvas);
    resumeAfterHostShow = false;
    clearFrameAdmissionWatchdog();
    const error = runtimeError(message);
    lastError = error;
    rejectPendingInspections(error);
    state = message.partialWrite ? 'faulted' : 'stopped';
    report = {
      ...report,
      engine: { ...report.engine, health: 'faulted' },
      ...(report.render === undefined
        ? {}
        : { render: { ...report.render, state: 'failed' as const } }),
      world: {
        identity: message.partialWrite ? message.worldIdentity : null,
        health: message.partialWrite ? 'poisoned' : report.world.health,
        partialWrite: message.partialWrite,
        retryable: message.retryable,
      },
      kernelDispatch: {
        ...report.kernelDispatch,
        reason: message.partialWrite ? 'poisoned' : report.kernelDispatch.reason,
      },
      fault: {
        source: message.source,
        code: message.code,
        expected: message.expected,
        hint: message.hint,
        detail: message.detail,
        partialWrite: message.partialWrite,
        retryable: message.retryable,
      },
    };
    fanout.fire(error);
    if (!message.partialWrite) {
      audio.dispose();
      disposeSession();
    }
    finishProfile();
  };

  const armFrameAdmission = (worldIdentity: string, frameId: number): void => {
    const admission = {
      session,
      worldIdentity,
      frameId,
    } as const;
    frameAdmission = admission;
    if (state !== 'running') return;
    // Initial source publication can still perform deferred preparation.
    const timeoutMs = frameId === 1 ? startupTimeoutMs : frameTimeoutMs;
    if (timeoutMs === null) return;
    frameDeadline = setTimeout(() => {
      // The callback can remain queued after a matching submitted message
      // clears the timer. Keep the identity fence so it cannot fault a
      // later frame if the runtime delivers that stale callback.
      if (state !== 'running' || frameAdmission !== admission) return;
      terminalFault({
        kind: 'fault',
        worldIdentity: admission.worldIdentity,
        source: 'runtime',
        code: 'app-execution-deadline-exceeded',
        expected: APP_EXPECTED['app-execution-deadline-exceeded'],
        hint: APP_ERROR_HINTS['app-execution-deadline-exceeded'],
        detail: { phase: 'frame', timeoutMs },
        partialWrite: false,
        retryable: false,
      });
    }, timeoutMs);
  };

  // Source frame IDs are monotonic across renderer replacement. A lost epoch
  // retires its outstanding frames; a new baseline starts at this floor.
  let renderRecoveryFloor = 0;
  // Ascending ids of issued update-only steps, which the Render Worker never
  // completes; render back-pressure counts only the pictures still in flight.
  let updateOnlyFrames: number[] = [];
  const renderPipelineCapacity =
    executionOptions.diagnostics?.renderPipelineCapacity === 4
      ? 4
      : executionOptions.diagnostics?.renderPipelineCapacity === 3
        ? 3
        : 2;
  type AdmissionMessage =
    | Extract<
        EngineToHostMessage,
        { kind: 'render-complete' | 'simulation-complete' | 'frame-complete' }
      >
    | ExecutionFrameMessage;
  const traceAdmission = (
    event: 'host-tick-due' | 'host-admission' | 'host-ack-entry' | 'host-ack-accepted',
    outcome: string,
    message?: AdmissionMessage,
  ): void => {
    const sink = executionDiagnosticSink();
    if (sink === undefined) return;
    const frame = message === undefined ? undefined : 'frame' in message ? message.frame : message;
    emitExecutionDiagnostic(sink, {
      event,
      outcome:
        outcome === 'render-blocked'
          ? report.render?.state === 'rebuilding'
            ? 'render-rebuilding'
            : 'render-credit'
          : outcome,
      worldIdentity: report.world.identity,
      frameId: frame?.frameId ?? null,
      messageWorldIdentity: frame?.worldIdentity ?? null,
      deviceGeneration:
        frame !== undefined && 'deviceGeneration' in frame
          ? (frame.deviceGeneration ?? null)
          : null,
      messageKind: message?.kind ?? null,
      messageRenderEpoch: message !== undefined && 'epoch' in message ? message.epoch : null,
      renderEpoch: report.render?.epoch ?? null,
      state,
      frameDue,
      ledger: ledger.inspect(),
      renderCompletedFrame: report.render?.completedFrame ?? null,
      renderRecoveryFloor,
      renderState: report.render?.state ?? null,
      capacity: renderPipelineCapacity,
    });
  };
  const renderBlocked = (): boolean => {
    if (report.render === undefined) return false;
    if (report.render.state === 'rebuilding') return true;
    const floor = Math.max(renderRecoveryFloor, report.render.completedFrame);
    const settled = updateOnlyFrames.findIndex((frameId) => frameId > floor);
    updateOnlyFrames.splice(0, settled === -1 ? updateOnlyFrames.length : settled);
    return ledger.inspect().submitted - floor - updateOnlyFrames.length >= renderPipelineCapacity;
  };
  const admitFrame = (): void => {
    if (state !== 'running') {
      traceAdmission('host-admission', 'not-running');
      return;
    }
    if (ledger.hasCreditInFlight) {
      traceAdmission('host-admission', 'simulation-in-flight');
      return;
    }
    if (renderBlocked()) {
      traceAdmission('host-admission', 'render-blocked');
      return;
    }
    // Sample input and native platform time at admission, including when an
    // ACK releases a tick that became due while a Worker still owned credit.
    const time = platform.now();
    if (!time.ok) {
      failPlatform(time.error);
      return;
    }
    frameDue = false;
    const timestamp = time.value;
    const deltaSeconds = lastTimestamp === undefined ? 0 : (timestamp - lastTimestamp) / 1_000;
    lastTimestamp = timestamp;
    if (postFrame(deltaSeconds, timestamp / 1_000)) scheduleFrame();
  };
  /**
   * Issues one frame with credit; an omitted sample time lets the Worker
   * advance its render-sample clock by the delta, as manual steps require.
   */
  const postFrame = (deltaSeconds: number, sampleTimeSeconds?: number, render = true): boolean => {
    const canvasSize =
      syncCanvas?.(canvas, display) ??
      ({
        width: canvas.width,
        height: canvas.height,
      } satisfies CanvasDrawingBufferSize);
    const frame = ledger.issue(
      deltaSeconds,
      () => input.sample(),
      canvasSize,
      sampleTimeSeconds,
      temporalResetAfterFrame !== undefined,
      render,
    );
    report = { ...report, frame: ledger.inspect() };
    if (frame === undefined) {
      traceAdmission('host-admission', 'not-issued');
      return false;
    }
    traceAdmission('host-admission', 'issued', frame);
    frameProfile = profiler?.activeSession();
    if (frameProfile !== undefined && profilerCaptureId !== frameProfile.captureId) {
      profilerCaptureId = frameProfile.captureId;
      profilerFrameId = 0;
    }
    profileFrameOpen = frameProfile?.beginFrame(++profilerFrameId).ok ?? false;
    hostFrameOpen = profileFrameOpen
      ? (frameProfile?.beginPhase('app', 'host-frame').ok ?? false)
      : false;
    frameSentAt = performance.now();
    armFrameAdmission(frame.worldIdentity, frame.frameId);
    const musicFeedbackStarted = performance.now();
    const audioState = audio.state(),
      musicState = audioState.music;
    session.post({
      ...frame,
      ...(musicState ? { musicState } : {}),
      ...(audioState.preparation ? { audioPreparation: audioState.preparation } : {}),
      ...(rejectedAudioPublications.size
        ? { rejectedAudioPublications: [...rejectedAudioPublications.values()] }
        : {}),
    });
    rejectedAudioPublications.clear();
    // Charge snapshot creation and synchronous publication as well as consumption.
    musicFeedbackMs = performance.now() - musicFeedbackStarted;
    return true;
  };
  const stepFrame = (
    deltaSeconds: number,
    options?: AppStepFrameOptions,
  ): Result<void, AppErrorType> => {
    const render = options?.render ?? true;
    const reason =
      state !== 'paused'
        ? 'state'
        : !Number.isFinite(deltaSeconds) || deltaSeconds < 0
          ? 'delta'
          : ledger.hasCreditInFlight || (render && renderBlocked())
            ? 'credit'
            : undefined;
    if (reason === undefined && postFrame(deltaSeconds, undefined, render)) {
      if (!render) {
        // The next drawn picture follows skipped ones: it carries a temporal reset.
        const frameId = ledger.inspect().submitted;
        updateOnlyFrames.push(frameId);
        temporalResetAfterFrame = frameId;
      }
      return ok(undefined);
    }
    return err(
      new AppError({
        code: 'app-frame-step-invalid',
        expected: APP_EXPECTED['app-frame-step-invalid'],
        hint: APP_ERROR_HINTS['app-frame-step-invalid'],
        detail: {
          state: state === 'faulted' ? 'stopped' : state,
          deltaSeconds,
          reason: reason ?? 'credit',
        },
      }),
    );
  };
  const scheduleFrame = (): void => {
    if (state !== 'running' || !platform.visible()) return;
    if (frameDue) {
      admitFrame();
      return;
    }
    if (cancelHostFrame !== undefined) return;
    const requested = platform.requestFrame(() => {
      cancelHostFrame = undefined;
      if (state !== 'running' || !platform.visible()) return;
      frameDue = true;
      traceAdmission('host-tick-due', 'callback');
      admitFrame();
    });
    if (requested.ok) cancelHostFrame = requested.value;
    else failPlatform(requested.error);
  };

  const failPlatform = (cause: unknown): void => {
    const error = platformError(cause);
    terminalFault({
      kind: 'fault',
      worldIdentity: report.world.identity,
      source: 'runtime',
      code: error.code,
      expected: error.expected,
      hint: error.hint,
      detail: error.detail,
      partialWrite: false,
      retryable: false,
    });
  };
  const pauseFrames = (): void => {
    state = 'paused';
    setEngineHealth('idle');
    cancelFrame();
    if (frameDeadline !== undefined) clearTimeout(frameDeadline);
    frameDeadline = undefined;
  };
  const resumeFrames = (): void => {
    lastTimestamp = undefined;
    temporalResetAfterFrame = ledger.inspect().submitted;
    resumeAfterHostShow = !platform.visible();
    if (resumeAfterHostShow) return;
    state = 'running';
    setEngineHealth('running');
    if (frameAdmission !== undefined)
      armFrameAdmission(frameAdmission.worldIdentity, frameAdmission.frameId);
    scheduleFrame();
  };
  const onPlatformEvent = (event: PlatformEvent): void => {
    if (state === 'stopped' || state === 'faulted') return;
    if (event.kind === 'visibility') {
      if (!event.visible) {
        input.clear?.();
        clearHostInjectedInput();
        clearWorkerInput();
        if (state === 'running') {
          resumeAfterHostShow = true;
          pauseFrames();
        }
      } else if (resumeAfterHostShow && state === 'paused') resumeFrames();
    } else if (event.kind === 'display') display = event.display;
    else if (event.kind === 'surface-lost') failPlatform(event.cause);
  };
  const subscribePlatform = (): void => {
    if (syncCanvas !== undefined) {
      const current = platform.display();
      if (!current.ok) throw platformError(current.error);
      display = current.value;
    }
    const subscribed = platform.subscribe(onPlatformEvent);
    if (!subscribed.ok) throw platformError(subscribed.error);
    releasePlatformEvents = subscribed.value;
  };

  const replaceCanvas = (): OffscreenCanvas => {
    const replacement = canvas.cloneNode(false) as HTMLCanvasElement;
    clearHostInjectedInput();
    inputHandle?.();
    canvas.replaceWith(replacement);
    resetBrowserFrameProgress(canvas);
    canvas = replacement;
    const nextPlatform = createBrowserPlatform(canvas).unwrap();
    try {
      releasePlatform();
      platform = nextPlatform;
      subscribePlatform();
    } catch (cause) {
      releaseAfterFailure(cause, () => nextPlatform.dispose());
      throw cause;
    }
    inputHandle = attachGatedInput();
    return canvas.transferControlToOffscreen();
  };
  // Every Worker reply for a request is fenced to the World the request was
  // admitted against; a reply from any other World ends the request as stale.
  const liveInspection = (
    message: Extract<EngineToHostMessage, { readonly requestId: number }>,
  ): PendingInspection | undefined => {
    const pending = pendingInspections.get(message.requestId);
    if (pending === undefined || message.worldIdentity === pending.worldIdentity) return pending;
    pendingInspections.delete(message.requestId);
    const stale = Object.assign(new Error('The inspection crossed a World rebuild'), {
      code: 'live-world-stale',
    });
    pending.reject(stale);
    pending.startedReject(stale);
    pending.cancelResolve?.(true);
    return undefined;
  };
  const postSurfaceFailure = (
    message: HostMessage<'surface-request'>,
    error: AppErrorType,
  ): void => {
    session.post({
      kind: 'surface-result',
      worldIdentity: message.worldIdentity,
      requestId: message.requestId,
      result: err({
        code: error.code,
        expected: error.expected,
        hint: error.hint,
        detail: error.detail,
      }),
    });
  };
  const onRenderError = (message: HostMessage<'render-error'>): void => {
    if (
      message.identity.epoch !== renderEpoch ||
      message.worldIdentity !== report.world.identity ||
      state === 'stopped' ||
      state === 'faulted'
    )
      return;
    const error = new AppError({
      code: 'app-system-update-failed',
      expected: APP_EXPECTED['app-system-update-failed'],
      hint: APP_ERROR_HINTS['app-system-update-failed'],
      detail: {
        cause: {
          ...message.error,
          renderIdentity: message.identity,
          worldIdentity: message.worldIdentity,
          ...(message.renderer === undefined ? {} : { renderer: message.renderer }),
          ...(message.omittedBeforeListenerCount === undefined
            ? {}
            : { omittedBeforeListenerCount: message.omittedBeforeListenerCount }),
        },
      },
    });
    lastError = error;
    fanout.fire(error);
  };
  const onSurfaceRequest = (message: HostMessage<'surface-request'>): void => {
    if (
      options.selection.render.enabled ||
      message.worldIdentity !== report.world.identity ||
      message.requestId <= lastSurfaceRequestId ||
      state === 'stopped' ||
      state === 'faulted'
    ) {
      postSurfaceFailure(message, lifecycleError('app-not-started'));
      return;
    }
    lastSurfaceRequestId = message.requestId;
    try {
      options.appOptions.input?.clear?.();
      const offscreen = replaceCanvas();
      session.post(
        {
          kind: 'surface-result',
          worldIdentity: message.worldIdentity,
          requestId: message.requestId,
          result: ok(offscreen),
        },
        [offscreen],
      );
    } catch (cause) {
      postSurfaceFailure(
        message,
        new AppError({
          code: 'app-system-update-failed',
          expected: APP_EXPECTED['app-system-update-failed'],
          hint: APP_ERROR_HINTS['app-system-update-failed'],
          detail: { cause },
        }),
      );
    }
  };
  const onRenderReady = (message: HostMessage<'render-ready'>): void => {
    if (message.epoch !== renderEpoch || state === 'stopped' || state === 'faulted') return;
    const recovered = report.render?.state === 'rebuilding';
    if (report.render !== undefined)
      report = {
        ...report,
        render: {
          ...report.render,
          state: 'alive',
          ...(message.capabilities === undefined ? {} : { capabilities: message.capabilities }),
          ...(message.limits === undefined ? {} : { limits: message.limits }),
        },
      };
    if (recovered && ledger.hasCreditInFlight && report.world.identity !== null)
      armFrameAdmission(report.world.identity, ledger.inspect().submitted);
    if (state === 'running') scheduleFrame();
  };
  const onRenderLost = (message: HostMessage<'render-lost'>): void => {
    if (message.epoch <= renderEpoch || state === 'stopped' || state === 'faulted') return;
    renderEpoch = message.epoch;
    renderRecoveryFloor = ledger.inspect().completed;
    clearFrameAdmissionWatchdog();
    report = {
      ...report,
      render: { epoch: renderEpoch, state: 'rebuilding', submittedFrame: 0, completedFrame: 0 },
    };
    const offscreen = replaceCanvas();
    session.post(
      {
        kind: 'render-replace',
        epoch: renderEpoch,
        canvas: offscreen,
        ...(options.appOptions.pipelineLibrary === undefined
          ? {}
          : { pipelineLibrary: options.appOptions.pipelineLibrary }),
      },
      [offscreen],
    );
  };
  // Render Worker frame facts belong to the current render epoch and World.
  const acceptsRenderFrame = (
    message: HostMessage<'render-submitted' | 'render-complete'>,
  ): boolean =>
    message.epoch === renderEpoch &&
    message.frame.worldIdentity === report.world.identity &&
    report.render?.state !== 'rebuilding' &&
    state !== 'stopped' &&
    state !== 'faulted';
  const onRenderSubmitted = (message: HostMessage<'render-submitted'>): void => {
    if (!acceptsRenderFrame(message)) return;
    if (message.frame.frameId <= (report.render?.submittedFrame ?? 0)) return;
    report = {
      ...report,
      render: {
        ...report.render,
        epoch: renderEpoch,
        state: 'alive',
        submittedFrame: message.frame.frameId,
        completedFrame: report.render?.completedFrame ?? 0,
      },
    };
    publishBrowserFrameSubmitted(canvas, message.frame);
  };
  const onRenderComplete = (message: HostMessage<'render-complete'>): void => {
    traceAdmission('host-ack-entry', 'callback', message);
    if (!acceptsRenderFrame(message)) return;
    if (message.frame.frameId <= (report.render?.completedFrame ?? 0)) return;
    report = {
      ...report,
      render: {
        ...report.render,
        epoch: renderEpoch,
        state: 'alive',
        submittedFrame: report.render?.submittedFrame ?? message.frame.frameId,
        completedFrame: message.frame.frameId,
      },
    };
    traceAdmission('host-ack-accepted', 'render-complete', message);
    publishBrowserFrameCompleted(canvas, {
      ...message.frame,
      deviceGeneration: message.frame.deviceGeneration ?? 0,
      presentation: message.frame.presentation ?? 'pending',
    });
    if (state === 'running') scheduleFrame();
  };
  const onFrameSubmitted = (message: HostMessage<'frame-submitted'>): void => {
    const admission = frameAdmission;
    if (
      admission === undefined ||
      admission.session !== session ||
      admission.worldIdentity !== report.world.identity ||
      admission.worldIdentity !== message.worldIdentity ||
      admission.frameId !== message.frameId
    ) {
      return;
    }
    clearFrameAdmissionWatchdog(admission);
    publishBrowserFrameSubmitted(canvas, message);
  };
  const recordRenderRejection = (
    message: HostMessage<'frame-complete' | 'simulation-complete'>,
  ): AppErrorType | undefined => {
    if (message.kind !== 'simulation-complete' || message.renderRejection === undefined)
      return undefined;
    const rejection = new AppError({
      code: 'app-system-update-failed',
      expected: 'a frame reaches Renderer queue acceptance',
      hint: 'the World completed but this frame was aborted; retain gameplay isolation while the next frame retries',
      detail: { cause: message.renderRejection },
    });
    lastError = rejection;
    return rejection;
  };
  // Engine-only rejection settles simulation credit without accepting a
  // picture. Keep the reset for its retry. Split rendering has already
  // accepted this reset into its publication; replacement seeds a new baseline.
  const settleTemporalReset = (
    message: HostMessage<'frame-complete' | 'simulation-complete'>,
  ): void => {
    if (
      temporalResetAfterFrame !== undefined &&
      message.frameId > temporalResetAfterFrame &&
      (message.kind !== 'simulation-complete' || message.renderRejection === undefined)
    )
      temporalResetAfterFrame = undefined;
  };
  const publishWorkerFrameCompleted = (message: HostMessage<'frame-complete'>): void => {
    publishBrowserFrameCompleted(canvas, {
      frameId: message.frameId,
      deviceGeneration: message.deviceGeneration ?? 0,
      ...(message.shadowWorkload === undefined ? {} : { shadowWorkload: message.shadowWorkload }),
      ...(message.graphGeneration === undefined
        ? {}
        : { graphGeneration: message.graphGeneration }),
      ...(message.barrelDistortion === undefined
        ? {}
        : { barrelDistortion: message.barrelDistortion }),
      worldIdentity: message.worldIdentity,
      // Completion without the Render receipt's explicit presentation fact
      // is not evidence that the active scene is visible. Fail closed so a
      // protocol omission cannot dismiss the startup screen.
      presentation: message.presentation ?? 'pending',
      ...(message.presentation !== 'pending' || message.presentationPendingReason === undefined
        ? {}
        : { presentationPendingReason: message.presentationPendingReason }),
    });
  };
  const closeWorkerReportedPhases = (
    message: HostMessage<'frame-complete' | 'simulation-complete'>,
  ): void => {
    if (hostFrameOpen) frameProfile?.endPhase();
    if (!profileFrameOpen) return;
    frameProfile?.recordSkip({
      source: 'app',
      phase: 'engine-update',
      reason: `worker-report:${message.engineUpdateMs.toFixed(3)}ms`,
    });
    frameProfile?.recordSkip({
      source: 'app',
      phase: 'kernel-wait',
      reason: `worker-report:${message.kernelWaitMs.toFixed(3)}ms`,
    });
  };
  // Host-owned audio and gamepad feedback consume the Worker's frame intents.
  const consumeWorkerFrameIntents = (
    message: HostMessage<'frame-complete' | 'simulation-complete'>,
  ): number => {
    const audioStarted = performance.now();
    const audioProfileOpen = profileFrameOpen
      ? (frameProfile?.beginPhase('app', 'host-audio').ok ?? false)
      : false;
    for (const intent of message.audioIntents ?? []) {
      const rejected = audio.consume(intent);
      if (rejected) rejectedAudioPublications.set(`${rejected.owner}:${rejected.handle}`, rejected);
    }
    (options.appOptions.input ?? inputHandle?.backend)?.dispatchFeedback?.(
      message.feedbackIntents ?? [],
    );
    if (audioProfileOpen) frameProfile?.endPhase();
    return performance.now() - audioStarted;
  };
  const recordWorkerFramePerformance = (
    message: HostMessage<'frame-complete' | 'simulation-complete'>,
    audioMs: number,
  ): void => {
    report = {
      ...report,
      performance: {
        ...report.performance,
        hostFrameMs: hostFrameMeasurements.add(performance.now() - frameSentAt),
        engineUpdateMs: engineMeasurements.add(message.engineUpdateMs),
        kernelWaitMs: kernelMeasurements.add(message.kernelWaitMs),
        hostAudioMs: audioMeasurements.add(audioMs + musicFeedbackMs),
      },
    };
    if (message.kernelDispatch !== undefined) {
      report = { ...report, kernelDispatch: message.kernelDispatch };
    }
  };
  const finishHostFrameProfile = (): void => {
    if (profileFrameOpen) frameProfile?.endFrame();
    frameProfile = undefined;
    profileFrameOpen = false;
    hostFrameOpen = false;
  };
  const onWorkerFrameCompletion = (
    message: HostMessage<'frame-complete' | 'simulation-complete'>,
  ): void => {
    traceAdmission('host-ack-entry', 'callback', message);
    if (ledger.complete(message) !== 'accepted') return;
    traceAdmission('host-ack-accepted', 'simulation-credit', message);
    const renderRejectionError = recordRenderRejection(message);
    settleTemporalReset(message);
    if (message.kind === 'frame-complete') publishWorkerFrameCompleted(message);
    report = { ...report, frame: ledger.inspect() };
    clearFrameAdmissionWatchdog({
      session,
      worldIdentity: message.worldIdentity,
      frameId: message.frameId,
    });
    closeWorkerReportedPhases(message);
    const audioMs = consumeWorkerFrameIntents(message);
    recordWorkerFramePerformance(message, audioMs);
    finishHostFrameProfile();
    if (state === 'running') scheduleFrame();
    if (renderRejectionError !== undefined) fanout.fire(renderRejectionError);
  };
  // A failed replacement audio consumer faults the rebuild terminally.
  const replaceHostAudio = (message: HostMessage<'rebuilt'>): boolean => {
    audio.dispose();
    rejectedAudioPublications.clear();
    try {
      audio = createAudio();
      return true;
    } catch (cause) {
      const error = new AppError({
        code: 'app-plugin-activation-failed',
        expected: APP_EXPECTED['app-plugin-activation-failed'],
        hint: APP_ERROR_HINTS['app-plugin-activation-failed'],
        detail: { cause },
      });
      rebuildResolve?.(err(error));
      rebuildResolve = undefined;
      terminalFault({
        kind: 'fault',
        source: 'rebuild',
        code: error.code,
        expected: error.expected,
        hint: error.hint,
        detail: error.detail,
        worldIdentity: message.worldIdentity,
        partialWrite: false,
        retryable: true,
      });
      return false;
    }
  };
  const onRebuilt = (message: HostMessage<'rebuilt'>): void => {
    clearFrameAdmissionWatchdog();
    rejectPendingInspections(
      new Error('The previous World was replaced before inspection execution.'),
    );
    if (!replaceHostAudio(message)) return;
    ledger = new FrameCreditLedger(message.worldIdentity);
    renderRecoveryFloor = 0;
    updateOnlyFrames = [];
    hostFrameMeasurements.clear();
    engineMeasurements.clear();
    kernelMeasurements.clear();
    audioMeasurements.clear();
    state = 'idle';
    frameDue = false;
    resumeAfterHostShow = false;
    temporalResetAfterFrame = undefined;
    const freshReport = createExecutionReport(report.capabilities, report.workers);
    report = {
      ...report,
      ...freshReport,
      audio: report.audio,
      // The rebuilt ACK follows complete source, kernel and renderer startup.
      // Its earlier render-ready event was ignored while the old World was faulted.
      ...(report.render === undefined
        ? {}
        : {
            render: {
              epoch: renderEpoch,
              state: 'alive' as const,
              submittedFrame: 0,
              completedFrame: 0,
            },
          }),
      world: { ...freshReport.world, identity: message.worldIdentity },
      frame: ledger.inspect(),
    };
    rebuildResolve?.(ok(cloneExecutionReport(report)));
    rebuildResolve = undefined;
    rebuildInFlight = undefined;
  };
  const onHostControl = (message: HostMessage<'host-control'>): void => {
    if (message.command === 'set-pointer-lock-allowed') {
      input.setPointerLockAllowed?.(message.allowed);
    }
  };
  const onInspectResult = (message: HostMessage<'inspect-result'>): void => {
    const pending = liveInspection(message);
    if (pending === undefined) return;
    pendingInspections.delete(message.requestId);
    pending.startedResolve();
    pending.cancelResolve?.(true);
    if (message.result.ok) pending.resolve(message.result.value);
    else pending.reject(message.result.error);
  };
  const onInspectCanceled = (message: HostMessage<'inspect-canceled'>): void => {
    const pending = liveInspection(message);
    if (pending === undefined) return;
    pending.cancelResolve?.(message.admitted);
    pending.cancelResolve = undefined;
    if (message.admitted) {
      // Admission is authoritative. The cancel() witness lets the caller
      // stop waiting, while the result Promise remains pending until the
      // Worker posts inspect-result and closes the execution.
      pending.startedResolve();
      return;
    }
    pendingInspections.delete(message.requestId);
    const cancelled = Object.assign(
      new Error('The inspection was cancelled before Worker admission'),
      { code: 'live-eval-cancelled-before-execution' },
    );
    pending.reject(cancelled);
    pending.startedReject(cancelled);
  };
  session.listen((message: EngineToHostMessage) => {
    if (disposal !== undefined) return;
    switch (message.kind) {
      // Startup readiness and the disposal ACK belong to the Worker session.
      case 'ready':
      case 'disposed':
        return;
      case 'render-error':
        onRenderError(message);
        return;
      case 'surface-request':
        onSurfaceRequest(message);
        return;
      case 'render-ready':
        onRenderReady(message);
        return;
      case 'render-lost':
        onRenderLost(message);
        return;
      case 'render-submitted':
        onRenderSubmitted(message);
        return;
      case 'render-complete':
        onRenderComplete(message);
        return;
      case 'frame-submitted':
        onFrameSubmitted(message);
        return;
      case 'frame-complete':
      case 'simulation-complete':
        onWorkerFrameCompletion(message);
        return;
      case 'fault':
        terminalFault(message);
        return;
      case 'rebuilt':
        onRebuilt(message);
        return;
      case 'host-control':
        onHostControl(message);
        return;
      case 'inspect-started':
        liveInspection(message)?.startedResolve();
        return;
      case 'inspect-result':
        onInspectResult(message);
        return;
      case 'inspect-canceled':
        onInspectCanceled(message);
        return;
    }
  });

  const remoteEval = (
    code: string,
    expectedWorldIdentity = report.world.identity ?? session.ready.worldIdentity,
  ): Promise<unknown> & {
    readonly started: Promise<void>;
    readonly cancel: () => Promise<boolean>;
  } => {
    const requestId = nextInspectionId++;
    let resolveStarted!: () => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    // `started` is optional metadata. The main result remains the failure owner
    // when a caller does not subscribe to admission separately.
    void started.catch(() => undefined);
    let resolveResult!: (value: unknown) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<unknown>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    if (state === 'stopped') {
      const error = lastError ?? lifecycleError('app-not-started');
      rejectResult(error);
      rejectStarted(error);
    } else {
      pendingInspections.set(requestId, {
        resolve: resolveResult,
        reject: rejectResult,
        startedResolve: resolveStarted,
        startedReject: rejectStarted,
        worldIdentity: expectedWorldIdentity,
        cancelResolve: undefined,
      });
      session.post({ kind: 'inspect', requestId, code, worldIdentity: expectedWorldIdentity });
    }
    let cancelPromise: Promise<boolean> | undefined;
    const cancel = (): Promise<boolean> => {
      const pending = pendingInspections.get(requestId);
      if (pending === undefined) return Promise.resolve(true);
      if (cancelPromise !== undefined) return cancelPromise;
      cancelPromise = new Promise<boolean>((resolve) => {
        pending.cancelResolve = resolve;
      });
      try {
        session.post({ kind: 'inspect-cancel', requestId, worldIdentity: expectedWorldIdentity });
      } catch {
        pending.cancelResolve?.(true);
        pending.cancelResolve = undefined;
      }
      return cancelPromise;
    };
    return Object.assign(result, { started, cancel });
  };

  const execution: ExecutionControl = {
    report: () =>
      cloneExecutionReport({
        ...report,
        audio: executionAudioReport(audio.state()),
      }),
    rebuild: () => {
      if (rebuildInFlight !== undefined) return rebuildInFlight;
      if (state !== 'faulted' || report.world.identity === null) {
        return Promise.resolve(
          err(
            new AppError({
              code: 'app-execution-rebuild-failed',
              expected: APP_EXPECTED['app-execution-rebuild-failed'],
              hint: APP_ERROR_HINTS['app-execution-rebuild-failed'],
              detail: {
                worldIdentity: report.world.identity,
                cause: new Error('World is not in a rebuildable poisoned state.'),
              },
            }),
          ),
        );
      }
      rebuildInFlight = new Promise((resolve) => {
        rebuildResolve = resolve;
        options.appOptions.input?.clear?.();
        const offscreen = replaceCanvas();
        if (options.selection.render.enabled) {
          renderEpoch = 1;
          report = {
            ...report,
            render: { epoch: 1, state: 'rebuilding', submittedFrame: 0, completedFrame: 0 },
          };
        }
        session.post(
          {
            kind: 'rebuild',
            worldIdentity: report.world.identity as string,
            canvas: offscreen,
            ...(options.appOptions.pipelineLibrary === undefined
              ? {}
              : { pipelineLibrary: options.appOptions.pipelineLibrary }),
          },
          [offscreen],
        );
        if (startupTimeoutMs !== null) {
          setTimeout(() => {
            if (rebuildResolve !== resolve) return;
            rebuildResolve = undefined;
            rebuildInFlight = undefined;
            resolve(
              err(
                new AppError({
                  code: 'app-execution-deadline-exceeded',
                  expected: APP_EXPECTED['app-execution-deadline-exceeded'],
                  hint: APP_ERROR_HINTS['app-execution-deadline-exceeded'],
                  detail: { phase: 'handshake', timeoutMs: startupTimeoutMs },
                }),
              ),
            );
          }, startupTimeoutMs);
        }
      });
      return rebuildInFlight;
    },
  };

  const app: ExecutionApp = {
    get canvas() {
      return canvas;
    },
    execution,
    remoteEval,
    input,
    start: () => {
      if (state === 'running') return err(lifecycleError('app-already-running'));
      if (state === 'stopped' || state === 'faulted') return err(lifecycleError('app-not-started'));
      const wasPaused = state === 'paused';
      if (wasPaused || !platform.visible()) {
        state = 'paused';
        resumeFrames();
        return ok(undefined);
      }
      state = 'running';
      setEngineHealth('running');
      lastTimestamp = undefined;
      temporalResetAfterFrame = undefined;
      scheduleFrame();
      return ok(undefined);
    },
    stop: () => {
      if (state !== 'running' && state !== 'paused') return err(lifecycleError('app-not-started'));
      cancelFrame();
      resumeAfterHostShow = false;
      state = 'stopped';
      clearFrameAdmissionWatchdog();
      clearHostInjectedInput();
      inputHandle?.();
      clearWorkerInput();
      audio.dispose();
      rejectPendingInspections(new Error('App stopped before inspection completed.'));
      void disposeSession();
      setEngineHealth('stopped');
      finishProfile();
      return ok(undefined);
    },
    dispose: async () => {
      if (state === 'running' || state === 'paused') {
        cancelFrame();
        resumeAfterHostShow = false;
        clearFrameAdmissionWatchdog();
        clearHostInjectedInput();
        inputHandle?.();
        clearWorkerInput();
        audio.dispose();
        state = 'stopped';
        setEngineHealth('stopped');
        finishProfile();
      } else if (state !== 'stopped') {
        clearFrameAdmissionWatchdog();
        clearHostInjectedInput();
        inputHandle?.();
        clearWorkerInput();
        audio.dispose();
        state = 'stopped';
        setEngineHealth('stopped');
        finishProfile();
      }
      rejectPendingInspections(new Error('App disposed before inspection completed.'));
      return await disposeSession();
    },
    pause: () => {
      if (state === 'paused' && resumeAfterHostShow) {
        resumeAfterHostShow = false;
        return ok(undefined);
      }
      if (state !== 'running') return err(lifecycleError('app-not-started'));
      resumeAfterHostShow = false;
      pauseFrames();
      return ok(undefined);
    },
    resume: () => {
      if (state !== 'paused') return err(lifecycleError('app-not-started'));
      resumeFrames();
      return ok(undefined);
    },
    stepFrame,
    onError: (listener) => fanout.add(listener),
    get lastError() {
      return lastError;
    },
    clearInput: clearWorkerInput,
    beginInputLease: beginWorkerInputLease,
    finishProfiler: finishWorkerProfiler,
  };
  try {
    subscribePlatform();
  } catch (cause) {
    await app.dispose();
    return err(platformError(cause));
  }
  return ok(app);
}
