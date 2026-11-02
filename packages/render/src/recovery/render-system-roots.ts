import type { LifecycleResourceSpec } from '../device/device-scope';
import type { EnvironmentGeneration } from '../environment/generation';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { RecoveryRootBundle, RecoveryRootRuntime } from './types';

/**
 * Assemble replacement-device roots without letting candidate construction
 * publish through the view's active state. The view's frame state owns its
 * environment lifecycle; publication swaps in the candidate lifecycle.
 */
export function prepareRenderSystemRecoveryRoots(
  runtime: RecoveryRootRuntime,
  frameState: RenderFrameState,
): RecoveryRootBundle {
  const environmentLifecycle = frameState.environmentLifecycle;
  const candidateEnvironmentLifecycle = environmentLifecycle.createRecoveryCandidate(runtime.scope);
  const roots: LifecycleResourceSpec<unknown>[] = [];
  let candidateEnvironmentGeneration: EnvironmentGeneration | undefined;
  let environmentRootCleaned = false;
  let published = false;
  if (candidateEnvironmentLifecycle.hasRecoveryFrame()) {
    const environmentRoot = candidateEnvironmentLifecycle.createRecoveryRoot(runtime.scope);
    roots.push({
      ...environmentRoot,
      create: async () => {
        const generation = (await environmentRoot.create()) as EnvironmentGeneration;
        candidateEnvironmentGeneration = generation;
        return generation;
      },
      cleanup: (value) => {
        if (environmentRootCleaned) return;
        environmentRootCleaned = true;
        if (candidateEnvironmentGeneration === value) candidateEnvironmentGeneration = undefined;
        if (published) {
          candidateEnvironmentLifecycle.retirePublishedGeneration(value as EnvironmentGeneration);
        } else {
          environmentRoot.cleanup(value);
        }
      },
    });
  }
  let discarded = false;
  return {
    roots: Object.freeze(roots),
    publish: () => {
      if (published || discarded) return;
      if (candidateEnvironmentGeneration !== undefined && !candidateEnvironmentGeneration.retired) {
        environmentLifecycle.retireActiveForReplacement();
        candidateEnvironmentLifecycle.publish(candidateEnvironmentGeneration);
      }
      published = true;
      Object.assign(frameState, { environmentLifecycle: candidateEnvironmentLifecycle });
    },
    discard: () => {
      if (published || discarded) return;
      discarded = true;
      if (candidateEnvironmentGeneration !== undefined) {
        candidateEnvironmentLifecycle.discard(candidateEnvironmentGeneration);
        candidateEnvironmentGeneration = undefined;
      }
      candidateEnvironmentLifecycle.discardRecoveryCandidates();
      runtime.scope.abandon();
    },
  };
}
