import { expect, it } from 'vitest';
import type { SubmissionPlan } from '../gpu-driven/batch-topology';
import { ShadowClaimTable } from '../gpu-driven/shadow-claims';
import { collectShadowViewClaims } from '../gpu-driven/shadow-view-claims';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import { preparedSnapshot } from './gpu-driven-production-fixture';

it('preserves the slot reader receiver and observes admission only for actual claim keys', () => {
  const slot = {
    slot: 0,
    generation: 0,
    snapshot: preparedSnapshot(1, 1),
  } as PersistentGpuDrivenState['slots'][number];
  const plan = {
    batches: [{ candidates: [{ primitiveIndex: 0, drawItemIndex: 0 }] }],
  } as unknown as SubmissionPlan;
  const scene = {
    slotAt(index: number) {
      expect(this).toBe(scene);
      expect(index).toBe(0);
      return slot;
    },
  };
  let reads = 0;
  const admitted = {
    get shadowDrawKeys() {
      reads++;
      return new Set(['1:-1:0:0']);
    },
  };
  const inherited = new Set(['static']);
  expect(collectShadowViewClaims(plan, scene, undefined, admitted, inherited)).toEqual(inherited);
  expect(reads).toBe(0);
  const claims = new ShadowClaimTable(undefined, [
    { worldEntity: 1, renderableIndex: 0, materialHandle: -1, drawItemIndex: 0, passIndex: 0 },
  ]);
  expect(collectShadowViewClaims(plan, scene, claims, admitted, inherited)).toEqual(
    new Set(['1:-1:0:0', 'static']),
  );
  expect(reads).toBe(1);
});
