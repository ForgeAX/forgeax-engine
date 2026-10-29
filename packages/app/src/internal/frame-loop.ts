import type { World } from '@forgeax/engine-ecs';
import type { Platform } from '@forgeax/engine-platform';
import type { ProfileFrameToken, Profiler, RecorderSession } from '@forgeax/engine-profiler';
import type {
  FrameReceipt,
  RenderError,
  Renderer,
  RenderFrameInput,
  RenderWorldLease,
} from '@forgeax/engine-render';
import { err, ok, type Result } from '@forgeax/engine-types';

import type { AppErrorCode, AppErrorDetailFor } from '../errors';
import { AppError } from '../errors';
import type { ExecutionFrameInspection } from '../execution';
import { APP_PHASE_CATALOG, type DrawSource } from '../types';
import type { FramePacer } from './frame-pacer';

type FrameState = 'idle' | 'running' | 'paused' | 'stopped';

export interface FrameLoopOptions {
  readonly world: World;
  readonly renderer: Renderer;
  readonly platform: Platform;
  readonly onError?: (e: AppError | RenderError) => void;
  /** Keep execution health a projection of the loop, including native scheduling failures. */
  readonly onStateChange?: (state: FrameState) => void;
  /** Optional dev-only RHI recorder hook; called once after each frame draw. */
  readonly debugRhi?: { onFrameEnd(): void };
  readonly profiler?: Profiler;
  /** Forward the exact successful renderer receipt to the App/browser bridge. */
  readonly onSubmitted?: (receipt: FrameReceipt) => void;
  /** Forward a receipt only after its completion Result is successful. */
  readonly onCompleted?: (receipt: FrameReceipt) => void;
  /** Reconcile host-owned camera state after World update and before draw. */
  readonly beforeDraw?: () => void;
  readonly drawSource?: DrawSource;
  readonly geometryLane?: RenderFrameInput['geometryLane'];
  /** Optional frame-rate limit; a callback it rejects only reserves its successor. */
  readonly pacer?: FramePacer;
}

export interface FrameLoopHandle {
  start(): Result<void, AppError>;
  stop(): Result<void, AppError>;
  /** Wait for all already-submitted frame receipts to settle. */
  drainFrameReceipts(): Promise<void>;
  pause(): Result<void, AppError>;
  resume(): Result<void, AppError>;
  /**
   * Run one complete update/draw frame through this loop while paused;
   * `render: false` runs the update only (no draw, no receipt credit).
   */
  stepFrame(deltaSeconds: number, render?: boolean): Result<void, AppError | RenderError>;
  /** Replace the per-frame world routing pull without replacing the loop. */
  setDrawSource(drawSource: FrameLoopOptions['drawSource']): void;
  getState(): FrameState;
  /** Snapshot the host-owned receipt credit counters without mutating them. */
  inspect(): ExecutionFrameInspection;
  setStopped(): void;
}

function beginFrame(session: RecorderSession | undefined, frameId: number): boolean {
  if (session === undefined) return false;
  try {
    return session.beginFrame(frameId).ok;
  } catch {
    return false;
  }
}

function beginPhase(session: RecorderSession | undefined, phase: string): boolean {
  if (session === undefined) return false;
  try {
    return session.beginPhase('app', phase).ok;
  } catch {
    return false;
  }
}

function endPhase(session: RecorderSession | undefined): void {
  if (session === undefined) return;
  try {
    session.endPhase();
  } catch {
    // Profiler failures never alter the host loop.
  }
}

function endFrame(session: RecorderSession | undefined): void {
  if (session === undefined) return;
  try {
    session.endFrame();
  } catch {
    // Profiler failures never alter the host loop.
  }
}

function finishProfilerCapture(profiler: Profiler | undefined): void {
  const session = profiler?.activeSession();
  if (session === undefined) return;
  try {
    session.finish();
  } catch {
    // Profiler failures never alter the host stop transition.
  }
}

