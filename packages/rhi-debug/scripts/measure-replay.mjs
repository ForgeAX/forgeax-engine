#!/usr/bin/env node
// Offline RHI Debug cost probe on one real .rhitape with a fresh Dawn device.
//
//   node packages/rhi-debug/scripts/measure-replay.mjs <tape> [--out result.json]
//        [--works a,b,c] [--batch]
//
// Measures decode/encode/model time, heap/RSS, openReplay, and readback latency at
// the selected works (default: first, middle, last work). `--batch` also measures
// one `readAtWorks` pass over the same requests when the API is available.
// Dawn on Linux: wrap with ~/.local/opt/forgeax-lavapipe/<version>/with-lavapipe.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const args = process.argv.slice(2);
const tapePath = args[0];
if (tapePath === undefined) {
  console.error('usage: measure-replay.mjs <tape> [--out file] [--works a,b] [--batch] [--timing]');
  process.exit(2);
}
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const outPath = option('--out');
const wantBatch = args.includes('--batch');
const wantTiming = args.includes('--timing');

if (process.platform === 'linux' && process.env.LP_NUM_THREADS === undefined)
  process.env.LP_NUM_THREADS = '4';
const { create, globals } = await import(
  resolve(root, 'node_modules/.pnpm/node_modules/webgpu/index.js')
).catch(() => import('@forgeax/engine-dawn-node'));
Object.assign(globalThis, globals);
const normalize = await import(resolve(root, 'scripts/ci/normalize-dawn-device-limits.mjs'));
normalize.patchDawnAdapterPrototype(globals);
if (globalThis.navigator === undefined)
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: create([]),
  configurable: true,
  writable: true,
});

const debug = await import(resolve(root, 'packages/rhi-debug/dist/index.mjs'));
const gpu = await import(resolve(root, 'packages/rhi-webgpu/dist/index.mjs'));

let peakRss = 0;
let peakHeap = 0;
const sample = () => {
  const usage = process.memoryUsage();
  peakRss = Math.max(peakRss, usage.rss);
  peakHeap = Math.max(peakHeap, usage.heapUsed + usage.arrayBuffers);
};
const sampler = setInterval(sample, 20);
const timed = async (fn) => {
  const started = performance.now();
  const value = await fn();
  sample();
  return { value, ms: Math.round((performance.now() - started) * 10) / 10 };
};
const unwrap = (result, what) => {
  if (!result.ok) throw new Error(`${what}: ${result.error.code} ${JSON.stringify(result.error.detail)}`);
  return result.value;
};

const bytes = new Uint8Array(readFileSync(tapePath));
sample();
const decoded = await timed(() => debug.decodeTape(bytes));
const tape = unwrap(decoded.value, 'decode');
const encoded = await timed(() => debug.encodeTape(tape));
unwrap(encoded.value, 'encode');
const modelTimed = await timed(() => debug.buildFrameModel(tape));
const model = modelTimed.value;
const blobBytes = tape.blobs.reduce((sum, blob) => sum + blob.bytes.byteLength, 0);

const adapter = unwrap(await gpu.rhi.requestAdapter(), 'adapter');
const device = unwrap(
  await adapter.requestDevice(debug.replayDeviceRequest(tape, adapter.features, adapter.limits)),
  'device',
);
const opened = await timed(() =>
  debug.openReplay(tape, { device, createShaderModule: gpu.createShaderModule }),
);
const replay = unwrap(opened.value, 'openReplay');

const lastWork = model.works.length - 1;
const selected = (option('--works') ?? `0,${Math.floor(lastWork / 2)},${lastWork}`)
  .split(',')
  .map(Number);
// One readable target per selected work: first color attachment, else first bound buffer.
const requests = selected.map((workIndex) => {
  const work = model.works[workIndex];
  const view = work?.attachments?.colorViewHandleIds?.find((id) => id !== undefined && id !== null);
  if (view !== undefined) return { workIndex, resourceId: view };
  const binding = work?.bindings.find((row) => row.resourceId !== null && row.bufferSize !== null);
  return {
    workIndex,
    resourceId: binding?.resourceId,
    subresource:
      binding === undefined
        ? undefined
        : { offset: (binding.bufferOffset ?? 0) + (binding.dynamicOffset ?? 0), size: binding.bufferSize },
  };
});

const reads = [];
for (const request of requests) {
  if (request.resourceId === undefined) continue;
  const first = await timed(() =>
    replay.readResourceAtWork(request.resourceId, request.workIndex, request.subresource),
  );
  unwrap(first.value, `read ${request.resourceId}@${request.workIndex}`);
  const repeat = await timed(() =>
    replay.readResourceAtWork(request.resourceId, request.workIndex, request.subresource),
  );
  reads.push({
    workIndex: request.workIndex,
    resourceId: request.resourceId,
    bytes: first.value.value.bytes.byteLength,
    digest: debug.tapeDigest(first.value.value.bytes),
    firstMs: first.ms,
    repeatMs: repeat.ms,
  });
}
let batch;
if (wantBatch && typeof replay.readAtWorks === 'function') {
  const items = requests.filter((request) => request.resourceId !== undefined);
  const result = await timed(() => replay.readAtWorks(items));
  const values = unwrap(result.value, 'readAtWorks');
  const digests = values.map((row) => (row.ok ? debug.tapeDigest(row.value.bytes) : row.error.code));
  batch = {
    requests: items.length,
    ms: result.ms,
    ok: values.every((row) => row.ok),
    matchesSequential: digests.every((digest, index) => digest === reads[index]?.digest),
  };
}
let timing;
if (wantTiming) {
  const result = await timed(() => replay.timePasses());
  const value = unwrap(result.value, 'timePasses');
  const passMs = (pass) => Math.round((pass.gpuNanoseconds ?? 0) / 1e4) / 100;
  timing = {
    ms: result.ms,
    passes: value.passes.length,
    untimed: value.passes.filter((pass) => pass.gpuNanoseconds === null).length,
    totalGpuMs: Math.round(value.totalGpuNanoseconds / 1e4) / 100,
    slowest: [...value.passes]
      .sort((a, b) => (b.gpuNanoseconds ?? 0) - (a.gpuNanoseconds ?? 0))
      .slice(0, 5)
      .map((pass) => ({
        passIndex: pass.passIndex,
        kind: pass.kind,
        label: pass.label,
        works: pass.workIndices.length,
        gpuMs: passMs(pass),
      })),
  };
}
await replay.dispose();
clearInterval(sampler);
sample();

const result = {
  tape: tapePath,
  fileBytes: bytes.byteLength,
  blobs: tape.blobs.length,
  blobBytes,
  events: tape.events.length,
  bootstrap: tape.bootstrap.length,
  works: model.works.length,
  decodeMs: decoded.ms,
  encodeMs: encoded.ms,
  frameModelMs: modelTimed.ms,
  openReplayMs: opened.ms,
  reads,
  ...(batch === undefined ? {} : { batch }),
  ...(timing === undefined ? {} : { timing }),
  peakRssBytes: peakRss,
  peakHeapPlusArrayBuffersBytes: peakHeap,
};
const text = JSON.stringify(result, null, 2);
if (outPath !== undefined) writeFileSync(outPath, `${text}\n`);
console.log(text);
device.destroy?.();
process.exit(0);
