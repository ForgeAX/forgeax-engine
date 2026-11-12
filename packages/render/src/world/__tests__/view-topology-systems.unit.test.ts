import { describe, expect, it, vi } from 'vitest';

const planned = vi.hoisted(() => ({ current: undefined as undefined | (() => unknown) }));
vi.mock('../../record/view-topology', () => ({ planViewTopology: () => planned.current?.() }));

import type { RenderSystemInternals } from '../../record/render-context';
import type { ExtractedFrame } from '../../render-system-extract';
import { createViewRecord, ViewCascadeFit, type ViewLights } from '../render-lights';
import { RenderViewFrameSource, RenderViewInput, ViewRecorder } from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderExtract,
  RenderPrepare,
} from '../render-world';
import {
  RENDER_STANDARD_LIGHTING_SYSTEM,
  storeViewStandardLighting,
} from '../standard-lighting-systems';
import {
  RENDER_VIEW_FRAME_SYSTEM,
  RENDER_VIEW_RECORDERS_SYSTEM,
  stageViewFrame,
} from '../view-frame-systems';
import {
  consumeViewTopology,
  RENDER_VIEW_TOPOLOGY_SYSTEM,
  registerViewTopologySystem,
  type ViewTopology,
  type ViewTopologyOutcome,
  viewTopologyOf,
} from '../view-topology-systems';
import { registerViewFrameStub, withInertTemporal } from './temporal-owner-fixture';

const opts = { cameraOwner: 0, resourceOwner: 0 } as const;
const topology = { shadowMapSize: 512, terrainReceivers: [] } as unknown as ViewTopology;

function setup(
  prepare: () => ViewTopologyOutcome,
  lighting: 'prepared' | 'not-admitted' = 'prepared',
) {
  const world = createRenderWorld();
  world.insertResource(
    RenderViewInput,
    new RenderViewFrameSource({ canvas: { width: 8, height: 8 } }),
  );
  const order: string[] = [];
  const staged = world.spawn().unwrap();
  const held = world.spawn().unwrap();
  // Registered first so only `after` can order the topology behind its inputs.
  registerViewTopologySystem(world);
  registerViewFrameStub(world, () => ({
    ok: true,
    value: { renderables: [], cameras: [] } as unknown as ExtractedFrame,
  }));
  // Stands in for `render-standard-lighting`: the staged view's stored outcome.
  world
    .addSystem(RenderPrepare, {
      name: RENDER_STANDARD_LIGHTING_SYSTEM,
      after: [RENDER_VIEW_FRAME_SYSTEM],
      queries: [],
      fn: (world) => {
        order.push(RENDER_STANDARD_LIGHTING_SYSTEM);
        storeViewStandardLighting(
          world,
          staged,
          lighting === 'prepared'
            ? ({ kind: 'prepared', lighting: {}, fence: {} } as never)
            : { kind: 'not-admitted' },
        );
      },
    })
    .unwrap();
  planned.current = () => {
    order.push(RENDER_VIEW_TOPOLOGY_SYSTEM);
    return prepare();
  };
  for (const entity of [staged, held]) {
    const state = world.allocUniqueRef(
      'ViewRecorder',
      withInertTemporal(
        {},
        {
          scene: { shadowCasterProjection: () => undefined },
          internals: {},
        },
      ),
    );
    world.addComponent(entity, { component: ViewRecorder, data: { state } }).unwrap();
    const record = createViewRecord(entity);
    record.lights = {} as ViewLights;
    world
      .addComponent(entity, {
        component: ViewCascadeFit,
        data: { fit: world.allocUniqueRef('ViewCascadeFit', record) },
      })
      .unwrap();
  }
  world
    .addSystem(RenderExtract, {
      name: RENDER_VIEW_RECORDERS_SYSTEM,
      queries: [],
      fn: (world) => stageViewFrame(world, staged, opts),
    })
    .unwrap();
  const internals = { renderWorld: world, viewEntity: staged } as unknown as RenderSystemInternals;
  return { world, order, staged, held, internals };
}

const unplanned = (): ViewTopologyOutcome => {
  throw new Error('a Render World view never computes topology while recording');
};

describe('render-view-topology system', () => {
  it('plans each staged view after its Standard lighting', () => {
    const { world, order, staged, held, internals } = setup(() => ({ kind: 'planned', topology }));
    beginRenderFrame(world, 1);
    expect(order).toEqual([RENDER_STANDARD_LIGHTING_SYSTEM, RENDER_VIEW_TOPOLOGY_SYSTEM]);
    expect(viewTopologyOf(world, staged)).toEqual({ kind: 'planned', topology });
    expect(viewTopologyOf(world, held)).toBeUndefined();
    expect(consumeViewTopology(internals, unplanned)).toBe(topology);
    endRenderFrame(world);
  });

  it('plans nothing for a view whose Standard lighting was not admitted', () => {
    const { world, order, staged } = setup(() => ({ kind: 'planned', topology }), 'not-admitted');
    beginRenderFrame(world, 1);
    expect(order).not.toContain(RENDER_VIEW_TOPOLOGY_SYSTEM);
    expect(viewTopologyOf(world, staged)).toBeUndefined();
    endRenderFrame(world);
  });

  it('leaves the recording without topology once the system is removed', () => {
    const { world, staged, internals } = setup(() => ({ kind: 'planned', topology }));
    beginRenderFrame(world, 1);
    endRenderFrame(world);
    world.removeSystem(RenderPrepare, RENDER_VIEW_TOPOLOGY_SYSTEM).unwrap();
    beginRenderFrame(world, 2);
    expect(viewTopologyOf(world, staged)).toBeUndefined();
    expect(() => consumeViewTopology(internals, unplanned)).toThrow(RENDER_VIEW_TOPOLOGY_SYSTEM);
    endRenderFrame(world);
  });

  it('stores a closed failure code and cause for the recording to rethrow', () => {
    const cause = new Error('density upload');
    const { world, staged, internals } = setup(() => ({
      kind: 'failed',
      code: 'volumetric-fog-prepare-failed',
      cause,
    }));
    beginRenderFrame(world, 1);
    expect(viewTopologyOf(world, staged)).toEqual({
      kind: 'failed',
      code: 'volumetric-fog-prepare-failed',
      cause,
    });
    expect(() => consumeViewTopology(internals, unplanned)).toThrow(cause);
    endRenderFrame(world);
  });

  it('lets a direct recorder outside a Render World view plan its own topology', () => {
    const internals = { renderWorld: createRenderWorld() } as unknown as RenderSystemInternals;
    expect(consumeViewTopology(internals, () => ({ kind: 'planned', topology }))).toBe(topology);
  });

  it('declares its view reads and phase order in the schedule', () => {
    const { world } = setup(() => ({ kind: 'planned', topology }));
    const system = world
      .scheduleData()
      .find((data) => data.name === 'RenderPrepare')
      ?.systems.find((data) => data.name === RENDER_VIEW_TOPOLOGY_SYSTEM);
    expect(system?.after).toEqual([RENDER_VIEW_FRAME_SYSTEM, RENDER_STANDARD_LIGHTING_SYSTEM]);
    expect(system?.queries[0]?.read).toEqual(['ViewRecorder', 'ViewFrame']);
    expect(system?.queries[0]?.optional).toEqual(['ViewTopologyInputs']);
  });
});
