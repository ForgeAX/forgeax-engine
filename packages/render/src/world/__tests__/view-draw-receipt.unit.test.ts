import { describe, expect, it, vi } from 'vitest';
import type { CameraSnapshot } from '../../render-contract';
import type { ExtractedFrame } from '../../render-system-extract';
import {
  RenderView,
  RenderViewFrameSource,
  RenderViewInput,
  RenderViews,
  recordViewSubmission,
  ViewRecorder,
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
  adoptViewDraws,
  DYNAMIC_GEOMETRY_COMMIT_SYSTEM,
  DYNAMIC_GEOMETRY_RESET_SYSTEM,
  registerViewDrawSystems,
  TERRAIN_COMMIT_SYSTEM,
  VIEW_TERRAIN_CANDIDATE_SYSTEM,
  viewDrawReceipt,
} from '../view-draw-receipt';
import {
  RENDER_VIEW_FRAME_SYSTEM,
  RENDER_VIEW_RECORDERS_SYSTEM,
  stageViewFrame,
} from '../view-frame-systems';
import { registerViewFrameStub, withInertTemporal } from './temporal-owner-fixture';

const terrainCapture = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | (() => { sections: unknown[]; worldKeys: number[] } | undefined),
}));
vi.mock('../../terrain/submitted.js', () => ({
  captureSubmittedTerrain: () => {
    const candidate = terrainCapture.current?.();
    if (candidate === undefined) throw new Error('terrain capture failed');
    return candidate.sections;
  },
}));

const camera = {
  entityKey: 1,
  historyVersion: 1,
  view: {
    viewport: new Float32Array([0, 0, 1, 1]),
    order: 0,
    resolutionScale: 1,
    maxRenderShortSide: 0,
    updateInterval: 1,
    enabled: true,
  },
} as unknown as CameraSnapshot;

const scope = {} as never;
const entry = (mesh: number) =>
  ({ source: { worldId: 0, entityKey: 7, assetHandle: mesh } }) as never;

function setup(removed?: 'commit' | 'reset') {
  const world = createRenderWorld();
  const views = new RenderViews(world);
  registerViewDrawSystems(world);
  if (removed === 'commit') {
    world.removeSystem(RenderCommit, DYNAMIC_GEOMETRY_COMMIT_SYSTEM).unwrap();
    world.removeSystem(RenderCommit, TERRAIN_COMMIT_SYSTEM).unwrap();
  }
  if (removed === 'reset')
    world.removeSystem(RenderCleanup, DYNAMIC_GEOMETRY_RESET_SYSTEM).unwrap();
  world.insertResource(RenderViewInput, {
    cameras: [camera],
    captures: [],
    primary: false,
    primaryCamera: undefined,
    canvas: { width: 64, height: 64 },
    attachment: () => 'w',
    targetExtent: () => undefined,
  });
  beginRenderFrame(world, 1);
  const entity = views.ordered[0] as NonNullable<(typeof views.ordered)[0]>;
  adoptViewDraws(world, entity);
  const receipt = viewDrawReceipt(world, entity)?.dynamicGeometry;
  const record = (mesh: number, accepted: boolean, frame: number) => {
    receipt?.onRenderableDraw([scope])(entry(mesh));
    recordViewSubmission(world, entity, {
      accepted,
      attempt: frame,
      scene: accepted,
      temporal: false,
    });
  };
  const draws = viewDrawReceipt(world, entity) as NonNullable<ReturnType<typeof viewDrawReceipt>>;
  return { world, receipt, record, entity, draws };
}

describe('view draw receipt systems', () => {
  it('schedules commit in RenderCommit and reset in RenderCleanup against the view submission', () => {
    const { world } = setup();
    const data = world.scheduleData();
    const commit = data
      .find((s) => s.name === 'RenderCommit')
      ?.systems.find((s) => s.name === DYNAMIC_GEOMETRY_COMMIT_SYSTEM);
    const reset = data
      .find((s) => s.name === 'RenderCleanup')
      ?.systems.find((s) => s.name === DYNAMIC_GEOMETRY_RESET_SYSTEM);
    expect(commit?.queries[0]?.read).toEqual(
      expect.arrayContaining(['ViewSubmission', 'ViewDraws']),
    );
    expect(reset?.queries[0]?.read).toEqual(
      expect.arrayContaining(['ViewSubmission', 'ViewDraws']),
    );
  });

  it('publishes an accepted attempt only through the commit system', () => {
    const lane = (removed?: 'commit') => {
      const { world, receipt, record } = setup(removed);
      record(9, true, 1);
      endRenderFrame(world);
      return receipt?.recordStageLane(scope, 7, 9);
    };
    expect(lane()).toBe('cpu');
    expect(lane('commit')).toBeUndefined();
  });

  it('clears a rejected attempt and keeps a held view until the reset system is removed', () => {
    const second = (removed?: 'reset') => {
      const { world, receipt, record } = setup(removed);
      record(9, true, 1);
      endRenderFrame(world);
      beginRenderFrame(world, 2);
      record(10, false, 2);
      endRenderFrame(world);
      return [receipt?.recordStageLane(scope, 7, 9), receipt?.recordStageLane(scope, 7, 10)];
    };
    expect(second()).toEqual([undefined, undefined]);
    expect(second('reset')).toEqual(['cpu', undefined]);
    const { world, receipt, record } = setup();
    record(9, true, 1);
    endRenderFrame(world);
    beginRenderFrame(world, 2);
    endRenderFrame(world);
    expect(receipt?.recordStageLane(scope, 7, 9)).toBe('cpu');
  });

  it('publishes drawn terrain sections only through the commit system for an accepted attempt', () => {
    const sections = [1, 2].map((n) => ({ worldId: 0, entity: n, section: 0 }) as never);
    const presented = { hasTerrain: (entity: number) => entity === 1 } as never;
    const run = (accepted: boolean, removed?: 'commit') => {
      const { world, entity, draws } = setup(removed);
      publishRenderSubmission(world, {
        accepted: true,
        completion: undefined,
        creditCompletion: undefined,
        generation: 0,
      });
      draws.stageTerrainCandidate(1, { sections, worldKeys: [0] });
      draws.stageTerrainPresented(presented);
      recordViewSubmission(world, entity, {
        accepted,
        attempt: 1,
        scene: accepted,
        temporal: false,
      });
      endRenderFrame(world);
      return draws.terrain.length;
    };
    expect(run(true)).toBe(1);
    expect(run(true, 'commit')).toBe(0);
    expect(run(false)).toBe(0);
  });
});

