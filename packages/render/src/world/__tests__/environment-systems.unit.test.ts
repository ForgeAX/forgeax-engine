import { describe, expect, it, vi } from 'vitest';
import {
  consumeViewEnvironment,
  registerEnvironmentAdmissionSystem,
  VIEW_ENVIRONMENT_ADMIT_SYSTEM,
} from '../environment-systems';
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
  RenderCommit,
  RenderExtract,
} from '../render-world';
import { RENDER_VIEW_RECORDERS_SYSTEM, stageViewFrame } from '../view-frame-systems';
import {
  RENDER_ATMOSPHERE_COMMIT_SYSTEM,
  RENDER_ENVIRONMENT_COMMIT_SYSTEM,
  RENDER_ENVIRONMENT_DISCARD_SYSTEM,
  RENDER_FOG_COMMIT_SYSTEM,
} from '../view-settlement';
import { registerViewFrameStub, withInertTemporal } from './temporal-owner-fixture';

const fog = vi.hoisted(() => ({ commit: vi.fn() }));
vi.mock('../../record/volumetric-fog-commit', () => ({
  commitSubmittedVolumetricFog: fog.commit,
}));

function fixture() {
  const world = createRenderWorld();
  const recorder = withInertTemporal({});
  const lifecycle = { publish: vi.fn(), discard: vi.fn(), recordStageFailure: vi.fn() };
  const owner = (recorder as unknown as { owner: { frameState: object } }).owner.frameState;
  const frameState = Object.assign(owner, {
    environmentLifecycle: lifecycle,
    environmentGeneration: undefined as unknown,
    pendingAtmospherePublish: undefined as (() => void) | undefined,
    volumetricFogCandidate: undefined as unknown,
    rejectedStage: undefined as unknown,
  });
  const view = world
    .spawn(
      {
        component: ViewSubmission,
        data: { accepted: false, attempt: 0, scene: false, temporal: false },
      },
      { component: ViewRecorder, data: { state: world.allocUniqueRef('ViewRecorder', recorder) } },
    )
    .unwrap();
  const publishAtmosphere = vi.fn();
  const frame = (submission: { accepted: boolean; scene: boolean; attempt?: number }) => {
    beginRenderFrame(world, 1);
    frameState.environmentGeneration = { signature: 'candidate' };
    frameState.pendingAtmospherePublish = publishAtmosphere;
    frameState.volumetricFogCandidate = { staged: true };
    frameState.rejectedStage = 'submit';
    world.set(view, ViewSubmission, { attempt: 1, temporal: false, ...submission }).unwrap();
    endRenderFrame(world);
  };
  return { world, frameState, lifecycle, publishAtmosphere, frame };
}

it('schedules the environment commits in order after record-commit and one rejection cleanup', () => {
  const data = createRenderWorld().scheduleData();
  const commit = data.find((schedule) => schedule.name === 'RenderCommit');
  const chain = [
    'render-record-commit',
    RENDER_ENVIRONMENT_COMMIT_SYSTEM,
    RENDER_ATMOSPHERE_COMMIT_SYSTEM,
    RENDER_FOG_COMMIT_SYSTEM,
  ];
  for (const [before, after] of chain.slice(0, -1).map((name, i) => [name, chain[i + 1]]))
    expect(commit?.dependencies).toContainEqual([before, after]);
  for (const name of chain.slice(1))
    expect(commit?.systems.find((entry) => entry.name === name)?.queries[0]?.read).toEqual([
      'ViewRecorder',
      'ViewSubmission',
    ]);
  const cleanup = data.find((schedule) => schedule.name === 'RenderCleanup');
  const discard = cleanup?.systems.find(
    (entry) => entry.name === RENDER_ENVIRONMENT_DISCARD_SYSTEM,
  );
  expect(discard?.queries[0]?.read).toEqual(['ViewRecorder', 'ViewSubmission']);
});

it('an accepted scene submission publishes the environment, atmosphere and fog', () => {
  fog.commit.mockClear();
  const { frameState, lifecycle, publishAtmosphere, frame } = fixture();
  frame({ accepted: true, scene: true });
  expect(lifecycle.publish).toHaveBeenCalledWith({ signature: 'candidate' });
  expect(lifecycle.discard).not.toHaveBeenCalled();
  expect(publishAtmosphere).toHaveBeenCalledTimes(1);
  expect(fog.commit).toHaveBeenCalledTimes(1);
  expect(frameState.environmentGeneration).toBeUndefined();
  expect(frameState.volumetricFogCandidate).toBeUndefined();
  expect(frameState.rejectedStage).toBeUndefined();
});

it('a rejected attempt records its stage, discards the generation and drops atmosphere and fog', () => {
  fog.commit.mockClear();
  const { frameState, lifecycle, publishAtmosphere, frame } = fixture();
  frame({ accepted: false, scene: false });
  expect(lifecycle.publish).not.toHaveBeenCalled();
  expect(lifecycle.recordStageFailure).toHaveBeenCalledWith('submit', { signature: 'candidate' });
  expect(lifecycle.discard).toHaveBeenCalledWith({ signature: 'candidate' });
  expect(publishAtmosphere).not.toHaveBeenCalled();
  expect(fog.commit).not.toHaveBeenCalled();
  expect(frameState.environmentGeneration).toBeUndefined();
  expect(frameState.pendingAtmospherePublish).toBeUndefined();
  expect(frameState.volumetricFogCandidate).toBeUndefined();
});

