import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { RecorderSession } from '@forgeax/engine-profiler';
import type { FrameCacheCounters } from '../inspection-types';
import type { RenderResourceScope } from '../publication/resource-scope';
import { runProfiledRenderPhase } from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import type { DispatchList } from '../render-system-extract';
import { TransparentSortCache, type TransparentSortRows } from '../systems/transparent-dispatch';
import { RenderQueue } from './render-world';
import { requireViewField } from './view-field';

export const RENDER_PHASE_SORT_SYSTEM = 'render-phase-sort';

/** The culled dispatch a view stages for `render-phase-sort`, with what its order reads. */
export interface PhaseSortInput {
  readonly dispatch: DispatchList;
  /** Resource owner of the transparent-sort configuration. */
  readonly scope: RenderResourceScope;
  readonly cameras: readonly CameraSnapshot[];
  readonly rows: TransparentSortRows;
  readonly profile: RecorderSession | undefined;
}

/**
 * One view's phase queue. A recording stages its culled dispatch before the
 * frame's RenderQueue barrier; `render-phase-sort` orders it and the recording
 * consumes `ordered`. The sort cache is the view's own retained order.
 */
export class ViewPhaseQueue {
  readonly transparent = new TransparentSortCache();
  staged: PhaseSortInput | undefined;
  ordered: DispatchList | undefined;

  /** Stage this attempt's dispatch; a previous attempt's order is dropped. */
  stage(input: PhaseSortInput): void {
    this.staged = input;
    this.ordered = undefined;
  }

  /** The order `render-phase-sort` produced for the staged dispatch. */
  take(): DispatchList {
    const ordered = this.ordered;
    if (ordered === undefined || this.staged !== undefined)
      throw new Error(`${RENDER_PHASE_SORT_SYSTEM} did not order the staged view dispatch`);
    this.ordered = undefined;
    return ordered;
  }

  inspect(): FrameCacheCounters {
    return this.transparent.inspect();
  }
}

export const ViewPhases = defineComponent('ViewPhases', { state: 'unique<ViewPhaseQueue>' });

/** A view entity's phase queue, created on first use. */
export function viewPhaseQueue(world: World, entity: EntityHandle): ViewPhaseQueue {
  if (!world.hasComponent(entity, ViewPhases)) {
    const state = world.allocUniqueRef('ViewPhaseQueue', new ViewPhaseQueue());
    world.addComponent(entity, { component: ViewPhases, data: { state } }).unwrap();
  }
  return world
    .resolveUniqueRef<ViewPhaseQueue>(requireViewField(world, entity, ViewPhases, 'state'))
    .unwrap();
}

/** Transparent-sort counters of a view, or undefined before it queued. */
export function viewPhaseInspection(
  world: World,
  entity: EntityHandle | undefined,
): FrameCacheCounters | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewPhases)) return undefined;
  return viewPhaseQueue(world, entity).inspect();
}

/**
 * Register `render-phase-sort` once: unified transparent sort, (layer ASC,
 * sortValue ASC) for modes 0/1/2 and back-to-front distance for mode 3, over
 * queue-selected or blended work. Native Scene Passes order their own work, so
 * a GPU-driven view stages nothing.
 */
export function registerQueueSystems(world: World): void {
  if (world.hasResource(QueueSystems)) return;
  world.insertResource(QueueSystems, true);
  world
    .addSystem(RenderQueue, {
      commands: 'none',
      name: RENDER_PHASE_SORT_SYSTEM,
      queries: [{ read: [ViewPhases] }],
      fn: (world, [views]) => {
        views.forEach((row) => {
          const entity = row.entity;

          const queue = world
            .resolveUniqueRef<ViewPhaseQueue>(requireViewField(world, entity, ViewPhases, 'state'))
            .unwrap();
          const input = queue.staged;
          if (input === undefined) return;
          queue.staged = undefined;
          queue.ordered = runProfiledRenderPhase(input.profile, 'sort', () =>
            queue.transparent.sort(input.dispatch, input.scope, input.cameras, input.rows),
          );
        });
      },
    })
    .unwrap();
}

const QueueSystems = Object.freeze({ name: 'QueueSystems' });
