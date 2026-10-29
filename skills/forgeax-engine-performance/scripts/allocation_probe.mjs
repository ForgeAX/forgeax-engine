#!/usr/bin/env node
import { Session } from 'node:inspector/promises';
import { heapNodes } from './heap_profile.mjs';
import { requireFact } from './lib.mjs';

// Match the probe subtree and an explicitly supplied target URL/name when JIT
// inlining removes this frame. Inspector/harness subtrees stay outside attribution.
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
 * `samplingWarmup` additionally warms under sampling; those ordinals are excluded.
 * Supply `targetFrame` for named targets that JIT may inline past the marker.
 * Collected objects are included: the result is allocation volume, not retained size.
 * The V8 sampler is Poisson; keep `samplingInterval` small relative to the expected
 * bytes per call and assert with a margin, e.g. `bytesPerCall < 8` for "allocation removed".
 */
export async function measureAllocations(
  fn,
  { calls = 10000, warmup = 2000, samplingWarmup = 0, samplingInterval = 32, includeProfile = false, targetFrame } = {},
) {
  requireFact(typeof fn === 'function', 'fn must be a function');
  requireFact(Number.isSafeInteger(calls) && calls > 0, 'calls must be a positive integer');
  requireFact(Number.isSafeInteger(warmup) && warmup >= 0, 'warmup must be a nonnegative integer');
  requireFact(Number.isSafeInteger(samplingWarmup) && samplingWarmup >= 0, 'samplingWarmup must be a nonnegative integer');
  requireFact(
    Number.isSafeInteger(samplingInterval) && samplingInterval > 0,
    'samplingInterval must be a positive integer',
  );
  if (warmup) __forgeaxAllocationProbe(fn, warmup);
  const session = new Session();
  session.connect();
  let profile;
  let firstMeasuredOrdinal = 0;
  try {
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startSampling', {
      samplingInterval,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    if (samplingWarmup > 0) {
      __forgeaxAllocationProbe(fn, samplingWarmup);
      const baseline = await session.post('HeapProfiler.getSamplingProfile');
      for (const sample of baseline.profile.samples) {
        requireFact(Number.isSafeInteger(sample.ordinal), 'Require sampler ordinals for warmup exclusion');
        firstMeasuredOrdinal = Math.max(firstMeasuredOrdinal, sample.ordinal);
      }
    }
    try {
      __forgeaxAllocationProbe(fn, calls);
    } finally {
      ({ profile } = await session.post('HeapProfiler.stopSampling'));
    }
    await session.post('HeapProfiler.disable');
  } finally {
    session.disconnect();
  }
  const attribution = summarizeProbeProfile(profile, { calls, firstMeasuredOrdinal, targetFrame });
  return {
    ...(includeProfile ? { profile } : {}),
    kind: 'node-sampled-allocation',
    calls,
    warmup,
    samplingWarmup,
    firstMeasuredOrdinal,
    samplingInterval,
    ...attribution,
    interpretation:
      'Poisson-sampled allocation including collected objects. Attribution matches probe descendants and an optional explicit target function URL/name when JIT removes the marker. bytesPerCall conservatively adds orphan samples. These are attribution estimates, not statistical confidence bounds, retained size, GC time or browser Worker acceptance.',
  };
}

/** Match the probe and an explicitly identified target when JIT removes a marker frame. */
export function summarizeProbeProfile(profile, { calls, firstMeasuredOrdinal = 0, targetFrame } = {}) {
  // Collected-object sampling can retain samples after V8 removes their nodes.
  // Their owner is unknown; quarantine all such bytes into a conservative upper bound.
  const nodes = heapNodes(profile, { allowOrphanSamples: true });
  const children = new Map(nodes.map((n) => [n.id, n.children]));
  let sampledBytes = 0,
    probeFrames = 0;
  const counted = new Set();
  for (const node of nodes) {
    const explicit = targetFrame !== undefined && targetFrame.functionName.length > 0 &&
      node.callFrame.functionName === targetFrame.functionName && node.callFrame.url === targetFrame.url;
    if ((node.callFrame.functionName !== PROBE_FRAME && !explicit) || counted.has(node.id)) continue;
    probeFrames++;
    const pending = [node];
    while (pending.length) {
      const current = pending.pop();
      if (counted.has(current.id)) continue;
      counted.add(current.id);
      pending.push(...children.get(current.id));
    }
  }
  let unattributedSampledBytes = 0;
  for (const sample of profile.samples) {
    requireFact(Number.isSafeInteger(sample.ordinal), 'Require sampler ordinals for measured allocation');
    if (sample.ordinal <= firstMeasuredOrdinal) continue;
    if (!children.has(sample.nodeId)) unattributedSampledBytes += sample.size;
    else if (counted.has(sample.nodeId)) sampledBytes += sample.size;
  }
  const attributedSampledBytes = sampledBytes;
  sampledBytes += unattributedSampledBytes;
  return {
    sampledBytes, attributedSampledBytes, unattributedSampledBytes,
    attributedBytesPerCall: attributedSampledBytes / calls,
    bytesPerCall: sampledBytes / calls, probeFrames,
  };
}
