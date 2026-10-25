// Engine Worker -> Render Worker transport, measured end to end per frame.
// Source realm: real World update + publisher encode + postMessage under App's
// publication-slot credit. Receiver realm: native deserialize + publication
// decode/apply (`--receiver scene`), optionally followed by the full stub
// Renderer draw and completion (`--receiver renderer`).
//
//   node packages/render/bench/transport/run.mjs --count 1000 --changes 8
//   node packages/render/bench/transport/run.mjs --sweep 100,1000,10000,100000 --changes 0,8,1%,100%
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { Session } from 'node:inspector/promises';
import { writeFile } from 'node:fs/promises';
import { RenderPublicationReceiver } from '@forgeax/engine-render/internal';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { identity, unwrap } from '../change-propagation/workload.mjs';
import { PROTOCOL, receivedPublication, returnedStorage } from './codec.mjs';

const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => process.argv.slice(2 + i * 2, 4 + i * 2)));
const receiverMode = args['--receiver'] ?? 'scene';
assert(['scene', 'renderer'].includes(receiverMode));
const workload = args['--workload'] ?? 'mixed';
const frames = Number(args['--frames'] ?? 120), warmup = Number(args['--warmup'] ?? 24);
const capacity = Number(args['--capacity'] ?? 2);
const paceMs = Number(args['--pace'] ?? 0);
const root = resolve(import.meta.dirname, '../../../..');
const manifest = `data:application/json;base64,${(await readFile(resolve(root, 'shared-build-inputs/shaders/manifest.json'))).toString('base64')}`;
const cpu = () => { const usage = process.threadCpuUsage(); return (usage.user + usage.system) / 1000; };
const now = () => performance.timeOrigin + performance.now();
const quantile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0; };
const p50 = (rows, key) => quantile(rows.map((row) => row[key]), 0.5);
const p95 = (rows, key) => quantile(rows.map((row) => row[key]), 0.95);

/** D: 0 = idle, k = k poses, k% = k percent of N poses, 100% = every entity moves. */
function workloadConfig(count, changes) {
  if (workload === 'frontline')
    return { workload, count, dirty: 8, users: 1, phase: 'mixed', frames, warmup, gameRoot: args['--game-root'], gameDist: args['--game-dist'], chunkPolicy: 'replace' };
  const percent = String(changes).endsWith('%') ? Number(String(changes).slice(0, -1)) : undefined;
  const dirty = percent === undefined ? Number(changes) : Math.max(1, Math.round((count * percent) / 100));
  const phase = dirty === 0 ? 'idle' : percent === 100 ? 'dense' : 'pose';
  return { workload, count, dirty: phase === 'pose' ? dirty : 8, users: Math.min(128, count / 2), phase, frames, warmup };
}

