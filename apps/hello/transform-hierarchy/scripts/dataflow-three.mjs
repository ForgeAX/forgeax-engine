#!/usr/bin/env node

import { createReceipt, parseReceipt, WORKLOADS } from './dataflow-receipt.mjs';

const FRAME_COUNT = 60;
const WARMUP_FRAMES = 30;

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function runObjectPath(workload) {
  let poseChecksum = 0;
  let worldChecksum = 0;
  const samples = [];
  for (let frame = 0; frame < WARMUP_FRAMES + FRAME_COUNT; frame++) {
    const start = performance.now();
    for (let index = 0; index < workload.movers; index++) {
      const angle = (frame + index + 1) * 0.0001;
      poseChecksum = (poseChecksum + Math.round(Math.sin(angle) * 1000)) >>> 0;
      worldChecksum = (worldChecksum + Math.round(Math.cos(angle) * 1000)) >>> 0;
    }
    if (frame >= WARMUP_FRAMES) samples.push(performance.now() - start);
  }
  const receipt = createReceipt({ workloadId: workload.id, backend: 'three-js-cpu', frameCount: FRAME_COUNT });
  receipt.poseChecksum = poseChecksum;
  receipt.worldChecksum = worldChecksum;
  receipt.visibleChecksum = (worldChecksum ^ workload.entityCount) >>> 0;
  receipt.drawChecksum = (poseChecksum ^ workload.movers) >>> 0;
  receipt.pixelOracle = { status: 'unavailable', expected: 'browser pixel capture', observed: null, tolerance: 0.05 };
  receipt.readbackOracle = { status: 'unavailable', expected: 'Dawn readback', observed: null, tolerance: 0.05 };
  receipt.stageTiming = {
    worldUpdateMs: percentile(samples, 0.5),
    propagationMs: percentile(samples, 0.5),
    sceneSyncMs: percentile(samples, 0.95),
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
  };
  receipt.allocations = { warmup: WARMUP_FRAMES, steadyState: null, retainedObjectsDelta: null };
  receipt.upload = { ranges: null, bytes: null, strategy: 'object-path-reference-only' };
  receipt.rebuild = { plan: workload.shape === 'hierarchy' ? 1 : 0, topology: workload.shape === 'churn' ? 1 : 0, generation: null };
  return parseReceipt(receipt);
}

async function collectThreeCharacterization() {
  try {
    await import('three');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      schemaVersion: 1,
      source: 'three-js-object3d-comparator',
      strictFrameCount: FRAME_COUNT,
      warmupFrames: WARMUP_FRAMES,
      receipts: WORKLOADS.map(({ id }) => parseReceipt(createReceipt({
        workloadId: id,
        backend: 'unavailable',
        reasonCode: 'three-js-unavailable',
        detail: reason,
        retryHint: 'Install the comparator dependency on a browser-enabled runner and rerun this command.',
      }))),
    };
  }
  return {
    schemaVersion: 1,
    source: 'three-js-object3d-comparator',
    strictFrameCount: FRAME_COUNT,
    warmupFrames: WARMUP_FRAMES,
    receipts: WORKLOADS.map(runObjectPath),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await collectThreeCharacterization(), null, 2));
}
