import type { EntityHandle } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { type FrameRecording, submitFrameRecordings } from '../../__tests__/frame-recording-driver';

import type { RenderResourceScope } from '../../publication/resource-scope';
import type { DispatchList } from '../../render-system-extract';
import { MaterialFrame } from '../../scene/material-dispatch';
import {
  EMPTY_VIEW_PASS_PLAN,
  type PassPlanInput,
  planOpaque,
  RENDER_OPAQUE_PLAN_SYSTEM,
  RENDER_TRANSMISSION_PLAN_SYSTEM,
  RENDER_TRANSPARENT_PLAN_SYSTEM,
  registerPassPlanSystems,
  viewPassPlanQueue,
} from '../pass-plan-systems';
import { RENDER_PHASE_SORT_SYSTEM, viewPhaseQueue } from '../queue-systems';
import { createRenderWorld, RenderQueue } from '../render-world';

const noSubsurface = {} as PassPlanInput['subsurface'];

const sceneTransmission = { activeCount: 2, needsRoughMips: false } as const;

function input(overrides: Partial<PassPlanInput> = {}): PassPlanInput {
  return {
    requested: 'weighted-blended',
    rgba16floatRenderable: false,
    renderables: [],
    dispatch: [],
    phaseSorted: false,
    materials: new MaterialFrame(undefined),
    sceneTransmission,
    preparation: undefined,
    renderPath: 'deferred',
    gpuOcclusion: undefined,
    clearOnly: false,
    ssr: {
      camera: {} as PassPlanInput['ssr']['camera'],
      dependencies: {} as PassPlanInput['ssr']['dependencies'],
      probeFallbackDemand: false,
      capabilities: { compute: true, storageTexture: true, rgba16floatRenderable: true },
    },
    subsurface: noSubsurface,
    ...overrides,
  };
}

function stage(world: ReturnType<typeof createRenderWorld>, entity: EntityHandle) {
  viewPassPlanQueue(world, entity).stage(input());
}

