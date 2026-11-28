import { defineSystem, type World } from '@forgeax/engine-ecs';
import { settleViewFeatures } from '../features/view-feature-work';
import { settleClusterWorkConformanceFrame } from '../record/cluster-work-conformance';
import { promoteGraphCandidate, rollbackGraphCandidate } from '../record/typed-frame-graph';
import { recordFailureError } from '../render-system-record-attempt';
import { RenderGraphSettleOrder } from '../system-order';
import { renderFrameEncoder } from './record-systems';
import { ViewRecorder, ViewSubmission, viewAccepted } from './render-views';
import { RenderCommit, renderSubmission } from './render-world';
import { requireViewField } from './view-field';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';

export const RENDER_GRAPH_SETTLE_SYSTEM = 'render-graph-settle';

/** A view can prepare only after the current frame has opened its encoder. */
export function awaitsRenderRecord(world: World): boolean {
  return renderSubmission(world).open && renderFrameEncoder(world).kind !== 'open';
}

function settleViewGraph(
  { frameState, internals }: ViewSettlementOwner,
  accepted: boolean,
  submitted: boolean,
): void {
  try {
    if (accepted) promoteGraphCandidate(frameState);
    else rollbackGraphCandidate(frameState, frameState.pipelinePreparationPending === true);
    settleViewFeatures(frameState, accepted);
    settleClusterWorkConformanceFrame(
      frameState.standardClusterWorkConformance,
      frameState.frameNumber,
      accepted ? 'submitted' : submitted ? 'pending' : 'unsubmitted',
    );
  } catch (cause) {
    internals.errorRegistry.fire(recordFailureError(cause));
  } finally {
    frameState.materialBgAssemblyCache.finishRecording();
    frameState.frameNumber += 1;
  }
}

/** Commit is the single owner of view history and graph retirement after submission. */
export function registerGraphSystems(world: World): void {
  world
    .addSystem(
      RenderCommit,
      defineSystem({
        sets: [RenderGraphSettleOrder],
        commands: 'none',
        name: RENDER_GRAPH_SETTLE_SYSTEM,
        before: [RenderCommit],
        queries: [{ read: [ViewRecorder, ViewSubmission] }],
        fn: (world, [rows]) => {
          const submission = renderSubmission(world);
          rows.forEach(({ entity }) => {
            if (requireViewField(world, entity, ViewSubmission, 'attempt') !== submission.frame)
              return;
            settleViewGraph(
              ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
              viewAccepted(world, entity) &&
                requireViewField(world, entity, ViewSubmission, 'scene'),
              submission.completion !== undefined,
            );
          });
        },
      }),
    )
    .unwrap();
}
