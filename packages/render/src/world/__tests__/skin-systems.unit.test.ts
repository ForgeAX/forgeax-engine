import { describe, expect, it } from 'vitest';
import type { ExtractedFrame, RenderableSnapshot } from '../../render-system-extract';
import { RENDER_GPU_DRIVEN_PREPARE_SYSTEM } from '../gpu-driven-systems';
import { RenderViewFrameSource, RenderViewInput, ViewRecorder } from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderExtract,
  RenderPrepare,
  RenderQueue,
  runRenderQueue,
} from '../render-world';
import { RENDER_SCENE_PUBLISH_SYSTEM } from '../scene-systems';
import {
  cpuSkinRows,
  RENDER_SKIN_DEMAND_SYSTEM,
  registerSkinDemandSystem,
  type SkinDemandLane,
  viewSkinDemandOf,
} from '../skin-systems';
import {
  RENDER_VIEW_RECORDERS_SYSTEM,
  stageViewFrame,
  type ViewFrameResult,
  type ViewRecordMode,
} from '../view-frame-systems';
import { registerViewFrameStub, withInertTemporal } from './temporal-owner-fixture';

const opts = { cameraOwner: 0, resourceOwner: 0 } as const;
const skinRow = (entityKey: number, extra: object = {}) =>
  ({ worldId: 0, entityKey, skinBinding: {}, ...extra }) as unknown as RenderableSnapshot;
// Entity 3 is author-hidden, 5 is rejected by the camera; 1 and 2 are demanded.
const frame = {
  cameras: [{}],
  cubeCameras: [],
  auxiliaryCameras: [],
  renderables: [
    skinRow(1),
    skinRow(2),
    skinRow(3, { authorVisible: false }),
    skinRow(5),
    { worldId: 0, entityKey: 9 },
  ],
  cameraVisible: (row: RenderableSnapshot) => row.entityKey !== 5,
} as unknown as ExtractedFrame;
const demanded = new Map([[7, undefined]]);

function setup(
  options: {
    readonly mode?: ViewRecordMode;
    readonly system?: boolean;
    readonly throws?: boolean;
    readonly frameResult?: ViewFrameResult;
    readonly lane?: () => SkinDemandLane | undefined;
  } = {},
) {
  const world = createRenderWorld();
  const source = new RenderViewFrameSource({ canvas: { width: 8, height: 8 } });
  world.insertResource(RenderViewInput, source);
  world
    .addSystem(RenderPrepare, { name: RENDER_SCENE_PUBLISH_SYSTEM, queries: [], fn: () => {} })
    .unwrap();
  if (options.system !== false) registerSkinDemandSystem(world);
  const prepared: number[][] = [];
  const recorder = {
    prepareViewFrame: () => options.frameResult ?? { ok: true, value: frame },
  };
  registerViewFrameStub(world, recorder.prepareViewFrame);
  const owner = {
    internals: {
      device: { queue: {} },
      errorRegistry: { fire: () => undefined },
      featureSceneInputs: undefined,
    },
    scene: { skinDemandLane: () => options.lane?.() },
    skin: {
      trackSubmittedWork: () => undefined,
      complete: () => [],
      prepareDemand: (rows: Iterable<RenderableSnapshot>) => {
        prepared.push([...rows].map((row) => row.entityKey));
        if (options.throws === true) throw new Error('compose failed');
        return demanded;
      },
    },
  };
  const staged = world.spawn().unwrap();
  const held = world.spawn().unwrap();
  for (const entity of [staged, held]) {
    const state = world.allocUniqueRef('ViewRecorder', withInertTemporal({}, owner));
    world.addComponent(entity, { component: ViewRecorder, data: { state } }).unwrap();
  }
  world
    .addSystem(RenderExtract, {
      name: RENDER_VIEW_RECORDERS_SYSTEM,
      queries: [],
      fn: (world) =>
        stageViewFrame(world, staged, { ...opts, cameraEntityKey: 7 }, options.mode ?? true),
    })
    .unwrap();
  const run = (frameNumber: number) => {
    source.stage([], [], [], opts, undefined, undefined);
    beginRenderFrame(world, frameNumber);
    runRenderQueue(world);
  };
  return { world, staged, held, prepared, run };
}

