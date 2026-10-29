import { parentPort, workerData } from 'node:worker_threads';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { Session } from 'node:inspector/promises';
import { writeFile } from 'node:fs/promises';
import { createRenderPublisher, renderPublicationBytes, renderPublicationTransfers } from '@forgeax/engine-render';
import { createPublicationAssets } from '@forgeax/engine-runtime/internal/renderer-host';
import { createWorkload, hash, identity, unwrap } from './workload.mjs';
import { heapCensus } from './heap-census.mjs';

const cpuMs = start => { const cpu = process.threadCpuUsage(start); return (cpu.user + cpu.system) / 1000; };
let current;
let publisher;
let inspector;
const gcEntries = [];
const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) gcEntries.push({ start: entry.startTime, duration: entry.duration }); });
observer.observe({ entryTypes: ['gc'] });
let measuredStart, measuredEnd, allocationStart, peakHeapUsed = 0, peakExternal = 0;
const sampleMemory = () => { const m = process.memoryUsage(); peakHeapUsed = Math.max(peakHeapUsed, m.heapUsed); peakExternal = Math.max(peakExternal, m.external); return m; };
try {
  const assets = await createPublicationAssets({ shaderManifestUrl: workerData.manifest });
  const scene = workerData.config.workload === 'frontline'
    ? await (await import('./frontline-workload.mjs')).createFrontlineWorkload(assets, workerData.config)
    : createWorkload(assets, workerData.config);
  publisher = createRenderPublisher(scene.world, assets, identity, workerData.capabilities, scene.features ?? [], scene.targetOwner, workerData.limits);
  parentPort.postMessage({ kind: 'ready', categories: scene.categories, expectedProjectionRecords: scene.expectedProjectionRecords ?? workerData.config.count, provenance: scene.provenance, memory: sampleMemory() });
  parentPort.on('message', async message => {
    try {
      if (message.kind === 'frame') {
        if (current !== undefined) throw new Error('publication credit is occupied');
        let startupInspector;
        if (message.startup && workerData.startupProfileOut !== undefined) {
          startupInspector = new Session(); startupInspector.connect();
          await startupInspector.post('Profiler.enable');
          await startupInspector.post('Profiler.setSamplingInterval', { interval: 100 });
          await startupInspector.post('Profiler.start');
          if (workerData.startupProfileAllocations) await startupInspector.post('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
        }
        const gcBefore = gcEntries.length, allocatedBefore = getHeapStatistics().total_allocated_bytes;
        const start = performance.now(), cpu = process.threadCpuUsage();
        if (message.measured && measuredStart === undefined) {
          measuredStart = start; allocationStart = getHeapStatistics().total_allocated_bytes; peakHeapUsed = 0; peakExternal = 0; scene.beginMeasurement?.();
          if (workerData.profileOut !== undefined) {
            inspector = new Session(); inspector.connect();
            await inspector.post('Profiler.enable');
            await inspector.post('Profiler.setSamplingInterval', { interval: 100 });
            await inspector.post('Profiler.start');
            if (workerData.profileAllocations) await inspector.post('HeapProfiler.startSampling', { samplingInterval: workerData.sampleInterval ?? 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
          }
        }
        const operation = scene.apply(workerData.config.phase, message.tick, { measured: message.measured });
        const mutationMs = performance.now() - start;
        unwrap(scene.world.update(1 / 60));
        const updatedAt = performance.now();
        const candidate = unwrap(publisher.prepare(message.tick / 60));
        const preparedAt = performance.now();
        const packet = candidate.packet;
        const transfers = renderPublicationTransfers(candidate.message);
        const counts = { upserts: packet.upserts.length / 2, transforms: packet.transformEntities.length,
          removals: packet.removed.length, assets: packet.assets.length, materials: packet.materials.length,
          transferBuffers: transfers.length, transferBytes: transfers.reduce((sum, buffer) => sum + buffer.byteLength, 0),
          logicalColumnBytes: renderPublicationBytes(candidate.message).columns,
          features: packet.features.length, programs: packet.programs.length,
          baseline: packet.baseline, operationHash: hash(operation), revision: packet.revision };
        current = { cpu, start, gcBefore, mutationMs, worldMs: updatedAt - start - mutationMs, prepareMs: preparedAt - updatedAt, counts,
          sourceAllocatedBytes: getHeapStatistics().total_allocated_bytes - allocatedBefore };
        if (startupInspector !== undefined) {
          const profile = await startupInspector.post('Profiler.stop');
          await writeFile(`${workerData.startupProfileOut}/source-startup-cpu-profile.json`, JSON.stringify(profile.profile));
          if (workerData.startupProfileAllocations) await writeFile(`${workerData.startupProfileOut}/source-startup-allocation-profile.json`, JSON.stringify((await startupInspector.post('HeapProfiler.stopSampling')).profile));
          startupInspector.disconnect();
        }
        parentPort.postMessage({ kind: 'packet', packet: candidate.message }, transfers);
        current.sendMs = performance.now() - preparedAt;
        candidate.accept();
        sampleMemory();
        if (message.measured) measuredEnd = performance.now();
      } else if (message.kind === 'recycle') {
        if (current === undefined) throw new Error('unexpected recycle');
        const start = performance.now();
        unwrap(publisher.acknowledgeFeatures(message.revision, message.feedback ?? []));
        unwrap(publisher.recycle(message.revision, message.buffers));
        const { counts, cpu, gcBefore, ...timings } = current;
        delete timings.start;
        timings.sourceGcMs = gcEntries.slice(gcBefore).reduce((sum, entry) => sum + entry.duration, 0);
        parentPort.postMessage({ kind: 'recycled', counts, timings: { ...timings, recycleMs: performance.now() - start, sourceThreadCpuMs: cpuMs(cpu) } });
        current = undefined;
      } else if (message.kind === 'metrics') {
        if (inspector !== undefined) {
          const cpu = await inspector.post('Profiler.stop');
          await writeFile(`${workerData.profileOut}/source-cpu-profile.json`, JSON.stringify(cpu.profile));
          if (workerData.profileAllocations) await writeFile(`${workerData.profileOut}/source-allocation-profile.json`, JSON.stringify((await inspector.post('HeapProfiler.stopSampling')).profile));
          inspector.disconnect(); inspector = undefined;
        }
        await new Promise(done => setImmediate(done));
        const allocatedHeapBytes = allocationStart === undefined ? null : getHeapStatistics().total_allocated_bytes - allocationStart;
        scene.validate?.();
        const entries = gcEntries.filter(entry => entry.start >= measuredStart && entry.start <= measuredEnd);
        parentPort.postMessage({ kind: 'metrics', memory: sampleMemory(), peakHeapUsed, peakExternal,
          allocatedHeapBytes,
          gc: { count: entries.length, durationMs: entries.reduce((sum, entry) => sum + entry.duration, 0) },
          workload: scene.metrics?.(),
          ...(message.objects ? { objects: await heapCensus() } : {}) });
      } else if (message.kind === 'dispose') {
        if (current !== undefined) throw new Error('disposing an unrecycled publication');
        publisher.dispose();
        await scene.dispose?.();
        observer.disconnect();
        parentPort.postMessage({ kind: 'disposed' });
        parentPort.close();
      }
    } catch (error) { parentPort.postMessage({ kind: 'failure', message: error.message, stack: error.stack }); }
  });
} catch (error) { parentPort.postMessage({ kind: 'failure', message: error.message, stack: error.stack }); parentPort.close(); }
