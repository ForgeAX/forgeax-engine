import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_GPU_DRAW_SELECTION, GpuDrawSelection } from '../../gpu-driven/draw-selection';
import { GpuDrivenMaterialProgramProjection } from '../../gpu-driven/material-artifacts';
import type {
  GpuDrivenProduction,
  PreparedGpuDrivenFrame,
} from '../../gpu-driven/production-raster';
import type { GpuDrivenLaneReason } from '../../inspection-types';
import { updateGpuDrivenShadowViews } from '../../record/frame-gpu-driven';
import type { FrameGpuDrivenSources } from '../../record/frame-gpu-driven-input';
import type { RenderSystemInternals } from '../../record/render-context';
import { MaterialFrame } from '../../scene/material-dispatch';
import type { PersistentGpuDrivenState } from '../../scene/render-scene';
import type { SsrDependenciesInspection } from '../../ssr/admission';
import {
  consumeViewGpuDrivenRaster,
  RENDER_GPU_DRIVEN_RASTER_SYSTEM,
  registerGpuDrivenRasterSystem,
} from '../gpu-driven-raster-systems';
import {
  consumeViewGpuDriven,
  RENDER_GPU_DRIVEN_PREPARE_SYSTEM,
  registerGpuDrivenPrepareSystem,
  stageViewGpuDrivenPrepareInput,
  viewGpuDrivenOf,
} from '../gpu-driven-systems';
import {
  type PassPlanInput,
  registerPassPlanSystems,
  viewPassPlanQueue,
} from '../pass-plan-systems';
import { ViewRecorder } from '../render-views';
import { beginRenderFrame, createRenderWorld, RenderCleanup, RenderQueue } from '../render-world';
import { RENDER_SKIN_DEMAND_SYSTEM } from '../skin-systems';
import { RENDER_SSR_ADMISSION_SYSTEM, registerSsrAdmissionSystem } from '../ssr-admission-systems';
import { ViewStandardLighting } from '../standard-lighting-systems';

const camera = { near: 0.1, far: 100, projection: 'perspective' } as PassPlanInput['ssr']['camera'];
const dependencies = {
  requested: false,
  admission: { status: 'unavailable' },
} as unknown as SsrDependenciesInspection;

function input(
  probeFallbackDemand: boolean,
  gpuDrivenScene?: PersistentGpuDrivenState,
): PassPlanInput {
  return {
    ...(gpuDrivenScene === undefined ? {} : { gpuDrivenScene }),
    requested: 'sorted',
    rgba16floatRenderable: false,
    renderables: [],
    dispatch: [],
    phaseSorted: false,
    materials: new MaterialFrame(undefined),
    sceneTransmission: { activeCount: 0, needsRoughMips: false },
    preparation: undefined,
    renderPath: 'forward',
    gpuOcclusion: undefined,
    clearOnly: false,
    ssr: {
      camera,
      dependencies,
      probeFallbackDemand,
      capabilities: { compute: true, storageTexture: true, rgba16floatRenderable: true },
    },
    subsurface: {} as PassPlanInput['subsurface'],
  };
}

function setup(
  renderPath: 'forward' | 'deferred' | 'none',
  probeFallbackDemand: boolean,
  gpuDrivenScene?: PersistentGpuDrivenState,
) {
  const world = createRenderWorld();
  registerPassPlanSystems(world);
  registerSsrAdmissionSystem(world);
  registerGpuDrivenPrepareSystem(world);
  beginRenderFrame(world, 1);
  const view = world.spawn().unwrap();
  if (renderPath !== 'none') {
    const outcome = {
      kind: 'prepared',
      lighting: { ok: true, value: { standard: { prepared: { renderPath } } } },
      fence: { pipelineState: { viewBindGroupLayout: {} } },
    };
    const state = world.allocUniqueRef('ViewStandardLighting', { frame: 1, outcome });
    world.addComponent(view, { component: ViewStandardLighting, data: { state } }).unwrap();
  }
  viewPassPlanQueue(world, view).stage(input(probeFallbackDemand, gpuDrivenScene));
  const internals = { renderWorld: world, viewEntity: view } as unknown as RenderSystemInternals;
  return { world, view, internals };
}

const lane = { owner: 'gpu-driven', scene: undefined } as const;

function consume(internals: RenderSystemInternals) {
  const reasons: (GpuDrivenLaneReason | undefined)[] = [];
  const selected = consumeViewGpuDriven(internals, lane, (reason) => reasons.push(reason)).frame;
  return { selected, reasons };
}

