// @perf-budget-skip: intentional 100k-row allocation-sensitive performance benchmark.
// @ts-expect-error The Vitest runtime provides Node's fs module; scene declarations stay browser-safe.
import { readFileSync } from 'node:fs';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import {
  beginDerivedRangeAllocationTrace,
  type DerivedRangeAllocationTrace,
  endDerivedRangeAllocationTrace,
} from '../../../ecs/src/query/derived-range-writer';
import { GlobalTransform, propagateTransforms, Transform } from '../index';

const SEED = 20260901;

const processLike = (
  globalThis as typeof globalThis & {
    process?: { memoryUsage(): { heapUsed: number }; env?: Record<string, string | undefined> };
  }
).process;
const CI_MODE = processLike?.env?.CI !== undefined;
const WARMUP_FRAMES = CI_MODE ? 2 : 5;
const SAMPLE_FRAMES = CI_MODE ? 5 : 20;
const LARGE_ROWS = CI_MODE ? 20_000 : 100_000;

type Mode = 'full' | 'sparse' | 'mixed';

type Workload = {
  readonly mode: Mode;
  readonly rows: number;
  readonly movers: number;
};

type FlatReceipt = {
  readonly schemaVersion: 1;
  readonly runner: string;
  readonly featureSha: string;
  readonly seed: number;
  readonly workload: Workload;
  readonly frameWindow: { readonly warmup: number; readonly samples: number };
  readonly moverDensity: number;
  readonly p50Ms: {
    readonly writer: number;
    readonly propagation: number;
    readonly query: number;
    readonly total: number;
  };
  readonly p95Ms: {
    readonly writer: number;
    readonly propagation: number;
    readonly query: number;
    readonly total: number;
  };
  readonly changedRows: number;
  readonly changedRuns: number;
  readonly querySpanCount: number;
  readonly hierarchyRows: 0;
  readonly worldChecksum: number;
  readonly expectedChecksum: number;
  readonly retainedHeapDeltaBytes: number | null;
  readonly allocationEvidence: {
    readonly typedArraySubarrayCalls: number;
    readonly shapeAllocations: number;
    readonly closureAllocations: number;
    readonly columnWindowAllocations: number;
    readonly rowFacadeAllocations: number;
    readonly proxyAllocations: number;
    readonly rangeCacheAllocations: number;
    readonly bindingRebuilds: number;
    readonly warmupFrames: number;
    readonly propagationOnly: true;
  };
};

const WORKLOADS: readonly Workload[] = [
  { mode: 'full', rows: 10_000, movers: 0 },
  { mode: 'full', rows: 10_000, movers: 10_000 },
  { mode: 'sparse', rows: 10_000, movers: 1 },
  { mode: 'sparse', rows: 10_000, movers: 100 },
  { mode: 'full', rows: LARGE_ROWS, movers: LARGE_ROWS },
  { mode: 'sparse', rows: LARGE_ROWS, movers: 1 },
  { mode: 'sparse', rows: LARGE_ROWS, movers: 100 },
  { mode: 'mixed', rows: LARGE_ROWS, movers: LARGE_ROWS / 10 },
  { mode: 'full', rows: LARGE_ROWS, movers: 0 },
];

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return Number((sorted[index] ?? 0).toFixed(3));
}

function addMovers(
  world: World,
  entities: readonly EntityHandle[],
  rows: number,
  movers: number,
  frame: number,
): number {
  for (let mover = 0; mover < movers; mover += 1) {
    const row = (mover * 97 + frame * 17 + SEED) % rows;
    const entity = entities[row];
    if (entity === undefined) throw new Error(`missing flat entity at row ${row}`);
    world.set(entity, Transform, { pos: [row + frame + 1, 0, 0] }).unwrap();
  }
  return movers;
}

function countRuns(indices: number[]): number {
  if (indices.length === 0) return 0;
  indices.sort((left, right) => left - right);
  let runs = 1;
  for (let index = 1; index < indices.length; index += 1) {
    if ((indices[index] ?? 0) !== (indices[index - 1] ?? 0) + 1) runs += 1;
  }
  return runs;
}

function spawnFlatWorld(rows: number): {
  readonly world: World;
  readonly entities: readonly EntityHandle[];
} {
  const world = new World();
  const entities = Array.from({ length: rows }, (_, row) =>
    world.spawn({ component: Transform, data: { pos: [row, 0, 0] } }).unwrap(),
  );
  return { world, entities };
}

