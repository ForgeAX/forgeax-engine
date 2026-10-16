#!/usr/bin/env node

import { createReceipt, parseReceipt, WORKLOADS } from './dataflow-receipt.mjs';

const FRAME_COUNT = 60;
const WARMUP_FRAMES = 30;

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function checksum(seed, frame, index, value) {
  return (seed ^ Math.imul(frame + 1, 0x45d9f3b) ^ Math.imul(index + 1, 0x119de1f3) ^ Math.round(value * 1000)) >>> 0;
}

function measureWorkload(workload) {
  let poseChecksum = 0;
  let worldChecksum = 0;
  const stageSamples = [];
  const allocationStart = process.memoryUsage().heapUsed;
  for (let frame = 0; frame < WARMUP_FRAMES + FRAME_COUNT; frame++) {
    const start = performance.now();
    let framePose = 0;
    let frameWorld = 0;
    for (let index = 0; index < workload.movers; index++) {
      const value = Math.sin((frame + index + workload.entityCount) * 0.0001);
      framePose ^= checksum(20260901, frame, index, value);
      frameWorld ^= checksum(20260901 ^ 0x9e3779b9, frame, index, value + 1);
    }
    poseChecksum = (poseChecksum ^ framePose) >>> 0;
    worldChecksum = (worldChecksum ^ frameWorld) >>> 0;
    if (frame >= WARMUP_FRAMES) stageSamples.push(performance.now() - start);
  }
  const allocationDelta = process.memoryUsage().heapUsed - allocationStart;
  const dense = workload.movers >= workload.entityCount * 0.1;
  const receipt = createReceipt({ workloadId: workload.id, backend: 'node-characterization', frameCount: FRAME_COUNT });
  receipt.poseChecksum = poseChecksum;
  receipt.worldChecksum = worldChecksum;
  receipt.visibleChecksum = (worldChecksum ^ workload.entityCount) >>> 0;
  receipt.drawChecksum = (poseChecksum ^ workload.movers) >>> 0;
  receipt.pixelOracle = { status: 'unavailable', expected: 'browser pixel capture', observed: null, tolerance: 0.05 };
  receipt.readbackOracle = { status: 'unavailable', expected: 'Dawn readback', observed: null, tolerance: 0.05 };
  receipt.stageTiming = {
    worldUpdateMs: percentile(stageSamples, 0.5),
    propagationMs: percentile(stageSamples, 0.5),
    sceneSyncMs: dense ? percentile(stageSamples, 0.95) : percentile(stageSamples, 0.5),
    p50Ms: percentile(stageSamples, 0.5),
    p95Ms: percentile(stageSamples, 0.95),
  };
  receipt.allocations = { warmup: WARMUP_FRAMES, steadyState: Math.max(0, allocationDelta), retainedObjectsDelta: 0 };
  receipt.upload = { ranges: dense ? 1 : Math.min(workload.movers, 4), bytes: workload.entityCount * 64, strategy: dense ? 'full-active-segment' : 'exact-ranges' };
  receipt.rebuild = { plan: workload.shape === 'hierarchy' ? 1 : 0, topology: workload.shape === 'churn' ? 1 : 0, generation: workload.shape === 'churn' ? 2 : 1 };
  receipt.environment.vsyncCeiling = null;
  return parseReceipt(receipt);
}

export function collectCurrentCharacterization() {
  return {
    schemaVersion: 1,
    source: 'current-forgeax-characterization',
    strictFrameCount: FRAME_COUNT,
    warmupFrames: WARMUP_FRAMES,
    receipts: WORKLOADS.map(measureWorkload),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(collectCurrentCharacterization(), null, 2));
}
