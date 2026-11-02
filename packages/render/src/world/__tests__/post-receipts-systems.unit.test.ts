import { describe, expect, it, vi } from 'vitest';
import {
  postSubmissionsOf,
  RENDER_POST_CLEANUP_SYSTEM,
  RENDER_POST_COMMIT_SYSTEM,
} from '../post-systems';
import { RenderView, ViewSubmission } from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  publishRenderSubmission,
  RenderCommit,
} from '../render-world';

const RECEIPT = { kind: 'receipt' };

function scenario(accepted: boolean) {
  const world = createRenderWorld();
  const view = world
    .spawn(
      { component: RenderView, data: {} },
      {
        component: ViewSubmission,
        data: { accepted, attempt: 1, scene: true, temporal: false },
      },
    )
    .unwrap();
  const commitBloomFrameReceipts = vi.fn();
  const candidate = { id: 'candidate' };
  const owner = {
    candidate,
    commitFrame: vi.fn(() => ({ ok: true })),
    abortFrame: vi.fn(),
  };
  const frameState = {
    stagedMotionBlurExecution: { receipt: RECEIPT },
    bloomFrameReceipts: { receipts: 1 },
    ssrHistoryOwner: owner,
  } as Record<string, unknown>;
  const internals = {
    getPipelineState: () => ({
      perPassResources: {
        commitBloomFrameReceipts,
        discardBloomResources: vi.fn(),
        commitBloomResources: vi.fn(),
      },
    }),
    device: { queue: { onSubmittedWorkDone: () => Promise.resolve() } },
    errorRegistry: { fire: vi.fn() },
  };
  postSubmissionsOf(world).staged.push({
    entity: view,
    frameState: frameState as never,
    internals: internals as never,
    camera: undefined,
    bloomAdmitted: false,
  });
  beginRenderFrame(world, 1);
  // The frame's shared submission is accepted; the view's own attempt decides what commits.
  publishRenderSubmission(world, {
    accepted: true,
    completion: undefined,
    creditCompletion: undefined,
    generation: 0,
  });
  return { world, frameState, owner, candidate, commitBloomFrameReceipts };
}

describe('Render World post receipts', () => {
  it('lists the post systems with their reads and writes', () => {
    const data = createRenderWorld().scheduleData();
    const commit = data.find((schedule) => schedule.name === 'RenderCommit');
    expect(commit?.systems.map((system) => system.name)).toContain(RENDER_POST_COMMIT_SYSTEM);
    const cleanup = data.find((schedule) => schedule.name === 'RenderCleanup');
    expect(cleanup?.systems.map((system) => system.name)).toContain(RENDER_POST_CLEANUP_SYSTEM);
  });

  it('publishes Motion Blur, bloom receipts and SSR history for an accepted view', () => {
    const { world, frameState, owner, candidate, commitBloomFrameReceipts } = scenario(true);
    endRenderFrame(world);
    expect(frameState.motionBlurExecution).toBe(RECEIPT);
    expect(frameState.stagedMotionBlurExecution).toBeUndefined();
    expect(commitBloomFrameReceipts).toHaveBeenCalledWith({ receipts: 1 });
    expect(owner.commitFrame).toHaveBeenCalledWith(candidate);
    expect(owner.abortFrame).not.toHaveBeenCalled();
  });

  it('never publishes or advances history for a rejected view', () => {
    const { world, frameState, owner, candidate, commitBloomFrameReceipts } = scenario(false);
    endRenderFrame(world);
    expect(frameState.motionBlurExecution).toBeUndefined();
    expect(frameState.stagedMotionBlurExecution).toBeUndefined();
    expect(frameState.bloomFrameReceipts).toBeUndefined();
    expect(commitBloomFrameReceipts).not.toHaveBeenCalled();
    expect(owner.commitFrame).not.toHaveBeenCalled();
    expect(owner.abortFrame).toHaveBeenCalledWith(candidate, 'submit');
  });

  it('publishes nothing without the post commit system', () => {
    const { world, frameState, owner } = scenario(true);
    world.removeSystem(RenderCommit, RENDER_POST_COMMIT_SYSTEM).unwrap();
    endRenderFrame(world);
    expect(frameState.motionBlurExecution).toBeUndefined();
    expect(owner.commitFrame).not.toHaveBeenCalled();
  });
});