/** A resident GPU Scene whose native source plan expands only when queried. */
function residentScene(query: () => PersistentGpuDrivenState['plan']) {
  const plan = { batches: [] } as unknown as PersistentGpuDrivenState['plan'];
  let queries = 0;
  const scene = {
    plan,
    queryPlan: () => {
      queries += 1;
      return query();
    },
  } as unknown as PersistentGpuDrivenState;
  return { scene, plan, queries: () => queries };
}

function stagePreparation(
  context: ReturnType<typeof setup>,
  prepare = vi.fn<GpuDrivenProduction['prepare']>(() => ok(undefined)),
) {
  const { world, view, internals } = context;
  const owner = { prepare, resourceGeneration: 7 } as unknown as GpuDrivenProduction;
  const frameState = {} as FrameGpuDrivenSources['frameState'];
  const sources: FrameGpuDrivenSources = {
    internals,
    frameState,
    camera,
    worlds: [],
    renderables: [],
    lights: { pointShadow: [], spot: [] } as unknown as FrameGpuDrivenSources['lights'],
    shadowCasterProjection: undefined,
    materialBindingClasses: new Map(),
    profilePhase: undefined,
    gpuDriven: { owner, scene: undefined, visibleRasterRows: 0, onRasterLane: () => {} },
  };
  stageViewGpuDrivenPrepareInput(world, view, sources);
  return { sources, prepare, frameState };
}

