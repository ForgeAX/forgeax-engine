import type { LifecycleResourceSpec } from '../device/device-scope';
import type { EnvironmentGeneration } from '../environment/generation';
import type { EnvironmentLifecycle } from '../environment/lifecycle';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { RecoveryRootBundle, RecoveryRootRuntime } from '../render-system';

/**
 * Assemble replacement-device roots without letting candidate construction
 * publish through the active RenderSystem owner.  The caller supplies the
 * small state handoff explicitly so this recovery seam remains independent
 * from frame orchestration.
 */
export function prepareRenderSystemRecoveryRoots(
  runtime: RecoveryRootRuntime,
  environmentLifecycle: EnvironmentLifecycle,
  frameState: RenderFrameState,
  publishEnvironmentLifecycle: (lifecycle: EnvironmentLifecycle) => void,
): RecoveryRootBundle {
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
  const graphCandidate = runtime.graphCandidate;
  if (graphCandidate !== undefined) {
    const releaseGraphCandidate = (): void => graphCandidate.release();
    const compiledGraph = graphCandidate.frameState.compiledFrameGraph?.graph ?? null;
    if (compiledGraph !== null) {
      roots.push({
        kind: 'pipeline',
        create: () => {
          if (!runtime.scope.isAlive())
            throw new Error('Recovery graph candidate scope is not active.');
          if (graphCandidate.frameState.compiledFrameGraph?.graph !== compiledGraph) {
            throw new Error('Recovery graph candidate was changed before aggregate assembly.');
          }
          return compiledGraph;
        },
        cleanup: releaseGraphCandidate,
      });
    }
    if (graphCandidate.featureHost !== undefined) {
      const featureRoot = graphCandidate.featureHost.createRecoveryRoot(runtime.scope);
      roots.push({ ...featureRoot, cleanup: releaseGraphCandidate });
    }
    if (graphCandidate.featureGpuWork !== undefined) {
      const featureWorkRoot = graphCandidate.featureGpuWork.createRecoveryRoot(runtime.scope);
      roots.push({ ...featureWorkRoot, cleanup: releaseGraphCandidate });
    }
    if (graphCandidate.gpuDrivenProduction !== undefined) {
      const productionRoot = graphCandidate.gpuDrivenProduction.createRecoveryRoot(runtime.scope);
      roots.push({ ...productionRoot, cleanup: releaseGraphCandidate });
    }
    if (graphCandidate.gpuDrivenScene?.state !== undefined) {
      const sceneRoot = graphCandidate.gpuDrivenScene.createRecoveryRoot(runtime.scope);
      roots.push({ ...sceneRoot, cleanup: releaseGraphCandidate });
    }
    if (graphCandidate.pointsLines !== undefined) {
      const pointsLinesRoot = graphCandidate.pointsLines.createRecoveryRoot(runtime.scope);
      roots.push({ ...pointsLinesRoot, cleanup: releaseGraphCandidate });
    }
    if (runtime.gpuStore.recoveryResourceCount() > 0) {
      const gpuStoreRoot = runtime.gpuStore.createRecoveryRoot(runtime.scope);
      roots.push({ ...gpuStoreRoot, cleanup: releaseGraphCandidate });
    }
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
      publishEnvironmentLifecycle(candidateEnvironmentLifecycle);
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
      graphCandidate?.release();
      runtime.scope.abandon();
    },
  };
}
