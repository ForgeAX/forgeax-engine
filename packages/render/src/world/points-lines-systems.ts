import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { defineSystem } from '@forgeax/engine-ecs';
import type {
  PointsLinesFrameOutcome,
  StandardPointsLinesOwner,
} from '../points-lines/standard-owner';
import { standardTopologyKind } from '../record/frame-lighting';
import { RenderCascadeFitOrder, RenderViewFrameOrder } from '../system-order';

import { viewLightsOf } from './render-lights';
import { ViewRecorder, ViewSubmission } from './render-views';
import { RenderCleanup, RenderCommit, RenderPrepare, renderSubmission } from './render-world';
import { requireViewField } from './view-field';
import { stagedViewInputs, ViewFrame, type ViewFrameState } from './view-frame-systems';
import { ViewPointsLines, viewPointsLinesState } from './view-points-lines';
import { recordContext } from './view-record-context';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';

export const POINTS_LINES_COMMIT_SYSTEM = 'points-lines-commit';
export const POINTS_LINES_DISCARD_SYSTEM = 'points-lines-discard';
export const VIEW_POINTS_LINES_SYSTEM = 'view-points-lines';
export const POINTS_LINES_SETTLE_SYSTEM = 'points-lines-settle';

/** Admit and upload the staged view's Points/Lines rows into `owner`; never throws. */
function preparePointsLines(
  world: World,
  entity: EntityHandle,
  staged: ViewFrameState,
  view: ViewSettlementOwner,
  owner: StandardPointsLinesOwner,
): PointsLinesFrameOutcome {
  try {
    const { frame, source: resourceWorld } = stagedViewInputs(world, staged);
    const lights = viewLightsOf(world, entity);
    // The lane follows the frame's Standard topology, which the same lights decide.
    const clustered =
      lights !== undefined &&
      standardTopologyKind(
        view.internals.device.caps.storageBuffer,
        lights.point.length + lights.spot.length + lights.rect.length,
      ) === 'clustered';
    // The retained set before the camera cull: a capture pass admits rows the main
    // camera culled, so the cull must not shrink what is prepared.
    const uncull = view.scene.shadowCasterProjection()?.renderables;
    const outcome = owner.prepareFrame(uncull ?? frame.renderables, () => resourceWorld, clustered);
    // The view's parameter buffer grows before recording addresses its slots.
    if (outcome.ok && (outcome.rows.size === 0 || outcome.slots > 0))
      recordContext(view.internals)
        .getPipelineState()
        ?.ensurePointsLinesViewCapacity?.(outcome.slots);
    return outcome;
  } catch (cause) {
    return { ok: false, cause };
  }
}

/**
 * A view's own attempt of this frame decides its Points/Lines observations: an
 * accepted attempt publishes them and fences its retired GPU rows behind the
 * frame's completion, a rejected one drops them. A held view keeps its last
 * publication.
 */
export function registerPointsLinesSystems(world: World): void {
  const systemToken1 = defineSystem({
    commands: 'none',
    name: VIEW_POINTS_LINES_SYSTEM,
    // The validated visible set is the view's culled frame; the lane follows its fitted lights.
    after: [RenderViewFrameOrder, RenderCascadeFitOrder],
    queries: [{ read: [ViewRecorder, ViewFrame, ViewPointsLines] }],
    fn: (world, [views]) => {
      const frame = renderSubmission(world).frame;

      views.forEach((row) => {
        const entity = row.entity;

        const staged = world
          .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
          .unwrap();
        // A held view records nothing; a failed frame is its recording's recovery.
        if (staged.frame !== frame || staged.result?.ok !== true || staged.mode === false) return;
        const owner = viewPointsLinesState(
          world,
          requireViewField(world, entity, ViewPointsLines, 'state'),
        );
        const view = ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state'));
        owner.stage(frame, preparePointsLines(world, entity, staged, view, owner));
      });
    },
  });
  world.addSystem(RenderPrepare, systemToken1).unwrap();
  const systemToken2 = defineSystem({
    commands: 'none',
    name: POINTS_LINES_SETTLE_SYSTEM,
    queries: [{ read: [ViewPointsLines] }],
    // An outcome no recording took must not pin its buffers past the frame.
    fn: (world, [views]) => {
      views.forEach((row) => {
        const entity = row.entity;
        viewPointsLinesState(
          world,
          requireViewField(world, entity, ViewPointsLines, 'state'),
        ).settle();
      });
    },
  });
  world.addSystem(RenderCleanup, systemToken2).unwrap();
  const systemToken3 = defineSystem({
    commands: 'none',
    name: POINTS_LINES_COMMIT_SYSTEM,
    queries: [{ read: [ViewSubmission, ViewPointsLines] }],
    fn: (world, [views]) => {
      const { frame, completion } = renderSubmission(world);

      views.forEach((row) => {
        const entity = row.entity;

        if (
          !requireViewField(world, entity, ViewSubmission, 'accepted') ||
          requireViewField(world, entity, ViewSubmission, 'attempt') !== frame
        )
          return;
        viewPointsLinesState(
          world,
          requireViewField(world, entity, ViewPointsLines, 'state'),
        ).commit(completion);
      });
    },
  });
  world.addSystem(RenderCommit, systemToken3).unwrap();
  const systemToken4 = defineSystem({
    commands: 'none',
    name: POINTS_LINES_DISCARD_SYSTEM,
    queries: [{ read: [ViewSubmission, ViewPointsLines] }],
    fn: (world, [views]) => {
      const frame = renderSubmission(world).frame;

      views.forEach((row) => {
        const entity = row.entity;

        if (
          requireViewField(world, entity, ViewSubmission, 'accepted') ||
          requireViewField(world, entity, ViewSubmission, 'attempt') !== frame
        )
          return;
        viewPointsLinesState(
          world,
          requireViewField(world, entity, ViewPointsLines, 'state'),
        ).discard();
      });
    },
  });
  world.addSystem(RenderCleanup, systemToken4).unwrap();
}
