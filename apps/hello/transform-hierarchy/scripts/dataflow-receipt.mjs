#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const REQUIRED_FRAME_COUNT = 60;
const REQUIRED_FIELDS = [
  'schemaVersion',
  'workloadId',
  'exactSha',
  'seed',
  'timestep',
  'camera',
  'frameIdentity',
  'frameCount',
  'poseChecksum',
  'worldChecksum',
  'visibleChecksum',
  'drawChecksum',
  'pixelOracle',
  'readbackOracle',
  'stageTiming',
  'allocations',
  'upload',
  'rebuild',
  'falsifiers',
  'environment',
  'unavailable',
];

export const WORKLOADS = Object.freeze([
  Object.freeze({ id: 'flat-dynamic', entityCount: 10_000, movers: 10_000, shape: 'flat' }),
  Object.freeze({ id: 'hierarchy-dynamic', entityCount: 10_000, movers: 10_000, shape: 'hierarchy' }),
  Object.freeze({ id: 'sparse-dynamic', entityCount: 100_000, movers: 1, shape: 'sparse' }),
  Object.freeze({ id: 'structural-churn', entityCount: 100_000, movers: 10_000, shape: 'churn' }),
  Object.freeze({ id: 'multi-view', entityCount: 100_000, movers: 10_000, shape: 'multi-view' }),
  Object.freeze({ id: 'temporal', entityCount: 10_000, movers: 10_000, shape: 'temporal' }),
]);

function currentSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createReceipt({
  workloadId,
  backend = 'unavailable',
  runner = 'transform-hierarchy-receipt',
  exactSha = currentSha(),
  seed = 20260901,
  timestep = 1 / 60,
  frameCount = REQUIRED_FRAME_COUNT,
  status = backend === 'unavailable' ? 'unavailable' : 'pass',
  reasonCode = backend === 'unavailable' ? 'backend-unavailable' : undefined,
  detail = backend === 'unavailable' ? 'No backend was supplied to this fixture.' : undefined,
  retryHint = backend === 'unavailable' ? 'Run the probe on a backend-enabled runner.' : undefined,
} = {}) {
  if (!WORKLOADS.some((workload) => workload.id === workloadId)) {
    throw new Error(`unknown workload: ${workloadId ?? '<missing>'}`);
  }
  if (!/^[0-9a-f]{40}$/.test(exactSha)) {
    throw new Error('exactSha must be a 40-character commit identity');
  }
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    throw new Error('frameCount must be a positive integer');
  }
  if (status === 'unavailable' && (!reasonCode || !detail || !retryHint)) {
    throw new Error('unavailable receipts require reasonCode, detail, and retryHint');
  }
  if (status === 'pass' && backend === 'unavailable') {
    throw new Error('unavailable backend cannot produce a pass receipt');
  }

  const workload = WORKLOADS.find((item) => item.id === workloadId);
  return {
    schemaVersion: 1,
    workloadId,
    workload: cloneJson(workload),
    exactSha,
    seed,
    timestep,
    camera: { position: [0, 0, 7], target: [0, 0, 0], fovRadians: Math.PI / 4 },
    frameIdentity: `${exactSha}:${workloadId}:${seed}:${frameCount}`,
    frameCount,
    poseChecksum: null,
    worldChecksum: null,
    visibleChecksum: null,
    drawChecksum: null,
    pixelOracle: { status, expected: 'fixed-seed rendered frame', observed: null, tolerance: 0.05 },
    readbackOracle: { status, expected: 'submitted frame readback', observed: null, tolerance: 0.05 },
    stageTiming: { worldUpdateMs: null, propagationMs: null, sceneSyncMs: null, p50Ms: null, p95Ms: null },
    allocations: { warmup: null, steadyState: null, retainedObjectsDelta: null },
    upload: { ranges: null, bytes: null, strategy: null },
    rebuild: { plan: null, topology: null, generation: null },
    falsifiers: {
      structuralGeneration: 'fail-closed',
      topologyRebuild: 'fail-closed',
      readback: 'fail-closed',
      strictFrameCount: 'fail-closed',
    },
    environment: { backend, runner, uncapped: true, vsyncCeiling: null },
    unavailable: status === 'unavailable' ? { reasonCode, detail, retryHint } : null,
  };
}