function makeAppError<C extends AppErrorCode>(
  code: C,
  expected: string,
  hint: string,
  detail: AppErrorDetailFor<C>,
): AppError {
  return new AppError({ code, expected, hint, detail }) as AppError;
}

function makeWorldUpdateError(cause: unknown): AppError {
  return makeAppError(
    'app-system-update-failed',
    'world.update(deltaSeconds) completes successfully',
    'check detail.cause for the original structured ECS error',
    { cause },
  );
}

function isFrameReceipt(value: unknown): value is FrameReceipt {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as {
    readonly frameId?: unknown;
    readonly deviceGeneration?: unknown;
    readonly backendId?: unknown;
    readonly graphGeneration?: unknown;
    readonly completed?: unknown;
  };
  if (!Number.isSafeInteger(candidate.frameId) || (candidate.frameId as number) < 0) return false;
  if (
    !Number.isSafeInteger(candidate.deviceGeneration) ||
    (candidate.deviceGeneration as number) < 0
  )
    return false;
  if (candidate.backendId !== undefined && typeof candidate.backendId !== 'string') return false;
  if (
    candidate.graphGeneration !== undefined &&
    (!Number.isSafeInteger(candidate.graphGeneration) || (candidate.graphGeneration as number) < 0)
  )
    return false;
  const completion = candidate.completed;
  return (
    (typeof completion === 'object' || typeof completion === 'function') &&
    completion !== null &&
    typeof (completion as { then?: unknown }).then === 'function'
  );
}

function fireWorldUpdateResult(
  result: ReturnType<World['update']>,
  fireError: ((e: AppError | RenderError) => void) | undefined,
): boolean {
  if (!result.ok && fireError !== undefined) {
    fireError(makeWorldUpdateError(result.error));
  }
  return result.ok;
}

function updateInjectedWorlds(
  worlds: readonly World[],
  ownWorld: World,
  deltaSeconds: number,
  fireError: ((e: AppError | RenderError) => void) | undefined,
  attachedWorlds: ReadonlySet<World>,
  updatedWorlds: Set<World>,
): void {
  for (const injectedWorld of worlds) {
    if (
      injectedWorld === ownWorld ||
      updatedWorlds.has(injectedWorld) ||
      !attachedWorlds.has(injectedWorld)
    ) {
      continue;
    }
    try {
      if (fireWorldUpdateResult(injectedWorld.update(deltaSeconds), fireError)) {
        updatedWorlds.add(injectedWorld);
      }
    } catch (cause: unknown) {
      if (fireError !== undefined) fireError(makeWorldUpdateError(cause));
    }
  }
}