function measurePropagationAllocations(world: World): DerivedRangeAllocationTrace {
  const prototype = Float32Array.prototype;
  const original = prototype.subarray;
  let calls = 0;
  beginDerivedRangeAllocationTrace();
  Object.defineProperty(prototype, 'subarray', {
    configurable: true,
    value: function countedSubarray(
      this: Float32Array,
      begin?: number,
      end?: number,
    ): Float32Array {
      calls += 1;
      return original.call(this, begin, end);
    },
  });
  try {
    propagateTransforms(world).unwrap();
  } finally {
    Object.defineProperty(prototype, 'subarray', {
      configurable: true,
      value: original,
    });
  }
  const trace = endDerivedRangeAllocationTrace();
  trace.subarrayCalls = calls;
  return trace;
}

function addAllocationTrace(
  target: DerivedRangeAllocationTrace,
  source: DerivedRangeAllocationTrace,
): void {
  target.subarrayCalls += source.subarrayCalls;
  target.shapeAllocations += source.shapeAllocations;
  target.closureAllocations += source.closureAllocations;
  target.columnWindowAllocations += source.columnWindowAllocations;
  target.rowFacadeAllocations += source.rowFacadeAllocations;
  target.proxyAllocations += source.proxyAllocations;
  target.rangeCacheAllocations += source.rangeCacheAllocations;
  target.bindingRebuilds += source.bindingRebuilds;
}

function runWorkload(workload: Workload): FlatReceipt {
  const { world, entities } = spawnFlatWorld(workload.rows);
  const source = world.query({ read: [Transform, GlobalTransform] }).unwrap();
  const spans = source.spans().unwrap();
  const querySpanCount = [...spans].length;
  const changed = world.query({ read: [Transform], changed: [Transform] }).unwrap();
  const expectedLocal = new Float64Array(workload.rows);
  for (let row = 0; row < workload.rows; row += 1) expectedLocal[row] = row;
  propagateTransforms(world).unwrap();
  const propagationAllocationTrace: DerivedRangeAllocationTrace = {
    subarrayCalls: 0,
    shapeAllocations: 0,
    closureAllocations: 0,
    columnWindowAllocations: 0,
    rowFacadeAllocations: 0,
    proxyAllocations: 0,
    rangeCacheAllocations: 0,
    bindingRebuilds: 0,
  };

  for (let frame = 0; frame < WARMUP_FRAMES; frame += 1) {
    addMovers(world, entities, workload.rows, workload.movers, frame);
    for (let mover = 0; mover < workload.movers; mover += 1) {
      const row = (mover * 97 + frame * 17 + SEED) % workload.rows;
      expectedLocal[row] = row + frame + 1;
    }
    addAllocationTrace(propagationAllocationTrace, measurePropagationAllocations(world));
    [...changed];
  }

  const writerTimes: number[] = [];
  const propagationTimes: number[] = [];
  const queryTimes: number[] = [];
  const totalTimes: number[] = [];
  let changedRows = 0;
  let changedRuns = 0;
  let checksum = 0;
  const expectedFrameChecksums: number[] = [];
  const heapBefore = processLike?.memoryUsage().heapUsed;
  for (let frame = WARMUP_FRAMES; frame < WARMUP_FRAMES + SAMPLE_FRAMES; frame += 1) {
    const totalStart = performance.now();
    const writerStart = performance.now();
    const expectedChangedRows = addMovers(world, entities, workload.rows, workload.movers, frame);
    for (let mover = 0; mover < workload.movers; mover += 1) {
      const row = (mover * 97 + frame * 17 + SEED) % workload.rows;
      expectedLocal[row] = row + frame + 1;
    }
    writerTimes.push(performance.now() - writerStart);

    const changedIndices: number[] = [];
    for (const row of changed) changedIndices.push(row.entity & 0xffffff);
    expect(changedIndices.length).toBe(expectedChangedRows);
    changedRows += changedIndices.length;
    changedRuns += countRuns(changedIndices);

    const propagationStart = performance.now();
    addAllocationTrace(propagationAllocationTrace, measurePropagationAllocations(world));
    propagationTimes.push(performance.now() - propagationStart);

    const queryStart = performance.now();
    let frameChecksum = 0;
    for (const row of world.query({ read: [GlobalTransform] }).unwrap()) {
      frameChecksum += row.get(GlobalTransform).world[12] ?? 0;
    }
    let expectedFrameChecksum = 0;
    for (let row = 0; row < workload.rows; row += 1)
      expectedFrameChecksum += expectedLocal[row] ?? 0;
    expectedFrameChecksums.push(expectedFrameChecksum);
    queryTimes.push(performance.now() - queryStart);
    checksum = (checksum + Math.round(frameChecksum * 1000) + SEED + frame) >>> 0;
    totalTimes.push(performance.now() - totalStart);
  }

  let expectedChecksum = 0;
  for (let sample = 0; sample < SAMPLE_FRAMES; sample += 1) {
    const frame = WARMUP_FRAMES + sample;
    const frameChecksum = expectedFrameChecksums[sample] ?? 0;
    expectedChecksum = (expectedChecksum + Math.round(frameChecksum * 1000) + SEED + frame) >>> 0;
  }
  const heapAfter = processLike?.memoryUsage().heapUsed;
  const retainedHeapDeltaBytes =
    heapBefore === undefined || heapAfter === undefined
      ? null
      : Math.max(0, heapAfter - heapBefore);
  return {
    schemaVersion: 1,
    runner: 'vitest-node',
    featureSha: processLike?.env?.FORGEAX_FEATURE_SHA ?? 'unbound',
    seed: SEED,
    workload,
    frameWindow: { warmup: WARMUP_FRAMES, samples: SAMPLE_FRAMES },
    moverDensity: workload.movers / workload.rows,
    p50Ms: {
      writer: percentile(writerTimes, 0.5),
      propagation: percentile(propagationTimes, 0.5),
      query: percentile(queryTimes, 0.5),
      total: percentile(totalTimes, 0.5),
    },
    p95Ms: {
      writer: percentile(writerTimes, 0.95),
      propagation: percentile(propagationTimes, 0.95),
      query: percentile(queryTimes, 0.95),
      total: percentile(totalTimes, 0.95),
    },
    changedRows: Math.round(changedRows / SAMPLE_FRAMES),
    changedRuns: Math.round(changedRuns / SAMPLE_FRAMES),
    querySpanCount,
    hierarchyRows: 0,
    worldChecksum: checksum,
    expectedChecksum,
    retainedHeapDeltaBytes,
    allocationEvidence: {
      typedArraySubarrayCalls: propagationAllocationTrace.subarrayCalls,
      shapeAllocations: propagationAllocationTrace.shapeAllocations,
      closureAllocations: propagationAllocationTrace.closureAllocations,
      columnWindowAllocations: propagationAllocationTrace.columnWindowAllocations,
      rowFacadeAllocations: propagationAllocationTrace.rowFacadeAllocations,
      proxyAllocations: propagationAllocationTrace.proxyAllocations,
      rangeCacheAllocations: propagationAllocationTrace.rangeCacheAllocations,
      bindingRebuilds: propagationAllocationTrace.bindingRebuilds,
      warmupFrames: WARMUP_FRAMES,
      propagationOnly: true,
    },
  };
}