export function parseReceipt(input) {
  const receipt = typeof input === 'string' ? JSON.parse(input) : cloneJson(input);
  for (const field of REQUIRED_FIELDS) {
    if (!(field in receipt)) throw new Error(`receipt missing field: ${field}`);
  }
  if (receipt.schemaVersion !== 1) throw new Error('unsupported receipt schemaVersion');
  if (!WORKLOADS.some((workload) => workload.id === receipt.workloadId)) {
    throw new Error(`receipt has unknown workload: ${receipt.workloadId}`);
  }
  if (!/^[0-9a-f]{40}$/.test(receipt.exactSha)) throw new Error('receipt exactSha is not immutable');
  if (!Number.isInteger(receipt.frameCount) || receipt.frameCount < REQUIRED_FRAME_COUNT) {
    throw new Error(`receipt requires at least ${REQUIRED_FRAME_COUNT} frames`);
  }
  if (!receipt.frameIdentity.includes(receipt.exactSha)) throw new Error('frame identity is not SHA-bound');
  if (!receipt.environment?.runner || !receipt.environment?.backend) {
    throw new Error('receipt environment must identify runner and backend');
  }
  if (!receipt.readbackOracle || !receipt.rebuild || !('generation' in receipt.rebuild)) {
    throw new Error('receipt is missing readback or generation evidence');
  }
  for (const name of ['structuralGeneration', 'topologyRebuild', 'readback', 'strictFrameCount']) {
    if (receipt.falsifiers?.[name] !== 'fail-closed') {
      throw new Error(`falsifier is not fail-closed: ${name}`);
    }
  }
  if (receipt.unavailable !== null) {
    if (!receipt.unavailable?.reasonCode || !receipt.unavailable?.detail || !receipt.unavailable?.retryHint) {
      throw new Error('unavailable receipt is missing recovery fields');
    }
  }
  for (const forbidden of ['winner', 'candidateWinner', 'carrierWinner', 'rowWinner', 'blockSummaryWinner']) {
    if (forbidden in receipt) throw new Error(`receipt cannot select a candidate: ${forbidden}`);
  }
  return receipt;
}

function assertReject(label, mutate) {
  const receipt = createReceipt({ workloadId: 'flat-dynamic', backend: 'dawn-node' });
  mutate(receipt);
  try {
    parseReceipt(receipt);
  } catch {
    return { label, status: 'fail-as-expected' };
  }
  throw new Error(`falsifier did not fail: ${label}`);
}

export function runSelfTest() {
  const receipts = WORKLOADS.map(({ id }) => parseReceipt(createReceipt({ workloadId: id })));
  const falsifiers = [
    assertReject('missing-structural-generation', (receipt) => { delete receipt.rebuild.generation; }),
    assertReject('unexpected-topology-rebuild', (receipt) => { receipt.falsifiers.topologyRebuild = 'ignored'; }),
    assertReject('missing-readback-oracle', (receipt) => { delete receipt.readbackOracle; }),
    assertReject('static-only-frame-count', (receipt) => { receipt.frameCount = 1; }),
  ];
  const unavailable = parseReceipt(createReceipt({ workloadId: 'temporal' }));
  return { schemaVersion: 1, requiredFrameCount: REQUIRED_FRAME_COUNT, receipts, falsifiers, unavailableStatus: unavailable.unavailable !== null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) {
    console.log(JSON.stringify(runSelfTest(), null, 2));
  } else {
    console.error('usage: node scripts/dataflow-receipt.mjs --self-test');
    process.exitCode = 2;
  }
}
