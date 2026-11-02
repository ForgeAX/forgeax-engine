import { World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import type { RenderFrameState } from '../../record/frame-snapshot';
import type { RenderSystemInternals } from '../../record/render-context';
import {
  type DisplaySubmission,
  RENDER_DISPLAY_COMMIT_SYSTEM,
  registerDisplaySubmissionSystems,
} from '../display-submission-systems';
import { giSubmissionsOf, registerGiSystems } from '../gi-systems';
import {
  type GraphSubmission,
  RENDER_GRAPH_SUBMISSION_COMMIT_SYSTEM,
  registerGraphSubmissionSystems,
} from '../graph-submission-systems';
import { ViewRecorder, ViewSubmission } from '../render-views';
import {
  beginRenderFrame,
  endRenderFrame,
  publishRenderSubmission,
  RenderCommit,
} from '../render-world';

function fixture(accepted: boolean) {
  const world = new World();
  registerGiSystems(world);
  registerGraphSubmissionSystems(world);
  registerDisplaySubmissionSystems(world);
  const timing = { markSubmitted: vi.fn(), discard: vi.fn() };
  const passTiming = { abort: vi.fn() };
  const gi = {};
  const graph: GraphSubmission = {
    frame: 3,
    timing: timing as never,
    passTiming: passTiming as never,
    gi: gi as never,
    onAccepted: undefined,
    submitted: true,
    rejectedStage: undefined,
    settled: false,
  };
  const resolution = { commit: vi.fn(), observe: vi.fn() };
  const mapping = {};
  const display = {
    frame: 3,
    attempt: { captureFrames: [{ work: { target: 'target', physical: 'layer' } }] },
    resolution,
    extent: { width: 16, height: 8 },
    rasterRows: () => 7,
    renderableCount: 9,
    sampleResolution: false,
    timing: undefined,
    barrelMapping: mapping,
  } as unknown as DisplaySubmission;
  const frameState = {
    graphSubmission: graph,
    displaySubmission: display,
    frameOutputs: { sceneSubmitted: false },
  } as unknown as RenderFrameState;
  const internals = {
    markRenderTargetSubmitted: vi.fn(),
    errorRegistry: { fire: vi.fn() },
    renderWorld: world,
  } as unknown as RenderSystemInternals;
  const state = world.allocUniqueRef('ViewRecorder', { owner: { internals, frameState } });
  world
    .spawn(
      { component: ViewRecorder, data: { state } },
      {
        component: ViewSubmission,
        data: { accepted: true, attempt: 3, scene: true, temporal: false },
      },
    )
    .unwrap();
  beginRenderFrame(world, 3);
  publishRenderSubmission(world, {
    accepted,
    completion: Promise.resolve(),
    creditCompletion: undefined,
    generation: 1,
  });
  return {
    world,
    timing,
    passTiming,
    graph,
    display,
    frameState,
    internals,
    resolution,
    mapping,
    gi,
  };
}

describe('graph and display submission systems', () => {
  it('publishes staged products only in Commit, once, then clears them in Cleanup', () => {
    const f = fixture(true);
    expect(f.timing.markSubmitted).not.toHaveBeenCalled();
    expect(f.resolution.commit).not.toHaveBeenCalled();
    expect(f.world.run(RenderCommit).ok).toBe(true);
    expect(f.timing.markSubmitted).toHaveBeenCalledTimes(1);
    expect(f.resolution.commit).toHaveBeenCalledWith(f.display.extent, expect.any(Function));
    expect(f.resolution.commit.mock.calls[0]?.[1]()).toBe(7);
    expect(f.internals.markRenderTargetSubmitted).toHaveBeenCalledWith('target', 'layer');
    expect(f.frameState.lastSuccessfulBarrelDistortion).toBe(f.mapping);
    expect(giSubmissionsOf(f.world)?.submitted).toEqual([f.gi]);
    endRenderFrame(f.world);
    expect(f.timing.markSubmitted).toHaveBeenCalledTimes(1);
    expect(f.timing.discard).not.toHaveBeenCalled();
    expect(f.frameState.graphSubmission).toBeUndefined();
    expect(f.frameState.displaySubmission).toBeUndefined();
    expect(f.world.execution.health).toBe('healthy');
  });

  it.each([
    'build',
    'execute',
    'finish',
    'submit',
  ] as const)('aborts %s without advancing accepted history', (stage) => {
    const f = fixture(false);
    f.graph.rejectedStage = stage;
    endRenderFrame(f.world);
    expect(f.frameState.rejectedStage).toBe(stage);
    expect(f.passTiming.abort).toHaveBeenCalledExactlyOnceWith({ code: stage });
    expect(f.timing.discard).toHaveBeenCalledTimes(1);
    expect(f.timing.markSubmitted).not.toHaveBeenCalled();
    expect(f.resolution.commit).not.toHaveBeenCalled();
    expect(f.frameState.lastSuccessfulBarrelDistortion).toBeUndefined();
    expect(f.internals.markRenderTargetSubmitted).not.toHaveBeenCalled();
    expect(f.world.execution.health).toBe('healthy');
  });

  it('cannot publish timing or GI when its commit system is removed', () => {
    const f = fixture(true);
    f.world.removeSystem(RenderCommit, RENDER_GRAPH_SUBMISSION_COMMIT_SYSTEM).unwrap();
    endRenderFrame(f.world);
    expect(f.timing.markSubmitted).not.toHaveBeenCalled();
    expect(f.timing.discard).toHaveBeenCalledTimes(1);
    expect(giSubmissionsOf(f.world)?.submitted).toEqual([]);
  });

  it('cannot advance display history when its commit system is removed', () => {
    const f = fixture(true);
    f.world.removeSystem(RenderCommit, RENDER_DISPLAY_COMMIT_SYSTEM).unwrap();
    endRenderFrame(f.world);
    expect(f.resolution.commit).not.toHaveBeenCalled();
    expect(f.frameState.lastSuccessfulBarrelDistortion).toBeUndefined();
    expect(f.internals.markRenderTargetSubmitted).not.toHaveBeenCalled();
  });
});
