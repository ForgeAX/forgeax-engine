#!/usr/bin/env node
import { Session } from 'node:inspector/promises';
import { heapNodes } from './heap_profile.mjs';
import { requireFact } from './lib.mjs';

// Every measured call runs below this frame; only its subtree is counted, so harness,
// inspector and test-runner allocations in the same isolate stay out of the result.
// V8 reports inferred debug names, so the probe is a declaration whose name is the marker.
const PROBE_FRAME = '__forgeaxAllocationProbe';
function __forgeaxAllocationProbe(fn, calls) {
  let sink;
  for (let i = 0; i < calls; i++) sink = fn(i);
  return sink;
}

/**
 * Sampled bytes allocated by `fn` over `calls` invocations in this Node isolate, after
 * `warmup` unmeasured calls (so optimized code and escape analysis are what is measured).
 * Collected objects are included: the result is allocation volume, not retained size.
 * The V8 sampler is Poisson; keep `samplingInterval` small relative to the expected
 * bytes per call and assert with a margin, e.g. `bytesPerCall < 8` for "allocation removed".
 */
export async function measureAllocations(
  fn,
  { calls = 10000, warmup = 2000, samplingInterval = 32 } = {},
) {
  requireFact(typeof fn === 'function', 'fn must be a function');
  requireFact(Number.isSafeInteger(calls) && calls > 0, 'calls must be a positive integer');
  requireFact(Number.isSafeInteger(warmup) && warmup >= 0, 'warmup must be a nonnegative integer');
  requireFact(
    Number.isSafeInteger(samplingInterval) && samplingInterval > 0,
    'samplingInterval must be a positive integer',
  );
  if (warmup) __forgeaxAllocationProbe(fn, warmup);
  const session = new Session();
  session.connect();
  let profile;
  try {
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startSampling', {
      samplingInterval,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    try {
      __forgeaxAllocationProbe(fn, calls);
    } finally {
      ({ profile } = await session.post('HeapProfiler.stopSampling'));
    }
    await session.post('HeapProfiler.disable');
  } finally {
    session.disconnect();
  }
  const nodes = heapNodes(profile);
  const children = new Map(nodes.map((n) => [n.id, n.children]));
  let sampledBytes = 0,
    probeFrames = 0;
  const counted = new Set();
  for (const node of nodes) {
    if (node.callFrame.functionName !== PROBE_FRAME || counted.has(node.id)) continue;
    probeFrames++;
    const pending = [node];
    while (pending.length) {
      const current = pending.pop();
      if (counted.has(current.id)) continue;
      counted.add(current.id);
      sampledBytes += current.selfSize;
      pending.push(...children.get(current.id));
    }
  }
  return {
    kind: 'node-sampled-allocation',
    calls,
    warmup,
    samplingInterval,
    sampledBytes,
    bytesPerCall: sampledBytes / calls,
    probeFrames,
    interpretation:
      'Poisson-sampled allocation volume below the probe frame, including collected objects. probeFrames 0 with nonzero work means the sampler saw no allocation under the probe. Not retained size, GC time or a browser Worker measurement.',
  };
}
