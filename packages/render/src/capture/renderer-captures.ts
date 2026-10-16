import type { CubeCameraSnapshot } from '../render-contract';
import type { RenderTarget } from '../targets/contracts';
import { type CubeCaptureWork, createCubeCaptureScheduler } from './scheduler';

/** The Renderer retains one progressive capture across view reorder, cadence and removal. */
export function createRendererCaptureOwner(
  getTargetStorage: (target: RenderTarget) => object | undefined,
) {
  const storage = new WeakMap<RenderTarget, object>();
  const scheduler = createCubeCaptureScheduler({ maxFacesPerFrame: 1 });
  let activeTarget: RenderTarget | undefined;
  let previousEntity: number | undefined;
  let recorded = false;
  return {
    isPending(target: RenderTarget): boolean {
      return scheduler.inspect(target).candidateGeneration !== undefined;
    },
    prepare(snapshots: readonly CubeCameraSnapshot[]): readonly CubeCaptureWork[] {
      recorded = false;
      scheduler.beginFrame();
      for (const { target } of snapshots) {
        const physical = getTargetStorage(target);
        if (storage.get(target) === physical) continue;
        scheduler.invalidate(target);
        if (activeTarget === target) activeTarget = undefined;
        if (physical === undefined) storage.delete(target);
        else storage.set(target, physical);
      }
      if (activeTarget !== undefined && !snapshots.some((item) => item.target === activeTarget)) {
        scheduler.cancel(activeTarget);
        activeTarget = undefined;
      }
      if (
        activeTarget !== undefined &&
        scheduler.inspect(activeTarget).candidateGeneration === undefined
      )
        activeTarget = undefined;
      if (activeTarget === undefined) {
        const sorted = [...snapshots].sort((a, b) => (a.entityKey ?? 0) - (b.entityKey ?? 0));
        const next = sorted.findIndex((item) => (item.entityKey ?? 0) > (previousEntity ?? -1));
        const start = next < 0 ? 0 : next;
        for (let index = 0; index < sorted.length; index += 1) {
          const snapshot = sorted[(start + index) % sorted.length];
          if (snapshot === undefined) continue;
          const request = scheduler.request(snapshot);
          if (!request.ok) throw request.error;
          if (!request.value.scheduled) continue;
          activeTarget = snapshot.target;
          previousEntity = snapshot.entityKey ?? 0;
          break;
        }
      }
      const work = scheduler.nextWork();
      recorded = work.length > 0;
      return work;
    },
    complete(submitted: boolean, completion?: Promise<unknown>): void {
      if (!recorded) return;
      recorded = false;
      const result = scheduler.completeSubmission(submitted, completion);
      // A failed outer transaction aborts the candidate; it is already reported
      // by the transaction owner, so only unexpected successful-submit failures throw.
      if (submitted && !result.ok) throw result.error;
    },
  };
}
export type RendererCaptureOwner = ReturnType<typeof createRendererCaptureOwner>;
