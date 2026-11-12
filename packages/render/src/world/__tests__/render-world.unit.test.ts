import type { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import type { CameraSnapshot } from '../../render-contract';
import { RENDER_DISPLAY_COMMIT_SYSTEM } from '../display-submission-systems';
import { RENDER_GRAPH_SUBMISSION_COMMIT_SYSTEM } from '../graph-submission-systems';
import { RENDER_GRAPH_SETTLE_SYSTEM } from '../graph-systems';
import { RENDER_POST_COMMIT_SYSTEM } from '../post-systems';
import {
  RENDER_VIEW_CAMERAS_SYSTEM,
  RENDER_VIEW_HISTORY_SYSTEM,
  RENDER_VIEWS_SYSTEM,
  RenderView,
  RenderViewInput,
  type RenderViewSource,
  RenderViews,
  recordViewSubmission,
  type ViewHistory,
  ViewRecorder,
  viewCameraOf,
} from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  publishSurfaceDynamicInput,
  RenderCleanup,
  RenderCommit,
  RenderExtract,
  RenderPrepare,
  RenderQueue,
  renderSubmission,
  runRenderQueue,
  surfaceDynamicInputOf,
} from '../render-world';
import { RENDER_RECORD_COMMIT_SYSTEM } from '../submission-systems';
import { RENDER_TEMPORAL_COMMIT_SYSTEMS } from '../temporal-systems';
import { RENDER_SETTLEMENT_COMMIT_SYSTEMS } from '../view-settlement';
import { withInertTemporal } from './temporal-owner-fixture';

function camera(entityKey: number, composed = true): CameraSnapshot {
  return {
    entityKey,
    historyVersion: 1,
    ...(composed
      ? {
          view: {
            viewport: new Float32Array([0, 0, 1, 1]),
            order: 0,
            resolutionScale: 1,
            maxRenderShortSide: 0,
            updateInterval: 1,
            enabled: true,
          },
        }
      : {}),
  } as unknown as CameraSnapshot;
}

function source(cameras: readonly CameraSnapshot[], primary?: CameraSnapshot): RenderViewSource {
  return {
    cameras,
    captures: [],
    primary: primary !== undefined,
    primaryCamera: primary,
    canvas: { width: 64, height: 64 },
    attachment: () => 'world-a',
    targetExtent: () => undefined,
  };
}

function frame(world: World, number: number): void {
  beginRenderFrame(world, number);
  endRenderFrame(world);
}

function trace(world: World) {
  const ran: string[] = [];
  for (const [schedule, name] of [
    [RenderExtract, 'extract'],
    [RenderPrepare, 'prepare'],
    [RenderQueue, 'queue'],
    [RenderCommit, 'commit'],
    [RenderCleanup, 'cleanup'],
  ] as const)
    world.addSystem(schedule, { name: `trace-${name}`, queries: [], fn: () => ran.push(name) });
  return ran;
}

