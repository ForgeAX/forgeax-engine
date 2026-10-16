import { describe, expect, it } from 'vitest';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import type { PreparedProductionPlan } from '../gpu-driven/production-raster-prepare';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';

const tokens = (p: ReturnType<FilteredPlanContributionOwner['update']>) =>
  p.plan.batches.map((batch) =>
    batch.candidates.map((candidate) => `${candidate.primitiveIndex}:${candidate.instanceOrdinal}`),
  );

function freezeOwnedTopology(p: PreparedProductionPlan): void {
  for (const row of p.batchRows) {
    for (const draws of row.facts.values()) {
      for (const fact of draws.values()) {
        const lod = fact?.lod;
        if (lod === undefined) continue;
        lod.ranges?.forEach((range) => {
          if (range !== undefined) Object.freeze(range);
        });
        if (lod.ranges !== undefined) Object.freeze(lod.ranges);
        Object.freeze(lod);
      }
    }
  }
  for (const batch of p.source.batches) {
    Object.freeze(batch.key);
    batch.candidates.forEach(Object.freeze);
    Object.freeze(batch.candidates);
    if (batch.prepared !== undefined) {
      Object.freeze(batch.prepared.identity);
      Object.freeze(batch.prepared);
    }
    if (batch.lod !== undefined) {
      Object.freeze(batch.lod.coverages);
      batch.lod.ranges?.forEach((range) => {
        if (range !== undefined) Object.freeze(range);
      });
      if (batch.lod.ranges !== undefined) Object.freeze(batch.lod.ranges);
      Object.freeze(batch.lod);
    }
    Object.freeze(batch);
  }
}

