import { describe, expect, it, vi } from 'vitest';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { materialBindingKey } from '../gpu-driven/material-bindings';
import { filteredPlan } from '../gpu-driven/production-raster-prepare';
import { ShadowClaimTable } from '../gpu-driven/shadow-claims';
import type { ShadowCasterMembership } from '../render-system-extract';
import {
  expectFilteredPlanContent as compare,
  createFilterPlanFixture,
} from './gpu-driven-filter-plan-fixture';

describe('incremental source-batch filtered contributions', () => {
  it('does not allocate or prune a live-ID set for the same accepted immutable roster', () => {
    const f = createFilterPlanFixture();
    const prepared = f.prepare();
    const owner = new FilteredPlanContributionOwner();
    const accepted = owner.update(prepared, 'immutable-source-facts', undefined, f.bindings);
    const retained = owner as unknown as { contributions: Map<number, unknown> };
    const keys = vi.spyOn(retained.contributions, 'keys');
    const NativeSet = globalThis.Set;
    let allocations = 0;
    let pruneCalls = 0;
    let current = accepted;
    class CountedSet<T> extends NativeSet<T> {
      constructor(values?: Iterable<T> | null) {
        super(values);
        allocations++;
      }
    }
    try {
      globalThis.Set = CountedSet;
      for (let frame = 0; frame < 12; frame++) {
        current = owner.update({ ...prepared }, 'immutable-source-facts', undefined, f.bindings);
      }
    } finally {
      globalThis.Set = NativeSet;
      pruneCalls = keys.mock.calls.length;
      keys.mockRestore();
    }
    expect(current).toBe(accepted);
    expect(allocations).toBe(0);
    expect(pruneCalls).toBe(0);
    // The accepted roster does not make material bindings immutable.
    f.bindings.set(materialBindingKey(defined(f.slots[0]).snapshot, 100), 'changed');
    compare(
      owner.update(prepared, 'immutable-source-facts', undefined, f.bindings),
      filteredPlan(prepared, undefined, f.bindings),
    );
    expect(owner.lastWork.projectedBatches).toBe(2);
  });

  it('fully observes mutable raw IDs after withdrawing the immutable scope', () => {
    const f = createFilterPlanFixture();
    const prepared = f.prepare();
    const owner = new FilteredPlanContributionOwner();
    owner.update(prepared, 'immutable-source-facts', undefined, f.bindings);
    let id = defined(prepared.batchRows[1]).source.batchId;
    let reads = 0;
    Object.defineProperty(defined(prepared.batchRows[0]).source, 'batchId', {
      configurable: true,
      get() {
        reads++;
        return id;
      },
    });
    for (const nextId of [id, 9001, id]) {
      id = nextId;
      const before = reads;
      const current = owner.update(prepared, undefined, undefined, f.bindings);
      expect(reads).toBeGreaterThan(before);
      compare(current, filteredPlan(prepared, undefined, f.bindings));
      expect(owner.lastWork.projectedBatches).toBe(prepared.batchRows.length);
    }
  });

  it('keeps the full result while skipping unchanged contributions and reusing unaffected merged candidates', () => {
    const f = createFilterPlanFixture(),
      p = f.prepare(),
      owner = new FilteredPlanContributionOwner();
    let keys = 0;
    let assemblies = 0;
    const profile = <T>(part: 'groups' | 'group-key' | 'batches', action: () => T) => {
      if (part === 'group-key') keys++;
      if (part === 'batches') assemblies++;
      return action();
    };
    const original = owner.update(p, 'current-artifact-values', undefined, f.bindings, profile);
    compare(original, filteredPlan(p, undefined, f.bindings));
    expect(owner.lastWork).toMatchObject({ projectedBatches: 3, projectedCandidates: 6 });
    expect(keys).toBe(6);
    keys = 0;
    assemblies = 0;
    const unchanged = owner.update(
      { ...p },
      'current-artifact-values',
      undefined,
      f.bindings,
      profile,
    );
    compare(unchanged, filteredPlan(p, undefined, f.bindings));
    expect(owner.lastWork).toMatchObject({
      projectedBatches: 0,
      projectedCandidates: 0,
      copiedCandidates: 0,
      reusedGroups: 2,
    });
    expect(keys).toBe(0);
    expect(assemblies).toBe(0);
    expect(unchanged).toBe(original);
    expect(unchanged.plan.batches[0]?.candidates).toBe(original.plan.batches[0]?.candidates);
    // Simulate one re-derived batch after a mesh revision. Immutable row facts
    // are new even though material keys and instance addresses are unchanged.
    const dirty = {
      ...p,
      batchRows: p.batchRows.map((row, index) =>
        index === 1 ? { ...row, facts: new Map(row.facts) } : row,
      ),
    };
    const changed = owner.update(dirty, 'current-artifact-values', undefined, f.bindings, profile);
    compare(changed, filteredPlan(dirty, undefined, f.bindings));
    expect(owner.lastWork).toMatchObject({
      projectedBatches: 1,
      projectedCandidates: 2,
      copiedCandidates: 4,
      reusedGroups: 1,
    });
    expect(keys).toBe(2);
    expect(changed.plan.batches[1]?.candidates).toBe(original.plan.batches[1]?.candidates);
    expect(original.plan.batches[0]?.candidates).toHaveLength(4);
  });

  it('updates publication revision and current main ownership without assembling unchanged batches', () => {
    const f = createFilterPlanFixture();
    const p = f.prepare();
    const owner = new FilteredPlanContributionOwner();
    const original = owner.update(p, 'values', undefined, f.bindings);
    const changed = {
      ...p,
      source: { ...p.source, revision: p.source.revision + 1 },
      drawKeys: new Set(p.drawKeys),
    };
    let assemblies = 0;
    const updated = owner.update(changed, 'values', undefined, f.bindings, (part, action) => {
      if (part === 'batches') assemblies++;
      return action();
    });
    compare(updated, filteredPlan(changed, undefined, f.bindings));
    expect(assemblies).toBe(0);
    expect(updated.plan.batches).toBe(original.plan.batches);
    expect(updated.batches).toBe(original.batches);
    expect(updated.materialBatches).toBe(original.materialBatches);
    expect(updated.drawKeys).toBe(changed.drawKeys);
    expect(updated.plan.revision).toBe(changed.source.revision);
    expect(original.plan.revision).toBe(p.source.revision);
    expect(original.drawKeys).toBe(p.drawKeys);
    expect(owner.update({ ...changed }, 'values', undefined, f.bindings)).toBe(updated);
  });

  it('checks current binding values without relying on mutable Map identity', () => {
    const f = createFilterPlanFixture(),
      p = f.prepare(),
      owner = new FilteredPlanContributionOwner();
    owner.update(p, 'program-values', undefined, f.bindings);
    const key = materialBindingKey(defined(f.slots[0]).snapshot, 100);
    f.bindings.set(key, 'C');
    compare(
      owner.update(p, 'program-values', undefined, f.bindings),
      filteredPlan(p, undefined, f.bindings),
    );
    expect(owner.lastWork).toMatchObject({ projectedBatches: 2, projectedCandidates: 4 });
    f.bindings.set(key, 'A');
    compare(
      owner.update(p, 'program-values', undefined, f.bindings),
      filteredPlan(p, undefined, f.bindings),
    );
    expect(owner.lastWork.projectedBatches).toBe(2);
    f.bindings.delete(key);
    compare(
      owner.update(p, 'program-values', undefined, f.bindings),
      filteredPlan(p, undefined, f.bindings),
    );
  });

  it('retains admitted default bindings across empty and CPU-only publications', () => {
    const f = createFilterPlanFixture(),
      p = f.prepare(),
      owner = new FilteredPlanContributionOwner();
    const original = owner.update(p, 'program-values', undefined, new Map<string, string>());
    for (const bindings of [
      new Map<string, string>(),
      new Map([['99:9001:0', 'forward|probe:']]),
    ]) {
      const next = owner.update(p, 'program-values', undefined, bindings);
      compare(next, filteredPlan(p, undefined, bindings));
      expect(owner.lastWork.projectedBatches).toBe(0);
      expect(next).toBe(original);
    }
  });

  it('preserves absent-map observations and admits binding-key errors before publishing', () => {
    const f = createFilterPlanFixture(),
      p = f.prepare(),
      owner = new FilteredPlanContributionOwner();
    const draws = defined([...defined(p.batchRows[0]).facts.values()][0]);
    const fact = defined(draws.values().next().value);
    const material = fact.material;
    const descriptor = defined(Object.getOwnPropertyDescriptor(material, 'materialHandle'));
    const fault = Error('first binding key read');
    let reads = 0;
    Object.defineProperty(material, 'materialHandle', {
      configurable: true,
      get() {
        reads++;
        throw fault;
      },
    });
    const absent = owner.update(p, 'program-values');
    expect(owner.update(p, 'program-values')).toBe(absent);
    expect(reads).toBe(0);
    let caught: unknown;
    try {
      owner.update(p, 'program-values', undefined, new Map());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(fault);
    expect(reads).toBe(1);
    Object.defineProperty(material, 'materialHandle', descriptor);
    const retry = owner.update(p, 'program-values', undefined, new Map());
    compare(retry, filteredPlan(p, undefined, new Map()));
    expect(owner.lastWork.projectedBatches).toBe(p.batchRows.length);
    expect(owner.update(p, 'program-values', undefined, new Map())).toBe(retry);
  });

  it('admits absent-to-default binding keys once and retains later CPU-only changes', () => {
    const f = createFilterPlanFixture(),
      p = f.prepare();
    const owner = new FilteredPlanContributionOwner();
    owner.update(p, 'program-values');
    const admitted = owner.update(p, 'program-values', undefined, new Map());
    expect(owner.lastWork.projectedBatches).toBe(p.batchRows.length);
    expect(
      owner.update(p, 'program-values', undefined, new Map([['99:9001:1', 'forward|probe:']])),
    ).toBe(admitted);
    expect(owner.lastWork.projectedBatches).toBe(0);
    const absent = owner.update(p, 'program-values');
    compare(absent, filteredPlan(p));
    expect(owner.lastWork.projectedBatches).toBe(p.batchRows.length);
    expect(owner.update(p, 'program-values')).toBe(absent);
  });

  it('observes consumed bindings first published after an absent map and their removal', () => {
    const f = createFilterPlanFixture(),
      p = f.prepare(),
      owner = new FilteredPlanContributionOwner();
    owner.update(p, 'program-values');
    const key = materialBindingKey(defined(f.slots[0]).snapshot, 100);
    for (const bindings of [new Map([[key, 'C']]), undefined]) {
      const changed = owner.update(p, 'program-values', undefined, bindings);
      compare(changed, filteredPlan(p, undefined, bindings));
      // Adding/removing the map changes which binding keys are observed.
      expect(owner.lastWork).toMatchObject({
        projectedBatches: p.batchRows.length,
        projectedCandidates: p.source.candidateCount,
      });
      expect(owner.update(p, 'program-values', undefined, bindings)).toBe(changed);
      expect(owner.lastWork.projectedBatches).toBe(0);
    }
  });

  it('preserves representative and prefix order through deletion, reorder, reuse and LOD changes', () => {
    const f = createFilterPlanFixture(),
      p = f.prepare(),
      owner = new FilteredPlanContributionOwner();
    owner.update(p, 'values', undefined, f.bindings);
    // Reorder retained rows as well as source; first occurrences are not a sorted-key order.
    const reverse = {
      ...p,
      source: { ...p.source, batches: [...p.source.batches].reverse() },
      batchRows: [...p.batchRows].reverse(),
    };
    compare(
      owner.update(reverse, 'values', undefined, f.bindings),
      filteredPlan(reverse, undefined, f.bindings),
    );
    expect(owner.lastWork.projectedBatches).toBe(0);
    const removed = {
      ...reverse,
      source: { ...reverse.source, batches: reverse.source.batches.slice(1) },
      batchRows: reverse.batchRows.slice(1),
    };
    compare(
      owner.update(removed, 'values', undefined, f.bindings),
      filteredPlan(removed, undefined, f.bindings),
    );
    compare(
      owner.update(p, 'values', undefined, f.bindings),
      filteredPlan(p, undefined, f.bindings),
    );
    expect(owner.lastWork.projectedBatches).toBe(1);
    const row = defined(p.batchRows[0]);
    const lodChanged = {
      ...row,
      facts: new Map(
        [...row.facts].map(([primitive, draws]) => [
          primitive,
          new Map(
            [...draws].map(([draw, fact]) => [
              draw,
              fact === undefined ? undefined : { ...fact, lod: { coverages: [1], ranges: [] } },
            ]),
          ),
        ]),
      ),
    };
    const next = { ...p, batchRows: [lodChanged, ...p.batchRows.slice(1)] };
    compare(
      owner.update(next, 'values', undefined, f.bindings),
      filteredPlan(next, undefined, f.bindings),
    );
  });

  it('rebases output windows but reprojects changed membership and reused batch generations', () => {
    const f = createFilterPlanFixture(),
      p = f.prepare(),
      owner = new FilteredPlanContributionOwner();
    owner.update(p, 'values', undefined, f.bindings);
    const rebasedRows = p.batchRows.map((row, index) => ({
      ...row,
      source: {
        ...row.source,
        visibleBase: 1000 + index * 64,
        indirectOffset: 2000 + index * 20,
      },
    }));
    const rebased = {
      ...p,
      source: {
        ...p.source,
        revision: p.source.revision + 1,
        batches: rebasedRows.map((row) => row.source),
      },
      batchRows: rebasedRows,
    };
    compare(
      owner.update(rebased, 'values', undefined, f.bindings),
      filteredPlan(rebased, undefined, f.bindings),
    );
    expect(owner.lastWork.projectedBatches).toBe(0);
    const first = defined(rebasedRows[0]);
    const changedRow = {
      ...first,
      source: { ...first.source, candidates: [...first.source.candidates].reverse() },
    };
    const changed = {
      ...rebased,
      batchRows: [changedRow, ...rebasedRows.slice(1)],
      source: {
        ...rebased.source,
        batches: [changedRow.source, ...rebased.source.batches.slice(1)],
      },
    };
    compare(
      owner.update(changed, 'values', undefined, f.bindings),
      filteredPlan(changed, undefined, f.bindings),
    );
    expect(owner.lastWork.projectedBatches).toBe(1);
    const generationRow = {
      ...changedRow,
      source: { ...changedRow.source, generation: changedRow.source.generation + 1 },
    };
    const generation = {
      ...changed,
      batchRows: [generationRow, ...changed.batchRows.slice(1)],
      source: {
        ...changed.source,
        batches: [generationRow.source, ...changed.source.batches.slice(1)],
      },
    };
    compare(
      owner.update(generation, 'values', undefined, f.bindings),
      filteredPlan(generation, undefined, f.bindings),
    );
    expect(owner.lastWork.projectedBatches).toBe(1);
    const worlds = { ...generation, worldKeys: [7, 8] };
    compare(
      owner.update(worlds, 'values', undefined, f.bindings),
      filteredPlan(worlds, undefined, f.bindings),
    );
    expect(owner.lastWork.projectedBatches).toBe(3);
  });

  it('does not serialize projection keys twice for cold or entirely changed unique contributions', () => {
    const f = createFilterPlanFixture(),
      p = f.prepare(),
      owner = new FilteredPlanContributionOwner();
    for (const [index, slot] of f.slots.entries()) {
      f.bindings.set(
        materialBindingKey(slot.snapshot, slot.snapshot.material.materialHandle ?? -1),
        `unique-${index}`,
      );
    }
    const count = () => {
      let keys = 0;
      return {
        profile: <T>(part: 'groups' | 'group-key' | 'batches', action: () => T) => {
          if (part === 'group-key') keys++;
          return action();
        },
        keys: () => keys,
      };
    };
    for (const next of [
      p,
      { ...p, batchRows: p.batchRows.map((row) => ({ ...row, facts: new Map(row.facts) })) },
    ]) {
      const reference = count(),
        candidate = count();
      compare(
        owner.update(next, 'values', undefined, f.bindings, candidate.profile),
        filteredPlan(next, undefined, f.bindings, reference.profile),
      );
      expect(candidate.keys()).toBe(reference.keys());
      expect(candidate.keys()).toBe(6);
      expect(owner.lastWork.projectedCandidates).toBe(6);
      expect(owner.lastWork.projectedBatches).toBe(3);
    }
  });

  it('clears partial attempts and preserves the previous immutable publication after a projection failure', () => {
    const f = createFilterPlanFixture(),
      p = f.prepare(),
      owner = new FilteredPlanContributionOwner();
    const first = owner.update(p, 'values', undefined, f.bindings);
    const before = first.plan.batches.map((batch) => [...batch.candidates]);
    const changed = {
      ...p,
      batchRows: p.batchRows.map((row) => ({ ...row, facts: new Map(row.facts) })),
    };
    expect(() =>
      owner.update(changed, 'values', undefined, f.bindings, (part, action) => {
        if (part === 'group-key') throw Error('fixture projection failure');
        return action();
      }),
    ).toThrow('fixture projection failure');
    expect(first.plan.batches.map((batch) => [...batch.candidates])).toEqual(before);
    compare(
      owner.update(p, 'values', undefined, f.bindings),
      filteredPlan(p, undefined, f.bindings),
    );
    expect(owner.lastWork.projectedBatches).toBe(3);
  });

  it('requires current shadow/artifact fences and falls back when no authority is supplied', () => {
    const f = createFilterPlanFixture(),
      p = f.prepare(),
      owner = new FilteredPlanContributionOwner();
    const membership: ShadowCasterMembership[] = f.slots.map((slot) => ({
      worldEntity: slot.snapshot.entityKey,
      renderableIndex: slot.slot,
      drawItemIndex: 0,
      materialHandle: slot.snapshot.material.materialHandle ?? -1,
      passIndex: 0,
      gpuDrivenEligible: true,
    }));
    const claims = (values: readonly ShadowCasterMembership[]) =>
      new ShadowClaimTable(undefined, values);
    const first = claims(membership);
    compare(owner.update(p, 'combined-programs|membership-v1', first), filteredPlan(p, first));
    // Equal value authority can reuse contributions across fresh claim wrappers.
    compare(
      owner.update(p, 'combined-programs|membership-v1', claims([...membership])),
      filteredPlan(p, claims(membership)),
    );
    expect(owner.lastWork.projectedBatches).toBe(0);
    const denied = membership.map((row) =>
      row.renderableIndex === 2 ? { ...row, gpuDrivenEligible: false } : row,
    );
    compare(
      owner.update(p, 'combined-programs|membership-v2', claims(denied)),
      filteredPlan(p, claims(denied)),
    );
    expect(owner.lastWork.projectedBatches).toBe(3);
    compare(
      owner.update(p, 'new-shadow-program|membership-v2', claims(denied)),
      filteredPlan(p, claims(denied)),
    );
    expect(owner.lastWork.projectedBatches).toBe(3);
    compare(owner.update(p, undefined, claims(membership)), filteredPlan(p, claims(membership)));
    expect(owner.lastWork.projectedBatches).toBe(3);
    const reusedIds = {
      ...p,
      batchRows: p.batchRows.map((row) => ({ ...row, source: { ...row.source, batchId: 0 } })),
    };
    compare(
      owner.update(reusedIds, 'values', undefined, f.bindings),
      filteredPlan(reusedIds, undefined, f.bindings),
    );
    owner.clear();
    compare(
      owner.update(p, 'values', undefined, f.bindings),
      filteredPlan(p, undefined, f.bindings),
    );
    expect(owner.lastWork.projectedBatches).toBe(3);
  });
});

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw Error('Missing contribution fixture value');
  return value;
}