describe('view-terrain-candidate system', () => {
  const opts = { cameraOwner: 0, resourceOwner: 0 } as const;

  function stagedSetup(capture: () => unknown, removed = false) {
    terrainCapture.current = capture as typeof terrainCapture.current;
    const world = createRenderWorld();
    world.insertResource(
      RenderViewInput,
      new RenderViewFrameSource({ canvas: { width: 8, height: 8 } }),
    );
    registerViewDrawSystems(world);
    if (removed) world.removeSystem(RenderPrepare, VIEW_TERRAIN_CANDIDATE_SYSTEM).unwrap();
    const recorder = {
      prepareViewFrame: () => ({
        ok: true as const,
        value: { renderables: [], dispatch: [], cameras: [camera] } as unknown as ExtractedFrame,
      }),
    };
    registerViewFrameStub(world, recorder.prepareViewFrame);
    const staged = world.spawn({ component: RenderView, data: {} }).unwrap();
    const held = world.spawn({ component: RenderView, data: {} }).unwrap();
    for (const entity of [staged, held]) {
      const state = world.allocUniqueRef(
        'ViewRecorder',
        withInertTemporal(
          {},
          { scene: { visibilityWorldKeysFor: () => terrainCapture.current?.()?.worldKeys } },
        ),
      );
      world.addComponent(entity, { component: ViewRecorder, data: { state } }).unwrap();
      adoptViewDraws(world, entity);
    }
    world
      .addSystem(RenderExtract, {
        name: RENDER_VIEW_RECORDERS_SYSTEM,
        queries: [],
        fn: (world) => stageViewFrame(world, staged, opts),
      })
      .unwrap();
    return { world, staged, held };
  }

  const presented = { hasTerrain: (entity: number) => entity === 1 } as never;
  const candidate = {
    sections: [1, 2].map((n) => ({ worldId: 0, entity: n, section: 0 }) as never),
    worldKeys: [0],
  };

  function frameOf(removed: boolean, accepted: boolean, capture = () => candidate as never) {
    const { world, staged, held } = stagedSetup(capture, removed);
    beginRenderFrame(world, 1);
    for (const entity of [staged, held])
      viewDrawReceipt(world, entity)?.stageTerrainPresented(presented);
    publishRenderSubmission(world, {
      accepted,
      completion: undefined,
      creditCompletion: undefined,
      generation: 0,
    });
    for (const entity of [staged, held])
      recordViewSubmission(world, entity, {
        accepted,
        attempt: 1,
        scene: accepted,
        temporal: false,
      });
    endRenderFrame(world);
    return [staged, held].map((entity) => viewDrawReceipt(world, entity)?.terrain.length);
  }

  it('captures the staged view candidate in RenderPrepare and commits the presented part', () => {
    expect(frameOf(false, true)).toEqual([1, 0]);
  });

  it('publishes nothing without the system, for a rejected frame, or a failed capture', () => {
    expect(frameOf(true, true)).toEqual([0, 0]);
    expect(frameOf(false, false)).toEqual([0, 0]);
    expect(frameOf(false, true, () => undefined as never)).toEqual([0, 0]);
  });

  it('declares its view reads, phase order and no writes in the schedule', () => {
    const { world } = stagedSetup(() => undefined);
    const prepare = world
      .scheduleData()
      .find((data) => data.name === 'RenderPrepare')
      ?.systems.find((data) => data.name === VIEW_TERRAIN_CANDIDATE_SYSTEM);
    expect(prepare?.after).toEqual([RENDER_VIEW_FRAME_SYSTEM]);
    expect(prepare?.queries[0]?.read).toEqual(['ViewRecorder', 'ViewFrame', 'ViewDraws']);
    expect(prepare?.queries[0]?.write ?? []).toEqual([]);
  });
});
