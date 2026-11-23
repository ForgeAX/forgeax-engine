import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineSystem, World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createProfiler, type RecorderSession } from '@forgeax/engine-profiler';
import { describe, expect, it, vi } from 'vitest';
import { type CameraSnapshot, RENDER_PHASE_CATALOG } from '../../render-contract';

import type { ExtractedFrame } from '../../render-system-extract';
import { SceneComposition } from '../../scene/scene-composition';
import { RenderScenePublishOrder, RenderViewFrameOrder } from '../../system-order';
import {
  RenderView,
  RenderViewFrameSource,
  RenderViewInput,
  ViewCamera,
  type ViewCameraState,
  ViewRecorder,
} from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderExtract,
  RenderPrepare,
  RenderQueue,
  runRenderQueue,
} from '../render-world';
import {
  RENDER_SCENE_PUBLISH_SYSTEM,
  RenderSceneDelta,
  RenderSceneInput,
  type RenderSceneSource,
} from '../scene-systems';
import {
  RENDER_VIEW_RECORDERS_SYSTEM,
  registerViewFrameSystem,
  stageRenderScene,
  stageViewFrame,
  type ViewRecordMode,
  viewFrameOf,
} from '../view-frame-systems';
import { withInertTemporal } from './temporal-owner-fixture';

const opts = {} as const;

/**
 * A staged and a held view over one owner bag. Its scene follows the frame's
 * adoption through `follow`; `built` is the pipeline handle the view's
 * graph state was built for (the installed handle is 3).
 */
function setup(
  follow: () => ExtractedFrame,
  mode: ViewRecordMode = true,
  built = 3,
  options: Readonly<{
    profileSession?: RecorderSession;
    candidateRequests?: readonly ('full' | 'none')[];
  }> = {},
) {
  const world = createRenderWorld();
  const source = new RenderViewFrameSource({ canvas: { width: 8, height: 8 } });
  const sourceWorld = new World();
  const lease = createRenderReadLease(sourceWorld);
  const stage = () => source.stage([], [], sourceWorld, opts, lease, undefined);
  world.insertResource(RenderViewInput, source);
  const order: string[] = [];
  const systemToken1 = defineSystem({
    sets: [RenderScenePublishOrder],
    name: RENDER_SCENE_PUBLISH_SYSTEM,
    queries: [],
    fn: () => void order.push('publish'),
  });
  world.addSystem(RenderPrepare, systemToken1).unwrap();
  registerViewFrameSystem(world);
  world.insertResource(RenderSceneDelta, { advance: undefined, failure: undefined });
  const shared = new SceneComposition();
  const scene = {
    shared,
    publicationBaselineRequired: () => false,
    materialSnapshotCacheStore: vi.fn(shared.materialSnapshotCacheStore.bind(shared)),
    resetView: vi.fn(),
    followPublication: vi.fn((_adoption, frame) => {
      order.push('publication');
      return frame;
    }),
    followAdoption: vi.fn(
      (_adoption, buildCandidate?: (request: 'full' | 'none') => ExtractedFrame) => {
        order.push('frame');
        for (const request of options.candidateRequests ?? []) buildCandidate?.(request);
        return follow();
      },
    ),
    discardTemporalFrame: vi.fn(() => order.push('discard')),
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
    assets: new AssetRegistry(),
    device: { queue: {}, caps: { backendKind: 'null', storageBuffer: false }, limits: {} },
    errorRegistry: { fire: vi.fn() },
    ...(options.profileSession === undefined
      ? {}
      : { profiler: { activeSession: () => options.profileSession } }),
  };
  const owner = { scene, skin, frameState, internals };
  const staged = world.spawn().unwrap();
  const held = world.spawn().unwrap();
  for (const entity of [staged, held]) {
    const state = world.allocUniqueRef('ViewRecorder', withInertTemporal({}, owner));
    world.addComponent(entity, { component: ViewRecorder, data: { state } }).unwrap();
  }
  const systemToken2 = defineSystem({
    name: RENDER_VIEW_RECORDERS_SYSTEM,
    queries: [],
    fn: (world) => stageViewFrame(world, staged, { ...opts, cameraEntityKey: 7 }, mode),
  });
  world.addSystem(RenderExtract, systemToken2).unwrap();
  return { world, source, sourceWorld, lease, stage, order, staged, held, owner };
}

