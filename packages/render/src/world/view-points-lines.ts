import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { Handle } from '@forgeax/engine-types';
import { RendererOperationError } from '../errors/render';
import { pointsLinesRowKey, StandardPointsLinesOwner } from '../points-lines/standard-owner';
import type { PointsLinesPreparedRows, RenderSystemInternals } from '../record/render-context';
import { renderSubmission, renderWorldFor } from './render-world';
import { requireViewField } from './view-field';

/** The view's Points/Lines preparation cache; it lives and dies with the view entity. */
export const ViewPointsLines = defineComponent('ViewPointsLines', {
  state: 'unique<StandardPointsLinesOwner>',
});

/** Give a view entity its Points/Lines owner; idempotent. */
export function adoptViewPointsLines(
  world: World,
  entity: EntityHandle,
  internals: RenderSystemInternals,
): StandardPointsLinesOwner {
  const existing = viewPointsLines(world, entity);
  if (existing !== undefined) return existing;
  const owner = new StandardPointsLinesOwner(internals);
  const state = world.allocUniqueRef('StandardPointsLinesOwner', owner, () => owner.dispose());
  world.addComponent(entity, { component: ViewPointsLines, data: { state } }).unwrap();
  return owner;
}

/** The Points/Lines owner of a view entity, or undefined when it has none. */
export function viewPointsLines(
  world: World,
  entity: EntityHandle | undefined,
): StandardPointsLinesOwner | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewPointsLines)) return undefined;
  return world
    .resolveUniqueRef<StandardPointsLinesOwner>(
      requireViewField(world, entity, ViewPointsLines, 'state'),
    )
    .unwrap();
}

/** Resolve the owner behind a `ViewPointsLines.state` handle read by a system. */
export function viewPointsLinesState(
  world: World,
  state: Handle<string, 'unique'>,
): StandardPointsLinesOwner {
  return world.resolveUniqueRef<StandardPointsLinesOwner>(state).unwrap();
}

function unprepared(): never {
  throw new Error('A Points/Lines row records only what view-points-lines prepared this frame');
}

/**
 * The parameter slots `view-points-lines` prepared for this recording's view
 * this frame; 0 when nothing was prepared or the preparation failed. A capture
 * view sizes its own buffer from it when its pipeline is built.
 */
export function preparedPointsLinesSlots(internals: RenderSystemInternals): number {
  const world = renderWorldFor(internals);
  const outcome = viewPointsLines(world, internals.viewEntity)?.stagedOutcome(
    renderSubmission(world).frame,
  );
  return outcome?.ok === true ? outcome.slots : 0;
}

/**
 * The rows `view-points-lines` prepared for this recording's view this frame.
 * A failed preparation is rethrown inside the recording's own recovery, and a
 * row whose mesh or material changed after RenderPrepare (a Feature extract
 * mutated its source) rejects the submission, which retries from fresh rows.
 * A recording outside a Render World view has no rows to draw.
 */
export function consumeViewPointsLines(
  internals: RenderSystemInternals,
): PointsLinesPreparedRows | undefined {
  const world = renderWorldFor(internals);
  const owner = viewPointsLines(world, internals.viewEntity);
  if (owner === undefined) return undefined;
  const outcome = owner.stagedOutcome(renderSubmission(world).frame);
  if (outcome === undefined)
    return {
      submission: unprepared,
      slot: unprepared,
    };
  if (!outcome.ok) throw outcome.cause;
  // The view's own buffer grew in RenderPrepare; capture views grow from `preparedPointsLinesSlots`.
  for (const row of outcome.rows.values()) {
    if (row.stale())
      throw new RendererOperationError('frame-submit-rejected', {
        operation: 'draw',
        stage: 'submit',
        accepted: false,
      });
  }
  // A row outside the view's frame (a capture pass reaching a row the main
  // camera culled) was not prepared and is not drawn.
  return {
    submission: (entry) => outcome.rows.get(pointsLinesRowKey(entry.source))?.submission,
    slot: (entry) => outcome.rows.get(pointsLinesRowKey(entry.source))?.slot ?? 0,
  };
}
