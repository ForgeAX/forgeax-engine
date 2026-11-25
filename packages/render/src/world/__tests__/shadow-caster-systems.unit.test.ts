import { defineSystem } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { describe, expect, it, vi } from 'vitest';
import { viewSourceFixture } from '../../__tests__/view-source.fixture';
import type { ExtractedFrame, RenderableSnapshot } from '../../render-system-extract';
import type { FrameList } from '../../scene/frame-list';
import { shadowPlanes } from '../../shadow-frustum';
import { RenderCascadeFitOrder, RenderScenePublishOrder } from '../../system-order';
import { RENDER_CASCADE_FIT_SYSTEM } from '../light-systems';
import { createViewRecord, ViewCascadeFit, type ViewLights } from '../render-lights';
import { RenderViewFrameSource, RenderViewInput, ViewRecorder } from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderExtract,
  RenderPrepare,
} from '../render-world';
import { RENDER_SCENE_PUBLISH_SYSTEM } from '../scene-systems';
import {
  RENDER_SHADOW_CASTERS_SYSTEM,
  registerShadowCasterSystem,
  viewShadowCastersOf,
} from '../shadow-caster-systems';
import { RENDER_VIEW_RECORDERS_SYSTEM, stageViewFrame } from '../view-frame-systems';
import { registerViewFrameStub, withInertTemporal } from './temporal-owner-fixture';

const opts = {} as const;
const skinBinding = {} as RenderableSnapshot['skinBinding'];

/** A Skin row whose world bounds are a unit box centred at `x` on the X axis. */
function skinRow(entityKey: number, x: number, extra: Partial<RenderableSnapshot> = {}) {
  return { entityKey, skinBinding, x, ...extra } as unknown as RenderableSnapshot & {
    readonly x: number;
  };
}

const inside = skinRow(1, 0);
const outside = skinRow(2, 10);
const otherChannel = skinRow(3, 0, { shadowChannels: 2 });
const notCaster = skinRow(4, 0, { shadowCaster: false });
const rows = [inside, outside, otherChannel, notCaster];

/** One directional cascade covering the unit clip volume, rastering caster channel 1. */
const matrix = mat4.identity(mat4.create()) as Float32Array;
const lights = {
  directionalCsmConfig: { shadowCasterChannels: 1 },
  cascades: { lightViewProj: [matrix] },
  shadowViews: [
    { identity: { kind: 'directional', index: 0 }, matrix, planes: shadowPlanes(matrix) },
  ],
  pointShadow: [],
  spot: [],
} as unknown as ViewLights;

function setup(
  options: {
    readonly system?: boolean;
    readonly capture?: boolean;
    readonly unfitted?: boolean;
    readonly lights?: ViewLights;
  } = {},
) {
  const world = createRenderWorld();
  const source = new RenderViewFrameSource({ canvas: { width: 8, height: 8 } });
  world.insertResource(RenderViewInput, viewSourceFixture(source));
  const systemToken1 = defineSystem({
    sets: [RenderScenePublishOrder],
    name: RENDER_SCENE_PUBLISH_SYSTEM,
    queries: [],
    fn: () => {},
  });
  world.addSystem(RenderPrepare, systemToken1).unwrap();
  if (options.system !== false) registerShadowCasterSystem(world);
  // The GPU lane's raster coverage of each frame; the caster projection never reads it.
  let gpuOwned: ExtractedFrame['gpuOwned'];
  const reads: number[] = [];
  const boundsReads: number[] = [];
  const recorder = {
    prepareViewFrame: () => ({
      ok: true as const,
      value: {
        renderables: [],
        gpuOwned,
        cubeCameras: [],
        auxiliaryCameras: [],
      } as unknown as ExtractedFrame,
    }),
  };
  registerViewFrameStub(world, recorder.prepareViewFrame);
  const scene = {
    shadowCasterProjection: () => {
      reads.push(1);
      return {
        renderables: rows as unknown as FrameList<RenderableSnapshot>,
        worldBoundsOf: (row: unknown, out: Float32Array) => {
          boundsReads.push((row as (typeof rows)[number]).entityKey);
          const x = (row as (typeof rows)[number]).x;
          out.set([x - 0.25, -0.25, 0.25, x + 0.25, 0.25, 0.75]);
          return true;
        },
      };
    },
  };
  const featureSceneInputs = { work: options.capture === true ? [{}] : [] };
  const view = world.spawn().unwrap();
  world
    .addComponent(view, {
      component: ViewRecorder,
      data: {
        state: world.allocUniqueRef(
          'ViewRecorder',
          withInertTemporal({}, { scene, internals: { featureSceneInputs } }),
        ),
      },
    })
    .unwrap();
  const record = createViewRecord(view);
  record.lights =
    options.unfitted === true ? { ...lights, shadowViews: [] } : (options.lights ?? lights);
  world
    .addComponent(view, {
      component: ViewCascadeFit,
      data: { fit: world.allocUniqueRef('ViewCascadeFit', record) },
    })
    .unwrap();
  const systemToken2 = defineSystem({
    sets: [RenderCascadeFitOrder],
    name: RENDER_CASCADE_FIT_SYSTEM,
    queries: [],
    fn: () => {},
  });
  world.addSystem(RenderPrepare, systemToken2).unwrap();
  const systemToken3 = defineSystem({
    name: RENDER_VIEW_RECORDERS_SYSTEM,
    queries: [],
    fn: (world) => stageViewFrame(world, view, opts),
  });
  world.addSystem(RenderExtract, systemToken3).unwrap();
  const run = (frameNumber: number, owned?: ExtractedFrame['gpuOwned']) => {
    gpuOwned = owned;
    source.stage([], [], undefined, opts, undefined, undefined);
    beginRenderFrame(world, frameNumber);
  };
  return { world, view, reads, boundsReads, run };
}

