import { describe, expect, it } from 'vitest';
import {
  buildBatchAlignedSubmission,
  buildSubmissionCandidateMembership,
  type GpuDrivenBatch,
  type SubmissionPlan,
} from '../gpu-driven/batch-topology';
import { fixedTaskPlan, hasFixedTaskHeaders } from '../gpu-driven/fixed-task-plan';
import { changedPrimitives, type ShadowPreparationCounters } from '../gpu-driven/shadow-views';

function batch(id: number, first: number, count: number, materialSlot = 0): GpuDrivenBatch {
  return Object.freeze({
    batchId: id,
    generation: 1,
    visibleBase: id * Math.ceil(count / 64) * 64,
    visibleCapacity: count,
    indirectOffset: id * 20,
    contentEpoch: 0,
    key: Object.freeze({
      assetHandle: 0,
      drawKind: 'indexed' as const,
      first: 0,
      count: 3,
      baseVertex: 0,
      materialSlot,
      topology: 'triangle-list' as const,
      pipelineClass: 'fixture',
      materialResourceClass: 'fixture',
    }),
    candidates: Object.freeze(
      Array.from({ length: count }, (_, offset) =>
        Object.freeze({
          primitiveIndex: first + offset,
          generation: 1,
          drawItemIndex: 0,
          instanceOrdinal: 0,
        }),
      ),
    ),
  });
}

function plan(batches: readonly GpuDrivenBatch[]): SubmissionPlan {
  return Object.freeze({
    revision: 1,
    batches: Object.freeze([...batches]),
    candidateCount: batches.reduce((count, row) => count + row.candidates.length, 0),
    visibleCapacity: batches.reduce(
      (maximum, row) => Math.max(maximum, row.visibleBase + row.visibleCapacity),
      0,
    ),
  });
}

function counters(): ShadowPreparationCounters {
  return {
    cacheHits: 0,
    cacheRebuilds: 0,
    cacheRebuildReasons: {},
    layerSlotVisits: 0,
    layerBatchSelections: 0,
    layerBatchPatches: 0,
    planComparisons: 0,
    batchChecks: 0,
    candidateScans: 0,
    primitiveChecks: 0,
  };
}

describe('shadow preparation on retained topology', () => {
  it('reobserves mutable candidate values even when aligned headers are fixed', () => {
    const row = batch(1, 0, 1);
    const original = row.candidates.at(0);
    if (original === undefined) throw new Error('Missing candidate');
    const mutable = { ...original };
    const source = buildBatchAlignedSubmission(
      fixedTaskPlan(plan([row])),
      new Map([[row.batchId, [mutable]]]),
    );
    expect(hasFixedTaskHeaders(source)).toBe(true);
    expect(buildSubmissionCandidateMembership(source).byPrimitiveIndex.has(0)).toBe(true);
    mutable.primitiveIndex = 7;
    const current = buildSubmissionCandidateMembership(source);
    expect(current.byPrimitiveIndex.has(0)).toBe(false);
    expect(current.byPrimitiveIndex.get(7)?.[0]?.candidate).toBe(mutable);
  });

  it('builds submission membership from its actual batch values', () => {
    const row = batch(1, 0, 64),
      source = plan([row]);
    const membership = buildSubmissionCandidateMembership(source);
    expect(buildSubmissionCandidateMembership(source)).not.toBe(membership);
    expect(membership.byPrimitiveIndex.get(4)?.[0]?.batch).toBe(row);
    expect(membership.byPrimitiveIndex.get(4)?.[0]?.candidate).toBe(row.candidates.at(4));
  });

  it('checks only candidates of the edited batch, retaining a large unchanged scene', () => {
    const rows = Array.from({ length: 80 }, (_, index) => batch(index, index * 64, 64));
    const before = plan(rows),
      nextRows = [...rows];
    nextRows[40] = batch(40, 40 * 64, 64, 1);
    const work = counters(),
      changed = new Set<number>();
    changedPrimitives(before, plan(nextRows), changed, work);
    expect([...changed]).toEqual(Array.from({ length: 64 }, (_, index) => 40 * 64 + index));
    expect(work.candidateScans).toBe(256);
    expect(work.primitiveChecks).toBe(64);
    expect(before.candidateCount).toBe(5120);
  });

  it('retains all batches across a fresh plan wrapper without scanning their candidates', () => {
    const rows = [batch(1, 0, 64), batch(2, 64, 64)],
      work = counters();
    const changed = new Set<number>();
    changedPrimitives(plan(rows), plan(rows), changed, work);
    expect(changed.size).toBe(0);
    expect(work.candidateScans).toBe(0);
  });

  it('detects equal-count slot generation changes and removed or added casters', () => {
    const first = batch(1, 0, 2),
      changed = new Set<number>();
    const one = first.candidates.at(0),
      two = first.candidates.at(1);
    if (one === undefined || two === undefined) throw Error('Missing fixture candidates');
    const replacement = Object.freeze({
      ...first,
      candidates: Object.freeze([
        { ...one, generation: 2 },
        { ...two, primitiveIndex: 7 },
      ]),
    });
    changedPrimitives(plan([first]), plan([replacement]), changed);
    expect([...changed].sort((a, b) => a - b)).toEqual([0, 1, 7]);
  });

  it('preserves other draws of a primitive shared across batches', () => {
    const stable = batch(1, 0, 2),
      edited = batch(2, 1, 2);
    const changed = new Set<number>();
    changedPrimitives(plan([stable, edited]), plan([stable, batch(2, 1, 2, 1)]), changed);
    expect([...changed]).toEqual([1, 2]);
    changed.clear();
    changedPrimitives(plan([stable, edited]), plan([stable]), changed);
    expect([...changed]).toEqual([1, 2]);
  });
});
