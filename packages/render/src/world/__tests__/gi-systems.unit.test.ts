import { describe, expect, it } from 'vitest';
import { consumeViewDiffuseGi, type FrameDiffuseGi } from '../../record/frame-diffuse-gi';
import type { RenderFrameState } from '../../record/frame-snapshot';
import { frameSubmissionHooks } from '../../record/frame-submission';
import type { RenderSystemInternals } from '../../record/render-context';
import type { CameraSnapshot } from '../../render-contract';
import type { ExtractedFrame } from '../../render-system-extract';
import { RenderScene } from '../../scene/render-scene';
import { type ProjectedRows, projectedRows } from '../../scene/row-projection';
import { RENDER_CAPTURE_GRAPH_RETIRE_SYSTEM } from '../capture-graph-systems';
import {
  RENDER_DISPLAY_COMMIT_SYSTEM,
  RENDER_DISPLAY_DISCARD_SYSTEM,
} from '../display-submission-systems';
import { RENDER_FEATURE_GRAPH_RETIRE_SYSTEM } from '../feature-graph-systems';
import {
  GI_SUBMISSION_CLEANUP_SYSTEM,
  GI_SUBMISSION_COMMIT_SYSTEM,
  GiSubmissions,
  giSubmissionsOf,
  registerGiSystems,
  registerViewDiffuseGiSystem,
  registerVisibleSurfaceSystem,
  requireGiSubmissions,
  VIEW_DIFFUSE_GI_SYSTEM,
  VISIBLE_SURFACE_ROWS_SYSTEM,
  viewDiffuseGiOf,
  visibleSurfaceOf,
} from '../gi-systems';
import { RENDER_GRAPH_SEAL_RELEASE_SYSTEM } from '../graph-seal-systems';
import {
  type GraphSubmission,
  RENDER_GRAPH_SUBMISSION_ABORT_SYSTEM,
  RENDER_GRAPH_SUBMISSION_COMMIT_SYSTEM,
} from '../graph-submission-systems';
import { RENDER_GRAPH_COMPILE_RELEASE_SYSTEM, RENDER_GRAPH_SETTLE_SYSTEM } from '../graph-systems';
import { RENDER_CASCADE_FIT_SYSTEM } from '../light-systems';
import { RENDER_POST_CLEANUP_SYSTEM, RENDER_POST_COMMIT_SYSTEM } from '../post-systems';
import { VIEW_REFLECTION_PROBES_SYSTEM } from '../reflection-systems';
import { createViewRecord, ViewCascadeFit, type ViewLights } from '../render-lights';
import {
  RenderViewFrameSource,
  RenderViewInput,
  ViewRecorder,
  ViewSubmission,
} from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  publishRenderSubmission,
  RenderCleanup,
  RenderCommit,
  RenderExtract,
  RenderPrepare,
} from '../render-world';
import {
  RENDER_RECORD_COMMIT_SYSTEM,
  RENDER_RECORD_RETIRE_SYSTEM,
  RENDER_SUBMISSION_RETIRE_SYSTEM,
} from '../submission-systems';
import {
  RENDER_TEMPORAL_COMMIT_SYSTEMS,
  RENDER_TEMPORAL_DISCARD_SYSTEM,
} from '../temporal-systems';
import {
  RENDER_VIEW_FRAME_SYSTEM,
  RENDER_VIEW_RECORDERS_SYSTEM,
  stageViewFrame,
} from '../view-frame-systems';
import {
  RENDER_SETTLEMENT_CLEANUP_SYSTEMS,
  RENDER_SETTLEMENT_COMMIT_SYSTEMS,
} from '../view-settlement';
import { registerViewFrameStub, withInertTemporal } from './temporal-owner-fixture';

function giFrame(log: string[]): FrameDiffuseGi {
  const owner = (name: string) => ({
    fence: { capturedGeneration: 0, currentGeneration: () => 0 },
    track: () => log.push(`${name}.track`),
    commit: () => log.push(`${name}.commit`),
  });
  return {
    rayDiffuse: owner('ray'),
    irradianceField: undefined,
    bakedField: undefined,
    screenProbe: undefined,
    probePlacement: { ...owner('placement'), abort: () => log.push('placement.abort') },
  } as unknown as FrameDiffuseGi;
}

