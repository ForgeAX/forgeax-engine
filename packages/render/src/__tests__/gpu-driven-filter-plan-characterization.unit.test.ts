import { describe, expect, it } from 'vitest';
import type { GpuDrivenCandidate } from '../gpu-driven/batch-topology';
import { materialBindingKey } from '../gpu-driven/material-bindings';
import { filteredPlan } from '../gpu-driven/production-raster-prepare';
import { ShadowClaimTable } from '../gpu-driven/shadow-claims';
import { SHADOW_CASTER_SHADER_ID } from '../pbr-pipeline';
import type { ShadowCasterMembership } from '../render-system-extract';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw Error('Missing characterization fixture value');
  return value;
}
const tokens = (candidates: readonly GpuDrivenCandidate[]) =>
  candidates.map((c) => `${c.primitiveIndex}:${c.instanceOrdinal}`);

describe('whole filtered-plan canonical output before incremental projection', () => {
  it('merges across source batches by first occurrence, observes binding mutations and preserves previous publications', () => {
    const f = createFilterPlanFixture(),
      prepared = f.prepare();
    const first = filteredPlan(prepared, undefined, f.bindings);
    expect(first.plan.batches.map((batch) => tokens(batch.candidates))).toEqual([
      ['2:0', '0:0', '2:1', '0:1'],
      ['1:0', '1:1'],
    ]);
    expect(first.batches.map((batch) => batch.primitiveSlot)).toEqual([2, 1]);
    expect(first.plan.batches.map((batch) => [batch.visibleBase, batch.indirectOffset])).toEqual([
      [0, 0],
      [128, 40],
    ]);
    const binding = materialBindingKey(defined(f.slots[0]).snapshot, 100);
    f.bindings.set(binding, 'C');
    const split = filteredPlan(prepared, undefined, f.bindings);
    expect(split.plan.batches.map((batch) => tokens(batch.candidates))).toEqual([
      ['2:0', '2:1'],
      ['1:0', '1:1'],
      ['0:0', '0:1'],
    ]);
    expect(split.plan.batches.map((batch) => [batch.visibleBase, batch.indirectOffset])).toEqual([
      [0, 0],
      [128, 40],
      [256, 80],
    ]);
    f.bindings.set(binding, 'A');
    expect(filteredPlan(prepared, undefined, f.bindings).plan).toEqual(first.plan);
    expect(first.plan.batches.map((batch) => tokens(batch.candidates))).toEqual([
      ['2:0', '0:0', '2:1', '0:1'],
      ['1:0', '1:1'],
    ]);
    const reversed = f.prepare({ ...f.source, batches: [...f.source.batches].reverse() });
    const reordered = filteredPlan(reversed, undefined, f.bindings);
    expect(reordered.plan.batches.map((batch) => tokens(batch.candidates))).toEqual([
      ['1:1', '1:0'],
      ['0:1', '0:0', '2:1', '2:0'],
    ]);
    expect(reordered.batches.map((batch) => batch.primitiveSlot)).toEqual([1, 0]);
    const removed = f.prepare({ ...f.source, batches: f.source.batches.slice(1) });
    expect(
      filteredPlan(removed, undefined, f.bindings).batches.map((batch) => batch.primitiveSlot),
    ).toEqual([0, 1]);
  });

  it('keeps shadow membership, compatibility and hard/fading LOD groups separate from main projection', () => {
    const f = createFilterPlanFixture(),
      prepared = f.prepare();
    const memberships: ShadowCasterMembership[] = f.slots.map((slot) => ({
      worldEntity: slot.snapshot.entityKey,
      renderableIndex: slot.slot,
      drawItemIndex: 0,
      materialHandle: slot.snapshot.material.materialHandle ?? -1,
      passIndex: 0,
      materialShaderId: slot.slot === 1 ? 'custom-shadow' : SHADOW_CASTER_SHADER_ID,
      renderState: { cullMode: slot.slot === 1 ? 'front' : 'back' },
      gpuDrivenEligible: true,
    }));
    const claims = (values: readonly ShadowCasterMembership[]) =>
      new ShadowClaimTable(undefined, values);
    const original = filteredPlan(prepared, claims(memberships));
    expect(original.plan.batches.map((batch) => tokens(batch.candidates))).toEqual([
      ['2:0', '0:0', '2:1', '0:1'],
      ['1:0', '1:1'],
    ]);
    expect(original.plan.batches.map((batch) => batch.lod?.crossfade ?? false)).toEqual([
      true,
      false,
    ]);
    const denied = memberships.map((value) =>
      value.renderableIndex === 2 ? { ...value, gpuDrivenEligible: false } : value,
    );
    const next = filteredPlan(prepared, claims(denied));
    expect(next.plan.batches.map((batch) => tokens(batch.candidates))).toEqual([
      ['1:0', '1:1'],
      ['0:0', '0:1'],
    ]);
    expect(next.batches.map((batch) => batch.primitiveSlot)).toEqual([1, 0]);
    expect(next.plan.batches.map((batch) => batch.lod?.crossfade ?? false)).toEqual([false, true]);
    expect(original.plan.candidateCount).toBe(6);
    expect(next.plan.candidateCount).toBe(4);
    expect(filteredPlan(prepared, undefined, f.bindings).plan.candidateCount).toBe(6);
    expect(filteredPlan(prepared, claims([...memberships].reverse())).plan).toEqual(original.plan);
  });
});
