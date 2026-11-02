import type { EntityHandle } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { RenderQueue as DrawQueue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type FrameRecording, submitFrameRecordings } from '../../__tests__/frame-recording-driver';

import type { RenderResourceScope } from '../../publication/resource-scope';
import type { CameraSnapshot } from '../../render-contract';
import type { DispatchEntry } from '../../render-system-extract';
import type { TransparentSortSource } from '../../systems/transparent-dispatch';
import { TRANSPARENT_SORT_MODE_DISTANCE } from '../../systems/transparent-sort-config';
import { RENDER_PHASE_SORT_SYSTEM, registerQueueSystems, viewPhaseQueue } from '../queue-systems';
import { createRenderWorld, RenderQueue } from '../render-world';

const scope = {
  transparentSort: { mode: TRANSPARENT_SORT_MODE_DISTANCE, yzAlpha: 1 },
} as unknown as RenderResourceScope;

function camera(): CameraSnapshot {
  return { position: new Float32Array([0, 0, 0]) } as unknown as CameraSnapshot;
}

function at(z: number): TransparentSortSource {
  const world = new Float32Array(16);
  world[0] = world[5] = world[10] = world[15] = 1;
  world[14] = z;
  return { transform: { world } } as unknown as TransparentSortSource;
}

/** Near first, far last: back-to-front sorting reverses it. */
const dispatch = [0, 1, 2].map(
  (index) => ({ renderableIndex: index, queue: DrawQueue.Transparent }) as unknown as DispatchEntry,
);
const rows = { at: (index: number) => at(-(index + 1)) };

function stage(world: ReturnType<typeof createRenderWorld>, entity: EntityHandle) {
  viewPhaseQueue(world, entity).stage({
    dispatch,
    scope,
    cameras: [camera()],
    rows,
    profile: undefined,
  });
}

const order = (list: unknown) =>
  (list as readonly DispatchEntry[]).map((entry) => entry.renderableIndex);

describe('render-phase-sort', () => {
  it('orders each staged view dispatch in RenderQueue', () => {
    const world = createRenderWorld();
    registerQueueSystems(world);
    registerQueueSystems(world);
    const queue = world.scheduleData().find((schedule) => schedule.name === 'RenderQueue');
    expect(queue?.systems.map((system) => system.name)).toEqual([
      'render-view-record-start',
      'render-view-graph-prepare',
      RENDER_PHASE_SORT_SYSTEM,
    ]);
    expect(
      queue?.systems.find((system) => system.name === 'render-view-graph-prepare')?.after,
    ).toContain(RENDER_PHASE_SORT_SYSTEM);
    expect(
      queue?.systems.find((system) => system.name === RENDER_PHASE_SORT_SYSTEM)?.queries[0]?.read,
    ).toEqual(['ViewPhases']);
    const view = world.spawn().unwrap();
    stage(world, view);
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(order(viewPhaseQueue(world, view).take())).toEqual([2, 1, 0]);
    expect(viewPhaseQueue(world, view).inspect().misses).toBe(1);
  });

  it('leaves the staged dispatch unordered once the system is removed', () => {
    const world = createRenderWorld();
    registerQueueSystems(world);
    expect(world.removeSystem(RenderQueue, RENDER_PHASE_SORT_SYSTEM).ok).toBe(true);
    const view = world.spawn().unwrap();
    stage(world, view);
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(() => viewPhaseQueue(world, view).take()).toThrow(RENDER_PHASE_SORT_SYSTEM);
  });

  it('runs RenderQueue once after every view staged, before any view records', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const world = createRenderWorld();
    registerQueueSystems(world);
    const events: string[] = [];
    world
      .addSystem(RenderQueue, {
        name: 'trace-queue',
        queries: [],
        after: [RENDER_PHASE_SORT_SYSTEM],
        fn: () => events.push('queue'),
      })
      .unwrap();
    function* view(name: string): FrameRecording {
      const entity = world.spawn().unwrap();
      stage(world, entity);
      events.push(`${name}:staged`);
      yield { kind: 'queue', world };
      events.push(`${name}:${order(viewPhaseQueue(world, entity).take()).join('')}`);
      const submitted = yield { reportError: (error) => events.push(error.code) };
      return submitted.ok;
    }
    expect(submitFrameRecordings({ world, device }, [view('a'), view('b')])).toBe(true);
    expect(events).toEqual(['a:staged', 'b:staged', 'queue', 'a:210', 'b:210']);
  });
});
