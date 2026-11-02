import { expect, it, vi } from 'vitest';
import { ViewRecorder, ViewSubmission } from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderCleanup,
  RenderCommit,
  renderSubmission,
} from '../render-world';
import { RENDER_SKIN_COMPLETE_SYSTEM, RENDER_SKIN_TRACK_SYSTEM } from '../view-settlement';
import { withInertTemporal } from './temporal-owner-fixture';

function fixture() {
  const world = createRenderWorld();
  const recorder = withInertTemporal({});
  const owner = (recorder as unknown as { owner: { skin: object; internals: object } }).owner;
  const fire = vi.fn();
  Object.assign(owner.internals, { errorRegistry: { fire } });
  const skin = { trackSubmittedWork: vi.fn(), complete: vi.fn((): unknown[] => []) };
  owner.skin = skin;
  const view = world
    .spawn(
      {
        component: ViewSubmission,
        data: { accepted: false, attempt: 0, scene: false, temporal: false },
      },
      { component: ViewRecorder, data: { state: world.allocUniqueRef('ViewRecorder', recorder) } },
    )
    .unwrap();
  const completion = Promise.resolve();
  const frame = (submission: { accepted: boolean; scene: boolean }) => {
    beginRenderFrame(world, 1);
    renderSubmission(world).completion = completion;
    world.set(view, ViewSubmission, { attempt: 1, temporal: false, ...submission }).unwrap();
    endRenderFrame(world);
  };
  return { world, skin, fire, frame, completion };
}

it('schedules the track in RenderCommit and the complete in RenderCleanup', () => {
  const data = createRenderWorld().scheduleData();
  const names = (schedule: string) =>
    data.find((entry) => entry.name === schedule)?.systems.map((entry) => entry.name);
  expect(names('RenderCommit')).toContain(RENDER_SKIN_TRACK_SYSTEM);
  expect(names('RenderCleanup')).toContain(RENDER_SKIN_COMPLETE_SYSTEM);
});

it('an accepted submission tracks its completion, then completes with the scene result', () => {
  const { skin, frame, completion } = fixture();
  frame({ accepted: true, scene: true });
  expect(skin.trackSubmittedWork).toHaveBeenCalledWith(completion);
  expect(skin.complete).toHaveBeenCalledWith(true);
});

it('a rejected submit tracks nothing and completes as not accepted', () => {
  const { skin, frame } = fixture();
  frame({ accepted: false, scene: false });
  expect(skin.trackSubmittedWork).not.toHaveBeenCalled();
  expect(skin.complete).toHaveBeenCalledWith(false);
});

it('completion failures are reported, not thrown into the World', () => {
  const { skin, fire, frame } = fixture();
  skin.complete.mockReturnValue([new Error('retire')]);
  frame({ accepted: true, scene: true });
  expect(fire).toHaveBeenCalledTimes(1);
});

it('without the systems the skin lifecycle is never settled', () => {
  const { world, skin, frame } = fixture();
  world.removeSystem(RenderCommit, RENDER_SKIN_TRACK_SYSTEM).unwrap();
  world.removeSystem(RenderCleanup, RENDER_SKIN_COMPLETE_SYSTEM).unwrap();
  frame({ accepted: true, scene: true });
  expect(skin.trackSubmittedWork).not.toHaveBeenCalled();
  expect(skin.complete).not.toHaveBeenCalled();
});
