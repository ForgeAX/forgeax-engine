import type { World } from '@forgeax/engine-ecs';
import {
  type DynamicResolutionController,
  gpuPassFrameMilliseconds,
} from '../pipeline/dynamic-resolution';
import type { RenderExtent } from '../pipeline/render-extent';
import type { resolveSubmittedBarrelMapping } from '../record/barrel-distortion-frame';
import type { FrameRecordingAttempt, GpuDrivenRecordInput } from '../record/frame';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { GpuTimingCapture } from '../record/gpu-timing';
import type { RenderSystemInternals } from '../record/render-context';
import { recordFailureError } from '../render-system-record-attempt';
import { RENDER_GRAPH_SETTLE_SYSTEM } from './graph-systems';
import { ViewRecorder, viewAccepted } from './render-views';
import { frameAccepted, RenderCleanup, RenderCommit, renderSubmission } from './render-world';
import { RENDER_RECORD_COMMIT_SYSTEM } from './submission-systems';
import { requireViewField } from './view-field';
import { recordContext } from './view-record-context';
import { ownerOf } from './view-settlement';

export const RENDER_DISPLAY_COMMIT_SYSTEM = 'render-display-commit';
export const RENDER_DISPLAY_DISCARD_SYSTEM = 'render-display-discard';

/** The exact display products encoded by this view; accepted history is written only in Commit. */
export interface DisplaySubmission {
  readonly frame: number;
  readonly attempt: FrameRecordingAttempt;
  readonly resolution: DynamicResolutionController;
  readonly extent: RenderExtent | undefined;
  readonly rasterRows: GpuDrivenRecordInput['visibleRasterRows'] | undefined;
  readonly renderableCount: number;
  readonly sampleResolution: boolean;
  readonly timing: GpuTimingCapture | undefined;
  readonly barrelMapping: ReturnType<typeof resolveSubmittedBarrelMapping>;
}

function resolutionObservation(
  internals: RenderSystemInternals,
  timing: GpuTimingCapture | undefined,
): Promise<number | undefined> {
  const passCapture = internals.gpuPassTimingCapture;
  const observation =
    passCapture !== undefined
      ? passCapture
          .observe()
          .then((result) =>
            result.ok
              ? gpuPassFrameMilliseconds(result.value, recordContext(internals).gpuPassTimingViewId)
              : undefined,
          )
      : timing
          ?.observation()
          .then((result) => (result.status === 'ready' ? result.frameMs : undefined));
  return observation ?? Promise.resolve(undefined);
}

/** Direct frame harnesses use the same accepted-display kernel. */
export function commitDisplaySubmission(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  submission: DisplaySubmission,
): void {
  const {
    attempt,
    resolution,
    extent,
    rasterRows,
    renderableCount,
    sampleResolution,
    timing,
    barrelMapping,
  } = submission;
  frameState.frameOutputs.sceneSubmitted = true;
  for (const capture of attempt.captureFrames)
    internals.markRenderTargetSubmitted?.(capture.work.target, capture.work.physical);
  for (const work of recordContext(internals).captureView?.state.work ?? [])
    internals.markRenderTargetSubmitted?.(work.target, work.physical);
  resolution.commit(extent, () =>
    typeof rasterRows === 'function' ? rasterRows() : (rasterRows ?? renderableCount),
  );
  if (sampleResolution) resolution.observe(resolutionObservation(internals, timing));
  if (barrelMapping !== undefined) frameState.lastSuccessfulBarrelDistortion = barrelMapping;
}

/** Stage encoded facts; direct frame harnesses have no view Commit lifecycle. */
export function stageDisplaySubmission(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  submission: DisplaySubmission,
): void {
  const accepted = frameAccepted(internals);
  submission.attempt.captureCompletion = submission.attempt.completion;
  frameState.frameOutputs.sceneSubmitted = accepted;
  frameState.displaySubmission = submission;
  if (internals.viewEntity === undefined && accepted)
    commitDisplaySubmission(internals, frameState, submission);
}

/** Promote the submitted display after graph promotion and before record history consumes it. */
export function registerDisplaySubmissionSystems(world: World): void {
  world
    .addSystem(RenderCommit, {
      commands: 'none',
      name: RENDER_DISPLAY_COMMIT_SYSTEM,
      after: [RENDER_GRAPH_SETTLE_SYSTEM],
      before: [RENDER_RECORD_COMMIT_SYSTEM],
      queries: [{ read: [ViewRecorder] }],
      fn: (world, [rows]) => {
        const { frame } = renderSubmission(world);

        rows.forEach((row) => {
          const entity = row.entity;

          const { internals, frameState } = ownerOf(
            world,
            requireViewField(world, entity, ViewRecorder, 'state'),
          );
          const submission = frameState.displaySubmission;
          if (submission?.frame !== frame || !viewAccepted(world, entity)) return;
          try {
            commitDisplaySubmission(internals, frameState, submission);
          } catch (cause) {
            internals.errorRegistry.fire(recordFailureError(cause));
          }
        });
      },
    })
    .unwrap();
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: RENDER_DISPLAY_DISCARD_SYSTEM,
      queries: [{ read: [ViewRecorder] }],
      fn: (world, [rows]) => {
        rows.forEach((row) => {
          const entity = row.entity;
          ownerOf(
            world,
            requireViewField(world, entity, ViewRecorder, 'state'),
          ).frameState.displaySubmission = undefined;
        });
      },
    })
    .unwrap();
}
