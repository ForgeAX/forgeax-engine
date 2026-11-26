import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { viewSourceFixture } from '../../__tests__/view-source.fixture';
import { Camera } from '../../components/camera';
import type { CameraSnapshot } from '../../render-contract';
import type { ExtractedFrame } from '../../render-system-extract';
import {
  LodObservationKey,
  RENDER_LOD_OBSERVATION_SYSTEM,
  registerLodObservationSystem,
} from '../lod-observation-systems';
import {
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
} from '../render-world';
import { viewFrameOf } from '../view-frame-systems';
import {
  registerViewOutputSystems,
  registerViewRecorderSystem,
  type ViewRecorderFactory,
  type ViewRecorderState,
  viewComposition,
} from '../view-output-systems';
import { withInertTemporal } from './temporal-owner-fixture';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function camera(entityKey: number): CameraSnapshot {
  return {
    entityKey,
    historyVersion: 7,
    world: IDENTITY,
    fov: 1,
    aspect: 1,
    view: {
      viewport: new Float32Array([0, 0, 1, 1]),
      order: entityKey,
      resolutionScale: 1,
      maxRenderShortSide: 0,
      updateInterval: 1,
      enabled: true,
    },
  } as unknown as CameraSnapshot;
}

function fixture() {
  const world = createRenderWorld();
  const views = new RenderViews(world);
  const device = {
    queue: { onSubmittedWorkDone: () => Promise.resolve() },
    createTexture: (descriptor: { label: string }) => ({
      ok: true as const,
      value: { label: descriptor.label },
    }),
    destroyTexture: () => undefined,
  };
  const host = {
    device,
    deviceScope: { generation: 3 },
    canvas: { width: 64, height: 32 },
    viewEntity: undefined as EntityHandle | undefined,
    observationFrameId: 41,
    getPipelineState: () => ({ format: 'rgba8unorm', colorAttachmentFormat: 'rgba8unorm' }),
    getRenderTargetPhysical: undefined,
    markRenderTargetSubmitted: () => undefined,
  };
  registerViewOutputSystems(world, views, host as never, () => {
    return { generation: 0, encode: () => true, dispose: () => undefined } as never;
  });
  const recorders: ViewRecorderState[] = [];
  const createRecorder: ViewRecorderFactory = (entity, facts, target, viewport) => {
    const state = withInertTemporal({
      entity,
      key: String(facts.camera),
      camera: facts.camera,
      eye: undefined,
      device,
      target,
      output: undefined,
      viewport,
      captureSize: { width: 1, height: 1 },
      picture: { source: undefined, viewport, channels: 'all' },
      renderedFrames: 0,
      lastFrame: Number.NEGATIVE_INFINITY,
      rendered: false,
      retired: false,
      capture: undefined,
    } as unknown as ViewRecorderState);
    recorders.push(state);
    const ref = world.allocUniqueRef('ViewRecorder', state, () => undefined);
    world.addComponent(entity, { component: ViewRecorder, data: { state: ref } }).unwrap();
    return state;
  };
  (host as { viewOwner?: unknown }).viewOwner = (
    withInertTemporal({}) as unknown as { owner: unknown }
  ).owner;
  registerViewRecorderSystem(world, views, { internals: host as never, createRecorder });
  registerLodObservationSystem(world, views, { internals: host as never });
  const source = new RenderViewFrameSource(host as never);
  world.insertResource(RenderViewInput, viewSourceFixture(source));
  const plan = viewComposition(world);
  let frame = 0;
  const begin = (
    cameras: readonly CameraSnapshot[] = [camera(1), camera(2)],
    owner = new World(),
  ) => {
    source.stage(
      cameras,
      [],
      owner,
      {},
      { worldIdentity: 'world-a', generation: 2 } as never,
      undefined,
    );
    beginRenderFrame(world, ++frame);
  };
  /** Publish the frame outcome; `rejected` names recorded view indexes whose attempt failed. */
  const submit = (accepted: boolean, rejected: readonly number[] = []) => {
    plan.recorded.forEach((view, index) => {
      recordViewSubmission(world, view.entity, {
        accepted: !rejected.includes(index),
        attempt: frame,
        scene: true,
        temporal: false,
      });
    });
    publishRenderSubmission(world, {
      accepted,
      completion: accepted ? Promise.resolve() : undefined,
      creditCompletion: undefined,
      generation: 3,
    });
  };
  const state = () => world.getResource(LodObservationKey);
  return { world, views, recorders, begin, submit, end: () => endRenderFrame(world), state };
}