it('a stale attempt neither publishes nor discards another frame candidate', () => {
  const { frameState, lifecycle, frame } = fixture();
  frame({ accepted: false, scene: false, attempt: 0 });
  expect(lifecycle.publish).not.toHaveBeenCalled();
  expect(lifecycle.discard).not.toHaveBeenCalled();
  expect(frameState.environmentGeneration).toEqual({ signature: 'candidate' });
});

it('without the commit systems an accepted scene submission publishes nothing', () => {
  const { world, lifecycle, publishAtmosphere, frame } = fixture();
  for (const name of [
    RENDER_FOG_COMMIT_SYSTEM,
    RENDER_ATMOSPHERE_COMMIT_SYSTEM,
    RENDER_ENVIRONMENT_COMMIT_SYSTEM,
  ])
    world.removeSystem(RenderCommit, name).unwrap();
  frame({ accepted: true, scene: true });
  expect(lifecycle.publish).not.toHaveBeenCalled();
  expect(publishAtmosphere).not.toHaveBeenCalled();
});

describe('render-environment-admit', () => {
  function admitFixture(frame: Record<string, unknown>, cameras = [{}]) {
    const world = createRenderWorld();
    world.insertResource(
      RenderViewInput,
      new RenderViewFrameSource({ canvas: { width: 8, height: 8 } }),
    );
    registerViewFrameStub(world, () => ({ ok: true, value: { cameras, ...frame } as never }));
    registerEnvironmentAdmissionSystem(world);
    const lifecycle = {
      bindScope: vi.fn(),
      recordSelectionFailure: vi.fn(),
      recordCandidateFailure: vi.fn(),
      ensure: vi.fn(() => ({ ok: true, value: { generation: 1 } })),
      isActive: vi.fn(() => false),
    };
    const fired: unknown[] = [];
    const frameState = { environmentLifecycle: lifecycle, temporalView: { discard: vi.fn() } };
    const recorder = withInertTemporal(
      {},
      {
        frameState,
        internals: { deviceScope: {}, errorRegistry: { fire: (e: unknown) => fired.push(e) } },
      },
    );
    const view = world.spawn().unwrap();
    world
      .addComponent(view, {
        component: ViewRecorder,
        data: { state: world.allocUniqueRef('ViewRecorder', recorder) },
      })
      .unwrap();
    world
      .addSystem(RenderExtract, {
        name: RENDER_VIEW_RECORDERS_SYSTEM,
        queries: [],
        fn: (world) => stageViewFrame(world, view, { cameraOwner: 0, resourceOwner: 0 }),
      })
      .unwrap();
    return { world, view, lifecycle, frameState, fired };
  }

  it('binds the candidate and stages a generation the active owner does not hold', () => {
    const environment = { source: { kind: 'none' } };
    const { world, view, lifecycle, frameState } = admitFixture({
      environment,
      environmentReady: true,
    });
    beginRenderFrame(world, 1);
    expect(consumeViewEnvironment(world, view)).toBe('admitted');
    expect(lifecycle.ensure).toHaveBeenCalledWith(environment);
    expect((frameState as { environmentGeneration?: unknown }).environmentGeneration).toEqual({
      generation: 1,
    });
    endRenderFrame(world);
  });

  it('rejects a camera-bearing frame without an environment and admits a camera-less one', () => {
    const camera = admitFixture({ environmentReady: false });
    beginRenderFrame(camera.world, 1);
    expect(consumeViewEnvironment(camera.world, camera.view)).toBe('rejected');
    endRenderFrame(camera.world);
    const clearOnly = admitFixture({ environmentReady: false }, []);
    beginRenderFrame(clearOnly.world, 1);
    expect(consumeViewEnvironment(clearOnly.world, clearOnly.view)).toBe('admitted');
    endRenderFrame(clearOnly.world);
  });

  it('fires a failed candidate once and rejects the frame', () => {
    const failed = admitFixture({
      environment: { source: { kind: 'none' } },
      environmentReady: true,
    });
    const error = new Error('generation');
    failed.lifecycle.ensure.mockReturnValue({ ok: false, error } as never);
    beginRenderFrame(failed.world, 1);
    expect(consumeViewEnvironment(failed.world, failed.view)).toBe('rejected');
    expect(failed.fired).toEqual([error]);
    expect(failed.lifecycle.recordCandidateFailure).toHaveBeenCalledWith(error);
    endRenderFrame(failed.world);
  });

  it('falsifier: without the system the recording has no admission to take', () => {
    const world = createRenderWorld();
    expect(() => consumeViewEnvironment(world, world.spawn().unwrap())).toThrow(
      VIEW_ENVIRONMENT_ADMIT_SYSTEM,
    );
  });
});