describe('render-shadow-casters', () => {
  it('projects the Skin casters a shadow view rasters: frustum and caster channels', () => {
    const { world, view, run } = setup();
    run(1);
    expect(viewShadowCastersOf(world, view)).toEqual([inside]);
    endRenderFrame(world);
  });

  it('leaves the view without shadow casters when the system is absent (red without the system)', () => {
    const { world, view, reads, run } = setup({ system: false });
    run(1);
    expect(reads).toEqual([]);
    expect(viewShadowCastersOf(world, view)).toBeUndefined();
    endRenderFrame(world);
  });

  it('admits every caster of a capture view, whose faces fit at record time', () => {
    const { world, view, run } = setup({ capture: true });
    run(1);
    expect(viewShadowCastersOf(world, view)).toEqual([inside, outside, otherChannel]);
    endRenderFrame(world);
  });

  it('keeps a GPU-covered caster across its flip to the CPU lane with one projection per frame', () => {
    const { world, view, reads, run } = setup();
    const covered = {
      selection: {},
      residual: () => [],
    } as unknown as NonNullable<ExtractedFrame['gpuOwned']>;
    run(1, covered);
    const first = viewShadowCastersOf(world, view);
    expect(first).toEqual([inside]);
    endRenderFrame(world);
    // The GPU lane no longer covers the row: the same frame projects it, no re-run.
    run(2, undefined);
    expect(viewShadowCastersOf(world, view)).toEqual([inside]);
    expect(viewShadowCastersOf(world, view)).toBe(first);
    expect(reads).toHaveLength(2);
    endRenderFrame(world);
  });

  it('declares its RenderPrepare reads, order and per-view caster component', () => {
    const { world } = setup();
    const prepare = world.scheduleData().find((schedule) => schedule.name === 'RenderPrepare');
    const system = prepare?.systems.find((entry) => entry.name === RENDER_SHADOW_CASTERS_SYSTEM);
    expect(system?.queries).toEqual([
      expect.objectContaining({
        read: ['ViewRecorder', 'ViewFrame'],
        optional: ['ViewCascadeFit', 'ViewShadowCasters'],
      }),
    ]);
  });
});

it('captures shadow inputs without testing Skin bounds before the current demand owner is known', () => {
  const f = setup();
  f.run(1);
  expect(f.boundsReads).toEqual([]);
  expect(viewShadowCastersOf(f.world, f.view)).toEqual([inside]);
  expect(f.boundsReads).toEqual([inside.entityKey, outside.entityKey]);
  endRenderFrame(f.world);
});

const selectedCasters: (
  world: Parameters<typeof viewShadowCastersOf>[0],
  view: Parameters<typeof viewShadowCastersOf>[1],
  owner: { ownsAll(row: RenderableSnapshot): boolean } | undefined,
) => ReturnType<typeof viewShadowCastersOf> = viewShadowCastersOf;

it('does not test GPU-owned caster bounds and widens again after ownership is lost in the same frame', () => {
  const f = setup();
  f.run(1);
  expect(selectedCasters(f.world, f.view, { ownsAll: () => true })).toEqual([]);
  expect(f.boundsReads).toEqual([]);
  expect(selectedCasters(f.world, f.view, undefined)).toEqual([inside]);
  expect(f.boundsReads).toEqual([inside.entityKey, outside.entityKey]);
  endRenderFrame(f.world);
});

it('keeps every capture caster even when the ordinary shadow owner covers every row', () => {
  const f = setup({ capture: true });
  f.run(1);
  expect(selectedCasters(f.world, f.view, { ownsAll: () => true })).toEqual([
    inside,
    outside,
    otherChannel,
  ]);
  expect(f.boundsReads).toEqual([]);
  endRenderFrame(f.world);
});

it('keeps all casters when shadow fits are unknown despite a previous GPU owner', () => {
  const f = setup({ unfitted: true });
  f.run(1);
  expect(selectedCasters(f.world, f.view, { ownsAll: () => true })).toEqual([
    inside,
    outside,
    otherChannel,
  ]);
  expect(f.boundsReads).toEqual([]);
  endRenderFrame(f.world);
});

it('widens a late capture demand beyond the main fitted frustum in the same frame', () => {
  const f = setup();
  f.run(1);
  expect(viewShadowCastersOf(f.world, f.view)).toEqual([inside]);
  expect(viewShadowCastersOf(f.world, f.view, { ownsAll: () => true }, true)).toEqual([
    inside,
    outside,
    otherChannel,
  ]);
  endRenderFrame(f.world);
});

it('reads each candidate bound once across multiple shadow frusta and resolves channels once per view', () => {
  const projected = lights.shadowViews[0];
  if (projected === undefined) throw new Error('missing fixture cascade');
  const masks = vi.fn(() => 1);
  const fitted = {
    ...lights,
    spot: [
      {
        shadowAtlasTile: 2,
        get shadowCasterChannels() {
          return masks();
        },
      },
    ],
    shadowViews: [projected, { ...projected, identity: { kind: 'spot', index: 2 } }],
  } as unknown as ViewLights;
  const f = setup({ lights: fitted });
  f.run(1);
  expect(viewShadowCastersOf(f.world, f.view)).toEqual([inside]);
  expect(f.boundsReads).toEqual([inside.entityKey, outside.entityKey]);
  expect(masks).toHaveBeenCalledOnce();
  endRenderFrame(f.world);
});
