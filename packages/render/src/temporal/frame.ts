import { err, ok, type Result } from '@forgeax/engine-types';
import { TemporalFrameSubmitError } from '../errors/render';
import type { RenderFrameState } from '../record/frame-snapshot';

export type TemporalResetReason =
  | 'none'
  | 'camera-cut'
  | 'resize'
  | 'signature-change'
  | 'depth-discontinuity'
  | 'out-of-screen'
  | 'queue-submit-failed'
  | 'device-recovery';

export interface TemporalFrameInput {
  readonly frameId: number;
  readonly currentViewProjection: Float32Array;
  readonly jitter: readonly [number, number];
  readonly viewport: { readonly width: number; readonly height: number };
  /** Current camera origin, retained only as accepted temporal history. */
  readonly cameraPosition?: readonly [number, number, number];
  readonly resetReason?: Exclude<TemporalResetReason, 'none' | 'queue-submit-failed'>;
}

export interface TemporalFrame {
  readonly frameId: number;
  readonly currentViewProjection: Float32Array;
  readonly previousViewProjection: Float32Array | undefined;
  readonly jitter: readonly [number, number];
  readonly viewport: { readonly width: number; readonly height: number };
  readonly currentCameraPosition: readonly [number, number, number];
  readonly previousCameraPosition: readonly [number, number, number] | undefined;
  readonly resetReason: TemporalResetReason;
  readonly historyEpoch: number;
  readonly deviceEpoch: number;
}

export interface TemporalSubmitResult {
  readonly accepted: boolean;
  readonly reason?: 'queue-submit-failed';
  readonly resetReason?: Exclude<TemporalResetReason, 'none' | 'queue-submit-failed'>;
}

/** Detached candidate/lifecycle facts consumed by Renderer inspection. */
export interface TemporalFrameTransactionInspection {
  readonly accepted: boolean;
  readonly staged: boolean;
  readonly lastFailure?: 'queue-submit-failed';
}

export interface TemporalFrameTransaction {
  stage(input: TemporalFrameInput): void;
  commit(submit: TemporalSubmitResult): Result<TemporalFrame, TemporalFrameSubmitError>;
  snapshot(): TemporalFrame;
  inspect(): TemporalFrameTransactionInspection;
  /** Drop accepted/staged history after a producer or device generation cut. */
  reset(reason?: Extract<TemporalResetReason, 'signature-change' | 'device-recovery'>): void;
}

function copyInput(input: TemporalFrameInput): TemporalFrameInput {
  return {
    ...input,
    currentViewProjection: new Float32Array(input.currentViewProjection),
    jitter: [input.jitter[0], input.jitter[1]],
    viewport: { ...input.viewport },
    ...(input.cameraPosition === undefined
      ? {}
      : { cameraPosition: [...input.cameraPosition] as [number, number, number] }),
  };
}

function copyFrame(frame: TemporalFrame): TemporalFrame {
  return {
    ...frame,
    currentViewProjection: new Float32Array(frame.currentViewProjection),
    previousViewProjection:
      frame.previousViewProjection === undefined
        ? undefined
        : new Float32Array(frame.previousViewProjection),
    jitter: [frame.jitter[0], frame.jitter[1]],
    viewport: { ...frame.viewport },
    currentCameraPosition: [...frame.currentCameraPosition] as [number, number, number],
    previousCameraPosition:
      frame.previousCameraPosition === undefined
        ? undefined
        : ([...frame.previousCameraPosition] as [number, number, number]),
  };
}

export function createTemporalFrameTransaction(options: {
  readonly deviceEpoch: number;
}): TemporalFrameTransaction {
  let accepted: TemporalFrame | undefined;
  let staged: TemporalFrameInput | undefined;
  let historyEpoch = 0;
  let pendingResetReason: Exclude<TemporalResetReason, 'none' | 'queue-submit-failed'> | undefined;
  let lastFailure: TemporalFrameTransactionInspection['lastFailure'];

  return {
    stage(input) {
      staged = copyInput(input);
    },
    commit(submit) {
      if (!submit.accepted) {
        staged = undefined;
        lastFailure = submit.reason ?? 'queue-submit-failed';
        return err(new TemporalFrameSubmitError(submit.reason ?? 'queue-submit-failed'));
      }
      if (staged === undefined) {
        lastFailure = 'queue-submit-failed';
        return err(new TemporalFrameSubmitError('queue-submit-failed'));
      }

      const resetReason = submit.resetReason ?? staged.resetReason ?? pendingResetReason ?? 'none';
      const shouldReset = resetReason !== 'none';
      if (shouldReset) historyEpoch += 1;
      const next: TemporalFrame = {
        frameId: staged.frameId,
        currentViewProjection: new Float32Array(staged.currentViewProjection),
        previousViewProjection:
          accepted === undefined || shouldReset
            ? undefined
            : new Float32Array(accepted.currentViewProjection),
        jitter: [staged.jitter[0], staged.jitter[1]],
        viewport: { ...staged.viewport },
        currentCameraPosition: staged.cameraPosition ?? [0, 0, 0],
        previousCameraPosition:
          accepted === undefined || shouldReset ? undefined : accepted.currentCameraPosition,
        resetReason,
        historyEpoch,
        deviceEpoch: options.deviceEpoch,
      };
      accepted = next;
      staged = undefined;
      pendingResetReason = undefined;
      lastFailure = undefined;
      return ok(copyFrame(next));
    },
    snapshot() {
      if (accepted === undefined)
        throw new Error('TemporalFrame snapshot is unavailable before commit');
      return copyFrame(accepted);
    },
    inspect() {
      return {
        accepted: accepted !== undefined,
        staged: staged !== undefined,
        ...(lastFailure === undefined ? {} : { lastFailure }),
      };
    },
    reset(reason = 'signature-change') {
      accepted = undefined;
      staged = undefined;
      historyEpoch += 1;
      // The reason is carried into the next accepted frame while clearing the
      // committed frame prevents stale motion vectors from crossing the
      // producer/device boundary.
      pendingResetReason = reason;
      lastFailure = undefined;
    },
  };
}

/** Drop accepted, staged and pending temporal history at a producer or device generation cut. */
export function resetTemporalHistory(
  frameState: RenderFrameState,
  reason: Extract<TemporalResetReason, 'signature-change' | 'device-recovery'>,
): void {
  frameState.temporalFrameTransaction.reset(reason);
  frameState.temporalFrame = undefined;
  frameState.lastSuccessfulTemporalView = undefined;
  frameState.successfulTemporalFrameIndex = 0;
  frameState.pendingTemporalCommit = { kind: 'none' };
}
