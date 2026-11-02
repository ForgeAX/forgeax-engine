import { expect, it, vi } from 'vitest';
import { ViewRecorder, ViewSubmission } from '../render-views';
import { beginRenderFrame, createRenderWorld, endRenderFrame, RenderCommit } from '../render-world';
import {
  RENDER_GPU_DRIVEN_ABORT_SYSTEM,
  RENDER_GPU_DRIVEN_COMMIT_SYSTEM,
} from '../view-settlement';
import { withInertTemporal } from './temporal-owner-fixture';

function fixture() {
  const world = createRenderWorld();
  const recorder = withInertTemporal({});
  const owner = (recorder as unknown as { owner: { frameState: object; internals: object } }).owner;
  const fire = vi.fn();
  Object.assign(owner.internals, { errorRegistry: { fire } });
  const prepared = {
    _commitResourceReplacement: vi.fn(),
    _abortResourceReplacement: vi.fn(),
    _consumeSurfaceDynamicInput: vi.fn(() => ({ ok: true as const })),
  };
  const frameState = Object.assign(owner.frameState, {
    gpuDrivenFrame: undefined as unknown,
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
  const frame = (submission: { accepted: boolean; scene: boolean }, commit = true) => {
    beginRenderFrame(world, 1);
    frameState.gpuDrivenFrame = {
      prepared,
      ...(commit ? { commit: { shadowGraphGeneration: 7, frameNumber: 3 } } : {}),
    };
    world.set(view, ViewSubmission, { attempt: 1, temporal: false, ...submission }).unwrap();
    endRenderFrame(world);
  };
  return { world, frameState, prepared, fire, frame };
}

it('schedules the commit after the fog commit and one abort in cleanup', () => {
  const data = createRenderWorld().scheduleData();
  const commit = data.find((schedule) => schedule.name === 'RenderCommit');
  expect(commit?.dependencies).toContainEqual([
    'render-fog-commit',
    RENDER_GPU_DRIVEN_COMMIT_SYSTEM,
  ]);
  const cleanup = data.find((schedule) => schedule.name === 'RenderCleanup');
  expect(cleanup?.systems.map((entry) => entry.name)).toContain(RENDER_GPU_DRIVEN_ABORT_SYSTEM);
});

it('an accepted scene submission commits resource replacement and consumes the surface input', () => {
  const { frameState, prepared, frame } = fixture();
  frame({ accepted: true, scene: true });
  expect(prepared._commitResourceReplacement).toHaveBeenCalledWith(7);
  expect(prepared._consumeSurfaceDynamicInput).toHaveBeenCalledWith(3);
  expect(frameState.gpuDrivenFrame).toBeUndefined();
});

it('a surface input failure is reported, not thrown into the World', () => {
  const { prepared, fire, frame } = fixture();
  const error = new Error('consume');
  prepared._consumeSurfaceDynamicInput.mockReturnValue({ ok: false, error } as never);
  frame({ accepted: true, scene: true });
  expect(fire).toHaveBeenCalledWith(error);
});

it.each([
  ['a rejected submit', { accepted: false, scene: false }, true],
  ['a capture-only frame', { accepted: true, scene: false }, false],
])('%s never commits and aborts the prepared frame', (_name, submission, commit) => {
  const { frameState, prepared, frame } = fixture();
  frame(submission, commit);
  expect(prepared._commitResourceReplacement).not.toHaveBeenCalled();
  expect(prepared._abortResourceReplacement).toHaveBeenCalledTimes(1);
  expect(frameState.gpuDrivenFrame).toBeUndefined();
});

it('without the commit system an accepted scene submission leaves the replacement uncommitted', () => {
  const { world, prepared, frame } = fixture();
  world.removeSystem(RenderCommit, RENDER_GPU_DRIVEN_COMMIT_SYSTEM).unwrap();
  frame({ accepted: true, scene: true });
  expect(prepared._commitResourceReplacement).not.toHaveBeenCalled();
});