describe('render-skin-demand', () => {
  it('composes the demand of each prepared view in RenderQueue, for its own frame only', () => {
    const { world, staged, held, prepared, run } = setup();
    run(1);
    expect(prepared).toEqual([[1, 2]]);
    expect(viewSkinDemandOf(world, staged)).toEqual({ ok: true, value: demanded });
    expect(viewSkinDemandOf(world, held)).toBeUndefined();
    endRenderFrame(world);
    // A frame that has not reached RenderQueue exposes no stale demand.
    beginRenderFrame(world, 2);
    expect(viewSkinDemandOf(world, staged)).toBeUndefined();
    runRenderQueue(world);
    expect(viewSkinDemandOf(world, staged)).toEqual({ ok: true, value: demanded });
    expect(prepared).toHaveLength(2);
    endRenderFrame(world);
  });

  it('leaves a recording without demand when the system is absent (red without the system)', () => {
    const { world, staged, prepared, run } = setup({ system: false });
    run(1);
    expect(prepared).toEqual([]);
    expect(viewSkinDemandOf(world, staged)).toBeUndefined();
    endRenderFrame(world);
  });

  it('composes nothing for a held view or a failed view frame', () => {
    const held = setup({ mode: false });
    held.run(1);
    expect(held.prepared).toEqual([]);
    expect(viewSkinDemandOf(held.world, held.staged)).toBeUndefined();
    endRenderFrame(held.world);

    const failed = setup({ frameResult: { ok: false, cause: new Error('pending') } });
    failed.run(1);
    expect(failed.prepared).toEqual([]);
    expect(viewSkinDemandOf(failed.world, failed.staged)).toBeUndefined();
    endRenderFrame(failed.world);
  });

  it('reports a compose failure as the view result instead of throwing', () => {
    const { world, staged, run } = setup({ throws: true });
    run(1);
    const result = viewSkinDemandOf(world, staged);
    expect(result?.ok).toBe(false);
    endRenderFrame(world);
  });

  it('declares its RenderQueue reads and its per-view demand component', () => {
    const { world } = setup();
    const queue = world.scheduleData().find((schedule) => schedule.name === 'RenderQueue');
    const system = queue?.systems.find((entry) => entry.name === RENDER_SKIN_DEMAND_SYSTEM);
    expect(system?.queries).toEqual([
      expect.objectContaining({
        read: ['ViewRecorder', 'ViewFrame'],
        optional: ['ViewSkinDemand'],
      }),
    ]);
  });
});

describe('cpuSkinRows', () => {
  const row = (entityKey: number) => ({ worldId: 0, entityKey }) as RenderableSnapshot;
  // Entities 17 and 29 draw entirely on the GPU lane; 23 is unbatched or a
  // member of an uncovered binding.
  const owner = { ownsAll: (source: RenderableSnapshot) => source.entityKey !== 23 };

  it('composes no palette for a row the GPU raster lane draws', () => {
    const rows = [row(17), row(23), row(29)];
    expect([...cpuSkinRows(rows, owner)].map((source) => source.entityKey)).toEqual([23]);
  });

  it('keeps every row without a GPU raster lane', () => {
    const rows = [row(17), row(23)];
    expect(cpuSkinRows(rows, undefined)).toBe(rows);
  });
});

it.each([
  16, 4096,
])('reads the sparse residual Skin query without materializing N=%i rigid residual rows', (count) => {
  let materialized = 0;
  const selection = { ownsAll: () => true };
  const selected = {
    ...frame,
    gpuOwned: {
      selection,
      residual: () => {
        materialized += count;
        return Array.from({ length: count }, (_, entityKey) => ({ worldId: 0, entityKey }));
      },
      residualSkin: () => [],
    },
  } as unknown as ExtractedFrame;
  const f = setup({
    frameResult: { ok: true, value: selected },
    lane: () => ({ selection, shadowSelection: undefined }),
  });
  f.run(1);
  expect(f.prepared).toEqual([[]]);
  expect(materialized).toBe(0);
  endRenderFrame(f.world);
});

it('reads GPU ownership after preparation can invalidate the previous resident lane', () => {
  const selection = { ownsAll: () => true };
  let lane: SkinDemandLane | undefined = { selection, shadowSelection: undefined };
  const events: string[] = [];
  const selected = {
    ...frame,
    gpuOwned: { selection, residual: () => [], residualSkin: () => [] },
  } as unknown as ExtractedFrame;
  const f = setup({
    frameResult: { ok: true, value: selected },
    lane: () => {
      events.push('skin-owner');
      return lane;
    },
  });
  f.world
    .addSystem(RenderQueue, {
      name: RENDER_GPU_DRIVEN_PREPARE_SYSTEM,
      queries: [],
      fn: () => {
        events.push('gpu-prepare');
        lane = undefined;
      },
    })
    .unwrap();
  f.run(1);
  expect(events).toEqual(['gpu-prepare', 'skin-owner']);
  expect(f.prepared).toEqual([[1, 2]]);
  endRenderFrame(f.world);
});
