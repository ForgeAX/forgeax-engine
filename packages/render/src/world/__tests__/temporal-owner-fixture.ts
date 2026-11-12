import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { TemporalViewHistory } from '../../temporal/frame';
import { ViewRecorder } from '../render-views';
import { RenderPrepare, renderSubmission } from '../render-world';
import { RENDER_SCENE_PUBLISH_SYSTEM } from '../scene-systems';
import {
  RENDER_VIEW_FRAME_SYSTEM,
  ViewFrame,
  type ViewFrameResult,
  type ViewFrameState,
} from '../view-frame-systems';
import type { ViewSettlementOwner } from '../view-settlement';

/**
 * Give a test's view recorder payload an owner bag with an empty temporal
 * history, for tests that only exercise other Render World domains: the
 * temporal commit and discard systems then have nothing to advance. `owner`
 * replaces owner-bag members a test drives (its scene, probes, internals,
 * ...). The recorder is returned itself, so its own fields stay observable.
 */
export function withInertTemporal<T extends object>(
  recorder: T,
  owner: Partial<Record<keyof ViewSettlementOwner, unknown>> = {},
): T {
  const given = owner.frameState as object | undefined;
  // A test's frame state keeps its identity and gains the inert temporal fields it omits.
  const frameState = Object.assign(
    {
      temporalFrameTransaction: { inspect: () => ({ staged: false }) },
      temporalView: new TemporalViewHistory(),
    },
    given,
  );
  const internals = { device: { queue: {} }, errorRegistry: { fire: () => undefined } };
  return Object.defineProperty(recorder, 'owner', {
    value: {
      internals,
      skin: {
        beginRecording: () => undefined,
        trackSubmittedWork: () => undefined,
        complete: () => [],
      },
      ssrFormats: new WeakMap(),
      lod: { cell: undefined },
      ...owner,
      frameState: given === undefined ? frameState : Object.assign(given, frameState),
    },
    enumerable: false,
  });
}

/**
 * Stand in for `render-view-frame` in tests of the systems that read its
 * product: each staged view with a recorder resolves its frame to
 * `prepare(entity)`, in the same RenderPrepare slot.
 */
export function registerViewFrameStub(
  world: World,
  prepare: (entity: EntityHandle) => ViewFrameResult,
): void {
  world
    .addSystem(RenderPrepare, {
      name: RENDER_VIEW_FRAME_SYSTEM,
      after: [RENDER_SCENE_PUBLISH_SYSTEM],
      queries: [{ read: [ViewRecorder, ViewFrame] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        for (const row of rows) {
          const state = world.resolveUniqueRef<ViewFrameState>(row.get(ViewFrame).state).unwrap();
          if (state.frame === frame) state.result = prepare(row.entity);
        }
      },
    })
    .unwrap();
}