async function runCase(count, changes) {
  const config = workloadConfig(count, changes);
  const gcEntries = [];
  const gc = new PerformanceObserver((list) => { for (const entry of list.getEntries()) gcEntries.push(entry.startTime); });
  gc.observe({ entryTypes: ['gc'] });
  let renderer, receiver, capabilities, limits;
  if (receiverMode === 'renderer') {
    const webgpu = await import('@forgeax/engine-rhi-webgpu');
    webgpu.installWebGpuStub(webgpu.DEFAULT_WEBGPU_STUB_PROFILE);
    const features = workload === 'frontline' ? [(await import('../change-propagation/frontline-workload.mjs')).frontlineVfx().feature] : [];
    let configuration, texture;
    const canvas = { width: 256, height: 256, addEventListener() {}, removeEventListener() {}, getContext: () => ({
      configure(options) { configuration = options; texture?.destroy(); texture = undefined; }, unconfigure() {},
      getCurrentTexture() { texture ??= configuration.device.createTexture({ size: [256, 256], format: configuration.format, usage: 0x11 }); return texture; } }) };
    renderer = unwrap(await constructRuntimeRendererHost(canvas, { rhi: webgpu.rhi, publicationSource: identity, features }, { shaderManifestUrl: manifest })).renderer;
    ({ capabilities, limits } = renderer.inspect());
  } else receiver = new RenderPublicationReceiver(identity);
  const worker = new Worker(new URL('./source.mjs', import.meta.url), { workerData: { manifest, config, capacity, frames, warmup, paceMs, capabilities, limits, ...(args['--profile-source'] ? { profileOut: args['--profile-source'] } : {}) } });
  const rows = [];
  let inspector, cloned, sourceReport, windowStart, allocationStart, cpuStart, windowEnd, allocationEnd, cpuEnd, received = 0;
  const failure = new Promise((_, reject) => {
    worker.on('error', reject);
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`source Worker exited ${code}`)); });
  });
  const finished = new Promise((resolveFinished, reject) => {
    // Draws are serialized in arrival order, like the Render Worker drain.
    let chain = Promise.resolve();
    worker.on('message', (message) => {
      if (message.kind === 'failure') { reject(Object.assign(new Error(message.message), { stack: message.stack })); return; }
      if (message.kind === 'cloned') { cloned = message.bytes; return; }
      if (message.kind === 'source-report') { sourceReport = message; resolveFinished(); return; }
      const receivedAt = now();
      const index = received++;
      if (index === warmup) {
        windowStart = performance.now(); cpuStart = cpu(); allocationStart = getHeapStatistics().total_allocated_bytes;
        if (args['--profile-receiver']) { inspector = new Session(); inspector.connect(); void inspector.post('HeapProfiler.startSampling', { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }); }
      }
      chain = chain.then(async () => {
        const start = now(), startCpu = cpu();
        const publication = receivedPublication(message);
        const feedback = [];
        let completedAt, submittedAt;
        if (receiver !== undefined) {
          const accepted = receiver.accept(publication);
          if (!accepted.ok) throw accepted.error;
          submittedAt = now();
        } else {
          const receipt = unwrap(renderer.draw({ publication, onFeatureSourceSubmitted: (identity, data) => feedback.push({ identity, feedback: data }) }));
          submittedAt = now();
          unwrap(await receipt.completed);
        }
        const applyCpuMs = cpu() - startCpu;
        completedAt = now();
        const buffers = returnedStorage(message);
        worker.postMessage({ kind: 'recycle', revision: publication.revision, buffers, feedback }, buffers);
        if (index >= warmup) {
          rows.push({ receiveLatencyMs: receivedAt - message.tickAt, queuedMs: start - receivedAt, applyMs: submittedAt - start, applyCpuMs,
            tickToAppliedMs: submittedAt - message.tickAt, tickToCompletedMs: completedAt - message.tickAt });
          if (index === warmup + frames - 1) { windowEnd = performance.now(); cpuEnd = cpu(); allocationEnd = getHeapStatistics().total_allocated_bytes; }
        }
      }).catch(reject);
    });
  });
  await Promise.race([finished, failure]);
  if (inspector !== undefined) { await writeFile(args['--profile-receiver'], JSON.stringify((await inspector.post('HeapProfiler.stopSampling')).profile)); inspector.disconnect(); }
  await worker.terminate();
  renderer?.dispose();
  receiver?.dispose();
  gc.disconnect();
  const source = sourceReport.samples;
  return {
    protocol: PROTOCOL, mode: receiverMode, workload, count, changes: String(changes), capacity, frames,
    source: {
      updateCpuMs: p50(source, 'updateCpuMs'), encodeCpuMsP50: p50(source, 'encodeCpuMs'), encodeCpuMsP95: p95(source, 'encodeCpuMs'),
      postMs: p50(source, 'postMs'), threadCpuPerFrameMs: sourceReport.threadCpuPerFrameMs,
      allocatedBytesPerFrame: Math.round(sourceReport.allocatedPerFrame), gc: sourceReport.gc,
      creditWaitMsP50: p50(source, 'creditWaitMs'), creditWaitMsP95: p95(source, 'creditWaitMs'),
      stalledFrames: source.filter((row) => row.creditWaitMs > 0.05).length, inFlightAtPostMax: Math.max(...source.map((row) => row.inFlightAtPost)),
    },
    bytes: { columnBytesP50: p50(source, 'columnBytes'), transferredBytesP50: p50(source, 'transferredBytes'), transferCount: p50(source, 'transferCount'),
      structuredClone: cloned },
    receiver: {
      applyCpuMsP50: p50(rows, 'applyCpuMs'), applyCpuMsP95: p95(rows, 'applyCpuMs'),
      threadCpuPerFrameMs: (cpuEnd - cpuStart) / frames, allocatedBytesPerFrame: Math.round((allocationEnd - allocationStart) / frames),
      gc: gcEntries.filter((start) => start >= windowStart && start <= windowEnd).length,
    },
    latency: { receiveMsP50: p50(rows, 'receiveLatencyMs'), receiveMsP95: p95(rows, 'receiveLatencyMs'), queuedMsP50: p50(rows, 'queuedMs'),
      tickToAppliedMsP50: p50(rows, 'tickToAppliedMs'), tickToAppliedMsP95: p95(rows, 'tickToAppliedMs'),
      tickToCompletedMsP50: p50(rows, 'tickToCompletedMs') },
  };
}

const counts = String(args['--sweep'] ?? args['--count'] ?? 1000).split(',').map(Number);
const changes = String(args['--changes'] ?? 8).split(',');
for (const count of counts)
  for (const change of changes) {
    const result = await runCase(count, change);
    console.log(JSON.stringify(result));
  }