// Fixed output witnesses deliberately avoid using the refactored full helper
// as the only oracle: it now shares its group-building implementation.
describe('independent filtered contribution publication boundaries', () => {
  it('rebases source windows while preserving fixed canonical members and output prefixes', () => {
    const f = createFilterPlanFixture();
    const p = f.prepare();
    freezeOwnedTopology(p);
    const owner = new FilteredPlanContributionOwner();
    const first = owner.update(p, 'current-combined-artifacts', undefined, f.bindings);
    const rebasedRows = p.batchRows.map((row) => ({
      ...row,
      source: {
        ...row.source,
        visibleBase: row.source.visibleBase + 1024,
        indirectOffset: row.source.indirectOffset + 800,
      },
    }));
    const rebased: PreparedProductionPlan = {
      ...p,
      source: {
        ...p.source,
        revision: p.source.revision + 1,
        batches: rebasedRows.map((r) => r.source),
      },
      batchRows: rebasedRows,
    };
    const value = owner.update(rebased, 'current-combined-artifacts', undefined, f.bindings);
    expect(owner.lastWork.projectedBatches).toBe(0);
    expect(tokens(value)).toEqual([
      ['2:0', '0:0', '2:1', '0:1'],
      ['1:0', '1:1'],
    ]);
    expect(value.batches.map((row) => row.primitiveSlot)).toEqual([2, 1]);
    expect(value.plan.batches.map((batch) => [batch.visibleBase, batch.indirectOffset])).toEqual([
      [0, 0],
      [32, 40],
    ]);
    expect(value.plan.revision).toBe(p.source.revision + 1);
    expect(value.plan.batches[0]?.candidates).toBe(first.plan.batches[0]?.candidates);
    expect(value.plan.batches[1]?.candidates).toBe(first.plan.batches[1]?.candidates);
    expect(value.batches[0]).toBe(first.batches[0]);
    expect(value.batches[1]).toBe(first.batches[1]);
  });

  it('rebuilds only the affected merged group when one immutable contribution changes', () => {
    const f = createFilterPlanFixture();
    const p = f.prepare();
    freezeOwnedTopology(p);
    const owner = new FilteredPlanContributionOwner();
    const first = owner.update(p, 'current-combined-artifacts', undefined, f.bindings);
    const rows = p.batchRows.map((row, index) =>
      index === 1 ? { ...row, facts: new Map(row.facts) } : row,
    );
    const next = { ...p, batchRows: rows };
    const changed = owner.update(next, 'current-combined-artifacts', undefined, f.bindings);
    expect(owner.lastWork.projectedBatches).toBe(1);
    expect(tokens(changed)).toEqual(tokens(first));
    expect(changed.batches[0]).not.toBe(first.batches[0]);
    expect(changed.batches[1]).toBe(first.batches[1]);
    expect(changed.plan.batches.map((batch) => [batch.visibleBase, batch.indirectOffset])).toEqual(
      first.plan.batches.map((batch) => [batch.visibleBase, batch.indirectOffset]),
    );
  });

  it('releases retained assembly under complete churn and recovers stable reuse', () => {
    const f = createFilterPlanFixture();
    const p = f.prepare();
    freezeOwnedTopology(p);
    const owner = new FilteredPlanContributionOwner();
    const initial = owner.update(p, 'current-combined-artifacts', undefined, f.bindings);
    const changed = {
      ...p,
      batchRows: p.batchRows.map((row) => ({ ...row, facts: new Map(row.facts) })),
    };
    const value = owner.update(changed, 'current-combined-artifacts', undefined, f.bindings);
    expect(owner.lastWork.projectedBatches).toBe(3);
    expect(tokens(value)).toEqual(tokens(initial));
    expect(Reflect.get(owner, 'publication')).toMatchObject({ value });
    const merged = Reflect.get(owner, 'merged') as Map<string, { batch?: unknown }>;
    expect([...merged.values()].every((entry) => entry.batch === undefined)).toBe(true);
    const settled = owner.update(changed, 'current-combined-artifacts', undefined, f.bindings);
    expect(owner.lastWork.projectedBatches).toBe(0);
    expect(tokens(settled)).toEqual(tokens(initial));
    expect(owner.update(changed, 'current-combined-artifacts', undefined, f.bindings)).toBe(
      settled,
    );
  });

  it('drops all retired IDs and merged parts rather than resurrecting an empty publication', () => {
    const f = createFilterPlanFixture();
    const p = f.prepare();
    const owner = new FilteredPlanContributionOwner();
    const first = owner.update(p, 'current-combined-artifacts', undefined, f.bindings);
    const empty: PreparedProductionPlan = {
      ...p,
      source: { ...p.source, batches: [], candidateCount: 0, visibleCapacity: 0 },
      batchRows: [],
      drawKeys: new Set(),
    };
    expect(
      owner.update(empty, 'current-combined-artifacts', undefined, f.bindings).plan.batches,
    ).toEqual([]);
    const reinserted = owner.update(p, 'current-combined-artifacts', undefined, f.bindings);
    expect(owner.lastWork.projectedBatches).toBe(3);
    expect(tokens(reinserted)).toEqual([
      ['2:0', '0:0', '2:1', '0:1'],
      ['1:0', '1:1'],
    ]);
    expect(reinserted.plan.batches[0]?.candidates).not.toBe(first.plan.batches[0]?.candidates);
    owner.clear();
    owner.update(p, 'current-combined-artifacts', undefined, f.bindings);
    expect(owner.lastWork.projectedBatches).toBe(3);
    expect(tokens(first)).toEqual([
      ['2:0', '0:0', '2:1', '0:1'],
      ['1:0', '1:1'],
    ]);
  });

  it('does not retain historical contributions after repeated failed projections', () => {
    const f = createFilterPlanFixture();
    const p = f.prepare();
    const owner = new FilteredPlanContributionOwner();
    const first = owner.update(p, 'current-combined-artifacts', undefined, f.bindings);
    for (let attempt = 1; attempt <= 4; attempt++) {
      const rows = p.batchRows.map((row, index) => ({
        ...row,
        source: { ...row.source, batchId: attempt * 100 + index },
      }));
      const next = {
        ...p,
        source: { ...p.source, batches: rows.map((r) => r.source) },
        batchRows: rows,
      };
      let keys = 0;
      expect(() =>
        owner.update(next, 'current-combined-artifacts', undefined, f.bindings, (part, action) => {
          if (part === 'group-key' && ++keys === 3) throw Error('controlled projection failure');
          return action();
        }),
      ).toThrow('controlled projection failure');
      // White-box storage bound, not a new inspection/public API.
      expect((Reflect.get(owner, 'contributions') as Map<number, unknown>).size).toBe(0);
      expect((Reflect.get(owner, 'merged') as Map<string, unknown>).size).toBe(0);
      expect(tokens(first)).toEqual([
        ['2:0', '0:0', '2:1', '0:1'],
        ['1:0', '1:1'],
      ]);
    }
    const recovered = owner.update(p, 'current-combined-artifacts', undefined, f.bindings);
    expect(owner.lastWork.projectedBatches).toBe(3);
    expect(tokens(recovered)).toEqual(tokens(first));
  });
});
