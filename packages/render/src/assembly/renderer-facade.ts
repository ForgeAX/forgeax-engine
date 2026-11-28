import { ProjectedDecalInvalidError } from '../decals/component';
import { unavailableGeometry } from '../geometry-observation';
import { RenderPublicationError } from '../publication/contract';
import { TextureResidencyError } from '../texture-residency';

// Public renderer facade and profile validation.
// This module narrows the lifetime-heavy host implementation to the stable
// lease/receipt contract and owns the profile/error projection helpers.

import type { World } from '@forgeax/engine-ecs';
import { err, ok, type RhiError } from '@forgeax/engine-rhi';
import type {
  DynamicGeometryCandidate,
  DynamicGeometryError,
  DynamicGeometryOrdering,
  DynamicGeometryPrepareInput,
} from '../dynamic-geometry';
import { type RecoverFailure, RecoveryFailedError } from '../errors/recover';
import {
  EquirectProjectionFailedError,
  ExternalTextureInvalidError,
  ExternalTextureStateInvalidError,
  MaterialSampledTextureBudgetExceededError,
  type RenderError,
  RendererContractFailureError,
  type RendererOperationCause,
  RendererOperationError,
} from '../errors/render';
import { MotionBlurValidationError } from '../features/motion-blur/motion-blur-params';
import type { StandardProfile } from '../pipeline/standard-profile';
import type {
  FrameObservationDomain,
  FrameReceipt,
  Renderer,
  RendererError,
  RendererEventListener,
  RendererState,
  RenderInspection,
  RenderResult,
} from '../render-contract';
import { captureTargetEnvironment } from '../targets/capture-environment';
import type { RendererHostImplementation } from './host-contract';
import { bindLevelSourceAccess } from './level-source-access';

export { freezeRenderProfile, validateRenderProfile } from './renderer-profile';

import { createRendererLifecycle, isRendererStateOperational } from './renderer-lifecycle';

