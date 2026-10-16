import { describe, expect, it } from 'vitest';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { filteredPlan } from '../gpu-driven/production-raster-prepare';
import { ShadowClaimTable } from '../gpu-driven/shadow-claims';
import { SHADOW_CASTER_SHADER_ID } from '../pbr-pipeline';
import type { ShadowCasterMembership } from '../render-system-extract';
import {
  createFilterPlanFixture,
  expectFilteredPlanContent,
} from './gpu-driven-filter-plan-fixture';

function fixture() {
  const source = createFilterPlanFixture();
  const prepared = source.prepare();
  const membership: ShadowCasterMembership[] = source.slots.map((slot) => ({
    worldEntity: slot.snapshot.entityKey,
    renderableIndex: slot.slot,
    drawItemIndex: 0,
    materialHandle: slot.snapshot.material.materialHandle ?? -1,
    passIndex: 0,
    materialShaderId: SHADOW_CASTER_SHADER_ID,
    gpuDrivenEligible: true,
  }));
  const owner = new FilteredPlanContributionOwner();
  const update = (claims: ShadowClaimTable | undefined) => {
    const value = owner.update(prepared, 'retained-binding-authority', claims);
    expectFilteredPlanContent(value, filteredPlan(prepared, claims));
    return value;
  };
  return { owner, prepared, membership, update };
}

function claims(membership: readonly ShadowCasterMembership[]): ShadowClaimTable {
  return new ShadowClaimTable(undefined, membership);
}