export function createFrameLoop(opts: FrameLoopOptions): FrameLoopHandle {
  const { world, renderer } = opts;
  const phaseCatalogRegistration = opts.profiler?.registerPhaseCatalog('app', APP_PHASE_CATALOG);
  let releasePhaseCatalog =
    phaseCatalogRegistration?.ok === true ? phaseCatalogRegistration.value : undefined;
  let drawSource = opts.drawSource;
  const now = () => opts.platform.now().unwrap();

  let state: FrameState = 'idle';
  let waitingForCredit = false;
  function setState(next: FrameState): void {
    if (state === next) return;
    if (next !== 'running') waitingForCredit = false;
    state = next;
    opts.onStateChange?.(next);
  }
  let lastTimestamp = 0;
  // The renderer needs the host sample time, not the ECS-clamped simulation
  // elapsed value. Keep it independently so a 200 ms host gap remains a
  // temporal discontinuity even when World.update accepts only 100 ms.
  let lastSampleTimeSeconds = 0;
  // Pause/resume is an explicit temporal lifecycle boundary. Keep it pending
  // until a renderer receipt proves that the fresh baseline was submitted.
  let temporalResetPending = false;
  let cancelPendingFrame: (() => void) | undefined;

  function cancelFrame(): Result<void, AppError> {
    const cancel = cancelPendingFrame;
    cancelPendingFrame = undefined;
    try {
      cancel?.();
      return ok(undefined);
    } catch (cause) {
      return err(makeWorldUpdateError(cause));
    }
  }

  function scheduleFrame(): Result<void, AppError> {
    try {
      const requested = opts.platform.requestFrame(tick);
      if (!requested.ok) return err(makeWorldUpdateError(requested.error));
      cancelPendingFrame = requested.value;
      return ok(undefined);
    } catch (cause) {
      return err(makeWorldUpdateError(cause));
    }
  }
  let profilerFrameId = 0;
  let profilerCaptureId: string | undefined;
  const leases = new Map<World, RenderWorldLease>();
  const maxFramesInFlight = 2;
  let submittedFrames = 0;
  let completedFrames = 0;
  let highWaterFrames = 0;
  let throttledTicks = 0;
  let pendingReceipts = 0;
  const receiptDrainWaiters = new Set<() => void>();

  function inspect(): ExecutionFrameInspection {
    return {
      submitted: submittedFrames,
      completed: completedFrames,
      inFlight: pendingReceipts,
      highWater: highWaterFrames,
      throttledTicks,
    };
  }

  function reportReceiptError(
    fireError: (e: AppError | RenderError) => void,
    error: AppError | RenderError,
  ): void {
    // Completion callbacks run in a Promise job, after runFrame has returned.
    // A user listener is allowed to throw, but must not turn a handled receipt
    // rejection into an unhandled Promise rejection.
    try {
      fireError(error);
    } catch {
      // Error fan-out is observational at this boundary.
    }
  }

  function notifyReceiptDrainWaiters(): void {
    if (pendingReceipts !== 0 || receiptDrainWaiters.size === 0) return;
    const waiters = [...receiptDrainWaiters];
    receiptDrainWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  function drainFrameReceipts(): Promise<void> {
    if (pendingReceipts === 0) return Promise.resolve();
    return new Promise((resolve) => {
      receiptDrainWaiters.add(resolve);
      notifyReceiptDrainWaiters();
    });
  }

  function trackReceipt(
    receipt: FrameReceipt,
    fireError: (e: AppError | RenderError) => void,
  ): void {
    submittedFrames += 1;
    pendingReceipts += 1;
    highWaterFrames = Math.max(highWaterFrames, pendingReceipts);

    try {
      opts.onSubmitted?.(receipt);
    } catch {
      // Browser projection is observational and cannot change frame state.
    }

    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      pendingReceipts -= 1;
      completedFrames += 1;
      notifyReceiptDrainWaiters();
    };
    const notifyCompleted = (): boolean => {
      // A completion that settles after the App has stopped, been disposed,
      // or moved to a different renderer generation is not an active startup
      // witness. Concrete Renderers already fence this in FrameReceipt, while
      // this host-side check keeps alternate execution adapters fail-closed.
      if (state === 'stopped') return false;
      if (typeof renderer.state === 'function' && renderer.state() !== 'alive') {
        waitingForCredit = false;
        return false;
      }
      try {
        // currentDeviceGeneration avoids materializing a per-entity
        // diagnostic snapshot on every completed frame.
        const generation =
          renderer.currentDeviceGeneration?.() ?? renderer.inspect?.()?.frame?.deviceGeneration;
        if (Number.isSafeInteger(generation) && generation !== receipt.deviceGeneration)
          return false;
      } catch {
        // Inspection is diagnostic only. The receipt Result remains the
        // authoritative completion proof when an adapter has no inspection.
      }
      try {
        opts.onCompleted?.(receipt);
      } catch {
        // Browser completion projection is observational and cannot change
        // frame ownership or turn a successful receipt into a failure.
      }
      return true;
    };
    const completion = receipt.completed;
    if (
      completion === null ||
      (typeof completion !== 'object' && typeof completion !== 'function') ||
      typeof (completion as { then?: unknown }).then !== 'function'
    ) {
      reportReceiptError(
        fireError,
        makeWorldUpdateError(new Error('renderer returned an invalid completion Promise')),
      );
      settle();
      return;
    }
    try {
      (completion as PromiseLike<unknown>).then(
        (result: unknown) => {
          let completed = false;
          if (result !== null && typeof result === 'object' && 'ok' in result) {
            if ((result as { ok?: unknown }).ok === false && 'error' in result) {
              reportReceiptError(fireError, (result as { error: RenderError }).error);
            } else if ((result as { ok?: unknown }).ok === true) {
              completed = notifyCompleted();
            } else {
              reportReceiptError(
                fireError,
                makeWorldUpdateError(new Error('renderer returned an invalid completion Result')),
              );
            }
          } else {
            reportReceiptError(
              fireError,
              makeWorldUpdateError(new Error('renderer returned an invalid completion Result')),
            );
          }
          settle();
          // Resume only a Host frame already blocked by credit. Keep its sole
          // reserved successor; ordinary completions never manufacture frames.
          if (completed && waitingForCredit && state === 'running') {
            try {
              runFrame();
            } catch (cause) {
              reportReceiptError(fireError, makeWorldUpdateError(cause));
            }
          }
        },
        (cause: unknown) => {
          reportReceiptError(fireError, makeWorldUpdateError(cause));
          settle();
        },
      );
    } catch (cause: unknown) {
      reportReceiptError(fireError, makeWorldUpdateError(cause));
      settle();
    }
  }

  function attachPrimary(fireError: (e: AppError | RenderError) => void): void {
    if (leases.has(world)) return;
    try {
      const result = renderer.attach(world);
      if (result.ok) leases.set(world, result.value);
      else fireError(result.error);
    } catch (cause: unknown) {
      fireError(makeWorldUpdateError(cause));
    }
  }

  function syncInjectedAttachments(
    worlds: readonly World[] | undefined,
    fireError?: (e: AppError | RenderError) => void,
  ): ReadonlySet<World> | undefined {
    if (worlds === undefined) {
      for (const [attached, lease] of leases) {
        if (attached !== world) {
          lease.dispose();
          leases.delete(attached);
        }
      }
      return undefined;
    }

    const next = new Set<World>();
    for (const candidate of worlds) {
      if (candidate === world || next.has(candidate)) continue;
      if (leases.has(candidate)) {
        next.add(candidate);
        continue;
      }
      try {
        const result = renderer.attach(candidate);
        if (result.ok) {
          leases.set(candidate, result.value);
          next.add(candidate);
        } else fireError?.(result.error);
      } catch (cause: unknown) {
        fireError?.(makeWorldUpdateError(cause));
      }
    }
    for (const [attached, lease] of leases) {
      if (attached !== world && !next.has(attached)) {
        lease.dispose();
        leases.delete(attached);
      }
    }
    return next;
  }

  function releaseInjectedAttachments(): void {
    syncInjectedAttachments(undefined);
  }

  function releaseAttachments(): void {
    releaseInjectedAttachments();
    const lease = leases.get(world);
    if (lease !== undefined) {
      lease.dispose();
      leases.delete(world);
    }
  }

  function runProfiledPhase<T>(
    session: RecorderSession | undefined,
    phase: string,
    action: () => T,
  ): T {
    const opened = beginPhase(session, phase);
    try {
      return action();
    } finally {
      if (opened) endPhase(session);
    }
  }

  function runFrame(deltaSeconds?: number, render = true): Result<void, AppError | RenderError> {
    waitingForCredit = false;
    const manualStep = deltaSeconds !== undefined;
    let timestamp: number;
    try {
      timestamp = manualStep ? lastTimestamp : now();
    } catch (cause) {
      const error = makeWorldUpdateError(cause);
      // Cancel before reporting: onError may synchronously resume the App.
      const cancelled = cancelFrame();
      setState('paused');
      temporalResetPending = true;
      opts.onError?.(error);
      if (!cancelled.ok) opts.onError?.(cancelled.error);
      return err(error);
    }
    // The public Renderer always exposes state(); keep the host loop tolerant
    // of legacy renderer-shaped adapters that predate that lifecycle method.
    // Real Renderer instances still take the state guard on every frame.
    const rendererState =
      typeof renderer.state === 'function' ? renderer.state() : ('alive' as const);
    if (rendererState !== 'alive') {
      // Recovery freezes simulation instead of accumulating device downtime.
      lastTimestamp = timestamp;
      return ok(undefined);
    }
    if (render && pendingReceipts >= maxFramesInFlight) {
      throttledTicks += 1;
      waitingForCredit = !manualStep && state === 'running';
      return ok(undefined);
    }
    // Only admitted frames consume elapsed time. Manual steps supply their
    // delta; ordinary ticks retain skipped GPU-credit intervals for the World.
    deltaSeconds ??= (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;
    const sampleTimeSeconds = manualStep ? lastSampleTimeSeconds + deltaSeconds : timestamp / 1000;
    const session = opts.profiler?.activeSession();
    let profileFrame: ProfileFrameToken | undefined;
    let frameError: AppError | RenderError | undefined;
    let primaryUpdated = false;
    const reportError = (error: AppError | RenderError): void => {
      frameError ??= error;
      opts.onError?.(error);
    };
    if (session !== undefined) {
      if (profilerCaptureId !== session.captureId) {
        profilerCaptureId = session.captureId;
        profilerFrameId = 0;
      }
      const frameId = ++profilerFrameId;
      if (beginFrame(session, frameId)) {
        profileFrame = { captureId: session.captureId, frameId };
      }
    }

    runProfiledPhase(session, 'frame-total', () => {
      attachPrimary(reportError);

      runProfiledPhase(session, 'world-update-primary', () => {
        try {
          if (fireWorldUpdateResult(world.update(deltaSeconds), reportError)) {
            primaryUpdated = true;
          }
        } catch (cause: unknown) {
          reportError(makeWorldUpdateError(cause));
        }
      });

      let injected: ReturnType<DrawSource>;
      runProfiledPhase(session, 'draw-source', () => {
        if (drawSource === undefined) return;
        try {
          injected = drawSource();
        } catch (cause: unknown) {
          reportError(makeWorldUpdateError(cause));
        }
      });

      const attachedInjectedWorlds = syncInjectedAttachments(injected?.worlds, reportError);
      const updatedWorlds = injected === undefined ? undefined : new Set<World>();
      if (updatedWorlds !== undefined && primaryUpdated && leases.has(world)) {
        updatedWorlds.add(world);
      }

      runProfiledPhase(session, 'world-update-injected', () => {
        if (
          injected != null &&
          attachedInjectedWorlds !== undefined &&
          updatedWorlds !== undefined
        ) {
          updateInjectedWorlds(
            injected.worlds,
            world,
            deltaSeconds,
            reportError,
            attachedInjectedWorlds,
            updatedWorlds,
          );
        }
      });

      if (!render) {
        skipDraw(sampleTimeSeconds, reportError);
        return;
      }
      runProfiledPhase(session, 'renderer-draw', () => {
        try {
          opts.beforeDraw?.();
          let drawResult: ReturnType<Renderer['draw']>;
          if (injected === null) {
            temporalResetPending = true;
            drawResult = renderer.draw({
              leases: [],
              camera: null,
              environment: null,
              sampleTimeSeconds,
              ...(profileFrame === undefined ? {} : { profileFrame }),
              ...(opts.geometryLane === undefined ? {} : { geometryLane: opts.geometryLane }),
            });
          } else if (injected === undefined) {
            const primaryLease = leases.get(world);
            if (!primaryUpdated || primaryLease === undefined) return;
            drawResult = renderer.draw({
              leases: [primaryLease],
              camera: { lease: primaryLease },
              environment: { lease: primaryLease },
              sampleTimeSeconds,
              ...(temporalResetPending ? { temporalReset: true } : {}),
              ...(profileFrame === undefined ? {} : { profileFrame }),
              ...(opts.geometryLane === undefined ? {} : { geometryLane: opts.geometryLane }),
            });
          } else {
            if (updatedWorlds === undefined) return;
            const readyEntries = injected.worlds
              .filter((candidate) => updatedWorlds.has(candidate))
              .map((candidate) => ({ candidate, lease: leases.get(candidate) }))
              .filter(
                (entry): entry is { candidate: World; lease: RenderWorldLease } =>
                  entry.lease !== undefined,
              );
            const readyLeases = readyEntries.map((entry) => entry.lease);
            const cameraWorld = injected.worlds[injected.cameraOwner];
            const environmentWorld = injected.worlds[injected.resourceOwner];
            if (cameraWorld === undefined || environmentWorld === undefined) return;
            const cameraLease = leases.get(cameraWorld);
            const environmentLease = leases.get(environmentWorld);
            if (
              readyLeases.length === 0 ||
              cameraLease === undefined ||
              environmentLease === undefined
            )
              return;
            drawResult = renderer.draw({
              leases: readyLeases,
              camera: { lease: cameraLease },
              environment: { lease: environmentLease },
              sampleTimeSeconds,
              ...(temporalResetPending ? { temporalReset: true } : {}),
              ...(profileFrame === undefined ? {} : { profileFrame }),
              ...(opts.geometryLane === undefined ? {} : { geometryLane: opts.geometryLane }),
            });
          }
          if (drawResult.ok) {
            if (drawResult.value === undefined) return;
            if (isFrameReceipt(drawResult.value)) {
              trackReceipt(drawResult.value, reportError);
              // The raw host sample becomes the next temporal baseline only
              // after Renderer.draw accepted the queue submission. A failed
              // submit must not advance the fallback clock used by a later
              // manual step or by the worker-facing frame request.
              lastSampleTimeSeconds = sampleTimeSeconds;
              if (injected !== null) temporalResetPending = false;
            } else {
              reportError(
                makeWorldUpdateError(new Error('renderer returned an invalid FrameReceipt')),
              );
            }
          } else {
            reportError(drawResult.error);
          }
        } catch (cause: unknown) {
          reportError(makeWorldUpdateError(cause));
        }
      });
    });
    endFrame(session);
    try {
      if (render) opts.debugRhi?.onFrameEnd();
    } catch {
      // Debug capture is an observational bridge. A recorder failure must not
      // change the App frame result or make the host loop stop.
    }
    return frameError === undefined ? ok(undefined) : err(frameError);
  }

  /**
   * An update-only step submits nothing: it still reconciles the host camera,
   * advances the manual sample clock by its delta and makes the next drawn
   * frame a temporal reset, since that picture follows a skipped interval.
   */
  function skipDraw(
    sampleTimeSeconds: number,
    reportError: (error: AppError | RenderError) => void,
  ): void {
    try {
      opts.beforeDraw?.();
    } catch (cause: unknown) {
      reportError(makeWorldUpdateError(cause));
    }
    lastSampleTimeSeconds = sampleTimeSeconds;
    temporalResetPending = true;
  }

  function tick(): void {
    if (state !== 'running') return;
    cancelPendingFrame = undefined;

    // Reserve the sole successor before synchronous World/render work. Some
    // native Hosts measure their frame delay from this request; requesting at
    // the end would add the entire current frame's CPU cost to that delay.
    // pause/stop cancel this reservation; a reentrant resume owns its replacement.
    const scheduled = scheduleFrame();
    if (!scheduled.ok) {
      setState('paused');
      opts.onError?.(scheduled.error);
      return;
    }
    // A limited loop keeps the reserved successor and skips this callback
    // until the limit interval has elapsed; an unlimited loop never samples here.
    const pacer = opts.pacer;
    if (pacer !== undefined && pacer.limit() !== null) {
      let sampled: number;
      try {
        sampled = now();
      } catch (cause) {
        setState('paused');
        cancelFrame();
        opts.onError?.(makeWorldUpdateError(cause));
        return;
      }
      if (!pacer.due(sampled)) return;
      pacer.admitted(sampled);
    }

    // Device loss is a renderer-owned degraded interval, not an application
    // stop. Keep the rAF heartbeat alive while the host performs the explicit
    // Renderer.recover() rebuild, but freeze simulation so recovery does not
    // advance the World against frames that cannot be submitted. The next
    // tick observes `alive` and resumes the normal update/draw sequence.
    runFrame();
  }

  function releaseProfiler(): void {
    finishProfilerCapture(opts.profiler);
    releasePhaseCatalog?.();
    releasePhaseCatalog = undefined;
  }

  return {
    setDrawSource(nextDrawSource): void {
      if (drawSource !== nextDrawSource) syncInjectedAttachments(undefined);
      drawSource = nextDrawSource;
    },
    drainFrameReceipts,
    stepFrame(deltaSeconds, render = true): Result<void, AppError | RenderError> {
      const reason =
        state !== 'paused'
          ? 'state'
          : !Number.isFinite(deltaSeconds) || deltaSeconds < 0
            ? 'delta'
            : render && pendingReceipts >= maxFramesInFlight
              ? 'credit'
              : undefined;
      if (reason !== undefined) {
        return err(
          makeAppError(
            'app-frame-step-invalid',
            'state is "paused", deltaSeconds is finite and non-negative, and a frame receipt credit is available',
            'pause the App, pass a finite non-negative delta, and retry after an in-flight receipt settles',
            { state, deltaSeconds, reason },
          ),
        );
      }
      return runFrame(deltaSeconds, render);
    },
    start(): Result<void, AppError> {
      if (state === 'running') {
        return err(
          makeAppError(
            'app-already-running',
            'state must be "idle" or "paused" to start',
            'audit start() call sites; the App is already running',
            {},
          ),
        );
      }
      if (state === 'stopped') {
        return err(
          makeAppError(
            'app-not-started',
            'frame-loop is in terminal "stopped" state',
            'create a new App via createApp({...}); the existing handle is dead',
            {},
          ),
        );
      }
      const wasPaused = state === 'paused';
      try {
        lastTimestamp = now();
      } catch (cause) {
        return err(makeWorldUpdateError(cause));
      }
      lastSampleTimeSeconds = lastTimestamp / 1000;
      temporalResetPending = wasPaused;
      setState('running');
      const scheduled = scheduleFrame();
      if (!scheduled.ok) setState(wasPaused ? 'paused' : 'idle');
      return scheduled;
    },

    stop(): Result<void, AppError> {
      if (state === 'idle') {
        return err(
          makeAppError(
            'app-not-started',
            'state must be "running" to stop',
            'call start() before stop(); idle handles cannot stop',
            {},
          ),
        );
      }
      if (state === 'stopped') {
        return err(
          makeAppError(
            'app-not-started',
            'frame-loop is in terminal "stopped" state',
            'discard this handle and create a new App',
            {},
          ),
        );
      }
      setState('stopped');
      const cancelled = cancelFrame();
      releaseAttachments();
      releaseProfiler();
      return cancelled;
    },

    pause(): Result<void, AppError> {
      if (state === 'paused') return ok(undefined);
      if (state !== 'running') {
        return err(
          makeAppError(
            'app-not-started',
            'state must be "running" or "paused" to pause',
            'call start() first; idle handles cannot pause',
            {},
          ),
        );
      }
      setState('paused');
      return cancelFrame();
    },

    resume(): Result<void, AppError> {
      if (state === 'idle' || state === 'stopped') {
        return err(
          makeAppError(
            'app-not-started',
            'state must be "paused" to resume',
            'call start() first to leave idle; resume() expects an active handle',
            {},
          ),
        );
      }
      if (state === 'running') return ok(undefined);
      try {
        lastTimestamp = now();
      } catch (cause) {
        return err(makeWorldUpdateError(cause));
      }
      temporalResetPending = true;
      setState('running');
      const scheduled = scheduleFrame();
      if (!scheduled.ok) setState('paused');
      return scheduled;
    },

    getState(): FrameState {
      return state;
    },

    inspect,

    setStopped(): void {
      setState('stopped');
      const cancelled = cancelFrame();
      releaseAttachments();
      releaseProfiler();
      if (!cancelled.ok) opts.onError?.(cancelled.error);
    },
  };
}