describe('Render World frame', () => {
  it('runs every phase once per frame and never inherits the previous submission', () => {
    const world = createRenderWorld();
    const ran = trace(world);
    beginRenderFrame(world, 1);
    runRenderQueue(world);
    Object.assign(renderSubmission(world), { accepted: true, completion: Promise.resolve() });
    endRenderFrame(world);
    expect(ran).toEqual(['extract', 'prepare', 'queue', 'commit', 'cleanup']);
    beginRenderFrame(world, 2);
    expect(renderSubmission(world)).toEqual({
      frame: 2,
      open: true,
      generation: 0,
      accepted: false,
      completion: undefined,
      creditCompletion: undefined,
    });
  });

  it('schedules render-views in RenderExtract and the view history in RenderCommit', () => {
    const world = createRenderWorld();
    new RenderViews(world);
    world
      .addSystem(RenderExtract, {
        name: 'after-views',
        queries: [],
        after: [RENDER_VIEWS_SYSTEM],
        fn: () => undefined,
      })
      .unwrap();
    const data = world.scheduleData();
    const extract = data.find((schedule) => schedule.name === 'RenderExtract');
    expect(extract?.systems.map((system) => system.name)).toEqual([
      RENDER_VIEWS_SYSTEM,
      RENDER_VIEW_CAMERAS_SYSTEM,
      'after-views',
    ]);
    expect(extract?.dependencies).toContainEqual([RENDER_VIEWS_SYSTEM, 'after-views']);
    expect(extract?.dependencies).toContainEqual([RENDER_VIEWS_SYSTEM, RENDER_VIEW_CAMERAS_SYSTEM]);
    expect(extract?.systems[1]?.queries[0]?.read).toEqual(
      expect.arrayContaining(['RenderView', 'ViewCamera']),
    );
    const commit = data.find((schedule) => schedule.name === 'RenderCommit');
    expect(commit?.systems.map((system) => system.name)).toEqual([
      RENDER_RECORD_COMMIT_SYSTEM,
      RENDER_POST_COMMIT_SYSTEM,
      ...RENDER_TEMPORAL_COMMIT_SYSTEMS,
      ...RENDER_SETTLEMENT_COMMIT_SYSTEMS,
      RENDER_GRAPH_SETTLE_SYSTEM,
      RENDER_GRAPH_SUBMISSION_COMMIT_SYSTEM,
      RENDER_DISPLAY_COMMIT_SYSTEM,
      RENDER_VIEW_HISTORY_SYSTEM,
    ]);
    expect(commit?.systems.at(-1)?.queries[0]?.read).toEqual(
      expect.arrayContaining(['RenderView', 'ViewRecorder', 'ViewSubmission']),
    );
  });

  it('declares no view entity once the render-views system is removed', () => {
    const declare = (removed: boolean) => {
      const world = createRenderWorld();
      const views = new RenderViews(world);
      if (removed) world.removeSystem(RenderExtract, RENDER_VIEWS_SYSTEM).unwrap();
      world.insertResource(RenderViewInput, source([camera(1), camera(2)]));
      frame(world, 1);
      return [views.size, [...world.query({ read: [RenderView] }).unwrap()].length];
    };
    // Two composed views plus the primary recorder's shared capture view.
    expect(declare(false)).toEqual([2, 3]);
    expect(declare(true)).toEqual([0, 0]);
  });

  it('resolves every view camera and extent before RenderPrepare', () => {
    const resolve = (removed: boolean) => {
      const world = createRenderWorld();
      const views = new RenderViews(world);
      if (removed) world.removeSystem(RenderExtract, RENDER_VIEW_CAMERAS_SYSTEM).unwrap();
      const split = camera(1);
      Object.assign(split.view as object, { viewport: new Float32Array([0, 0, 0.5, 1]) });
      world.insertResource(RenderViewInput, source([split]));
      const seen: unknown[] = [];
      world
        .addSystem(RenderPrepare, {
          name: 'reads-view-camera',
          queries: [],
          fn: (world) => {
            const entity = views.ordered[0];
            const view = viewCameraOf(world, entity);
            const shared = viewCameraOf(world, views.primary);
            seen.push(
              view?.extent,
              view?.camera?.aspect,
              view?.viewport.width,
              shared?.extent,
              shared?.camera?.entityKey,
            );
          },
        })
        .unwrap();
      frame(world, 1);
      return seen;
    };
    // A 64x64 canvas: the left half records 32x64; the shared capture view covers the canvas.
    expect(resolve(false)).toEqual([
      { width: 32, height: 64 },
      0.5,
      32,
      { width: 64, height: 64 },
      1,
    ]);
    expect(resolve(true)).toEqual([
      { width: 1, height: 1 },
      undefined,
      1,
      { width: 1, height: 1 },
      undefined,
    ]);
  });

  it('keeps one primary view: the display, then the shared capture view', () => {
    const world = createRenderWorld();
    const views = new RenderViews(world);
    world.insertResource(RenderViewInput, source([], camera(5, false)));
    frame(world, 1);
    const primary = views.primary;
    expect(primary).toBeDefined();
    expect(views.ordered).toEqual([]);
    expect(world.get(primary as never, RenderView).unwrap()).toMatchObject({
      primary: true,
      camera: 5,
    });
    world.insertResource(RenderViewInput, source([], camera(6, false)));
    frame(world, 2);
    expect(views.primary).toBe(primary);
    expect(world.get(primary as never, RenderView).unwrap().camera).toBe(6);
    const disabled = camera(1);
    Object.assign(disabled.view as object, { enabled: false });
    world.insertResource(RenderViewInput, source([disabled, camera(2)]));
    frame(world, 3);
    // The same entity becomes the shared capture view of the first enabled composed view.
    expect(views.primary).toBe(primary);
    expect(views.size).toBe(2);
    expect(world.get(primary as never, RenderView).unwrap()).toMatchObject({
      primary: true,
      capture: true,
      camera: 2,
    });
    world.insertResource(RenderViewInput, source([disabled]));
    frame(world, 4);
    expect(world.get(primary as never, RenderView).unwrap().camera).toBe(1);
  });

  it('advances a view history only for an accepted attempt of the current frame', () => {
    const run = (removed: boolean) => {
      const world = createRenderWorld();
      const views = new RenderViews(world);
      if (removed) world.removeSystem(RenderCommit, RENDER_VIEW_HISTORY_SYSTEM).unwrap();
      world.insertResource(RenderViewInput, source([camera(1)]));
      beginRenderFrame(world, 1);
      const entity = views.ordered[0] as NonNullable<(typeof views.ordered)[0]>;
      const history: ViewHistory = { rendered: true, lastFrame: -1, renderedFrames: 0 };
      const state = world.allocUniqueRef('ViewRecorder', withInertTemporal(history));
      world.addComponent(entity, { component: ViewRecorder, data: { state } }).unwrap();
      const attempt = (accepted: boolean, number: number) =>
        recordViewSubmission(world, entity, {
          accepted,
          attempt: number,
          scene: accepted,
          temporal: false,
        });
      attempt(true, 1);
      endRenderFrame(world);
      // A rejected attempt keeps the history.
      beginRenderFrame(world, 2);
      attempt(false, 2);
      endRenderFrame(world);
      // A frame without an attempt of its own does not reuse an older one.
      frame(world, 3);
      return history;
    };
    expect(run(false)).toEqual({ rendered: true, lastFrame: 1, renderedFrames: 1 });
    expect(run(true)).toEqual({ rendered: true, lastFrame: -1, renderedFrames: 0 });
  });

  it('publishes one Surface dynamic page every view reads and withdraws it', () => {
    const world = createRenderWorld();
    const page = { frameTime: 1 } as unknown as Parameters<typeof publishSurfaceDynamicInput>[1];
    expect(surfaceDynamicInputOf(world)).toBeUndefined();
    publishSurfaceDynamicInput(world, page);
    expect(surfaceDynamicInputOf(world)).toBe(page);
    publishSurfaceDynamicInput(world, undefined);
    expect(surfaceDynamicInputOf(world)).toBeUndefined();
  });
});
