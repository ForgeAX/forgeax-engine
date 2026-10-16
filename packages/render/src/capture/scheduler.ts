import { CUBE_CAMERA_FACE_ORDER, type CubeCameraFace } from '../components/cube-camera';
import type { RenderError } from '../errors/render';
import { RenderTargetOperationFailedError, RenderTargetStateInvalidError } from '../errors/render';
import type { CubeCameraSnapshot, RenderResult } from '../render-contract';
import type { RenderTarget } from '../targets/contracts';
import { buildCubeCameraFaceViews, type CubeCameraFaceView } from './cube-views';

export interface CubeCaptureWork extends CubeCameraFaceView {
  readonly target: RenderTarget;
  readonly requestVersion: number;
  readonly candidateGeneration: number;
}

export interface CubeCaptureInspection {
  readonly target: RenderTarget;
  readonly activeGeneration: number;
  readonly candidateGeneration?: number;
  readonly completedVersion: number;
  readonly pendingFaces: readonly CubeCameraFace[];
  readonly fallback: 'neutral' | 'previous-active';
  readonly nestedRejections: number;
}

export interface CubeCaptureSchedulerOptions {
  readonly maxFacesPerFrame?: number;
}

export type CubeCaptureRenderableKind = 'opaque' | 'transparent' | 'environment' | 'debug' | 'ui';

export interface CubeCaptureRenderable {
  readonly kind: CubeCaptureRenderableKind;
  readonly target?: RenderTarget;
}

/** Apply the Standard capture visibility boundary to one extracted scene. */
export function selectCubeCaptureRenderables(
  renderables: readonly CubeCaptureRenderable[],
  candidateTarget: RenderTarget,
): readonly CubeCaptureRenderable[] {
  return renderables.filter(
    (renderable) =>
      renderable.kind !== 'debug' &&
      renderable.kind !== 'ui' &&
      renderable.target !== candidateTarget,
  );
}

export interface CubeCaptureScheduler {
  beginFrame(): void;
  cancel(target: RenderTarget): void;
  invalidate(target: RenderTarget): void;
  request(request: CubeCameraSnapshot): RenderResult<{ readonly scheduled: boolean }, RenderError>;
  nextWork(): readonly CubeCaptureWork[];
  completeSubmission(
    submitted: boolean,
    completed?: Promise<unknown>,
  ): RenderResult<void, RenderError>;
  inspect(target: RenderTarget): CubeCaptureInspection;
}

interface PendingCapture {
  readonly request: CubeCameraSnapshot;
  readonly views: readonly CubeCameraFaceView[];
  readonly candidateGeneration: number;
  readonly written: Set<CubeCameraFace>;
  inFlight: readonly CubeCaptureWork[];
  submitted: boolean;
}

interface CaptureState {
  readonly target: RenderTarget;
  activeGeneration: number;
  completedVersion: number;
  pending: PendingCapture | undefined;
  nestedRejections: number;
}

function invalid(
  reason: 'generation-mismatch' | 'uninitialized',
): RenderResult<never, RenderError> {
  return {
    ok: false,
    error: new RenderTargetStateInvalidError({
      operation: 'source',
      reason,
      state: reason === 'uninitialized' ? 'uninitialized' : 'candidate',
      generation: 0,
    }),
  };
}

function failed(generation: number, cause: unknown): RenderResult<never, RenderError> {
  return {
    ok: false,
    error: new RenderTargetOperationFailedError({
      operation: 'source',
      stage: 'submit',
      generation,
      cause,
      recovery: 'retain-last-known-good',
    }),
  };
}

function validateRequest(request: CubeCameraSnapshot): RenderResult<void, RenderError> {
  if (!Number.isInteger(request.requestVersion) || request.requestVersion < 0) {
    return invalid('generation-mismatch');
  }
  if (!Number.isInteger(request.faceBudget) || request.faceBudget < 1 || request.faceBudget > 6) {
    return invalid('uninitialized');
  }
  if (request.updateIntent === 'once' && request.requestVersion > 1) {
    return invalid('generation-mismatch');
  }
  return { ok: true, value: undefined };
}

/**
 * Schedules CubeCamera views inside the existing display frame. The scheduler
 * never owns a World, encoder, or queue; callers contribute the returned work
 * to the frame graph and report the one matching submission result.
 */