describe('shadow contribution dependencies within one binding authority', () => {
  it.each([
    'shader',
    'raster state',
  ])('retains the accepted claim value when a new publication aliases a mutated %s', (field) => {
    const f = fixture();
    const membership = f.membership.map((entry) => ({
      ...entry,
      renderState: { cullMode: 'back' } as const,
    }));
    const first = f.update(claims(membership));
    const entry = membership[0];
    if (entry === undefined) throw Error('expected membership');
    const mutate = (changed: boolean) => {
      if (field === 'shader')
        Reflect.set(entry, 'materialShaderId', changed ? 'custom-shadow' : SHADOW_CASTER_SHADER_ID);
      else Reflect.set(entry.renderState, 'cullMode', changed ? 'front' : 'back');
    };
    mutate(true);
    f.update(claims([...membership]));
    expect(f.owner.lastWork.projectedBatches).toBe(2);
    mutate(false);
    expect(() =>
      f.owner.update(
        f.prepared,
        'retained-binding-authority',
        claims([...membership]),
        undefined,
        (part, action) => {
          const value = action();
          if (part === 'batches') throw Error('aliased publication interrupted');
          return value;
        },
      ),
    ).toThrow('aliased publication interrupted');
    mutate(true);
    f.update(claims([...membership]));
    expect(f.owner.lastWork.projectedBatches).toBe(3);
    mutate(false);
    f.update(claims([...membership]));
    expect(f.owner.lastWork.projectedBatches).toBe(2);
    expect(first.plan.batches).toHaveLength(1);
    expect(first.plan.batches[0]?.lod?.crossfade).toBe(true);
  });

  it.each<[string, Partial<ShadowCasterMembership>, number]>([
    ['producer denial', { gpuDrivenEligible: false }, 2],
    ['CPU admission', { cpuReason: 'unprepared' }, 2],
    ['unsupported state', { renderState: { depthWriteEnabled: false } }, 2],
    ['pass key', { passIndex: 2 }, 2],
    ['raster state', { renderState: { cullMode: 'front' } }, 2],
    ['undefined versus empty raster state', { renderState: {} }, 2],
    ['custom crossfade policy', { materialShaderId: 'custom-shadow' }, 2],
    ['entry names consumed later by raster', { vertexEntry: 'new_vs', fragmentEntry: 'new_fs' }, 0],
    ['unconsumed presentation index', { renderableIndex: 1000 }, 0],
  ])('observes %s without reprojecting unrelated source batches', (_name, patch, projected) => {
    const f = fixture();
    const before = f.update(claims(f.membership));
    const next = f.update(
      claims(
        f.membership.map((entry, index) => (index === 0 ? { ...entry, ...patch } : { ...entry })),
      ),
    );
    // Primitive zero occurs in two of the three source partitions.
    expect(f.owner.lastWork.projectedBatches).toBe(projected);
    expect(f.owner.lastWork.projectedCandidates).toBe(projected * 2);
    expect(before.plan.candidateCount).toBe(6);
    if (projected === 0)
      expect(next.plan.batches[0]?.candidates).toBe(before.plan.batches[0]?.candidates);
  });

  it('admits previously missing draws and observes ambiguous ownership returning to one pass', () => {
    const f = fixture();
    expect(f.update(claims([])).plan.candidateCount).toBe(0);
    const first = f.membership[0];
    if (first === undefined) throw Error('expected membership');
    // Both claims deny this draw, so changing its CPU reason is irrelevant.
    expect(f.update(claims([{ ...first, gpuDrivenEligible: false }])).plan.candidateCount).toBe(0);
    expect(f.owner.lastWork.projectedBatches).toBe(0);
    expect(f.update(claims([first])).plan.candidateCount).toBe(2);
    expect(f.owner.lastWork.projectedBatches).toBe(2);
    expect(f.update(claims([first, { ...first, passIndex: 1 }])).plan.candidateCount).toBe(0);
    expect(f.owner.lastWork.projectedBatches).toBe(2);
    expect(f.update(claims([first])).plan.candidateCount).toBe(2);
    expect(f.owner.lastWork.projectedBatches).toBe(2);
    expect(f.update(claims([])).plan.candidateCount).toBe(0);
    expect(f.owner.lastWork.projectedBatches).toBe(2);
  });

  it('ignores unused membership and equal fresh state wrappers while preserving the canonical state key', () => {
    const f = fixture();
    const membership = f.membership.map((entry) => ({
      ...entry,
      renderState: { cullMode: 'back' as const, frontFace: 'ccw' as const },
    }));
    const first = f.update(claims(membership));
    const unused = { ...membership[0], worldEntity: 999 } as ShadowCasterMembership;
    const rematerialized = f.update(
      claims(
        [
          ...membership.map((entry) => ({ ...entry, renderState: { ...entry.renderState } })),
          unused,
        ].reverse(),
      ),
    );
    expect(f.owner.lastWork.projectedBatches).toBe(0);
    expect(rematerialized.plan.batches[0]?.candidates).toBe(first.plan.batches[0]?.candidates);
    // The reference group key retains POD property order; preserve its exact
    // split/merge behavior even when the GPU raster state is equivalent.
    f.update(
      claims(
        membership.map((entry, index) =>
          index === 0 ? { ...entry, renderState: { frontFace: 'ccw', cullMode: 'back' } } : entry,
        ),
      ),
    );
    expect(f.owner.lastWork.projectedBatches).toBe(2);
  });

  it('distinguishes legacy entry absence from an explicit entry with no shader for LOD crossfade', () => {
    const f = fixture();
    const drawKeys = new Set(
      f.membership.map(
        (entry) =>
          `${entry.worldEntity}:${entry.materialHandle}:${entry.drawItemIndex}:${entry.passIndex}`,
      ),
    );
    const legacy = new ShadowClaimTable(drawKeys, undefined);
    const original = f.update(legacy);
    expect(original.plan.batches.every((batch) => batch.lod?.crossfade === true)).toBe(true);
    f.update(claims(f.membership));
    expect(f.owner.lastWork.projectedBatches).toBe(0);
    const noShader = f.membership.map(({ materialShaderId: _shader, ...entry }) => entry);
    const hard = f.update(claims(noShader));
    expect(f.owner.lastWork.projectedBatches).toBe(3);
    expect(hard.plan.batches.every((batch) => batch.lod?.crossfade !== true)).toBe(true);
    f.update(legacy);
    expect(f.owner.lastWork.projectedBatches).toBe(3);
    f.update(undefined);
    expect(f.owner.lastWork.projectedBatches).toBe(3);
    f.update(legacy);
    expect(f.owner.lastWork.projectedBatches).toBe(3);
  });

  it.each([
    'group-key',
    'batches',
  ])('clears partial contributions when %s fails before accepting new claims', (failurePart) => {
    const f = fixture();
    const originalClaims = claims(f.membership);
    const first = f.update(originalClaims);
    const changedClaims = claims(
      f.membership.map((entry, index) =>
        index === 0 ? { ...entry, renderState: { cullMode: 'front' } } : entry,
      ),
    );
    expect(() =>
      f.owner.update(
        f.prepared,
        'retained-binding-authority',
        changedClaims,
        undefined,
        (part, action) => {
          const value = action();
          if (part === failurePart) throw Error('shadow projection interrupted');
          return value;
        },
      ),
    ).toThrow('shadow projection interrupted');
    expect(Reflect.get(f.owner, 'contributions').size).toBe(0);
    expect(Reflect.get(f.owner, 'merged').size).toBe(0);
    const recovered = f.update(originalClaims);
    expectFilteredPlanContent(recovered, first);
    expect(recovered.plan.batches[0]?.generation).not.toBe(first.plan.batches[0]?.generation);
    expect(f.owner.lastWork.projectedBatches).toBe(3);
    f.update(changedClaims);
    expect(f.owner.lastWork.projectedBatches).toBe(2);
  });
});