describe('render-view-frame', () => {
  it('sets the receiving device material context before projecting a published scene', () => {
    const frame = { cameras: [], renderables: [] } as unknown as ExtractedFrame;
    const { world, owner } = setup(() => frame);
    const publication = { frame } as never;
    const source = {
      staged: false,
      publication: undefined,
      world: undefined,
      lease: undefined,
      buildCandidateFrame: undefined,
    } satisfies RenderSceneSource;
    world.insertResource(RenderSceneInput, source);

    stageRenderScene(
      world,
      owner as unknown as Parameters<typeof stageRenderScene>[1],
      undefined,
      opts,
      undefined,
      publication,
      undefined,
    );

    expect(source.publication).toBe(publication);
    expect(owner.scene.materialSnapshotCacheStore).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'webgpu', capability: 'uniform-fallback' }),
    );
  });

  it('routes the primary display WaterMesh projection through its selected publication camera', () => {
    const camera = { entityKey: 7 } as CameraSnapshot;
    const frame = { cameras: [camera], renderables: [] } as unknown as ExtractedFrame;
    const publication = { frame } as never;
    const { world, source, sourceWorld, lease, owner } = setup(() => frame);
    source.stage([camera], [], sourceWorld, opts, lease, publication);
    beginRenderFrame(world, 1);
    runRenderQueue(world);
    expect(owner.scene.followPublication).toHaveBeenCalledWith(
      expect.anything(),
      frame,
      'camera:7',
    );
    endRenderFrame(world);
  });

  it('routes an explicit stereo view through its selected eye camera identity', () => {
    const left = { entityKey: 7, eye: { side: 'left' } } as unknown as CameraSnapshot;
    const right = { entityKey: 7, eye: { side: 'right' } } as unknown as CameraSnapshot;
    const frame = { cameras: [left, right], renderables: [] } as unknown as ExtractedFrame;
    const publication = { frame } as never;
    const { world, source, sourceWorld, lease, staged, owner } = setup(() => frame);
    world
      .addComponent(staged, {
        component: RenderView,
        data: { primary: false, capture: false },
      })
      .unwrap();
    const viewCamera = world.allocUniqueRef('ViewCamera', {
      camera: left,
    } as ViewCameraState);
    world.addComponent(staged, { component: ViewCamera, data: { state: viewCamera } }).unwrap();
    source.stage([left, right], [], sourceWorld, opts, lease, publication);
    beginRenderFrame(world, 1);
    runRenderQueue(world);
    expect(owner.scene.followPublication).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cameras: [left] }),
      'camera:7:left',
    );
    endRenderFrame(world);
  });

  it('prepares only staged views after the scene publishes, before RenderQueue reads', () => {
    const frame = { renderables: [] } as unknown as ExtractedFrame;
    const { world, stage, order, staged, held, owner } = setup(() => frame);
    let queued: unknown;
    const systemToken3 = defineSystem({
      name: 'consumer',
      queries: [],
      fn: (world) => {
        queued = viewFrameOf(world, staged)?.result;
      },
    });
    world.addSystem(RenderQueue, systemToken3).unwrap();
    stage();
    beginRenderFrame(world, 1);
    expect(queued).toBeUndefined();
    runRenderQueue(world);
    expect(order).toEqual(['publish', 'discard', 'frame']);
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
    const { world, stage, staged } = setup(() => {
      throw cause;
    });
    stage();
    beginRenderFrame(world, 1);
    expect(viewFrameOf(world, staged)?.result).toEqual({ ok: false, cause });
    endRenderFrame(world);
  });

  it('profiles only resource-only candidate builds under the active extract parent', () => {
    const profiler = createProfiler({ phaseCatalog: { app: [], render: RENDER_PHASE_CATALOG } });
    const started = profiler.startCapture({ frameLimit: 1, eventLimit: 64 });
    if (!started.ok) throw new Error(started.error.code);
    const session = started.value;
    const frame = { renderables: [] } as unknown as ExtractedFrame;
    const { world, stage, owner } = setup(() => frame, true, 3, {
      profileSession: session,
      candidateRequests: ['full', 'none'],
    });
    expect(session.beginFrame(1).ok).toBe(true);
    stage();
    beginRenderFrame(world, 1);
    runRenderQueue(world);
    endRenderFrame(world);
    expect(session.endFrame().ok).toBe(true);
    const captured = session.finish();
    if (!captured.ok) throw new Error(captured.error.code);
    const resourceFrames = captured.value.records.filter(
      (record) => record.kind === 'phase' && record.phase === 'extract/resource-frame',
    );
    expect(resourceFrames).toHaveLength(1);
    expect(resourceFrames[0]).toMatchObject({
      source: 'render',
      parentSource: 'render',
      parentPhase: 'extract',
    });
    expect(owner.scene.followAdoption).toHaveBeenCalledTimes(1);
    expect(owner.internals.errorRegistry.fire).not.toHaveBeenCalled();
  });

  it('keeps staged resource-frame timing on the session pinned at frame entry', () => {
    const profiler = createProfiler({ phaseCatalog: { app: [], render: RENDER_PHASE_CATALOG } });
    const started = profiler.startCapture({ frameLimit: 1, eventLimit: 64 });
    if (!started.ok) throw new Error(started.error.code);
    const session = started.value;
    const frame = { renderables: [] } as unknown as ExtractedFrame;
    const { world, sourceWorld, lease, owner } = setup(() => frame);
    const sceneSource: RenderSceneSource = {
      composition: {} as RenderSceneSource['composition'],
      assets: undefined,
      staged: false,
      publication: undefined,
      world: sourceWorld,
      lease,
      buildCandidateFrame: undefined,
    };
    world.insertResource(RenderSceneInput, sceneSource);
    expect(session.beginFrame(1).ok).toBe(true);
    expect(session.beginPhase('render', 'extract-schedule').ok).toBe(true);
    stageRenderScene(
      world,
      owner as unknown as Parameters<typeof stageRenderScene>[1],
      sourceWorld,
      opts,
      lease,
      undefined,
      session,
    );
    const build = sceneSource.buildCandidateFrame;
    if (build === undefined) throw new Error('Expected staged candidate builder');
    build('full');
    build('none');
    expect(session.endPhase().ok).toBe(true);
    expect(session.endFrame().ok).toBe(true);
    const captured = session.finish();
    if (!captured.ok) throw new Error(captured.error.code);
    const resourceFrames = captured.value.records.filter(
      (record) => record.kind === 'phase' && record.phase === 'extract/resource-frame',
    );
    expect(resourceFrames).toHaveLength(1);
    expect(resourceFrames[0]).toMatchObject({
      source: 'render',
      parentSource: 'render',
      parentPhase: 'extract-schedule',
    });
  });

  it('publishes the record mode decided in RenderExtract to RenderPrepare readers', () => {
    const frame = { renderables: [] } as unknown as ExtractedFrame;
    const { world, stage, staged } = setup(() => frame, 'capture');
    let prepared: unknown;
    const systemToken4 = defineSystem({
      name: 'mode-reader',
      after: [RenderViewFrameOrder],
      queries: [],
      fn: (world) => {
        prepared = viewFrameOf(world, staged)?.mode;
      },
    });
    world.addSystem(RenderPrepare, systemToken4).unwrap();
    stage();
    beginRenderFrame(world, 1);
    expect(prepared).toBe('capture');
    endRenderFrame(world);
  });

  it('retires a swapped pipeline graph from the view owner before following the scene', () => {
    const frame = { renderables: [] } as unknown as ExtractedFrame;
    const { world, stage, staged, owner } = setup(() => frame, true, 2);
    stage();
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
