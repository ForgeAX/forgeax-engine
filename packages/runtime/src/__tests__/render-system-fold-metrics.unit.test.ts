// feat-20260622-chunk-gpu-instancing-sprite-tilemap M3 / w12 — fold metric
// counter unit tests (AC-06).
//
// Drives the pure helper `incrementFoldedDrawsMetric(plan, metrics)` co-
// located in record/mesh-ssbo.ts: every fold-eligible head bucket
// (bucketSize > 1) in the dispatch plan contributes one
// `metrics.increment('render.instancing.foldedDraws')` call. The helper is
// the SSOT for "how many instanced drawIndexed will this frame emit"; the
// record-stage consumer calls it once per recordFrame after the cap-fallback
// filter (M2 / w11) so cap-overrun buckets — which have been removed from
// the plan — do not contribute to the counter.
//
// Coverage (AC-06):
//   (1) mode-0 fold-eligible plan -> increment count == fold head count.
//   (2) mode-bypass plan (all singletons -> empty headBuckets) -> no
//       increment (per-entity drawIndexed does not count, plan-strategy
//       D-3 "instanced draw call" semantics).
//   (3) cap-fallback filtered plan -> increment count tracks the filtered
//       count, not the pre-filter bucket count (M2 / w11 cap-overrun
//       buckets removed from plan upstream).
//   (4) `metrics.reset()` zeroes the counter; next frame increments start
//       from 1 again (test isolation hook).
//   (5) Multi-bucket plan accumulates correctly (3 head buckets -> +3).
//
// Constraints from plan-strategy §2 D-3 / research F-5 / N-3:
//   - Counter key = `render.instancing.foldedDraws` (verbatim).
//   - Lives on `EngineMetrics` (runtime counter, dot-namespace); does NOT
//     touch schemas/forgeax-metrics.schema.json (N-3: that schema closes the 5
//     CI MetricKind, unrelated to runtime counters).
//   - Semantics: count of instanced drawIndexed emitted this frame; not
//     entity count, not pre-filter bucket count.

import { describe, expect, it, vi } from 'vitest';
import { createEngineMetrics } from '../../../render/src/engine-metrics';
import {
  type FoldBucket,
  type FoldDispatchPlan,
  incrementFoldedDrawsMetric,
} from '../../../render/src/record/mesh-ssbo';
import type { DispatchEntry } from '../../../render/src/render-system-extract';

const METRIC_KEY = 'render.instancing.foldedDraws';

function mockEntry(renderableIndex: number, materialHandle: number, layer: number): DispatchEntry {
  return {
    entityIndex: renderableIndex,
    materialHandle,
    renderableIndex,
    passIndex: 0,
    queue: 3000,
    layer,
    tags: {},
    renderState: undefined,
    defines: undefined,
    vertexEntry: undefined,
    fragmentEntry: undefined,
    materialShaderId: undefined,
    paramSnapshot: undefined,
  };
}

function mockBucket(count: number, materialHandle = 7, layer = 0): FoldBucket {
  const transforms = new Float32Array(count * 16);
  const entries: DispatchEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push(mockEntry(i, materialHandle, layer));
  }
  return { entries, bucketSize: count, transforms, materialHandle, layer, sortKey: 0 };
}

function planFromBuckets(headBuckets: ReadonlyMap<number, FoldBucket>): FoldDispatchPlan {
  let folded = 0;
  for (const b of headBuckets.values()) {
    if (b.bucketSize > 1) folded += 1;
  }
  return { headBuckets, skipIndices: new Set<number>(), foldedBucketCount: folded };
}

describe('M3 / w12 — incrementFoldedDrawsMetric (AC-06)', () => {
  it('fold-eligible plan with 1 head bucket -> metric == 1', () => {
    const metrics = createEngineMetrics();
    const plan = planFromBuckets(new Map([[0, mockBucket(5)]]));

    incrementFoldedDrawsMetric(plan, metrics);

    expect(metrics.snapshot()[METRIC_KEY]).toBe(1);
  });

  it('multi-bucket plan: 3 head buckets -> metric == 3 (accumulation)', () => {
    const metrics = createEngineMetrics();
    const plan = planFromBuckets(
      new Map([
        [0, mockBucket(4, 1, 0)],
        [4, mockBucket(3, 2, 0)],
        [7, mockBucket(2, 3, 1)],
      ]),
    );

    incrementFoldedDrawsMetric(plan, metrics);

    expect(metrics.snapshot()[METRIC_KEY]).toBe(3);
  });

  it('empty plan (mode-bypass, all singletons -> headBuckets empty) -> metric unset', () => {
    // Mode-bypass (D-5): mode != 0 yields per-entry singleton buckets which
    // buildFoldDispatchPlan filters out (bucketSize <= 1 skipped). The
    // resulting plan has empty headBuckets so no instanced drawIndexed
    // emits, and the per-entity drawIndexed path does NOT count toward the
    // metric (plan-strategy D-3 / w12 acceptance criterion 2).
    const metrics = createEngineMetrics();
    const plan = planFromBuckets(new Map<number, FoldBucket>());

    incrementFoldedDrawsMetric(plan, metrics);

    expect(metrics.snapshot()[METRIC_KEY]).toBeUndefined();
  });

  it('cap-fallback filtered plan: pre-filter had 3 heads, filter dropped 1 (cap-overrun) -> metric == 2', () => {
    // Simulates the M2 / w11 cap-fallback exit in render-system-record.ts:
    // the dispatch site rebuilds the plan with the cap-overrun bucket
    // removed BEFORE calling this helper. The metric tracks the post-
    // filter count (acceptance criterion 3 — overrun bucket members get
    // per-entity drawIndexed, which does not count as an instanced draw).
    const metrics = createEngineMetrics();
    const filteredPlan = planFromBuckets(
      new Map([
        [0, mockBucket(4)],
        [10, mockBucket(2)],
        // pre-filter [20, mockBucket(200)] removed by cap-fallback in record-stage
      ]),
    );

    incrementFoldedDrawsMetric(filteredPlan, metrics);

    expect(metrics.snapshot()[METRIC_KEY]).toBe(2);
  });

  it('reset() zeros the counter; next frame starts from 1 (test isolation hook)', () => {
    const metrics = createEngineMetrics();
    const plan = planFromBuckets(new Map([[0, mockBucket(3)]]));

    incrementFoldedDrawsMetric(plan, metrics);
    expect(metrics.snapshot()[METRIC_KEY]).toBe(1);

    metrics.reset();
    expect(metrics.snapshot()[METRIC_KEY]).toBeUndefined();

    incrementFoldedDrawsMetric(plan, metrics);
    expect(metrics.snapshot()[METRIC_KEY]).toBe(1);
  });

  it('uses metrics.increment() exactly N times for a plan with N head buckets (mock metrics)', () => {
    // Mock-driven assertion (plan w12: "inject mock metrics into the fold
    // helper, assert increment call count"). Spy verifies both call count
    // AND key.
    const mockMetrics = { increment: vi.fn() };
    const plan = planFromBuckets(
      new Map([
        [0, mockBucket(5)],
        [5, mockBucket(2)],
      ]),
    );

    incrementFoldedDrawsMetric(plan, mockMetrics);

    expect(mockMetrics.increment).toHaveBeenCalledTimes(2);
    expect(mockMetrics.increment).toHaveBeenNthCalledWith(1, METRIC_KEY);
    expect(mockMetrics.increment).toHaveBeenNthCalledWith(2, METRIC_KEY);
  });
});