/** One view's real submission hooks inside one Renderer frame. */
function frame(
  world: ReturnType<typeof createRenderWorld>,
  log: string[],
  outcome: 'accepted' | 'not-submitted' | 'rejected',
): void {
  beginRenderFrame(world, 1);
  const internals = { renderWorld: world } as unknown as RenderSystemInternals;
  const gi = giFrame(log);
  // prepareFrameDiffuseGi enqueues the view's prepared owners.
  if (world.hasResource(GiSubmissions)) requireGiSubmissions(internals).prepared.push(gi);
  const hooks = frameSubmissionHooks(
    internals,
    {} as never,
    {} as never,
    gi,
    undefined,
    undefined,
    undefined,
    undefined,
  );
  if (outcome !== 'not-submitted') hooks?.onSubmittedWork(Promise.resolve());
  const frameState = {
    graphSubmission: {
      frame: 1,
      timing: undefined,
      passTiming: undefined,
      gi: hooks?.gi,
      onAccepted: undefined,
      submitted: outcome !== 'not-submitted',
      rejectedStage: undefined,
      settled: false,
    } satisfies GraphSubmission,
  };
  const state = world.allocUniqueRef(
    'ViewRecorder',
    withInertTemporal({}, { internals, frameState }),
  );
  const entity = world
    .spawn(
      { component: ViewRecorder, data: { state } },
      {
        component: ViewSubmission,
        data: { accepted: outcome === 'accepted', attempt: 1, scene: false, temporal: false },
      },
    )
    .unwrap();
  publishRenderSubmission(world, {
    accepted: outcome === 'accepted',
    completion: undefined,
    creditCompletion: undefined,
    generation: 1,
  });
  endRenderFrame(world);
  world.despawn(entity).unwrap();
}

describe('GI submission systems', () => {
  it('commit only physically submitted GI of an accepted frame and abort the rest', () => {
    const world = createRenderWorld();
    registerGiSystems(world);
    const log: string[] = [];
    frame(world, log, 'accepted');
    expect(log).toEqual([
      'placement.track',
      'ray.track',
      'placement.commit',
      'ray.commit',
      'placement.abort',
    ]);
    log.length = 0;
    frame(world, log, 'rejected');
    expect(log).toEqual(['placement.track', 'ray.track', 'placement.abort']);
    log.length = 0;
    frame(world, log, 'not-submitted');
    expect(log).toEqual(['placement.abort']);
    const queue = giSubmissionsOf(world);
    expect(queue?.prepared).toHaveLength(0);
    expect(queue?.submitted).toHaveLength(0);
  });

  it('advances no GI history once the commit system is removed', () => {
    const world = createRenderWorld();
    registerGiSystems(world);
    world.removeSystem(RenderCommit, GI_SUBMISSION_COMMIT_SYSTEM).unwrap();
    const log: string[] = [];
    frame(world, log, 'accepted');
    expect(log.filter((entry) => entry.endsWith('.commit'))).toEqual([]);
  });

  it('leaves a rejected placement candidate unretired once the cleanup system is removed', () => {
    const world = createRenderWorld();
    registerGiSystems(world);
    world.removeSystem(RenderCleanup, GI_SUBMISSION_CLEANUP_SYSTEM).unwrap();
    const log: string[] = [];
    frame(world, log, 'rejected');
    expect(log).not.toContain('placement.abort');
  });

  it('declares the commit and cleanup systems in their Render World phases', () => {
    const world = createRenderWorld();
    registerGiSystems(world);
    registerGiSystems(world);
    const names = (schedule: string) =>
      world
        .scheduleData()
        .find((data) => data.name === schedule)
        ?.systems.map((system) => system.name);
    expect(names('RenderCommit')).toEqual([
      RENDER_RECORD_COMMIT_SYSTEM,
      RENDER_POST_COMMIT_SYSTEM,
      ...RENDER_TEMPORAL_COMMIT_SYSTEMS,
      ...RENDER_SETTLEMENT_COMMIT_SYSTEMS,
      RENDER_GRAPH_SETTLE_SYSTEM,
      RENDER_GRAPH_SUBMISSION_COMMIT_SYSTEM,
      RENDER_DISPLAY_COMMIT_SYSTEM,
      GI_SUBMISSION_COMMIT_SYSTEM,
    ]);
    expect(names('RenderCleanup')).toEqual([
      RENDER_RECORD_RETIRE_SYSTEM,
      RENDER_SUBMISSION_RETIRE_SYSTEM,
      RENDER_POST_CLEANUP_SYSTEM,
      RENDER_TEMPORAL_DISCARD_SYSTEM,
      ...RENDER_SETTLEMENT_CLEANUP_SYSTEMS,
      RENDER_GRAPH_COMPILE_RELEASE_SYSTEM,
      RENDER_CAPTURE_GRAPH_RETIRE_SYSTEM,
      RENDER_GRAPH_SEAL_RELEASE_SYSTEM,
      RENDER_GRAPH_SUBMISSION_ABORT_SYSTEM,
      RENDER_DISPLAY_DISCARD_SYSTEM,
      RENDER_FEATURE_GRAPH_RETIRE_SYSTEM,
      'render-view-record-abandon',
      'render-view-record-release',
      GI_SUBMISSION_CLEANUP_SYSTEM,
    ]);
  });

  it('rejects GI submission hooks without a Render World frame entry', () => {
    expect(() => frame(createRenderWorld(), [], 'accepted')).toThrow(/frame entry/);
  });
});

