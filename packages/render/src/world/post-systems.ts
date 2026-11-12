import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { RenderSystemInternals } from '../record/render-context';
import { reportSsrHistoryFailure } from '../record/ssr-history-frame';
import type { CameraSnapshot } from '../render-contract';
import {
  acceptSubmittedDepthOfField,
  commitSubmittedBloom,
  discardUnsubmittedFrame,
} from '../render-system-record-attempt';
import { commitSsrHistoryBaseline } from './history-admission-systems';
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

export const PostSubmissions = Object.freeze({ name: 'PostSubmissions' });

/** The queue a view's scene recording enqueues into. */
export function postSubmissionsOf(world: World): PostSubmissionQueue {
  registerPostSystems(world);
  return world.getResource<PostSubmissionQueue>(PostSubmissions);
}

/**
 * An accepted view publishes the receipts and SSR history its frame staged:
 * Motion Blur execution, bloom record receipts and the SSR history candidate.
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
  const owner = frameState.ssrHistoryOwner;
  const candidate = owner?.candidate;
  if (owner === undefined || candidate === undefined) return;
  const committed = owner.submitFrame(candidate, internals.device.queue);
  if (committed.ok) return;
  owner.abortFrame(candidate, 'submit');
  reportSsrHistoryFailure(internals, 'submit', committed.error);
}

/** A view without an accepted submission never advances history or publishes receipts. */
function discardPostReceipts({ frameState }: PostCandidate): void {
  delete frameState.stagedMotionBlurExecution;
  frameState.bloomFrameReceipts = undefined;
  const owner = frameState.ssrHistoryOwner;
  if (owner?.candidate !== undefined) owner.abortFrame(owner.candidate, 'submit');
}

/** Register the post commit/cleanup systems and their queue on a Render World once. */
export function registerPostSystems(world: World): void {
  if (world.hasResource(PostSubmissions)) return;
  const queue: PostSubmissionQueue = { staged: [] };
  world.insertResource(PostSubmissions, queue);
  world
    .addSystem(RenderCommit, {
      commands: 'none',
      name: RENDER_POST_COMMIT_SYSTEM,
      queries: [],
      // An accepted view that drew its scene adopts the camera's AA, DoF and
      // bloom; an accepted barrier-only view drops its bloom candidate.
      fn: (world) => {
        const queue = world.getResource<PostSubmissionQueue>(PostSubmissions);
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
          commitSsrHistoryBaseline(world, entity, frameState, internals, camera);
          frameState.lastSuccessfulCameraAntialias = camera?.antialias;
          acceptSubmittedDepthOfField(frameState, internals, camera);
          commitSubmittedBloom(frameState, internals, candidate.bloomAdmitted);
        }
        queue.staged.length = kept;
      },
    })
    .unwrap();
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: RENDER_POST_CLEANUP_SYSTEM,
      queries: [],
      // A candidate no accepted view committed records the failed submit and
      // releases its armed bloom resources.
      fn: (world) => {
        const queue = world.getResource<PostSubmissionQueue>(PostSubmissions);
        for (const candidate of queue.staged) {
          discardPostReceipts(candidate);
          discardUnsubmittedFrame(candidate.frameState, candidate.internals, candidate.camera);
        }
        queue.staged.length = 0;
      },
    })
    .unwrap();
}
