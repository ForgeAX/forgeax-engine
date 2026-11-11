import { describe, expect, it } from 'vitest';
import type { GpuDrivenBatch, SubmissionPlan } from '../gpu-driven/batch-topology';
import { ShadowPlanChanges } from '../gpu-driven/shadow-plan-changes';
import { changedPrimitives, type ShadowPreparationCounters } from '../gpu-driven/shadow-views';
import type { GpuScene } from '../gpu-scene';
import type { SceneContentCursor } from '../gpu-scene-content-boxes';

function batch(id: number, first: number, count: number, materialSlot = 0): GpuDrivenBatch {
  return Object.freeze({
    batchId: id,
    generation: 1,
    visibleBase: id * 64,
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

function countingChanges() {
  const calls = { compare: 0 };
  const changes = new ShadowPlanChanges<ShadowPreparationCounters>((previous, next, out, work) => {
    calls.compare++;
    changedPrimitives(previous, next, out, work);
  });
  return { changes, calls };
}

function fakeScene() {
  const journal = {};
  const state = { cursor: { journal, position: 0 } as unknown as SceneContentCursor, reads: 0 };
  const scene = {
    get contentCursor() {
      return state.cursor;
    },
    slotBoundsSince(_since: SceneContentCursor, slots: Iterable<number>) {
      state.reads++;
      return new Float32Array([...slots].flatMap((slot) => [slot, 0, 0, slot + 1, 1, 1]));
    },
  } as unknown as GpuScene;
  const sync = () => {
    state.cursor = { journal, position: 1 } as unknown as SceneContentCursor;
  };
  return { scene, state, sync };
}

describe('shadow plan-pair changes', () => {
  it('compares one retained/next plan pair once for every view that shares it', () => {
    const { changes, calls } = countingChanges();
    const retained = plan([batch(0, 0, 4), batch(1, 4, 4)]);
    const next = plan([batch(0, 0, 4), batch(1, 4, 4, 1)]);
    const first = changes.between(retained, next);
    expect([...first]).toEqual([4, 5, 6, 7]);
    expect(changes.between(retained, next)).toBe(first);
    expect(calls.compare).toBe(1);
  });

  it('compares again for a new next plan, a new retained plan, or after clear', () => {
    const { changes, calls } = countingChanges();
    const retained = plan([batch(0, 0, 4)]);
    const next = plan([batch(0, 0, 4, 1)]);
    const changed = changes.between(retained, next);
    expect([...changes.between(retained, plan([batch(0, 0, 4)]))]).toEqual([]);
    expect([...changes.between(next, retained)]).toEqual([...changed]);
    expect(calls.compare).toBe(3);
    changes.clear();
    expect(changes.between(retained, next)).not.toBe(changed);
    expect(calls.compare).toBe(4);
  });

  it('reads the bounds of one change set once per scene sync and retained cursor', () => {
    const { changes } = countingChanges();
    const { scene, state, sync } = fakeScene();
    const changed = changes.between(plan([batch(0, 0, 2)]), plan([batch(0, 0, 2, 1)]));
    const since = state.cursor;
    const bounds = changes.boundsSince(scene, since, changed);
    expect(changes.boundsSince(scene, since, changed)).toBe(bounds);
    expect(state.reads).toBe(1);
    sync();
    expect(changes.boundsSince(scene, since, changed)).not.toBe(bounds);
    expect(state.reads).toBe(2);
    const later = state.cursor;
    changes.boundsSince(scene, later, changed);
    expect(state.reads).toBe(3);
    const other = fakeScene();
    changes.boundsSince(other.scene, later, changed);
    expect(other.state.reads).toBe(1);
    expect(state.reads).toBe(3);
  });
});