/** Narrow the concrete host to the lease/receipt-only public contract. */
export function exposeRenderer(renderer: RendererHostImplementation): Renderer {
  const listeners = new Set<RendererEventListener>();
  const lifecycle = createRendererLifecycle(renderer.inspect({ fields: ['state'] }).state);
  let scheduledFrame:
    | {
        readonly controller: AbortController;
        readonly done: Promise<RenderResult<FrameReceipt, RenderError>>;
      }
    | undefined;
  let disposeInFlight: Promise<RenderResult<void, RenderError>> | undefined;
  let synchronousDrawDepth = 0;
  let synchronousDrawDrained: (() => void) | undefined;
  let disposed = lifecycle.state() === 'disposed';
  let recoverInFlight: Promise<RenderResult<void, RenderError>> | undefined;
  const dynamicGeometryFault = (world: World): DynamicGeometryError | undefined =>
    (
      renderer as RendererHostImplementation & {
        readonly dynamicGeometryFault?: (world: World) => DynamicGeometryError | undefined;
      }
    ).dynamicGeometryFault?.(world);

  const emit = (event: Parameters<RendererEventListener>[0]): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (cause) {
        console.error('[Renderer.subscribe] listener threw:', cause);
      }
    }
  };
  const transition = (next: RendererState): void => {
    const previous = lifecycle.state();
    if (previous === next || !lifecycle.transition(next)) return;
    emit(Object.freeze({ kind: 'state-changed', previous, current: next }));
  };
  // Projection and texture-budget failures are public, asset-caused RenderErrors
  // that name the source problem; wrapping them would hide it behind a device code.
  const expiredProjectionError = (
    cause: unknown,
  ): RendererOperationError<'scene-projection-failed'> | undefined => {
    const error = asRecord(cause);
    const detail = asRecord(error?.detail);
    const source = asRecord(detail?.error);
    if (error?.code !== 'webgpu-runtime-error' || source?.code !== 'state-projection-expired')
      return undefined;
    const projection = asRecord(source.detail) ?? source;
    return new RendererOperationError('scene-projection-failed', {
      operation: 'draw',
      cause: structuredRendererCause(projection, 'World source projection'),
    });
  };
  const eventError = (cause: RendererError): RenderError =>
    expiredProjectionError(cause) ??
    (cause instanceof RendererOperationError ||
    cause instanceof EquirectProjectionFailedError ||
    cause instanceof ExternalTextureInvalidError ||
    cause instanceof ExternalTextureStateInvalidError ||
    cause instanceof MaterialSampledTextureBudgetExceededError
      ? cause
      : new RendererOperationError('device-operation-failed', {
          operation: 'renderer-event',
          cause: structuredRendererCause(cause, 'renderer-event'),
        }));
  const drawError = (cause: RhiError | RenderError): RenderError => {
    const projectionFailure = expiredProjectionError(cause);
    if (projectionFailure !== undefined) return projectionFailure;
    if (
      cause instanceof MotionBlurValidationError ||
      cause instanceof RenderPublicationError ||
      cause instanceof ProjectedDecalInvalidError
    )
      return cause;
    if (cause instanceof RendererOperationError) return cause;
    if (cause instanceof RendererContractFailureError) {
      return new RendererOperationError('device-operation-failed', {
        operation: 'draw',
        cause: structuredRendererCause(cause, 'draw'),
      });
    }
    return new RendererOperationError('device-operation-failed', {
      operation: 'draw',
      cause: structuredRendererCause(cause, 'draw'),
    });
  };
  const assertPreparationIdle = () => {
    if (scheduledFrame !== undefined)
      throw new RendererContractFailureError(
        'draw',
        'one active Renderer preparation without interleaved mutation',
      );
  };
  const afterScheduledPreparation = async <T>(action: () => T | Promise<T>): Promise<T> => {
    // Re-read after every settlement: a completion callback can already have
    // admitted another frame before this waiter resumes. No await on idle.
    while (scheduledFrame !== undefined) {
      const active = scheduledFrame;
      try {
        await active.done;
      } catch {
        /* Failed preparation still drains its owners. */
      }
    }
    return action();
  };
  const projectSubmittedFrame = (
    result: RenderResult<FrameReceipt, RhiError | RenderError>,
    frameFailure?: RenderError,
  ): RenderResult<FrameReceipt, RenderError> => {
    if (!result.ok)
      return err(
        result.error instanceof RendererContractFailureError && frameFailure !== undefined
          ? frameFailure
          : drawError(result.error),
      );
    emit(
      Object.freeze({
        kind: 'frame-submitted',
        frameId: result.value.frameId,
        deviceGeneration: result.value.deviceGeneration,
        ...(result.value.graphGeneration === undefined
          ? {}
          : { graphGeneration: result.value.graphGeneration }),
        receipt: result.value,
      }),
    );
    return ok(result.value);
  };
  const offHostEvents = renderer.subscribeHostEvents((event) => {
    if (event.kind === 'error') {
      emit(Object.freeze({ kind: 'error', error: eventError(event.error) }));
      return;
    }
    transition(
      event.health.reason === 'device-lost'
        ? 'device-lost'
        : event.health.reason === 'internal-fault'
          ? 'faulted'
          : 'alive',
    );
  });

  const facade: Renderer = {
    setSurfaceDynamicInput: (frame) => {
      assertPreparationIdle();
      renderer.setSurfaceDynamicInput(frame);
    },
    bounds: (world, entity) => (disposed ? undefined : renderer.bounds(world, entity)),
    attach: (world) => {
      assertPreparationIdle();
      const result = renderer.attach(world);
      return result.ok
        ? result
        : err(
            new RendererOperationError('world-lease-invalid', {
              operation: 'attach',
              cause: result.error,
            }),
          );
    },
    prepareDynamicGeometryPipelines: (candidates, options) =>
      afterScheduledPreparation(() =>
        renderer.prepareDynamicGeometryPipelines(candidates, options),
      ),
    prepareDynamicGeometry: (input: DynamicGeometryPrepareInput) => {
      assertPreparationIdle();
      const fault = dynamicGeometryFault(input.world as World);
      return fault === undefined ? renderer.prepareDynamicGeometry(input) : err(fault);
    },
    prepareDynamicGeometryCandidates: (inputs) => {
      assertPreparationIdle();
      const first = inputs[0];
      const fault = first === undefined ? undefined : dynamicGeometryFault(first.world as World);
      return fault === undefined ? renderer.prepareDynamicGeometryCandidates(inputs) : err(fault);
    },
    reservePublishedMeshTransfer: (bytes) => renderer.reservePublishedMeshTransfer(bytes),
    preparePublishedMeshResidency: async (input, inputOwnership, options) => {
      const prepared = await afterScheduledPreparation(() =>
        renderer.preparePublishedMeshResidency(input, inputOwnership, options),
      );
      if (!prepared.ok) return prepared;
      const lease = prepared.value;
      return ok({
        ...lease,
        // A previously issued lease may be released while a newer frame holds
        // its extracted references. Recheck every active preparation owner.
        release: (evict) => afterScheduledPreparation(() => lease.release(evict)),
      });
    },
    prepareTextureResidency: (world, textureHandle) => {
      assertPreparationIdle();
      if (lifecycle.state() !== 'alive')
        return err(new TextureResidencyError({ reason: 'renderer-not-alive', textureHandle }));
      return renderer.prepareTextureResidency(world, textureHandle);
    },
    prepareMeshResidency: (world, meshHandle, observePhase) => {
      assertPreparationIdle();
      return renderer.prepareMeshResidency(world, meshHandle, observePhase);
    },
    acceptDynamicGeometry: (
      candidate: DynamicGeometryCandidate,
      ordering: DynamicGeometryOrdering,
    ) => {
      assertPreparationIdle();
      const fault = dynamicGeometryFault(candidate.world as World);
      return fault === undefined ? renderer.acceptDynamicGeometry(candidate, ordering) : err(fault);
    },
    acceptDynamicGeometryCandidates: (candidates, ordering) => {
      assertPreparationIdle();
      const first = candidates[0];
      const fault = first === undefined ? undefined : dynamicGeometryFault(first.world as World);
      return fault === undefined
        ? renderer.acceptDynamicGeometryCandidates(candidates, ordering)
        : err(fault);
    },
    isDynamicGeometryCurrent: (candidate: DynamicGeometryCandidate) =>
      lifecycle.state() === 'alive' && renderer.isDynamicGeometryCurrent(candidate),
    dynamicGeometryReceipt: (candidate: DynamicGeometryCandidate) =>
      dynamicGeometryFault(candidate.world as World) === undefined
        ? renderer.dynamicGeometryReceipt(candidate)
        : undefined,
    cancelDynamicGeometry: (candidate: DynamicGeometryCandidate) => {
      assertPreparationIdle();
      const fault = dynamicGeometryFault(candidate.world as World);
      return fault === undefined ? renderer.cancelDynamicGeometry(candidate) : err(fault);
    },
    retireDynamicGeometry: (candidate: DynamicGeometryCandidate) => {
      assertPreparationIdle();
      const fault = dynamicGeometryFault(candidate.world as World);
      return fault === undefined ? renderer.retireDynamicGeometry(candidate) : err(fault);
    },
    retireSupersededDynamicGeometry: (
      candidate: DynamicGeometryCandidate,
      successor: DynamicGeometryCandidate,
    ) => {
      assertPreparationIdle();
      const fault = dynamicGeometryFault(candidate.world as World);
      return fault === undefined
        ? renderer.retireSupersededDynamicGeometry(candidate, successor)
        : err(fault);
    },
    captureRenderTargetEnvironment: (target, options) =>
      afterScheduledPreparation(() =>
        captureTargetEnvironment(target, options, {
          draw: facade.draw,
          filter: (faces) =>
            afterScheduledPreparation(() => renderer.prepareRenderTargetEnvironment(target, faces)),
        }),
      ),
    prepareRenderTargetEnvironment: (target) =>
      afterScheduledPreparation(() => renderer.prepareRenderTargetEnvironment(target)),
    createRenderTarget: (descriptor) => {
      assertPreparationIdle();
      return renderer.createRenderTarget(descriptor);
    },
    resizeRenderTarget: (target, descriptor) => {
      assertPreparationIdle();
      return renderer.resizeRenderTarget(target, descriptor);
    },
    createRenderTargetTextureSource: (target, options) => {
      assertPreparationIdle();
      return renderer.createRenderTargetTextureSource(target, options);
    },
    requestTargetReadback: (target, request) => {
      assertPreparationIdle();
      return renderer.requestTargetReadback(target, request);
    },
    requestFramebufferSnapshot: (target, request) => {
      assertPreparationIdle();
      return renderer.requestFramebufferSnapshot(target, request);
    },
    destroyRenderTarget: (target) => {
      assertPreparationIdle();
      return renderer.destroyRenderTarget(target);
    },
    importTexture: (input) => {
      assertPreparationIdle();
      return renderer.importTexture(input);
    },
    nativeDevice: () => renderer.nativeDevice(),
    setProfile: (profile) => {
      assertPreparationIdle();
      const state = lifecycle.state();
      if (!isRendererStateOperational(state)) {
        return err(
          new RendererOperationError('renderer-state-invalid', {
            operation: 'set-profile',
            state,
          }),
        );
      }
      return renderer.setProfile(profile);
    },
    setOutputColorSpace: (colorSpace) => {
      assertPreparationIdle();
      const state = lifecycle.state();
      if (!isRendererStateOperational(state)) {
        return err(
          new RendererOperationError('renderer-state-invalid', {
            operation: 'set-output-color-space',
            state,
          }),
        );
      }
      return renderer.setOutputColorSpace(colorSpace);
    },
    setViewportOutput: (mode) => {
      assertPreparationIdle();
      const state = lifecycle.state();
      if (!isRendererStateOperational(state)) {
        return err(
          new RendererOperationError('renderer-state-invalid', {
            operation: 'set-viewport-output',
            state,
          }),
        );
      }
      return (
        renderer.setViewportOutput?.(mode) ??
        err(
          new RendererOperationError('frame-input-invalid', {
            operation: 'set-viewport-output',
            cause: {
              code: 'viewport-output-unavailable',
              expected: 'a renderer created with the optional debug-view extension',
              hint: 'pass viewportOutput: createViewportOutputExtension() when creating the renderer',
            },
          }),
        )
      );
    },
    getViewportOutput: () =>
      renderer.getViewportOutput?.() ?? {
        enabled: false,
        requestedMode: 'lit',
        effectiveMode: 'lit',
        activePath: 'native',
        caveats: [],
      },
    state: () => lifecycle.state(),
    draw: (request) => {
      const state = lifecycle.state();
      if (disposed || !isRendererStateOperational(state)) {
        return err(
          new RendererOperationError('renderer-state-invalid', {
            operation: 'draw',
            state,
          }),
        );
      }
      assertPreparationIdle();
      // A failed record can publish its precise owner error before returning the
      // generic no-submission guard. Preserve that same-call cause for the caller.
      let frameFailure: RenderError | undefined;
      const observeFailure: RendererEventListener = (event) => {
        if (event.kind === 'error') frameFailure ??= event.error;
      };
      listeners.add(observeFailure);
      let result: RenderResult<FrameReceipt, RhiError | RenderError>;
      synchronousDrawDepth++;
      try {
        result = renderer.drawFrame(request);
      } finally {
        listeners.delete(observeFailure);
        if (--synchronousDrawDepth === 0) {
          synchronousDrawDrained?.();
          synchronousDrawDrained = undefined;
        }
      }
      return projectSubmittedFrame(result, frameFailure);
    },
    drawScheduled: (request, schedule) => {
      const state = lifecycle.state();
      const scheduledDraw = renderer.drawFrameScheduled;
      if (
        !isRendererStateOperational(state) ||
        disposed ||
        scheduledFrame !== undefined ||
        scheduledDraw === undefined
      )
        return Promise.resolve(
          err(new RendererOperationError('renderer-state-invalid', { operation: 'draw', state })),
        );
      const controller = new AbortController();
      const cancel = () => controller.abort();
      schedule.signal?.addEventListener('abort', cancel, { once: true });
      if (schedule.signal?.aborted) controller.abort();
      let resolveDone!: (value: RenderResult<FrameReceipt, RenderError>) => void;
      let rejectDone!: (cause: unknown) => void;
      const done = new Promise<RenderResult<FrameReceipt, RenderError>>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      const active = { controller, done };
      scheduledFrame = active;
      void (async () => {
        let frameFailure: RenderError | undefined;
        const observeFailure: RendererEventListener = (event) => {
          if (event.kind === 'error') frameFailure ??= event.error;
        };
        listeners.add(observeFailure);
        try {
          const result = await scheduledDraw.call(renderer, request, {
            checkpoint: schedule.checkpoint,
            signal: controller.signal,
            isCurrent: () =>
              !disposed &&
              isRendererStateOperational(lifecycle.state()) &&
              (schedule.isCurrent?.() ?? true),
          });
          return projectSubmittedFrame(result, frameFailure);
        } finally {
          listeners.delete(observeFailure);
          schedule.signal?.removeEventListener('abort', cancel);
        }
      })().then(resolveDone, rejectDone);
      const clear = () => {
        if (scheduledFrame === active) scheduledFrame = undefined;
      };
      void done.then(clear, clear);
      return done;
    },
    requestObservation: (domains: readonly FrameObservationDomain[]) => {
      assertPreparationIdle();
      return (
        renderer.requestObservation?.(domains) ??
        err(
          new RendererOperationError('renderer-state-invalid', {
            operation: 'request-observation',
            state: lifecycle.state(),
          }),
        )
      );
    },
    currentDeviceGeneration: () =>
      renderer.currentDeviceGeneration?.() ??
      renderer.inspect({ fields: ['frame'] }).frame.deviceGeneration,
    inspect: (options) => {
      const snapshot = renderer.inspect(options) as RenderInspection;
      return options?.fields === undefined || options.fields.some((field) => field === 'state')
        ? { ...snapshot, state: lifecycle.state() }
        : snapshot;
    },
    requestViewportHit: (request, signal) =>
      renderer.requestViewportHit?.(request, signal) ??
      Promise.resolve({ kind: 'unavailable', reason: 'backend' }),
    observeGeometry: (receipt) =>
      renderer.observeGeometry?.(receipt) ??
      Promise.resolve(
        unavailableGeometry('unsupported-renderer', receipt.frameId, receipt.deviceGeneration),
      ),
    observe: (receipt, request) => renderer.observe(receipt, request),
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    releaseSurface: () => {
      assertPreparationIdle();
      const result = renderer.releaseSurface();
      return result.ok
        ? result
        : err(
            new RendererOperationError('surface-unavailable', {
              operation: 'release-surface',
              cause: result.error,
            }),
          );
    },
    restoreSurface: () => {
      assertPreparationIdle();
      const result = renderer.restoreSurface();
      return result.ok
        ? result
        : err(
            new RendererOperationError('surface-unavailable', {
              operation: 'restore-surface',
              cause: result.error,
            }),
          );
    },
    recover: () => {
      if (recoverInFlight !== undefined) return recoverInFlight;
      const state = lifecycle.state();
      if (state !== 'device-lost') {
        return Promise.resolve(
          err(
            new RendererOperationError('renderer-state-invalid', {
              operation: 'recover',
              state,
            }),
          ),
        );
      }
      transition('recovering');
      scheduledFrame?.controller.abort();
      recoverInFlight = Promise.resolve(scheduledFrame?.done)
        .catch(() => undefined)
        .then(() => renderer.recover())
        .then((result): RenderResult<void, RenderError> => {
          if (!result.ok) {
            const error = new RendererOperationError('recovery-failed', {
              operation: 'recover',
              ...projectRecoveryFailureDetail(
                result.error,
                renderer.inspect({ fields: ['recovery'] }).recovery,
              ),
              cause: structuredRendererCause(result.error, 'recover'),
            });
            emit(Object.freeze({ kind: 'error', error }));
            return err(error);
          }
          return ok(undefined);
        })
        .finally(() => {
          transition(renderer.inspect({ fields: ['state'] }).state);
          recoverInFlight = undefined;
        });
      return recoverInFlight;
    },
    dispose: () => {
      if (disposeInFlight !== undefined) return disposeInFlight;
      if (disposed) return Promise.resolve(ok(undefined));
      disposed = true;
      scheduledFrame?.controller.abort();
      const active =
        scheduledFrame?.done ??
        (synchronousDrawDepth > 0
          ? new Promise<void>((resolve) => {
              synchronousDrawDrained = resolve;
            })
          : undefined);
      disposeInFlight = (async () => {
        // Idle disposal closes both facade and legacy Host admission in this
        // stack. Only an already-admitted preparation may delay destruction.
        if (active !== undefined) {
          try {
            await active;
          } catch {
            /* The frame error already owns its failure. */
          }
        }
        const result = renderer.dispose();
        if (!result.ok) emit(Object.freeze({ kind: 'error', error: result.error }));
        transition('disposed');
        offHostEvents();
        listeners.clear();
        return result;
      })().finally(() => {
        disposeInFlight = undefined;
      });
      return disposeInFlight;
    },
  };
  return bindLevelSourceAccess(facade, renderer.levelSourceAccess);
}

