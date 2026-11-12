import { describe, expect, it, vi } from 'vitest';
import type { ExtractedFrame } from '../../render-system-extract';
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
import { RENDER_SCENE_PUBLISH_SYSTEM, RenderSceneDelta } from '../scene-systems';
import {
  RENDER_VIEW_FRAME_SYSTEM,
  RENDER_VIEW_RECORDERS_SYSTEM,
  registerViewFrameSystem,
  stageViewFrame,
  type ViewRecordMode,
  viewFrameOf,
} from '../view-frame-systems';
import { withInertTemporal } from './temporal-owner-fixture';

const opts = { cameraOwner: 0, resourceOwner: 0 } as const;

/**
 * A staged and a held view over one owner bag. Its scene follows the frame's
 * adoption through `follow`; `built` is the pipeline handle the view's
 * graph state was built for (the installed handle is 3).
 */
function setup(follow: () => ExtractedFrame, mode: ViewRecordMode = true, built = 3) {
  const world = createRenderWorld();
  const source = new RenderViewFrameSource({ canvas: { width: 8, height: 8 } });
  world.insertResource(RenderViewInput, source);
  const order: string[] = [];
  world
    .addSystem(RenderPrepare, {
      name: RENDER_SCENE_PUBLISH_SYSTEM,
      queries: [],
      fn: () => void order.push('publish'),
    })
    .unwrap();
  registerViewFrameSystem(world);
  world.insertResource(RenderSceneDelta, { advance: undefined, failure: undefined });
  const scene = {
    publicationBaselineRequired: () => false,
    materialSnapshotCacheStore: () => ({}),
    resetView: vi.fn(),
    followAdoption: vi.fn(() => {
      order.push('frame');
      return follow();
    }),
  };
  const skin = {
    beginRecording: vi.fn(),
    trackSubmittedWork: () => undefined,
    complete: () => [],
  };
  const frameState = {
    installedPipelineHandle: 3,
    standardInstall: { configured: undefined, built, cameraSignature: '', cameraFailure: '' },
  };
  const internals = {
    device: { queue: {}, caps: { backendKind: 'null', storageBuffer: false }, limits: {} },
    errorRegistry: { fire: () => undefined },
  };
  const owner = { scene, skin, frameState, internals };
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
      fn: (world) => stageViewFrame(world, staged, { ...opts, cameraEntityKey: 7 }, mode),
    })
    .unwrap();
  return { world, source, order, staged, held, owner };
}

describe('render-view-frame', () => {
  it('prepares only staged views after the scene publishes, before RenderQueue reads', () => {
    const frame = { renderables: [] } as unknown as ExtractedFrame;
    const { world, source, order, staged, held, owner } = setup(() => frame);
    let queued: unknown;
    world
      .addSystem(RenderQueue, {
        name: 'consumer',
        queries: [],
        fn: (world) => {
          queued = viewFrameOf(world, staged)?.result;
        },
      })
      .unwrap();
    source.stage([], [], [], opts, undefined, undefined);
    beginRenderFrame(world, 1);
    expect(queued).toBeUndefined();
    runRenderQueue(world);
    expect(order).toEqual(['publish', 'frame']);
    expect(queued).toEqual({ ok: true, value: frame });
    // The view's frame opens its Skin recording; an unswapped pipeline keeps its view state.
    expect(owner.skin.beginRecording).toHaveBeenCalledTimes(1);
    expect(owner.scene.resetView).not.toHaveBeenCalled();
    expect(viewFrameOf(world, held)).toBeUndefined();
    endRenderFrame(world);
    beginRenderFrame(world, 2);
    expect(viewFrameOf(world, staged)?.frame).toBe(2);
    endRenderFrame(world);
  });

  it('stores a failed view frame as its result instead of poisoning the World', () => {
    const cause = new Error('pending asset');
    const { world, source, staged } = setup(() => {
      throw cause;
    });
    source.stage([], [], [], opts, undefined, undefined);
    beginRenderFrame(world, 1);
    expect(viewFrameOf(world, staged)?.result).toEqual({ ok: false, cause });
    endRenderFrame(world);
  });

  it('publishes the record mode decided in RenderExtract to RenderPrepare readers', () => {
    const frame = { renderables: [] } as unknown as ExtractedFrame;
    const { world, source, staged } = setup(() => frame, 'capture');
    let prepared: unknown;
    world
      .addSystem(RenderPrepare, {
        name: 'mode-reader',
        after: [RENDER_VIEW_FRAME_SYSTEM],
        queries: [],
        fn: (world) => {
          prepared = viewFrameOf(world, staged)?.mode;
        },
      })
      .unwrap();
    source.stage([], [], [], opts, undefined, undefined);
    beginRenderFrame(world, 1);
    expect(prepared).toBe('capture');
    endRenderFrame(world);
  });

  it('retires a swapped pipeline graph from the view owner before following the scene', () => {
    const frame = { renderables: [] } as unknown as ExtractedFrame;
    const { world, source, staged, owner } = setup(() => frame, true, 2);
    source.stage([], [], [], opts, undefined, undefined);
    beginRenderFrame(world, 1);
    expect(viewFrameOf(world, staged)?.result).toEqual({ ok: true, value: frame });
    expect(owner.scene.resetView).toHaveBeenCalledTimes(1);
    expect(owner.frameState.standardInstall.built).toBe(3);
    endRenderFrame(world);
    beginRenderFrame(world, 2);
    expect(owner.scene.resetView).toHaveBeenCalledTimes(1);
    endRenderFrame(world);
  });
});