export function createCubeCaptureScheduler(
  options: CubeCaptureSchedulerOptions = {},
): CubeCaptureScheduler {
  const maxFacesPerFrame = Math.max(1, Math.min(6, Math.floor(options.maxFacesPerFrame ?? 1)));
  const states = new WeakMap<object, CaptureState>();
  let activeCapture: CaptureState | undefined;
  let frameOpen = false;

  const stateFor = (target: RenderTarget): CaptureState => {
    const existing = states.get(target as object);
    if (existing !== undefined) return existing;
    const created: CaptureState = {
      target,
      activeGeneration: 0,
      completedVersion: 0,
      pending: undefined,
      nestedRejections: 0,
    };
    states.set(target as object, created);
    return created;
  };

  return {
    beginFrame() {
      frameOpen = true;
    },

    cancel(target) {
      if (activeCapture?.target !== target) return;
      activeCapture.pending = undefined;
      activeCapture = undefined;
    },

    invalidate(target) {
      if (activeCapture?.target === target) activeCapture = undefined;
      states.delete(target);
    },

    request(request) {
      const valid = validateRequest(request);
      if (!valid.ok) return valid;
      const state = stateFor(request.target);
      if (activeCapture?.pending !== undefined) {
        state.nestedRejections += 1;
        return invalid('generation-mismatch');
      }
      const shouldSchedule =
        request.updateIntent === 'continuous' ||
        state.activeGeneration === 0 ||
        request.requestVersion > state.completedVersion;
      if (!shouldSchedule) return { ok: true, value: { scheduled: false } };
      const views = buildCubeCameraFaceViews({
        position: request.position,
        near: request.near,
        far: request.far,
      });
      const pending: PendingCapture = {
        request,
        views,
        candidateGeneration: state.activeGeneration + 1,
        written: new Set(),
        inFlight: [],
        submitted: false,
      };
      state.pending = pending;
      activeCapture = state;
      return { ok: true, value: { scheduled: true } };
    },

    nextWork() {
      if (!frameOpen || activeCapture?.pending === undefined) return [];
      const pending = activeCapture.pending;
      if (pending.submitted) return [];
      if (pending.inFlight.length > 0) return pending.inFlight;
      const remaining = pending.views.filter((view) => !pending.written.has(view.face));
      const count = Math.min(maxFacesPerFrame, pending.request.faceBudget, remaining.length);
      const work = remaining.slice(0, count).map((view) => ({
        ...view,
        target: pending.request.target,
        requestVersion: pending.request.requestVersion,
        candidateGeneration: pending.candidateGeneration,
      }));
      pending.inFlight = work;
      return work;
    },

    completeSubmission(submitted, completed) {
      const state = activeCapture;
      const pending = state?.pending;
      if (state === undefined || pending === undefined) return invalid('uninitialized');
      if (!submitted) {
        state.pending = undefined;
        activeCapture = undefined;
        return failed(pending.candidateGeneration, new Error('cube capture submission failed'));
      }
      pending.submitted = true;
      const submittedWork = pending.inFlight;
      const commit = (): void => {
        if (activeCapture !== state || state.pending !== pending) return;
        for (const work of submittedWork) pending.written.add(work.face);
        pending.inFlight = [];
        pending.submitted = false;
        if (pending.written.size === CUBE_CAMERA_FACE_ORDER.length) {
          state.activeGeneration = pending.candidateGeneration;
          state.completedVersion = pending.request.requestVersion;
          state.pending = undefined;
          activeCapture = undefined;
        }
      };
      if (completed === undefined) commit();
      else
        void completed.then(commit, () => {
          if (activeCapture === state && state.pending === pending) {
            state.pending = undefined;
            activeCapture = undefined;
          }
        });
      return { ok: true, value: undefined };
    },

    inspect(target) {
      const state = stateFor(target);
      const pending = state.pending;
      const pendingFaces =
        pending === undefined
          ? []
          : pending.views
              .filter(
                (view) =>
                  !pending.written.has(view.face) &&
                  !pending.inFlight.some((work) => work.face === view.face),
              )
              .map((view) => view.face);
      return Object.freeze({
        target: state.target,
        activeGeneration: state.activeGeneration,
        ...(state.pending === undefined
          ? {}
          : { candidateGeneration: state.pending.candidateGeneration }),
        completedVersion: state.completedVersion,
        pendingFaces,
        fallback: state.activeGeneration === 0 ? 'neutral' : 'previous-active',
        nestedRejections: state.nestedRejections,
      });
    },
  };
}
