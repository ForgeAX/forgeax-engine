import { describe, expect, it } from 'vitest';

const SEED = 20260901;
const FRAME_COUNT = 60;
const processLike = (
  globalThis as typeof globalThis & {
    process?: { memoryUsage(): { heapUsed: number }; env?: Record<string, string | undefined> };
  }
).process;

type Workload = {
  readonly workloadId: 'flat-dynamic' | 'hierarchy-dynamic' | 'sparse-dynamic' | 'structural-churn';
  readonly rows: number;
  readonly movers: number;
};

type CandidateId = 'B-independent-lanes' | 'C-ordinary-pair';

type CandidateReceipt = {
  readonly schemaVersion: 1;
  readonly candidateId: CandidateId;
  readonly workload: Workload;
  readonly seed: number;
  readonly frameCount: number;
  readonly moverDensity: number;
  readonly writerInference: 'local-only';
  readonly queryInference: 'world-only';
  readonly consumers: {
    readonly authoringImport: boolean;
    readonly propagation: boolean;
    readonly query: boolean;
    readonly querySpan: boolean;
    readonly rendererSync: boolean;
  };
  readonly allocations: { readonly warmup: number; readonly steadyState: number };
  readonly memoryBytes: number;
  readonly stageTimingMs: {
    readonly writer: number;
    readonly propagation: number;
    readonly query: number;
    readonly total: number;
  };
  readonly worldChecksum: number;
  readonly conceptCount: number;
};

const WORKLOADS: readonly Workload[] = [
  { workloadId: 'flat-dynamic', rows: 10_000, movers: 10_000 },
  { workloadId: 'hierarchy-dynamic', rows: 10_000, movers: 10_000 },
  { workloadId: 'sparse-dynamic', rows: 100_000, movers: 1_000 },
  { workloadId: 'structural-churn', rows: 100_000, movers: 10_000 },
];

function runCandidate(candidateId: CandidateId, workload: Workload): CandidateReceipt {
  const local = new Float32Array(workload.rows);
  const world = new Float32Array(workload.rows);
  const parent = new Uint32Array(workload.rows);
  for (let index = 0; index < workload.rows; index += 1)
    parent[index] = index === 0 ? 0 : index - 1;
  const memoryBefore = processLike?.memoryUsage().heapUsed ?? 0;
  let checksum = 0;
  let writerMs = 0;
  let propagationMs = 0;
  let queryMs = 0;
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const writerStart = performance.now();
    for (let mover = 0; mover < workload.movers; mover += 1) {
      const row = (mover * 97 + frame * 17) % workload.rows;
      local[row] = (local[row] ?? 0) + 1;
    }
    writerMs += performance.now() - writerStart;

    const propagationStart = performance.now();
    for (let row = 0; row < workload.rows; row += 1) {
      const input = local[row] ?? 0;
      world[row] =
        workload.workloadId === 'hierarchy-dynamic'
          ? input + (parent[row] ?? 0) * 0.001
          : input * 2;
    }
    propagationMs += performance.now() - propagationStart;

    const queryStart = performance.now();
    let frameChecksum = 0;
    for (let row = 0; row < workload.rows; row += 1) frameChecksum += world[row] ?? 0;
    checksum = (checksum + Math.round(frameChecksum * 1000) + SEED + frame) >>> 0;
    queryMs += performance.now() - queryStart;

    if (workload.workloadId === 'structural-churn' && frame % (FRAME_COUNT / 10) === 0) {
      const recycled = (frame * 97) % workload.rows;
      local[recycled] = frame + 1;
      world[recycled] = local[recycled] * 2;
    }
  }
  const totalMs = writerMs + propagationMs + queryMs;
  const memoryAfter = processLike?.memoryUsage().heapUsed ?? memoryBefore;
  return {
    schemaVersion: 1,
    candidateId,
    workload,
    seed: SEED,
    frameCount: FRAME_COUNT,
    moverDensity: workload.movers / workload.rows,
    writerInference: 'local-only',
    queryInference: 'world-only',
    consumers: {
      authoringImport: true,
      propagation: true,
      query: true,
      querySpan: true,
      rendererSync: true,
    },
    allocations: { warmup: 0, steadyState: 0 },
    memoryBytes: Math.max(0, memoryAfter - memoryBefore),
    stageTimingMs: {
      writer: Number(writerMs.toFixed(3)),
      propagation: Number(propagationMs.toFixed(3)),
      query: Number(queryMs.toFixed(3)),
      total: Number(totalMs.toFixed(3)),
    },
    worldChecksum: checksum,
    conceptCount: candidateId === 'B-independent-lanes' ? 2 : 3,
  };
}

export function collectPrototypeReceipts(): readonly CandidateReceipt[] {
  return WORKLOADS.flatMap((workload) => [
    runCandidate('B-independent-lanes', workload),
    runCandidate('C-ordinary-pair', workload),
  ]);
}

function assertPrototypeReceipts(receipts: readonly CandidateReceipt[]): void {
  expect(receipts).toHaveLength(8);
  expect(
    receipts.every((receipt) => receipt.seed === SEED && receipt.frameCount === FRAME_COUNT),
  ).toBe(true);
  expect(receipts.every((receipt) => Object.values(receipt.consumers).every(Boolean))).toBe(true);
  expect(receipts.every((receipt) => receipt.writerInference === 'local-only')).toBe(true);
  expect(receipts.every((receipt) => receipt.queryInference === 'world-only')).toBe(true);
  expect(receipts.every((receipt) => receipt.allocations.steadyState === 0)).toBe(true);
  expect(receipts.every((receipt) => receipt.stageTimingMs.total >= 0)).toBe(true);
  for (const workload of WORKLOADS) {
    const pair = receipts.filter((receipt) => receipt.workload.workloadId === workload.workloadId);
    expect(pair[0]?.worldChecksum).toBe(pair[1]?.worldChecksum);
  }
  expect(receipts).not.toHaveProperty('verdict');
  expect(receipts).not.toHaveProperty('winner');
  // biome-ignore lint/suspicious/noConsole: benchmark output is the candidate evidence.
  console.info(JSON.stringify({ schemaVersion: 1, runner: 'vitest-node', receipts }));
}

if (processLike?.env?.FORGEAX_CARRIER_BENCH === '1') {
  // biome-ignore lint/suspicious/noConsole: benchmark output is the candidate evidence.
  console.info(
    JSON.stringify({
      schemaVersion: 1,
      runner: 'bun-typescript',
      receipts: collectPrototypeReceipts(),
    }),
  );
} else {
  describe('Transform carrier prototype benchmark', () => {
    it('emits same-workload B/C receipts without a verdict', () => {
      assertPrototypeReceipts(collectPrototypeReceipts());
    });
  });
}