describe('real ECS flat Transform propagation benchmark', () => {
  // Coverage instrumentation expands the default 100k-row allocation-sensitive workload
  // substantially; CI selects a bounded 20k-row large case while local runs retain the full
  // benchmark budget and receipt values.
  it('covers dynamic full, sparse, and mixed C workloads without a static shortcut', () => {
    const receipts = WORKLOADS.map(runWorkload);
    // biome-ignore lint/suspicious/noConsole: benchmark output is the machine evidence receipt.
    console.info(JSON.stringify({ schemaVersion: 1, receipts }));
    expect(receipts).toHaveLength(WORKLOADS.length);
    expect(receipts.every((receipt) => receipt.querySpanCount === 1)).toBe(true);
    expect(receipts.every((receipt) => receipt.hierarchyRows === 0)).toBe(true);
    expect(receipts.every((receipt) => receipt.worldChecksum === receipt.expectedChecksum)).toBe(
      true,
    );
    expect(
      receipts.every(
        (receipt) =>
          receipt.workload.movers === 0 || (receipt.changedRows > 0 && receipt.changedRuns > 0),
      ),
    ).toBe(true);
    expect(receipts.every((receipt) => receipt.allocationEvidence.propagationOnly)).toBe(true);
    expect(
      receipts.every((receipt) =>
        Object.entries(receipt.allocationEvidence)
          .filter(([name]) => name.endsWith('Allocations'))
          .every(([, count]) => count === 0),
      ),
    ).toBe(true);
    expect(
      receipts.every(
        (receipt) =>
          receipt.allocationEvidence.typedArraySubarrayCalls <=
          receipt.changedRuns * 4 * (WARMUP_FRAMES + SAMPLE_FRAMES),
      ),
    ).toBe(true);

    const source = readFileSync(
      new URL('../systems/propagate-transforms.ts', import.meta.url),
      'utf8',
    );
    expect(source.slice(0, source.indexOf('function walkChildren('))).not.toMatch(
      /new (Map|Set)|\\b(Map|Set)</,
    );
  }, 120_000);
});
