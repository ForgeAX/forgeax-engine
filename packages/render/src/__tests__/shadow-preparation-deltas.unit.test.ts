import { describe, expect, it } from 'vitest';
import {
  buildSubmissionCandidateMembership,
  type GpuDrivenBatch,
  type SubmissionPlan,
} from '../gpu-driven/batch-topology';
import { changedPrimitives, type ShadowPreparationCounters } from '../gpu-driven/shadow-views';

function batch(id: number, first: number, count: number, materialSlot = 0): GpuDrivenBatch {
  return Object.freeze({
    batchId: id,
    key: Object.freeze({ materialSlot }),
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
  }) as GpuDrivenBatch;
}

function plan(batches: readonly GpuDrivenBatch[]): SubmissionPlan {
  return Object.freeze({
    revision: 1,
    batches: Object.freeze([...batches]),
    candidateCount: batches.reduce((count, row) => count + row.candidates.length, 0),
    visibleCapacity: 0,
  });
}

function counters(): ShadowPreparationCounters {
  return {
    cacheHits: 0,
    cacheRebuilds: 0,
    cacheRebuildReasons: {},
    membershipBuilds: 0,
    membershipCandidateScans: 0,
    planComparisons: 0,
    batchChecks: 0,
    candidateScans: 0,
    primitiveChecks: 0,
  };
}

describe('shadow preparation on retained topology', () => {
  it('shares the submission membership and references its actual batch', () => {
    const row = batch(1, 0, 64),
      source = plan([row]);
    const membership = buildSubmissionCandidateMembership(source);
    expect(buildSubmissionCandidateMembership(source)).toBe(membership);
    expect(membership.byPrimitiveIndex.get(4)?.[0]?.batch).toBe(row);
    expect(membership.byPrimitiveIndex.get(4)?.[0]?.candidate).toBe(row.candidates[4]);
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
    expect(work.membershipCandidateScans).toBe(0);
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
    const one = first.candidates[0],
      two = first.candidates[1];
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
