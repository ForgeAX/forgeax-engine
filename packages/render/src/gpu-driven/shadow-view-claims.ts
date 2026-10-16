import type { RenderableSnapshot } from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { SubmissionPlan } from './batch-topology';
import type { FilteredProductionPlan } from './production-raster-prepare';
import type { ShadowClaimTable } from './shadow-claims';

/** Keep the candidate walk outside the graph-projection closure and its captured resources. */
export function collectShadowViewClaims(
  plan: SubmissionPlan,
  scene: Pick<PersistentGpuDrivenState, 'slotAt'>,
  claims: ShadowClaimTable | undefined,
  admitted: Pick<FilteredProductionPlan, 'shadowDrawKeys'>,
  inherited: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const batch of plan.batches) {
    let previousSnapshot: RenderableSnapshot | undefined;
    let previousDrawItemIndex: number | undefined;
    for (const candidate of batch.candidates) {
      const slot = scene.slotAt(candidate.primitiveIndex);
      if (slot === undefined) continue;
      if (slot.snapshot === previousSnapshot && candidate.drawItemIndex === previousDrawItemIndex)
        continue;
      previousSnapshot = slot.snapshot;
      previousDrawItemIndex = candidate.drawItemIndex;
      const claim = claims?.claim(slot, candidate);
      if (claim === undefined || !claim.compatible) continue;
      for (const key of claim.keys) if (admitted.shadowDrawKeys.has(key)) keys.add(key);
    }
  }
  for (const key of inherited ?? []) keys.add(key);
  return Object.freeze(keys);
}
