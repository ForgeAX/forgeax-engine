// Engine Worker side of the transport bench: the real World, the real
// publisher and App's publication-slot credit, posting to the receiver realm.
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { parentPort, workerData } from 'node:worker_threads';
import { Session } from 'node:inspector/promises';
import { writeFile } from 'node:fs/promises';
import { createRenderPublisher } from '@forgeax/engine-render';
import { createPublicationAssets } from '@forgeax/engine-runtime/internal/renderer-host';
import { createWorkload, identity, unwrap } from '../change-propagation/workload.mjs';
import { publicationMessage, structuredBytes } from './codec.mjs';

const { config, capacity, frames, warmup, paceMs } = workerData;
const now = () => performance.timeOrigin + performance.now();
const cpu = () => { const usage = process.threadCpuUsage(); return (usage.user + usage.system) / 1000; };
const gcEntries = [];
const gc = new PerformanceObserver((list) => { for (const entry of list.getEntries()) gcEntries.push(entry.startTime); });
gc.observe({ entryTypes: ['gc'] });
const credit = { inFlight: 0, waiters: [] };
const returned = [];
parentPort.on('message', (message) => {
  if (message.kind !== 'recycle') return;
  returned.push(message);
  credit.inFlight--;
  for (const waiter of credit.waiters.splice(0)) waiter();
});

try {
  const assets = await createPublicationAssets({ shaderManifestUrl: workerData.manifest });
  const scene = config.workload === 'frontline'
    ? await (await import('../change-propagation/frontline-workload.mjs')).createFrontlineWorkload(assets, config)
    : createWorkload(assets, config);
  const publisher = createRenderPublisher(scene.world, assets, identity, workerData.capabilities, scene.features ?? [], undefined, workerData.limits, capacity);
  const samples = [];
  let windowStart, allocationStart, cpuStart, inspector;
  const drainReturns = () => {
    for (const message of returned.splice(0)) {
      unwrap(publisher.acknowledgeFeatures(message.revision, message.feedback ?? []));
      unwrap(publisher.recycle(message.revision, message.buffers));
    }
  };
  for (let tick = 0; tick < warmup + frames; tick++) {
    const measured = tick >= warmup;
    if (tick === warmup) {
      scene.beginMeasurement?.();
      windowStart = performance.now();
      cpuStart = cpu();
      allocationStart = getHeapStatistics().total_allocated_bytes;
      if (workerData.profileOut) { inspector = new Session(); inspector.connect(); await inspector.post('HeapProfiler.startSampling', { samplingInterval: 2048, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }); }
    }
    const begin = now();
    // App's publication-slot credit: two (capacity) occupied slots block the next World update.
    drainReturns();
    while (credit.inFlight >= capacity) {
      await new Promise((resolve) => credit.waiters.push(resolve));
      drainReturns();
    }
    const tickAt = now();
    const tickCpu = cpu();
    scene.apply(config.phase, tick, { measured });
    unwrap(scene.world.update(1 / 60));
    const updatedAt = now();
    const updateCpu = cpu();
    const candidate = unwrap(publisher.prepare(tick / 60));
    const { message, transfers, bytes } = publicationMessage(candidate, { frameId: tick + 1, tickAt });
    // Byte composition of the cloned (non-transferred) message, outside the measured window.
    const cloned = tick === warmup - 1 ? structuredBytes(message) : undefined;
    const encodedAt = now();
    parentPort.postMessage(message, transfers);
    const postedAt = now();
    candidate.accept();
    credit.inFlight++;
    const encodeCpu = cpu() - updateCpu;
    if (measured) {
      samples.push({ tick, creditWaitMs: tickAt - begin, updateMs: updatedAt - tickAt, updateCpuMs: updateCpu - tickCpu,
        encodeMs: encodedAt - updatedAt, postMs: postedAt - encodedAt, encodeCpuMs: encodeCpu, inFlightAtPost: credit.inFlight, ...bytes });
    } else if (cloned !== undefined) parentPort.postMessage({ kind: 'cloned', bytes: cloned });
    if (paceMs > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
  }
  const windowEnd = performance.now();
  if (inspector) { await writeFile(workerData.profileOut, JSON.stringify((await inspector.post('HeapProfiler.stopSampling')).profile)); inspector.disconnect(); }
  const allocated = getHeapStatistics().total_allocated_bytes - allocationStart;
  const threadCpu = cpu() - cpuStart;
  while (credit.inFlight > 0) { await new Promise((resolve) => credit.waiters.push(resolve)); }
  drainReturns();
  parentPort.postMessage({ kind: 'source-report', samples, allocatedPerFrame: allocated / frames, threadCpuPerFrameMs: threadCpu / frames,
    gc: gcEntries.filter((start) => start >= windowStart && start <= windowEnd).length });
  publisher.dispose();
  await scene.dispose?.();
  gc.disconnect();
  parentPort.close();
} catch (error) {
  parentPort.postMessage({ kind: 'failure', message: error.message, stack: error.stack });
  parentPort.close();
}
