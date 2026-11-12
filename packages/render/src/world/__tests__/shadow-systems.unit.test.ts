import { expect, it, vi } from 'vitest';
import { ViewRecorder, ViewSubmission } from '../render-views';
import { beginRenderFrame, createRenderWorld, endRenderFrame, RenderCommit } from '../render-world';
import { RENDER_SHADOW_COMMIT_SYSTEM, RENDER_SHADOW_DISCARD_SYSTEM } from '../view-settlement';
import { withInertTemporal } from './temporal-owner-fixture';

function fixture() {
  const world = createRenderWorld();
  const release = vi.fn();
  const previousRelease = vi.fn();
  const previous = { meshReads: { release: previousRelease } };
  const nextCache = { meshReads: { release: vi.fn() } };
  const recorder = withInertTemporal({});
  const frameState = (recorder as unknown as { owner: { frameState: object } }).owner.frameState;
  const owner = Object.assign(frameState, {
    shadowRaster: { commit: vi.fn() },
    shadowDepthLayers: { _commit: vi.fn(), _abort: vi.fn() },
    directionalShadowCache: previous as unknown,
    directionalShadowCacheRecorded: true,
    directionalCascadeCadence: undefined as unknown,
    shadowCandidate: undefined as unknown,
  });
  const view = world
    .spawn(
      {
        component: ViewSubmission,
        data: { accepted: false, attempt: 0, scene: false, temporal: false },
      },
      {
        component: ViewRecorder,
        data: { state: world.allocUniqueRef('ViewRecorder', recorder) },
      },
    )
    .unwrap();
  const frame = (submission: { accepted: boolean; scene: boolean }) => {
    beginRenderFrame(world, 1);
    owner.shadowCandidate = {
      cadence: { stale: 1 },
      cache: { miss: undefined, next: nextCache },
      lease: { reads: { release } },
    };
    world.set(view, ViewSubmission, { ...submission, attempt: 1, temporal: false }).unwrap();
    endRenderFrame(world);
  };
  return { world, owner, frame, release, previousRelease, nextCache, previous };
}

it('schedules the shadow commit after record-commit and one cleanup discard', () => {
  const data = createRenderWorld().scheduleData();
  const commit = data.find((schedule) => schedule.name === 'RenderCommit');
  const system = commit?.systems.find((entry) => entry.name === RENDER_SHADOW_COMMIT_SYSTEM);
  expect(system?.queries[0]?.read).toEqual(['ViewRecorder', 'ViewSubmission']);
  expect(commit?.dependencies).toContainEqual([
    'render-record-commit',
    RENDER_SHADOW_COMMIT_SYSTEM,
  ]);
  const cleanup = data.find((schedule) => schedule.name === 'RenderCleanup');
  expect(cleanup?.systems.map((entry) => entry.name)).toContain(RENDER_SHADOW_DISCARD_SYSTEM);
});

it('an accepted scene submission promotes the cache, transfers the lease and commits rasters', () => {
  const { owner, frame, release, previousRelease, nextCache } = fixture();
  frame({ accepted: true, scene: true });
  expect(owner.shadowRaster.commit).toHaveBeenCalledTimes(1);
  expect(owner.shadowDepthLayers._commit).toHaveBeenCalledTimes(1);
  expect(owner.directionalCascadeCadence).toEqual({ stale: 1 });
  expect(owner.directionalShadowCache).toBe(nextCache);
  expect(previousRelease).toHaveBeenCalledTimes(1);
  expect(release).not.toHaveBeenCalled();
  expect(owner.shadowCandidate).toBeUndefined();
});

it.each([
  ['a rejected submit', { accepted: false, scene: false }],
  ['an accepted frame without a scene', { accepted: true, scene: false }],
])('%s never advances shadow history and releases the lease', (_name, submission) => {
  const { owner, frame, release, previous } = fixture();
  frame(submission);
  expect(owner.shadowRaster.commit).not.toHaveBeenCalled();
  expect(owner.shadowDepthLayers._commit).not.toHaveBeenCalled();
  expect(owner.shadowDepthLayers._abort).toHaveBeenCalledTimes(1);
  expect(owner.directionalShadowCache).toBe(previous);
  expect(release).toHaveBeenCalledTimes(1);
  expect(owner.shadowCandidate).toBeUndefined();
});

it('without the commit system an accepted scene submission leaves shadow history unadvanced', () => {
  const { world, owner, frame, previous } = fixture();
  world.removeSystem(RenderCommit, RENDER_SHADOW_COMMIT_SYSTEM).unwrap();
  frame({ accepted: true, scene: true });
  expect(owner.shadowRaster.commit).not.toHaveBeenCalled();
  expect(owner.directionalShadowCache).toBe(previous);
});