describe('visible-surface-rows system', () => {
  function rowsOf(scene: RenderScene): ProjectedRows {
    return projectedRows({ slots: scene.slotsSnapshot() });
  }

  it('projects the shared rows once per frame and re-projects only changes', () => {
    const world = createRenderWorld();
    const scene = new RenderScene();
    registerVisibleSurfaceSystem(world, {
      enabled: () => true,
      retained: () => rowsOf(scene),
      maxRecords: () => 1024,
    });
    beginRenderFrame(world, 1);
    const state = visibleSurfaceOf(world);
    expect(state?.projection).toBeDefined();
    expect(state?.failure).toBeUndefined();
    const visits = state?.rows.visits;
    endRenderFrame(world);
    beginRenderFrame(world, 2);
    // An unchanged scene re-projects no rows.
    expect(state?.rows.visits).toBe(visits);
    endRenderFrame(world);
    expect(world.scheduleData().find((data) => data.name === 'RenderPrepare')?.systems).toEqual([
      expect.objectContaining({ name: 'render-surface-ui-prepare' }),
      expect.objectContaining({ name: VISIBLE_SURFACE_ROWS_SYSTEM }),
    ]);
  });

  it('stores a projection failure for the reading view instead of throwing', () => {
    const world = createRenderWorld();
    registerVisibleSurfaceSystem(world, {
      enabled: () => true,
      retained: () => rowsOf(new RenderScene()),
      maxRecords: () => -1,
    });
    beginRenderFrame(world, 1);
    expect(visibleSurfaceOf(world)?.projection).toBeUndefined();
    expect(visibleSurfaceOf(world)?.failure).toBeDefined();
    endRenderFrame(world);
  });

  it('leaves no visible-surface rows once the system is removed', () => {
    const world = createRenderWorld();
    registerVisibleSurfaceSystem(world, {
      enabled: () => true,
      retained: () => rowsOf(new RenderScene()),
      maxRecords: () => 1024,
    });
    world.removeSystem(RenderPrepare, VISIBLE_SURFACE_ROWS_SYSTEM).unwrap();
    beginRenderFrame(world, 1);
    expect(visibleSurfaceOf(world)?.projection).toBeUndefined();
    endRenderFrame(world);
    const prepare = world.scheduleData().find((data) => data.name === 'RenderPrepare');
    expect(prepare?.systems.map((system) => system.name)).toEqual(['render-surface-ui-prepare']);
  });
});