describe('LOD observation commit system', () => {
  it('commits in RenderCommit, reading view state and writing no component', () => {
    const { world } = fixture();
    const system = world
      .scheduleData()
      .find((data) => data.name === 'RenderCommit')
      ?.systems.find((data) => data.name === RENDER_LOD_OBSERVATION_SYSTEM);
    expect(system?.queries[0]?.read).toEqual(['RenderView', 'ViewRecorder', 'ViewSubmission']);
    expect(system?.queries[0]?.write ?? []).toEqual([]);
  });

  it('observes the views whose own attempt was accepted in an accepted frame', () => {
    const { begin, submit, end, state } = fixture();
    begin();
    submit(true, [1]);
    end();
    const capture = state().capture;
    expect(capture).toMatchObject({ frameId: 41, deviceGeneration: 3 });
    expect(capture?.views.map((view) => view.viewKey)).toEqual(['1']);
    expect(capture?.views[0]).toMatchObject({
      viewGeneration: 7,
      state: 'rendered',
      primary: false,
    });
    expect(capture?.source?.worldIdentity).toBe('world-a');
    expect(state().failure).toBeUndefined();
  });

  it('attributes a submitted primary view to its recorded camera after the source changes', () => {
    const { world, views, begin, submit, end, state } = fixture();
    const owner = new World();
    const entity = owner
      .spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { fov: 1, near: 0.1, far: 100, aspect: 2, historyVersion: 7 } },
      )
      .unwrap();
    propagateTransforms(owner).unwrap();
    begin([], owner);
    const recorded = world.getResource(RenderViewInput).primaryCamera;
    if (recorded === undefined) throw new Error('Expected a primary camera');
    const staged = viewFrameOf(world, views.primary);
    if (staged === undefined) throw new Error('Expected a staged primary view');
    staged.result = { ok: true, value: { cameras: [recorded] } as unknown as ExtractedFrame };
    recordViewSubmission(world, views.primary, {
      accepted: true,
      attempt: 1,
      scene: true,
      temporal: false,
    });
    submit(true);
    owner.set(entity, Camera, { historyVersion: 8 }).unwrap();
    end();
    expect(state().capture?.views).toMatchObject([
      { entityKey: Number(entity), viewGeneration: 7, primary: true },
    ]);
  });

  it('lists a held view that recorded no attempt as held', () => {
    const { recorders, begin, submit, end, state } = fixture();
    begin();
    const held = recorders[1];
    if (held !== undefined) held.rendered = false;
    submit(true, [1]);
    end();
    expect(state().capture?.views.map((view) => [view.viewKey, view.state])).toEqual([
      ['1', 'rendered'],
      ['2', 'held'],
    ]);
  });

  it('keeps the previous capture when the frame was submitted but not accepted', () => {
    const { begin, submit, end, state } = fixture();
    begin();
    submit(true);
    end();
    const first = state().capture;
    expect(first?.views).toHaveLength(2);
    begin();
    submit(false);
    end();
    expect(state().capture).toBe(first);
  });

  it('reports an unreadable view as failure data and still closes the frame', () => {
    const { recorders, begin, submit, end, state } = fixture();
    begin();
    Object.defineProperty(recorders[0]?.owner.lod, 'cell', {
      get: () => {
        throw new Error('view state gone');
      },
    });
    submit(true);
    expect(() => end()).not.toThrow();
    expect(state().capture).toBeUndefined();
    expect(state().failure).toEqual({ code: 'view-state-unavailable', frame: 1 });
  });
});