// ─── feat-20260520-directional-light-shadow-mapping M1c / w8 helpers ────────

// ─── Helpers ────────────────────────────────────────────────────────────────

export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

export function structuredRendererCause(cause: unknown, operation: string): RendererOperationCause {
  if (typeof cause === 'object' && cause !== null) {
    const candidate = cause as Partial<RendererOperationCause>;
    if (
      typeof candidate.code === 'string' &&
      typeof candidate.expected === 'string' &&
      typeof candidate.hint === 'string'
    ) {
      return {
        code: candidate.code,
        expected: candidate.expected,
        hint: candidate.hint,
        ...(candidate.detail === undefined ? {} : { detail: candidate.detail }),
      };
    }
  }
  const contractFailure = new RendererContractFailureError(
    'draw',
    `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
  return {
    code: contractFailure.code,
    expected: contractFailure.expected,
    hint: contractFailure.hint,
    detail: contractFailure.detail,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function projectRecoveryFailureDetail(
  failure: RecoverFailure,
  inspection: RenderInspection['recovery'],
): Omit<
  import('../errors/render').RendererOperationDetailByCode['recovery-failed'],
  'operation' | 'cause'
> {
  if (failure instanceof RecoveryFailedError) {
    return {
      phase: failure.detail.phase,
      oldGeneration: failure.detail.oldGeneration,
      candidateGeneration: failure.detail.candidateGeneration,
      attempt: failure.detail.attempt,
      elapsedMs: failure.detail.elapsedMs,
      retryable: failure.detail.retryable,
      guidance: failure.detail.guidance,
      owner: failure.detail.owner,
      resourceKind: failure.detail.resourceKind,
      lastOutcome: failure.detail.lastOutcome,
      rehydratedRoots: failure.detail.rehydratedRoots,
      staleLossEvents: failure.detail.staleLossEvents,
      cleanupFailures: Object.freeze(
        failure.detail.cleanupFailures.map((cause: unknown) =>
          structuredRendererCause(cause, 'recovery-cleanup'),
        ),
      ),
    };
  }
  const lastOutcome = inspection.lastOutcome === 'disposed' ? 'disposed' : 'failed';
  return {
    phase: inspection.phase ?? 'cleanup',
    oldGeneration: inspection.fromGeneration,
    candidateGeneration: inspection.candidateGeneration,
    attempt: inspection.attempt,
    elapsedMs: inspection.elapsedMs,
    retryable: false,
    guidance: 'rebuild-renderer',
    owner: inspection.failedOwner ?? 'renderer',
    resourceKind: inspection.failedResourceKind ?? 'pipeline',
    lastOutcome,
    rehydratedRoots: inspection.rehydratedRoots,
    staleLossEvents: inspection.staleLossEvents,
    cleanupFailures: Object.freeze([]),
  };
}

/** One view locks its writer/graph dependency for the existing Renderer frame.
 * The installation epoch is the accepted configuration authority; a readonly
 * annotation or shallow object identity is not a configuration revision. */
export function createScreenReceiverProfile(required: () => boolean) {
  let frame = -1,
    configuration = -1,
    generation = -1;
  let base: StandardProfile | undefined, locked: StandardProfile | undefined;
  let derivedBase: StandardProfile | undefined,
    derivedConfiguration = -1;
  let derived: StandardProfile | undefined;
  return (
    profile: StandardProfile | undefined,
    nextFrame: number,
    installation: number,
    deviceGeneration: number,
  ) => {
    if (
      frame === nextFrame &&
      base === profile &&
      configuration === installation &&
      generation === deviceGeneration
    )
      return locked;
    frame = nextFrame;
    base = profile;
    configuration = installation;
    generation = deviceGeneration;
    if (
      profile?.diffuseGi?.gather !== 'screen-probe' ||
      profile.visibleSurface === true ||
      !required()
    ) {
      locked = profile;
      return locked;
    }
    if (derivedBase !== profile || derivedConfiguration !== installation) {
      derivedBase = profile;
      derivedConfiguration = installation;
      derived = Object.freeze({ ...profile, visibleSurface: true });
    }
    locked = derived;
    return locked;
  };
}