describe('view-diffuse-gi system', () => {
  const opts = { cameraOwner: 0, resourceOwner: 0 } as const;
  const lights = { directional: [], point: [], spot: [], rect: [] } as unknown as ViewLights;

  interface Setup {
    readonly standardProfile?: object;
    readonly mode?: boolean | 'capture';
    readonly fitted?: boolean;
    readonly canvas?: { width: number; height: number };
  }

  function setup({
    standardProfile,
    mode = true,
    fitted = true,
    canvas = { width: 8, height: 8 },
  }: Setup = {}) {
    const world = createRenderWorld();
    world.insertResource(
      RenderViewInput,
      new RenderViewFrameSource({ canvas: { width: 8, height: 8 } }),
    );
    const order: string[] = [];
    // Registered first so only `after` can order GI behind its inputs.
    registerViewDiffuseGiSystem(world);
    for (const name of [
      RENDER_CASCADE_FIT_SYSTEM,
      VISIBLE_SURFACE_ROWS_SYSTEM,
      VIEW_REFLECTION_PROBES_SYSTEM,
    ])
      world
        .addSystem(RenderPrepare, { name, queries: [], fn: () => void order.push(name) })
        .unwrap();
    const recorder = {
      prepareViewFrame: () => {
        order.push(RENDER_VIEW_FRAME_SYSTEM);
        return {
          ok: true as const,
          value: { renderables: [], cameras: [{ entityKey: 5 }] } as unknown as ExtractedFrame,
        };
      },
    };
    registerViewFrameStub(world, recorder.prepareViewFrame);
    const internals = {
      renderWorld: world,
      // The hoisted view extent: a display view's canvas reads its ViewCamera.
      canvas,
      device: { caps: {}, queue: {}, limits: { maxStorageBufferBindingSize: 1 << 20 } },
      deviceScope: { generation: 2 },
      errorRegistry: { fire: () => undefined },
      getPipelineState: () => ({}),
      standardProfile,
    };
    // The reflection-fallback lane: no GPU scene.
    const scene = {
      compositionGpuDrivenState: () => {
        order.push('gpu-scene');
        return undefined;
      },
    };
    const frameState = {} as Record<string, unknown>;
    const staged = world.spawn().unwrap();
    const held = world.spawn().unwrap();
    for (const entity of [staged, held]) {
      const state = world.allocUniqueRef(
        'ViewRecorder',
        withInertTemporal({}, { internals, scene, frameState }),
      );
      world.addComponent(entity, { component: ViewRecorder, data: { state } }).unwrap();
    }
    if (fitted) {
      const record = createViewRecord(staged);
      record.lights = lights;
      world
        .addComponent(staged, {
          component: ViewCascadeFit,
          data: { fit: world.allocUniqueRef('ViewCascadeFit', record) },
        })
        .unwrap();
    }
    world
      .addSystem(RenderExtract, {
        name: RENDER_VIEW_RECORDERS_SYSTEM,
        queries: [],
        fn: (world) => stageViewFrame(world, staged, opts, mode),
      })
      .unwrap();
    return { world, order, staged, held, frameState };
  }

  it('prepares each staged view after its frame, lights, surfaces and probes', () => {
    const { world, order, staged, held, frameState } = setup({
      canvas: { width: 64, height: 32 },
    });
    beginRenderFrame(world, 1);
    expect(order.slice(0, 4)).toContain(RENDER_VIEW_FRAME_SYSTEM);
    expect(order.at(-1)).toBe('gpu-scene');
    const outcome = viewDiffuseGiOf(world, staged);
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok !== true) throw new Error('unreachable');
    // The view's resolution is configured from its hoisted extent.
    expect(outcome.value.resolution).toBe(frameState.dynamicResolution);
    expect(outcome.value.gi.probePlacement).toBeUndefined();
    expect(viewDiffuseGiOf(world, held)).toBeUndefined();
    endRenderFrame(world);
    // The stored GI is this frame's only; recording reads it once.
    world.removeSystem(RenderPrepare, VIEW_DIFFUSE_GI_SYSTEM).unwrap();
    beginRenderFrame(world, 2);
    expect(viewDiffuseGiOf(world, staged)).toBeUndefined();
    endRenderFrame(world);
  });

  it('reads no GPU scene for a held, capture-only or unfitted view', () => {
    for (const input of [{ mode: false }, { mode: 'capture' as const }, { fitted: false }]) {
      const { world, order, staged } = setup(input);
      beginRenderFrame(world, 1);
      expect(order).not.toContain('gpu-scene');
      const outcome = viewDiffuseGiOf(world, staged);
      expect(outcome?.ok === true && outcome.value.gi.rayDiffuse).toBeUndefined();
      endRenderFrame(world);
    }
  });

  it('stores closed failure codes for the recording to rethrow', () => {
    const surface = setup({ standardProfile: { visibleSurface: true } });
    beginRenderFrame(surface.world, 1);
    const failed = viewDiffuseGiOf(surface.world, surface.staged);
    expect(failed?.ok === false && failed.code).toBe('visible-surface-failed');
    const internals = {
      renderWorld: surface.world,
      viewEntity: surface.staged,
    } as unknown as RenderSystemInternals;
    expect(() =>
      consumeViewDiffuseGi(
        internals,
        {} as RenderFrameState,
        {} as never,
        [],
        {} as CameraSnapshot,
      ),
    ).toThrow(/visible-surface/);
    endRenderFrame(surface.world);

    // Placement needs the retained scene the fallback lane does not have.
    const placement = setup({ standardProfile: { probePlacement: {} } });
    beginRenderFrame(placement.world, 1);
    const gi = viewDiffuseGiOf(placement.world, placement.staged);
    expect(gi?.ok === false && gi.code).toBe('gi-prepare-failed');
    endRenderFrame(placement.world);
  });

  it('drops a placement whose source a Feature mutated after RenderPrepare', () => {
    const log: string[] = [];
    let generation = 3;
    const probePlacement = {
      fence: { capturedGeneration: 3, currentGeneration: () => generation },
      abort: () => log.push('placement.abort'),
    };
    const { world, staged } = setup();
    const internals = {
      renderWorld: world,
      viewEntity: staged,
    } as unknown as RenderSystemInternals;
    const consume = () =>
      consumeViewDiffuseGi(
        internals,
        {} as RenderFrameState,
        {} as never,
        [],
        {} as CameraSnapshot,
      );
    beginRenderFrame(world, 1);
    const prepared = viewDiffuseGiOf(world, staged);
    if (prepared?.ok !== true) throw new Error('unreachable');
    // The placement RenderPrepare captured, as prepareProbePlacement returns it.
    (prepared.value as { gi: unknown }).gi = { probePlacement };
    expect(consume().gi.probePlacement).toBe(probePlacement);
    generation = -1;
    expect(consume().gi.probePlacement).toBeUndefined();
    expect(log).toEqual(['placement.abort']);
    endRenderFrame(world);
  });

  it('rejects recording a GI profile the system did not prepare', () => {
    const world = createRenderWorld();
    const internals = {
      renderWorld: world,
      viewEntity: world.spawn().unwrap(),
      standardProfile: { diffuseGi: { gather: 'baked' } },
    } as unknown as RenderSystemInternals;
    beginRenderFrame(world, 1);
    expect(() =>
      consumeViewDiffuseGi(
        internals,
        {} as RenderFrameState,
        {} as never,
        [],
        {} as CameraSnapshot,
      ),
    ).toThrow(/view-diffuse-gi/);
    endRenderFrame(world);
  });

  it('declares its view reads and phase order in the schedule', () => {
    const { world } = setup();
    const system = world
      .scheduleData()
      .find((data) => data.name === 'RenderPrepare')
      ?.systems.find((data) => data.name === VIEW_DIFFUSE_GI_SYSTEM);
    expect(system?.after).toEqual([
      RENDER_VIEW_FRAME_SYSTEM,
      RENDER_CASCADE_FIT_SYSTEM,
      VISIBLE_SURFACE_ROWS_SYSTEM,
      VIEW_REFLECTION_PROBES_SYSTEM,
    ]);
    expect(system?.queries[0]?.read).toEqual(['ViewRecorder', 'ViewFrame']);
    expect(system?.queries[0]?.optional).toEqual(['ViewDiffuseGi', 'ViewCascadeFit']);
    expect(system?.queries[0]?.write ?? []).toEqual([]);
  });
});
