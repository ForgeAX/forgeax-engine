import { World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import type { CameraSnapshot } from '../../render-contract';
import { adoptViewRecordHistory, viewRecordHistory } from '../record-history';
import { RenderViewInput, RenderViews, recordViewSubmission, ViewRecorder } from '../render-views';
import {
  beginRenderFrame,
  endRenderFrame,
  publishRenderSubmission,
  RenderCommit,
} from '../render-world';
import { RENDER_RECORD_COMMIT_SYSTEM, registerSubmissionSystems } from '../submission-systems';

const camera = {
  entityKey: 1,
  historyVersion: 1,
  view: {
    viewport: new Float32Array([0, 0, 1, 1]),
    order: 0,
    resolutionScale: 1,
    maxRenderShortSide: 0,
    updateInterval: 1,
    enabled: true,
  },
} as unknown as CameraSnapshot;

function setup(removed = false) {
  // Only the submission lifecycle runs beside the views: the other per-view
  // settlement systems would read the real owner the fake below stands for.
  const world = new World();
  registerSubmissionSystems(world);
  const views = new RenderViews(world);
  if (removed) world.removeSystem(RenderCommit, RENDER_RECORD_COMMIT_SYSTEM).unwrap();
  world.insertResource(RenderViewInput, {
    cameras: [camera],
    captures: [],
    primary: false,
    primaryCamera: undefined,
    canvas: { width: 64, height: 64 },
    attachment: () => 'w',
    targetExtent: () => undefined,
  });
  beginRenderFrame(world, 1);
  const entity = views.ordered[0] as NonNullable<(typeof views.ordered)[0]>;
  adoptViewRecordHistory(world, entity);
  const owner = {
    frameState: {
      directionalShadowCache: null,
      compiledFrameGraph: null,
      graphGeneration: 0,
    },
    internals: {
      errorRegistry: { fire: vi.fn() },
      getPipelineState: () => null,
      deviceScope: { generation: 3 },
    },
    scene: { discardTemporalFrame: () => {} },
  };
  const state = world.allocUniqueRef('ViewRecorder', { owner });
  world.addComponent(entity, { component: ViewRecorder, data: { state } }).unwrap();
  const history = viewRecordHistory(world, entity) as NonNullable<
    ReturnType<typeof viewRecordHistory>
  >;
  const record = (accepted: boolean, frame: number) => {
    // A preparation barrier carries no outcome: the accepted attempt only counts.
    history.stage({
      frame,
      generation: 3,
      attempt: { submitted: true, sceneSubmitted: false, outcome: undefined } as never,
      accepted,
      failure: undefined,
      ownsProfileFrame: false,
    });
    publishRenderSubmission(world, {
      accepted: true,
      completion: undefined,
      creditCompletion: undefined,
      generation: 3,
    });
    recordViewSubmission(world, entity, {
      accepted,
      attempt: frame,
      scene: accepted,
      temporal: false,
    });
  };
  return { world, history, record, errors: owner.internals.errorRegistry.fire };
}

describe('record history', () => {
  it('is committed by render-record-commit, which writes the view submission', () => {
    const { world } = setup();
    const commit = world
      .scheduleData()
      .find((s) => s.name === 'RenderCommit')
      ?.systems.find((s) => s.name === RENDER_RECORD_COMMIT_SYSTEM);
    expect(commit?.queries[0]?.write).toContain('ViewSubmission');
    expect(commit?.queries[0]?.read).toContain('ViewRecordHistory');
  });

  it('counts and publishes an accepted attempt only through the commit system', () => {
    const run = (removed: boolean, accepted = true) => {
      const { world, history, record, errors } = setup(removed);
      record(accepted, 1);
      endRenderFrame(world);
      expect(errors).not.toHaveBeenCalled();
      return history;
    };
    const committed = run(false);
    expect(committed.submittedFrames).toBe(1);
    expect(committed.lastGeneration).toBe(3);
    expect(committed.staged).toEqual([]);
    const removed = run(true);
    expect(removed.submittedFrames).toBe(0);
    expect(removed.lastGeneration).toBeUndefined();
    expect(run(false, false).submittedFrames).toBe(0);
  });
});
