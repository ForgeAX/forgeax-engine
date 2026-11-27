import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { defineResource, defineSystem } from '@forgeax/engine-ecs';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { RenderSystemInternals } from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import {
  acceptSubmittedDepthOfField,
  commitSubmittedBloom,
  discardUnsubmittedFrame,
} from '../render-system-record-attempt';
import { ViewSubmission, viewAccepted } from './render-views';
import { RenderCleanup, RenderCommit } from './render-world';
import { recordContext } from './view-record-context';

export const RENDER_POST_COMMIT_SYSTEM = 'render-post-commit';
export const RENDER_POST_CLEANUP_SYSTEM = 'render-post-cleanup';

/**
 * One view's Standard post candidate of this Renderer frame: the camera its
 * scene recorded and whether that recording armed bloom resources.
 */
export interface PostCandidate {
  readonly entity: EntityHandle | undefined;
  readonly frameState: RenderFrameState;
  readonly internals: RenderSystemInternals;
  readonly camera: CameraSnapshot | undefined;
  readonly bloomAdmitted: boolean;
}

/**
 * The frame's staged post candidates. A view enqueues one when it records its
 * scene; RenderCommit settles each view's candidate against that view's
 * `ViewSubmission`, and RenderCleanup discards whatever no accepted view committed.
 */
export interface PostSubmissionQueue {
  readonly staged: PostCandidate[];
}

export const PostSubmissions = defineResource<PostSubmissionQueue>('PostSubmissions');

/** The queue a view's scene recording enqueues into. */
export function postSubmissionsOf(world: World): PostSubmissionQueue {
  registerPostSystems(world);
  return world.getResource(PostSubmissions);
}

/**
 * An accepted view publishes Motion Blur and bloom receipts.
 */
function commitPostReceipts({ frameState, internals }: PostCandidate): void {
  const motionBlur = frameState.stagedMotionBlurExecution;
  if (motionBlur !== undefined) {
    if (motionBlur.receipt === undefined) delete frameState.motionBlurExecution;
    else frameState.motionBlurExecution = motionBlur.receipt;
    delete frameState.stagedMotionBlurExecution;
  }
  if (frameState.bloomFrameReceipts !== undefined) {
    recordContext(internals)
      .getPipelineState()
      ?.perPassResources.commitBloomFrameReceipts?.(frameState.bloomFrameReceipts);
    frameState.bloomFrameReceipts = undefined;
  }
}

/** A view without an accepted submission never advances history or publishes receipts. */
function discardPostReceipts({ frameState }: PostCandidate): void {
  delete frameState.stagedMotionBlurExecution;
  frameState.bloomFrameReceipts = undefined;
}

/** Register the post commit/cleanup systems and their queue on a Render World once. */
export function registerPostSystems(world: World): void {
  if (world.hasResource(PostSubmissions)) return;
  const queue: PostSubmissionQueue = { staged: [] };
  world.insertResource(PostSubmissions, queue);
  const systemToken1 = defineSystem({
    commands: 'none',
    name: RENDER_POST_COMMIT_SYSTEM,
    queries: [],
    // An accepted view that drew its scene adopts the camera's AA, DoF and
    // bloom; an accepted barrier-only view drops its bloom candidate.
    fn: (world) => {
      const queue = world.getResource(PostSubmissions);
      let kept = 0;
      for (const candidate of queue.staged) {
        const entity = candidate.entity;
        if (entity === undefined || !viewAccepted(world, entity)) {
          queue.staged[kept++] = candidate;
          continue;
        }
        const submission = world.get(entity, ViewSubmission).unwrap();
        commitPostReceipts(candidate);
        const { frameState, internals, camera } = candidate;
        if (!submission.scene) {
          recordContext(internals).getPipelineState()?.perPassResources.discardBloomResources?.();
          continue;
        }
        frameState.lastSuccessfulCameraAntialias = camera?.antialias;
        acceptSubmittedDepthOfField(frameState, internals, camera);
        commitSubmittedBloom(frameState, internals, candidate.bloomAdmitted);
      }
      queue.staged.length = kept;
    },
  });
  world.addSystem(RenderCommit, systemToken1).unwrap();
  const systemToken2 = defineSystem({
    commands: 'none',
    name: RENDER_POST_CLEANUP_SYSTEM,
    queries: [],
    // A candidate no accepted view committed records the failed submit and
    // releases its armed bloom resources.
    fn: (world) => {
      const queue = world.getResource(PostSubmissions);
      for (const candidate of queue.staged) {
        discardPostReceipts(candidate);
        discardUnsubmittedFrame(candidate.frameState, candidate.internals, candidate.camera);
      }
      queue.staged.length = 0;
    },
  });
  world.addSystem(RenderCleanup, systemToken2).unwrap();
}