describe('render-gpu-driven-prepare system', () => {
  it('registers once in RenderQueue after render-ssr-admission', () => {
    const { world } = setup('forward', false);
    const queue = world.scheduleData().find((schedule) => schedule.name === 'RenderQueue');
    const systems = queue?.systems.filter((s) => s.name === RENDER_GPU_DRIVEN_PREPARE_SYSTEM);
    expect(systems).toHaveLength(1);
    expect(systems?.[0]?.after).toEqual([RENDER_SSR_ADMISSION_SYSTEM]);
    expect(systems?.[0]?.queries[0]?.read).toEqual(['ViewPassPlans', 'ViewSsrAdmission']);
    expect(systems?.[0]?.queries[0]?.optional).toEqual([
      'ViewStandardLighting',
      'ViewGpuDrivenPrepareInput',
      'ViewGpuDriven',
    ]);
  });

  it('keeps the GPU lane without a reflection fallback candidate', () => {
    const { world, view, internals } = setup('forward', false);
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewGpuDrivenOf(world, view)).toEqual({
      kind: 'selected',
      gpuLane: true,
      laneReason: undefined,
      scene: undefined,
    });
    expect(consume(internals)).toEqual({ selected: lane, reasons: [undefined] });
    // Another frame's selection is never read.
    beginRenderFrame(world, 2);
    expect(viewGpuDrivenOf(world, view)).toBeUndefined();
  });

  it('declines a forward GPU lane for the reflection fallback MRT before the queue barrier', () => {
    const { world, view, internals } = setup('forward', true);
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewGpuDrivenOf(world, view)).toEqual({
      kind: 'selected',
      gpuLane: false,
      laneReason: 'reflection-fallback-mrt',
      scene: undefined,
    });
    expect(consume(internals)).toEqual({
      selected: undefined,
      reasons: ['reflection-fallback-mrt'],
    });
  });

  it('keeps the deferred GPU lane, whose lighting pass writes the fallback', () => {
    const { world, internals } = setup('deferred', true);
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(consume(internals)).toEqual({ selected: lane, reasons: [undefined] });
  });

  it('stores an unavailable code instead of throwing without prepared lighting', () => {
    const { world, view, internals } = setup('none', true);
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewGpuDrivenOf(world, view)).toEqual({
      kind: 'unavailable',
      code: 'ssr-admission-unavailable',
    });
    expect(() => consume(internals)).toThrow('ssr-admission-unavailable');
  });

  it('leaves the recorded view without a selection once the system is removed', () => {
    const { world, view, internals } = setup('forward', true);
    expect(world.removeSystem(RenderQueue, RENDER_GPU_DRIVEN_PREPARE_SYSTEM).ok).toBe(true);
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewGpuDrivenOf(world, view)).toBeUndefined();
    expect(() => consume(internals)).toThrow(RENDER_GPU_DRIVEN_PREPARE_SYSTEM);
  });

  it('keeps the given lane for a direct recorder outside a Render World view', () => {
    expect(consume({} as RenderSystemInternals)).toEqual({ selected: lane, reasons: [undefined] });
  });

  it('queries the staged GPU Scene execution plan once, before the queue barrier', () => {
    const queried = { batches: [], queried: true } as unknown as PersistentGpuDrivenState['plan'];
    const resident = residentScene(() => queried);
    const { world, view, internals } = setup('forward', true, resident.scene);
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(resident.queries()).toBe(1);
    const outcome = viewGpuDrivenOf(world, view);
    expect(outcome?.kind === 'selected' && outcome.scene?.source).toBe(resident.scene);
    expect(outcome?.kind === 'selected' && outcome.scene?.queried.plan).toBe(queried);
    // The recording reads the query without re-running it; the CPU lane keeps its rows.
    const consumed = consumeViewGpuDriven(internals, { scene: resident.scene }, () => {});
    expect(resident.queries()).toBe(1);
    expect(consumed.input?.scene?.plan).toBe(queried);
    expect(consumed.input?.scene?.queryPlan).toBeUndefined();
    expect(consumed.frame).toBeUndefined();
  });

  it('stores a rejected GPU Scene query as data the recording rethrows', () => {
    const cause = new Error('topology failed');
    const resident = residentScene(() => {
      throw cause;
    });
    const { world, view, internals } = setup('deferred', false, resident.scene);
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(viewGpuDrivenOf(world, view)).toEqual({
      kind: 'failed',
      code: 'scene-query-rejected',
      cause,
    });
    expect(() => consumeViewGpuDriven(internals, { scene: resident.scene }, () => {})).toThrow(
      cause,
    );
  });

  it('rejects a recording whose GPU Scene the system did not query', () => {
    const resident = residentScene(() => ({ batches: [] }) as never);
    const { world, internals } = setup('deferred', false);
    expect(world.run(RenderQueue).ok).toBe(true);
    expect(() => consumeViewGpuDriven(internals, { scene: resident.scene }, () => {})).toThrow(
      'did not query the recorded GPU Scene',
    );
    expect(resident.queries()).toBe(0);
  });

  it('queries the scene of a direct recorder at consume time', () => {
    const queried = { batches: [] } as unknown as PersistentGpuDrivenState['plan'];
    const resident = residentScene(() => queried);
    const consumed = consumeViewGpuDriven(
      {} as RenderSystemInternals,
      { scene: resident.scene },
      () => {},
    );
    expect(consumed.frame?.scene?.plan).toBe(queried);
    expect(resident.queries()).toBe(1);
  });
  it('prepares once in Queue and consumes the same inputs without another owner call', () => {
    const context = setup('forward', false);
    const staged = stagePreparation(context);
    expect(staged.prepare).not.toHaveBeenCalled();
    expect(context.world.run(RenderQueue).ok).toBe(true);
    expect(staged.prepare).toHaveBeenCalledTimes(1);
    const consumed = consumeViewGpuDriven(context.internals, staged.sources.gpuDriven, () => {});
    expect(consumed.preparation?.input.request).toBe(staged.prepare.mock.calls[0]?.[0]);
    expect(consumed.preparation?.resourceGeneration).toBe(7);
    expect(staged.prepare).toHaveBeenCalledTimes(1);
    expect(context.world.run(RenderQueue).ok).toBe(true);
    expect(staged.prepare).toHaveBeenCalledTimes(1);
  });

  it('registers prepared resources for Cleanup even when recording never resumes', () => {
    const context = setup('forward', false);
    const abort = vi.fn();
    const prepared = { _abortResourceReplacement: abort } as unknown as PreparedGpuDrivenFrame;
    const staged = stagePreparation(
      context,
      vi.fn(() => ok(prepared)),
    );
    const state = context.world.allocUniqueRef('ViewRecorder', {
      owner: { frameState: staged.frameState },
    });
    context.world.addComponent(context.view, { component: ViewRecorder, data: { state } }).unwrap();
    expect(context.world.run(RenderQueue).ok).toBe(true);
    expect(staged.frameState.gpuDrivenFrame?.prepared).toBe(prepared);
    // Exercise the real GPU cleanup owner without unrelated domain fixtures.
    for (const system of context.world.scheduleData().find((s) => s.name === 'RenderCleanup')
      ?.systems ?? [])
      if (system.name !== 'render-gpu-driven-abort')
        context.world.removeSystem(RenderCleanup, system.name).unwrap();
    expect(context.world.run(RenderCleanup).ok).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(staged.frameState.gpuDrivenFrame).toBeUndefined();
  });

  it('stores owner rejection and reports it when the recording consumes it', () => {
    const context = setup('forward', false);
    const error = new RhiError({ code: 'rhi-not-available', expected: 'producer', hint: 'retry' });
    const staged = stagePreparation(
      context,
      vi.fn(() => err(error)),
    );
    const fire = vi.fn();
    Object.assign(context.internals, { errorRegistry: { fire } });
    expect(context.world.run(RenderQueue).ok).toBe(true);
    expect(viewGpuDrivenOf(context.world, context.view)).toEqual({
      kind: 'rejected',
      code: 'owner-prepare-rejected',
      error,
    });
    expect(fire).not.toHaveBeenCalled();
    expect(
      consumeViewGpuDriven(context.internals, staged.sources.gpuDriven, () => {}).rejected,
    ).toBe(true);
    expect(fire).toHaveBeenCalledWith(error);
    expect(staged.frameState.gpuDrivenFrame).toBeUndefined();
  });

  it('stores an input/owner exception without poisoning Queue', () => {
    const context = setup('forward', false);
    const cause = new Error('prepare rejected');
    const staged = stagePreparation(
      context,
      vi.fn(() => {
        throw cause;
      }),
    );
    expect(context.world.run(RenderQueue).ok).toBe(true);
    expect(viewGpuDrivenOf(context.world, context.view)).toEqual({
      kind: 'failed',
      code: 'input-rejected',
      cause,
    });
    expect(() =>
      consumeViewGpuDriven(context.internals, staged.sources.gpuDriven, () => {}),
    ).toThrow(cause);
  });

  it('does not prepare an owner when the forward MRT fallback declines the lane', () => {
    const context = setup('forward', true);
    const staged = stagePreparation(context);
    expect(context.world.run(RenderQueue).ok).toBe(true);
    expect(staged.prepare).not.toHaveBeenCalled();
    const consumed = consumeViewGpuDriven(context.internals, staged.sources.gpuDriven, () => {});
    expect(consumed.frame).toBeUndefined();
    expect(consumed.preparation?.input.meshes.size).toBe(0);
  });
  it.each([
    ['automatic', true, true],
    ['direct', true, false],
    ['automatic', false, false],
  ] as const)('stages %s raster with prepared=%s after Skin and refines HZB to %s', (geometryLane, hasPrepared, lateOcclusion) => {
    const context = setup('forward', false);
    const order: string[] = [];
    const prepared = {
      selection: EMPTY_GPU_DRAW_SELECTION,
      shadowDirectRequired: false,
      shadowViewPool: {},
    } as unknown as PreparedGpuDrivenFrame;
    const staged = stagePreparation(
      context,
      vi.fn(() => ok(hasPrepared ? prepared : undefined)),
    );
    stageViewGpuDrivenPrepareInput(context.world, context.view, {
      ...staged.sources,
      gpuDriven: { ...staged.sources.gpuDriven, geometryLane },
    });
    const stageRasterLane = vi.fn(() => {
      order.push('raster');
    });
    const state = context.world.allocUniqueRef('ViewRecorder', {
      owner: { scene: { stageRasterLane } },
    });
    context.world.addComponent(context.view, { component: ViewRecorder, data: { state } }).unwrap();
    context.world
      .addSystem(RenderQueue, {
        name: RENDER_SKIN_DEMAND_SYSTEM,
        queries: [],
        fn: () => {
          order.push('skin');
          expect(stageRasterLane).not.toHaveBeenCalled();
        },
      })
      .unwrap();
    registerGpuDrivenRasterSystem(context.world);
    expect(context.world.run(RenderQueue).ok).toBe(true);
    expect(order).toEqual(['skin', 'raster']);
    const outcome = viewGpuDrivenOf(context.world, context.view);
    expect(outcome?.kind === 'selected' && outcome.raster?.raster).toBe(
      lateOcclusion ? prepared : undefined,
    );
    expect(viewPassPlanQueue(context.world, context.view).opaque?.lateOcclusion).toBe(
      lateOcclusion,
    );
    expect(stageRasterLane).toHaveBeenCalledTimes(1);
    const consumed = consumeViewGpuDrivenRaster(
      context.internals,
      staged.sources.gpuDriven,
      staged.sources.gpuDriven,
      undefined,
      false,
      undefined,
    );
    expect(consumed).toBe(outcome?.kind === 'selected' ? outcome.raster : undefined);
  });

  it('keeps prepared GPU shadow coverage when another batch needs direct shadows', () => {
    const context = setup('forward', false);
    const selection = new GpuDrawSelection([]);
    const programs = new GpuDrivenMaterialProgramProjection().project(
      [],
      new MaterialFrame(undefined),
    );
    const prepared = {
      selection: EMPTY_GPU_DRAW_SELECTION,
      shadowSelection: selection,
      shadowDirectRequired: true,
      shadowViewPool: {},
    } as unknown as PreparedGpuDrivenFrame;
    const lane = consumeViewGpuDrivenRaster(
      context.internals,
      undefined,
      undefined,
      prepared,
      false,
      programs,
    );
    expect(lane.ownership?.shadows).toEqual({ selection, programs });
    expect(
      consumeViewGpuDrivenRaster(context.internals, undefined, undefined, prepared, true, programs)
        .ownership?.shadows,
    ).toBeUndefined();
  });

  it('requires the raster system product instead of publishing from the recorder', () => {
    const context = setup('forward', false);
    const staged = stagePreparation(context);
    expect(context.world.run(RenderQueue).ok).toBe(true);
    expect(() =>
      consumeViewGpuDrivenRaster(
        context.internals,
        staged.sources.gpuDriven,
        staged.sources.gpuDriven,
        undefined,
        false,
        undefined,
      ),
    ).toThrow(RENDER_GPU_DRIVEN_RASTER_SYSTEM);
  });
  it('captures resource generation before preparation replaces it', () => {
    const context = setup('forward', false);
    const staged = stagePreparation(context);
    staged.prepare.mockImplementation(() => {
      Object.assign(staged.sources.gpuDriven.owner, { resourceGeneration: 8 });
      return ok(undefined);
    });
    expect(context.world.run(RenderQueue).ok).toBe(true);
    const consumed = consumeViewGpuDriven(context.internals, staged.sources.gpuDriven, () => {});
    expect(consumed.preparation?.resourceGeneration).toBe(7);
    expect(staged.sources.gpuDriven.owner.resourceGeneration).toBe(8);
  });
  it('leaves an unstaged view lane untouched and permits a camera-less clear', () => {
    const context = setup('forward', false);
    const stageRasterLane = vi.fn();
    const state = context.world.allocUniqueRef('ViewRecorder', {
      owner: { scene: { stageRasterLane } },
    });
    context.world.addComponent(context.view, { component: ViewRecorder, data: { state } }).unwrap();
    context.world
      .addSystem(RenderQueue, { name: RENDER_SKIN_DEMAND_SYSTEM, queries: [], fn: () => {} })
      .unwrap();
    registerGpuDrivenRasterSystem(context.world);
    expect(context.world.run(RenderQueue).ok).toBe(true);
    expect(stageRasterLane).not.toHaveBeenCalled();
    const lane = consumeViewGpuDrivenRaster(
      context.internals,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
    );
    expect(lane.raster).toBeUndefined();
    expect(lane.selection.empty).toBe(true);
  });

  it('stores shadow-view rejection while retaining the prepared frame for Cleanup', () => {
    const context = setup('forward', false);
    const error = new RhiError({
      code: 'rhi-not-available',
      expected: 'shadow producer',
      hint: 'retry',
    });
    const prepared = { updateShadowViews: () => err(error) } as unknown as PreparedGpuDrivenFrame;
    const staged = stagePreparation(
      context,
      vi.fn(() => ok(prepared)),
    );
    const fire = vi.fn();
    Object.assign(context.internals, { errorRegistry: { fire } });
    expect(context.world.run(RenderQueue).ok).toBe(true);
    expect(
      updateGpuDrivenShadowViews(
        context.internals,
        prepared,
        undefined,
        false,
        staged.sources.lights,
        () => new Map(),
        undefined,
        1,
        undefined,
      ),
    ).toBe(false);
    expect(viewGpuDrivenOf(context.world, context.view)).toEqual({
      kind: 'rejected',
      code: 'shadow-views-rejected',
      error,
    });
    expect(fire).toHaveBeenCalledWith(error);
    expect(staged.frameState.gpuDrivenFrame?.prepared).toBe(prepared);
  });
});
