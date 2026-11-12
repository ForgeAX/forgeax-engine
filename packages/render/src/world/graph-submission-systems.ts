import type { World } from '@forgeax/engine-ecs';
import type { RendererFrameStage } from '../assembly/renderer-frame-transaction';
import type { FrameDiffuseGi } from '../record/frame-diffuse-gi';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { GpuTimingCapture } from '../record/gpu-timing';
import type { RenderSystemInternals } from '../record/render-context';
import { recordFailureError } from '../render-system-record-attempt';
import { requireGiSubmissions } from './gi-systems';
import { RENDER_GRAPH_SETTLE_SYSTEM } from './graph-systems';
import { ViewRecorder, viewAccepted } from './render-views';
import { RenderCleanup, RenderCommit, renderSubmission } from './render-world';
import { requireViewField } from './view-field';
import { ownerOf } from './view-settlement';

/** RenderCommit: accepted graph work publishes timing, GI and completion observers. */
export const RENDER_GRAPH_SUBMISSION_COMMIT_SYSTEM = 'render-graph-submission-commit';
/** RenderCleanup: abandoned or rejected graph work releases its timing capture. */
export const RENDER_GRAPH_SUBMISSION_ABORT_SYSTEM = 'render-graph-submission-abort';

/** One graph execution's submission-sensitive products; recording only stages them. */
export interface GraphSubmission {
  readonly frame: number;
  readonly timing: GpuTimingCapture | undefined;
  readonly passTiming: RenderSystemInternals['gpuPassTimingCapture'];
  readonly gi: FrameDiffuseGi | undefined;
  /** Diagnostic observers of accepted work, never owners of history. */
  readonly onAccepted: (() => void) | undefined;
  submitted: boolean;
  rejectedStage: RendererFrameStage | undefined;
  settled: boolean;
}

/** Direct graph harnesses use the same settlement kernel without a view entity. */
export function commitGraphSubmission(
  internals: RenderSystemInternals,
  candidate: GraphSubmission,
): void {
  if (candidate.settled) return;
  candidate.settled = true;
  candidate.timing?.markSubmitted();
  if (candidate.gi !== undefined) requireGiSubmissions(internals).submitted.push(candidate.gi);
  candidate.onAccepted?.();
}

export function abortGraphSubmission(
  frameState: RenderFrameState,
  candidate: GraphSubmission,
): void {
  if (candidate.settled) return;
  candidate.settled = true;
  const stage = candidate.rejectedStage ?? 'submit';
  frameState.rejectedStage = stage;
  candidate.passTiming?.abort({ code: stage });
  candidate.timing?.discard();
}

/** Graph promotion precedes these products; every GI history consumer follows them. */
export function registerGraphSubmissionSystems(world: World): void {
  world
    .addSystem(RenderCommit, {
      commands: 'none',
      name: RENDER_GRAPH_SUBMISSION_COMMIT_SYSTEM,
      after: [RENDER_GRAPH_SETTLE_SYSTEM],
      before: ['gi-submission-commit'],
      queries: [{ read: [ViewRecorder] }],
      fn: (world, [rows]) => {
        const { frame } = renderSubmission(world);

        rows.forEach((row) => {
          const entity = row.entity;

          const { internals, frameState } = ownerOf(
            world,
            requireViewField(world, entity, ViewRecorder, 'state'),
          );
          const candidate = frameState.graphSubmission;
          if (candidate?.frame !== frame || !candidate.submitted || !viewAccepted(world, entity))
            return;
          try {
            commitGraphSubmission(internals, candidate);
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
      name: RENDER_GRAPH_SUBMISSION_ABORT_SYSTEM,
      queries: [{ read: [ViewRecorder] }],
      fn: (world, [rows]) => {
        rows.forEach((row) => {
          const entity = row.entity;

          const { internals, frameState } = ownerOf(
            world,
            requireViewField(world, entity, ViewRecorder, 'state'),
          );
          const candidate = frameState.graphSubmission;
          frameState.featureGraphReceipt = undefined;
          frameState.graphSubmission = undefined;
          if (candidate === undefined) return;
          try {
            abortGraphSubmission(frameState, candidate);
          } catch (cause) {
            internals.errorRegistry.fire(recordFailureError(cause));
          }
        });
      },
    })
    .unwrap();
}
