import { heapNodes } from './heap_profile.mjs';
import { requireFact } from './lib.mjs';

/** Keep sampler boundary uncertainty and missing allocation owners visible. */
export function summarizeAllocationWindow(profile, { beforeStart, afterStart, beforeStop, afterStop }) {
  const observations = [beforeStart, afterStart, beforeStop, afterStop];
  for (let i = 0; i < observations.length; i++) {
    const current = observations[i];
    requireFact(Number.isFinite(current?.now) && Number.isSafeInteger(current.ready) && current.ready >= 0,
      'Require finite clock and completed-ready-frame observations');
    if (i > 0) requireFact(current.now >= observations[i - 1].now && current.ready >= observations[i - 1].ready,
      'Allocation window clocks and frames must be monotonic');
    requireFact(current.world === beforeStart.world && current.device === beforeStart.device,
      'World or device replaced during allocation window');
  }
  requireFact(typeof beforeStart.world === 'string' && beforeStart.world.length > 0 &&
    Number.isSafeInteger(beforeStart.device), 'Require World and device identity');
  const minimumSeconds = (beforeStop.now - afterStart.now) / 1000;
  const maximumSeconds = (afterStop.now - beforeStart.now) / 1000;
  const minimumFrames = beforeStop.ready - afterStart.ready;
  const maximumFrames = afterStop.ready - beforeStart.ready;
  requireFact(minimumSeconds > 0 && minimumFrames > 0, 'Require a completed nonempty sampling window');
  const nodes = heapNodes(profile, { allowOrphanSamples: true });
  const ids = new Set(nodes.map(node => node.id));
  let sampledBytes = 0, orphanBytes = 0, orphanRecords = 0;
  for (const sample of profile.samples) {
    sampledBytes += sample.size;
    if (!ids.has(sample.nodeId)) { orphanBytes += sample.size; orphanRecords++; }
  }
  return {
    sampledBytes, sampledRecords: profile.samples.length, orphanBytes, orphanRecords,
    treeSelfBytes: nodes.reduce((total, node) => total + node.selfSize, 0),
    secondsBounds: [minimumSeconds, maximumSeconds],
    readyFrameBounds: [minimumFrames, maximumFrames],
    estimatedBytesPerSecondBounds: [sampledBytes / maximumSeconds, sampledBytes / minimumSeconds],
    estimatedBytesPerReadyFrameBounds: [sampledBytes / maximumFrames, sampledBytes / minimumFrames],
    interpretation: 'Poisson sampled allocation including collected objects. Every sample is counted once, including orphan bytes with unknown owners. Bounds cover asynchronous sampler boundaries, not statistical confidence. Sample records are not object counts; tree self bytes are a separate population. ArrayBuffer backing, retained objects and GC pauses require separate evidence.',
  };
}