describe('pass-plan systems', () => {
  it('register both families after render-phase-sort, reading the view pass plans', () => {
    const world = createRenderWorld();
    registerPassPlanSystems(world);
    registerPassPlanSystems(world);
    const queue = world.scheduleData().find((schedule) => schedule.name === 'RenderQueue');
    expect(queue?.systems.map((system) => system.name)).toEqual([
      'render-view-record-start',
      'render-view-graph-prepare',
      RENDER_PHASE_SORT_SYSTEM,
      RENDER_TRANSPARENT_PLAN_SYSTEM,
      RENDER_TRANSMISSION_PLAN_SYSTEM,
      RENDER_OPAQUE_PLAN_SYSTEM,
    ]);
    expect(
      queue?.systems.find((system) => system.name === 'render-view-graph-prepare')?.after,
    ).toContain(RENDER_PHASE_SORT_SYSTEM);
    const transparent = queue?.systems.find((s) => s.name === RENDER_TRANSPARENT_PLAN_SYSTEM);
    const transmission = queue?.systems.find((s) => s.name === RENDER_TRANSMISSION_PLAN_SYSTEM);
    expect(transparent?.after).toEqual([RENDER_PHASE_SORT_SYSTEM]);
    expect(transparent?.queries[0]?.read).toEqual(['ViewPassPlans']);
    expect(transparent?.queries[0]?.optional).toEqual(['ViewPhases']);
    expect(transmission?.after).toEqual([RENDER_PHASE_SORT_SYSTEM]);
    expect(transmission?.queries[0]?.read).toEqual(['ViewPassPlans']);
    const opaque = queue?.systems.find((s) => s.name === RENDER_OPAQUE_PLAN_SYSTEM);
    expect(opaque?.after).toEqual([RENDER_PHASE_SORT_SYSTEM]);
    expect(opaque?.queries[0]?.read).toEqual(['ViewPassPlans']);
  });

  it('plans each staged view in RenderQueue', () => {
    const world = createRenderWorld();
    registerPassPlanSystems(world);
    const view = world.spawn().unwrap();
    stage(world, view);
    expect(world.run(RenderQueue).ok).toBe(true);
    const plan = viewPassPlanQueue(world, view).take();
    // The missing float capability resolves the requested OIT to sorted.
    expect(plan.transparent.inspection).toMatchObject({
      requested: 'weighted-blended',
      resolved: 'sorted',
      reason: 'capability-absent',
    });
    expect(plan.transparent.topology).toBeUndefined();
    expect(plan.transmission).toEqual({ demand: sceneTransmission, singleLayerMedium: false });
    // A plan is consumed once per staged attempt.
    expect(() => viewPassPlanQueue(world, view).take()).toThrow('staged input');
  });

  it.each([
    [RENDER_TRANSPARENT_PLAN_SYSTEM],
    [RENDER_TRANSMISSION_PLAN_SYSTEM],
    [RENDER_OPAQUE_PLAN_SYSTEM],
  ])('reads a view missing %s as data and keeps the staged attempt', (name) => {
    const world = createRenderWorld();
    registerPassPlanSystems(world);
    expect(world.removeSystem(RenderQueue, name).ok).toBe(true);
    const view = world.spawn().unwrap();
    stage(world, view);
    expect(world.run(RenderQueue).ok).toBe(true);
    const read = viewPassPlanQueue(world, view).read();
    expect(read).toEqual({ ok: false, error: { code: 'pass-plan-missing', system: name } });
    expect(viewPassPlanQueue(world, view).staged).toBeDefined();
  });

  it('reads an unstaged view as a missing input stage', () => {
    const world = createRenderWorld();
    registerPassPlanSystems(world);
    const view = world.spawn().unwrap();
    expect(viewPassPlanQueue(world, view).read()).toEqual({
      ok: false,
      error: { code: 'pass-plan-missing', system: 'view-pass-plan-input' },
    });
  });

  it('adds candidate preparation demand to the scene demand', () => {
    const world = createRenderWorld();
    registerPassPlanSystems(world);
    const view = world.spawn().unwrap();
    const preparation = {
      transmissionDemand: { activeCount: 1, needsRoughMips: true, needsBackPass: true },
      hasMedium: true,
    } as unknown as MaterialFrame;
    viewPassPlanQueue(world, view).stage(input({ preparation }));
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewPassPlanQueue(world, view).take().transmission).toEqual({
      demand: { activeCount: 3, needsRoughMips: true, needsBackPass: true },
      singleLayerMedium: true,
    });
  });

  it.each([
    [{}, { lane: 'deferred', lateOcclusion: true }],
    [{ renderPath: 'forward' }, { lane: 'forward', lateOcclusion: true }],
    [{ gpuOcclusion: false }, { lane: 'deferred', lateOcclusion: false }],
    [{ clearOnly: true }, { lane: 'forward', lateOcclusion: true }],
  ] as const)('plans the opaque lane of %o as %o', (overrides, expected) => {
    const world = createRenderWorld();
    registerPassPlanSystems(world);
    const view = world.spawn().unwrap();
    viewPassPlanQueue(world, view).stage(input(overrides));
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewPassPlanQueue(world, view).take().opaque).toEqual(expected);
  });

  it.each([
    RENDER_TRANSPARENT_PLAN_SYSTEM,
    RENDER_TRANSMISSION_PLAN_SYSTEM,
    RENDER_OPAQUE_PLAN_SYSTEM,
  ])('leaves the staged view unplanned once %s is removed', (name) => {
    const world = createRenderWorld();
    registerPassPlanSystems(world);
    expect(world.removeSystem(RenderQueue, name).ok).toBe(true);
    const view = world.spawn().unwrap();
    stage(world, view);
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(() => viewPassPlanQueue(world, view).take()).toThrow(name);
  });

  it('plans a phase-sorted view over the order render-phase-sort produced', () => {
    const world = createRenderWorld();
    registerPassPlanSystems(world);
    const view = world.spawn().unwrap();
    const culled: DispatchList = [];
    const ordered: DispatchList = [];
    const seen: DispatchList[] = [];
    world
      .addSystem(RenderQueue, {
        name: 'trace-order',
        queries: [],
        after: [RENDER_PHASE_SORT_SYSTEM],
        before: [RENDER_TRANSPARENT_PLAN_SYSTEM],
        fn: () => {
          const phases = viewPhaseQueue(world, view);
          seen.push(phases.ordered ?? culled);
          phases.ordered = ordered;
        },
      })
      .unwrap();
    viewPhaseQueue(world, view).stage({
      dispatch: culled,
      scope: { transparentSort: { mode: 0, yzAlpha: 1 } } as unknown as RenderResourceScope,
      cameras: [],
      rows: { at: () => undefined },
      profile: undefined,
    });
    viewPassPlanQueue(world, view).stage(input({ dispatch: culled, phaseSorted: true }));
    expect(world.run(RenderQueue).ok).toBe(true);
    // The phase sort ran first; the plan then read the order this view records.
    expect(seen).toHaveLength(1);
    expect(viewPhaseQueue(world, view).take()).toBe(ordered);
    expect(viewPassPlanQueue(world, view).take().transparent.inspection.resolved).toBe('sorted');
  });

  it('runs RenderQueue once after every view staged, before any view compiles', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const world = createRenderWorld();
    registerPassPlanSystems(world);
    const events: string[] = [];
    function* view(name: string): FrameRecording {
      const entity = world.spawn().unwrap();
      stage(world, entity);
      events.push(`${name}:staged`);
      yield { kind: 'queue', world };
      const plan = viewPassPlanQueue(world, entity).take();
      events.push(`${name}:${plan.transmission.demand.activeCount}`);
      const submitted = yield { reportError: (error) => events.push(error.code) };
      return submitted.ok;
    }
    expect(submitFrameRecordings({ world, device }, [view('a'), view('b')])).toBe(true);
    expect(events).toEqual(['a:staged', 'b:staged', 'a:2', 'b:2']);
  });

  it('gives an unplanned recording the sorted plan without a backdrop or medium', () => {
    expect(EMPTY_VIEW_PASS_PLAN.transparent.topology).toBeUndefined();
    expect(EMPTY_VIEW_PASS_PLAN.transparent.inspection.resolved).toBe('sorted');
    expect(EMPTY_VIEW_PASS_PLAN.transmission).toEqual({
      demand: { activeCount: 0, needsRoughMips: false },
      singleLayerMedium: false,
    });
    // Graph compile plans an unplanned recording's opaque lane with the same function.
    expect(EMPTY_VIEW_PASS_PLAN.opaque).toBeUndefined();
    expect(
      planOpaque({ renderPath: 'deferred', gpuOcclusion: undefined, clearOnly: false }),
    ).toEqual({ lane: 'deferred', lateOcclusion: true });
  });
});
