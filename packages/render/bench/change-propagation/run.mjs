// Complete live producer -> native Worker transfer -> Renderer -> completion -> recycle.
// No packet replay, alternate renderer, synthetic full-scan baseline or app FPS claim.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { cpus, loadavg, platform } from 'node:os';
import { resolve } from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { getHeapStatistics } from 'node:v8';
import { Session } from 'node:inspector/promises';
import { renderPublicationTransfers } from '@forgeax/engine-render';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { cellConfig, hash, identity, unwrap, validateConfig } from './workload.mjs';
import { heapCensus } from './heap-census.mjs';

// `--profile 1`: CPU + sampled allocations on both threads; `--profile cpu`: CPU only (100 us samples).
const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => process.argv.slice(2 + i * 2, 4 + i * 2)));
assert(args['--out'], '--out NEW_DIRECTORY is required');
const profiling = args['--profile'] === '1' || args['--profile'] === 'cpu';
// `--sample-interval B` (default 32768): mean sampled-allocation spacing; small values estimate allocation counts.
const sampleInterval = Number(args['--sample-interval'] ?? 32768);
// `--profile-startup cpu|1`: CPU (+ sampled allocations) of the first frame only, on both threads.
const profilingStartup = args['--profile-startup'] === '1' || args['--profile-startup'] === 'cpu';
const output = resolve(args['--out']);
const root = resolve(import.meta.dirname, '../../../..');
const backend = args['--backend'] ?? (args['--cell'] === undefined ? undefined : cellConfig(args['--cell'], 100).backend) ?? 'stub';
const workload = args['--workload'] ?? 'mixed';
assert(['mixed', 'frontline'].includes(workload));
assert(['null', 'stub', 'dawn'].includes(backend));
// `--cell ID` selects a named scenario cell (workload.mjs `cells`) at `--count`; explicit flags still win.
const cell = args['--cell'] === undefined ? {} : cellConfig(args['--cell'], Number(args['--count'] ?? 1000));
const config = validateConfig({ count: Number(args['--count'] ?? 1000), dirty: Number(args['--dirty'] ?? cell.dirty ?? 8),
  users: Number(args['--users'] ?? cell.users ?? 128), phase: args['--phase'] ?? (cell.scenario === undefined ? 'mixed' : 'scenario'),
  frames: Number(args['--frames'] ?? (workload === 'frontline' ? 600 : 60)), warmup: Number(args['--warmup'] ?? 16), workload,
  ...(cell.scenario === undefined ? {} : { scenario: cell.scenario, params: cell.params, cell: args['--cell'] }),
  ...(args['--residuals'] === undefined ? {} : { residuals: Number(args['--residuals']) }),
  ...(args['--cameras'] ?? cell.cameras) === undefined ? {} : { cameras: Number(args['--cameras'] ?? cell.cameras) },
  ...(args['--transparent'] === undefined ? {} : { transparent: Number(args['--transparent']) }),
  ...(workload === 'frontline' ? { gameRoot: args['--game-root'], gameDist: args['--game-dist'], chunkPolicy: args['--chunk-policy'] ?? 'replace' } : {}) });
const loseAt = args['--lose-at'] === undefined ? cell.loseAt : Number(args['--lose-at']);
assert(workload !== 'frontline' || ['replace', 'ranges'].includes(config.chunkPolicy));
// Refuse to overwrite earlier evidence, including rejected/interrupted attempts.
await mkdir(output, { recursive: false });
const manifestBytes = await readFile(resolve(root, 'shared-build-inputs/shaders/manifest.json'));
const manifest = `data:application/json;base64,${manifestBytes.toString('base64')}`;
const width = 256, height = 256;
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim();
const sourceDeltaSha256 = hash(execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }));
const builtFiles = [];
for (const name of await readdir(resolve(root, 'packages'))) {
  try { for (const file of await readdir(resolve(root, 'packages', name, 'dist'), { recursive: true })) if (/\.mjs$/.test(file)) builtFiles.push(`packages/${name}/dist/${file}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const buildHashes = Object.fromEntries(await Promise.all(builtFiles.sort().map(async file => [file, hash(await readFile(resolve(root, file)))])));
const report = { sourceHead, dirty, sourceDeltaSha256, buildHashes, manifestSha256: hash(manifestBytes), config, backend,
  fixtureSha256: hash(await readFile(import.meta.filename)), workloadSha256: hash(await readFile(new URL('./workload.mjs', import.meta.url))),
  sourceWorkerSha256: hash(await readFile(new URL('./source-worker.mjs', import.meta.url))),
  ...(workload === 'frontline' ? { frontlineSha256: hash(await readFile(new URL('./frontline-workload.mjs', import.meta.url))) } : {}),
  scope: 'serialized live Worker publication and full Renderer; one completion credit; excludes App pacing, browser compositor, game AI/physics and display scanout',
  clocks: { cpu: 'sum of disjoint source/render thread CPU; not elapsed await time', elapsed: 'request through completion and returned-buffer recycle acknowledgement', gpu: 'not observed in ordinary timing window' },
  host: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, platform: platform(), node: process.version },
  timingQualification: 'diagnostic-unqualified; requires independent idle-host and paired-run admission',
  hostSamples: [], raw: [], audits: [], errors: [], status: 'running' };
const devices = new Set(), textures = [];
let worker, renderer, unsubscribe, gpu, loseDevice, commandCounts;
let inspector;
let gcMs = 0, gcCount = 0;
const gcEntries = [];
const gc = new PerformanceObserver(list => { for (const entry of list.getEntries()) { gcMs += entry.duration; gcCount++; gcEntries.push({ start: entry.startTime, duration: entry.duration }); } });
gc.observe({ entryTypes: ['gc'] });
const cpuMs = start => { const cpu = process.threadCpuUsage(start); return (cpu.user + cpu.system) / 1000; };
const cpuSnapshot = () => cpus().map(cpu => cpu.times);
let previousCpu = cpuSnapshot();
function hostSample() {
  const current = cpuSnapshot();
  let total = 0, idle = 0;
  for (let i = 0; i < current.length; i++) for (const key of Object.keys(current[i])) {
    const delta = current[i][key] - previousCpu[i][key]; total += delta; if (key === 'idle') idle += delta;
  }
  previousCpu = current;
  return { at: performance.now(), load: loadavg(), cpuBusyFraction: total > 0 ? 1 - idle / total : null };
}
function canvas() {
  let configuration, texture;
  return { width, height, addEventListener() {}, removeEventListener() {}, getContext: () => backend === 'null' ? null : {
    configure(options) {
      configuration = options;
      if (!devices.has(options.device)) { devices.add(options.device); options.device.addEventListener('uncapturederror', event => report.errors.push({ code: 'native-validation', message: event.error.message })); }
      texture?.destroy(); texture = undefined;
    }, unconfigure() {}, getCurrentTexture() {
      if (texture === undefined) { texture = configuration.device.createTexture({ size: [width, height], format: configuration.format, viewFormats: configuration.viewFormats ?? [], usage: 0x11 }); textures.push(texture); }
      return texture;
    },
  } };
}
// Exactly one awaited response. Worker failures/exits cannot turn into a hung run.
const inbox = [], waiters = [];
function receive() {
  if (inbox.length) return Promise.resolve(inbox.shift());
  return new Promise((resolve, reject) => {
    // Cold first publications at very large N may exceed the default; `--settle-ms` raises the bound.
    const limit = Math.max(300000, Number(args['--settle-ms'] ?? 0));
    const timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error(`source Worker response exceeded ${limit / 1000} seconds`)); }, limit);
    const waiter = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
    waiters.push(waiter);
  });
}
function deliver(message) {
  const waiter = waiters.shift();
  if (message.kind === 'failure') { const error = new Error(message.message); error.stack = message.stack; if (waiter) waiter.reject(error); else inbox.push(message); }
  else if (waiter) waiter.resolve(message); else inbox.push(message);
}
async function expected(kind) {
  const message = await receive();
  // Failure detail must be lazy: serializing a valid publication here walks
  // every typed-array capacity and resource byte inside the measured window.
  if (message.kind === 'failure') { const error = new Error(message.message); error.stack = message.stack; throw error; }
  assert.equal(message.kind, kind, `expected ${kind}, received ${message.kind}`);
  return message;
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const q = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { count: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) };
}
try {
  const started = performance.now();
  let rhi;
  if (backend === 'dawn') {
    const { create, globals } = await import('@forgeax/engine-dawn-node');
    Object.assign(globalThis, globals); gpu = create([]);
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu } });
    const adapter = await gpu.requestAdapter(); assert(adapter, 'Dawn adapter unavailable');
    report.adapter = Object.fromEntries(['vendor', 'architecture', 'device', 'description', 'backendType'].map(key => [key, adapter.info?.[key] ?? null]));
    assert(/apple|intel|nvidia|amd/i.test(JSON.stringify(report.adapter)) && !/software|swiftshader|lavapipe|fallback/i.test(JSON.stringify(report.adapter)), 'identified physical adapter required');
    ({ rhi } = await import('@forgeax/engine-rhi-webgpu'));
  } else if (backend === 'stub') {
    const webgpu = await import('@forgeax/engine-rhi-webgpu');
    webgpu.installWebGpuStub(webgpu.DEFAULT_WEBGPU_STUB_PROFILE);
    if (loseAt !== undefined) {
      // The stub's `lost` promise never settles; give every device a settable one so a mid-run loss exercises the real recovery path.
      const gpuObject = navigator.gpu, requestAdapter = gpuObject.requestAdapter.bind(gpuObject);
      gpuObject.requestAdapter = async (...rest) => {
        const adapter = await requestAdapter(...rest), requestDevice = adapter.requestDevice.bind(adapter);
        adapter.requestDevice = async descriptor => {
          const device = await requestDevice(descriptor);
          const lost = new Promise(settle => { loseDevice = () => settle({ reason: 'unknown', message: 'scenario matrix injected loss' }); });
          Object.defineProperty(device, 'lost', { value: lost, configurable: true });
          return device;
        };
        return adapter;
      };
    }
    commandCounts = webgpu.readRhiCommandCounts;
    report.stubProfile = webgpu.DEFAULT_WEBGPU_STUB_PROFILE;
    rhi = webgpu.rhi;
  } else ({ rhi } = await import('@forgeax/engine-rhi-null'));
  const frontendVfx = workload === 'frontline' ? (await import('./frontline-workload.mjs')).frontlineVfx() : undefined;
  const host = unwrap(await constructRuntimeRendererHost(canvas(), { rhi, publicationSource: identity,
    ...(frontendVfx === undefined ? {} : { features: [frontendVfx.feature] }) }, { shaderManifestUrl: manifest }));
  renderer = host.renderer;
  unsubscribe = renderer.subscribe(event => { if (event.kind === 'error') report.errors.push(event.error); });
  const inspection = renderer.inspect();
  report.device = { capabilities: inspection.capabilities, limits: inspection.limits };
  worker = new Worker(new URL('./source-worker.mjs', import.meta.url), { workerData: { manifest, config, capabilities: inspection.capabilities, limits: inspection.limits, ...(profiling ? { profileOut: output, profileAllocations: args['--profile'] === '1', sampleInterval } : {}),
    ...(profilingStartup ? { startupProfileOut: output, startupProfileAllocations: args['--profile-startup'] === '1' } : {}) } });
  worker.on('message', deliver);
  worker.on('error', error => deliver({ kind: 'failure', message: error.message, stack: error.stack }));
  worker.on('exit', code => { if (code !== 0 || waiters.length) for (const waiter of waiters.splice(0)) waiter.reject(new Error(`source Worker exited ${code}`)); });
  const sourceReady = await expected('ready');
  report.categories = sourceReady.categories;
  report.workloadProvenance = sourceReady.provenance;
  report.sourceInitialMemory = sourceReady.memory;
  report.startupMs = performance.now() - started;
  report.profile = renderer.inspect().profile;
  async function frame(tick, audit = false, measured = false, startup = false) {
    let startupInspector;
    if (startup && profilingStartup) {
      startupInspector = new Session(); startupInspector.connect();
      await startupInspector.post('Profiler.enable');
      await startupInspector.post('Profiler.setSamplingInterval', { interval: 100 });
      await startupInspector.post('Profiler.start');
      if (args['--profile-startup'] === '1') await startupInspector.post('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    }
    const gcBefore = gcMs, gcCountBefore = gcCount, allocatedBefore = getHeapStatistics().total_allocated_bytes;
    const start = performance.now(), cpu = process.threadCpuUsage();
    worker.postMessage({ kind: 'frame', tick, measured, startup });
    const { packet } = await expected('packet');
    const receivedAt = performance.now();
    if (audit && backend === 'dawn') unwrap(renderer.requestObservation(['final-display']));
    const drawStart = performance.now();
    const feedback = [];
    const receipt = unwrap(renderer.draw({ publication: packet, onFeatureSourceSubmitted: (identity, data) => feedback.push({ identity, feedback: data }) }));
    const drawMs = performance.now() - drawStart;
    assert(receipt, 'missing receipt');
    unwrap(await receipt.completed);
    const completedAt = performance.now();
    const renderThreadCpuMs = cpuMs(cpu);
    const renderGcMs = gcMs - gcBefore, renderGcCount = gcCount - gcCountBefore;
    const renderAllocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedBefore;
    if (startupInspector) {
      const profile = await startupInspector.post('Profiler.stop');
      await writeFile(resolve(output, 'startup-cpu-profile.json'), JSON.stringify(profile.profile));
      if (args['--profile-startup'] === '1') await writeFile(resolve(output, 'startup-allocation-profile.json'), JSON.stringify((await startupInspector.post('HeapProfiler.stopSampling')).profile));
      startupInspector.disconnect();
    }
    const buffers = renderPublicationTransfers(packet);
    worker.postMessage({ kind: 'recycle', revision: packet.revision, buffers, feedback }, buffers);
    const recycled = await expected('recycled');
    const sample = { tick, frameId: receipt.frameId, presentation: receipt.presentation, deviceGeneration: receipt.deviceGeneration,
      sourceAndTransportMs: receivedAt - start, drawMs, completionWaitMs: completedAt - drawStart - drawMs,
      endToEndMs: performance.now() - start, renderThreadCpuMs, renderGcMs, renderGcCount, renderAllocatedBytes,
      ...recycled.timings, counts: recycled.counts, memory: process.memoryUsage() };
    sample.totalThreadCpuMs = renderThreadCpuMs + sample.sourceThreadCpuMs;
    if (audit) {
      const inspection = renderer.inspect();
      const entry = { tick, counts: recycled.counts, renderScene: inspection.renderScene, presentation: receipt.presentation };
      if (backend === 'dawn' && receipt.presentation !== 'pending') {
        const observation = unwrap(await renderer.observe(receipt, { include: ['final-display'] }));
        const image = observation.observations.find(item => item.domain === 'final-display');
        assert(image, 'missing final-display observation');
        entry.image = { metadata: image.metadata, sha256: hash(image.bytes) };
        await writeFile(resolve(output, `frame-${tick}.rgba`), image.bytes);
      }
      report.audits.push(entry);
    }
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    return sample;
  }
  // One injected device loss + Renderer.recover(), then frames until the first non-pending presentation.
  // Recovery frames leave `raw`; their cost is `report.recovery` so the steady statistics stay comparable.
  async function recoverOnce(at) {
    // The stub cannot read pixels back, so Renderer.recover()'s candidate probe only passes on a real Dawn device.
    if (backend === 'dawn') for (const device of devices) device.destroy();
    else { assert(loseDevice, 'device loss injection needs the stub or dawn backend'); loseDevice(); }
    const deadline = performance.now() + 5000;
    while (renderer.inspect().state === 'alive' && performance.now() < deadline) await new Promise(done => setTimeout(done, 5));
    const lostState = renderer.inspect().state;
    const start = performance.now();
    const result = await renderer.recover();
    const recoverMs = performance.now() - start;
    report.recovery = { lostState, recoverOk: result.ok, recoverError: result.ok ? undefined : result.error, recoverMs, stateAfter: renderer.inspect().state };
    // The injected loss is announced as a renderer error event; it is the expected cause, kept as evidence.
    const injected = report.errors.splice(0).map(error => error.code ?? error.message);
    report.recovery.injectedErrors = injected;
    assert(result.ok, `Renderer.recover() failed: ${JSON.stringify(result.error)}`);
    const frames = [];
    let pending = 0, tick = at;
    for (; pending < 600; tick++) {
      const t = performance.now(), sample = await frame(tick);
      frames.push({ ms: performance.now() - t, presentation: sample.presentation, totalThreadCpuMs: sample.totalThreadCpuMs });
      if (sample.presentation !== 'pending') break;
      pending++;
    }
    report.recovery = { ...report.recovery, lostState, recoverOk: result.ok, recoverError: result.ok ? undefined : result.error, recoverMs, pendingFrames: pending, firstReadyFrame: frames.at(-1), frames: frames.length,
      totalMs: performance.now() - start, stateAfter: renderer.inspect().state };
    return tick + 1;
  }
  // Pending preparation receipts remain explicit and never enter measured frames.
  let tick = 0, ready = 0;
  const preparationDeadline = performance.now() + Number(args['--settle-ms'] ?? 60000);
  for (; performance.now() < preparationDeadline && ready < config.warmup; tick++) {
    const sample = await frame(tick, false, false, tick === 0);
    if (tick < 2) (report.startupFrames ??= []).push(sample);
    ready = sample.presentation === 'pending' ? 0 : ready + 1;
    if (sample.presentation === 'pending') await new Promise(done => setTimeout(done, 16));
  }
  assert.equal(ready, config.warmup, 'startup did not settle');
  report.firstMeasuredTick = tick;
  // Warmup readiness can vary with asynchronous compilation. The measured tape
  // always starts at the same logical tick; its digest must match in A/A and A/B.
  tick = 0;
  report.hostSamples.push(hostSample());
  if (profiling) {
    report.timingQualification = 'intrusive CPU/allocation attribution; not ordinary performance';
    inspector = new Session(); inspector.connect();
    await inspector.post('Profiler.enable');
    await inspector.post('Profiler.setSamplingInterval', { interval: 100 });
    await inspector.post('Profiler.start');
    if (args['--profile'] === '1') await inspector.post('HeapProfiler.startSampling', { samplingInterval: sampleInterval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  }
  const windowStart = performance.now();
  const allocationStart = getHeapStatistics().total_allocated_bytes;
  const commandsStart = commandCounts?.();
  for (let i = 0; i < config.frames; i++, tick++) {
    if (loseAt !== undefined && i === loseAt) tick = await recoverOnce(tick);
    const sample = await frame(tick, false, true);
    report.raw.push(sample);
    assert.notEqual(sample.presentation, 'pending', 'preparation inside steady window; capture rejected');
    if (i % 10 === 9) report.hostSamples.push(hostSample());
  }
  const windowEnd = performance.now();
  if (commandsStart !== undefined) {
    const end = commandCounts(), perFrame = {};
    for (const key of Object.keys(end)) perFrame[key] = (end[key] - commandsStart[key]) / report.raw.length;
    // Recovery frames are excluded from raw but their commands fall inside the window delta; the recovery cell reports both.
    report.rhiCommandsPerFrame = perFrame;
  }
  const allocationEnd = getHeapStatistics().total_allocated_bytes;
  if (inspector) {
    const cpu = await inspector.post('Profiler.stop');
    await writeFile(resolve(output, 'cpu-profile.json'), JSON.stringify(cpu.profile));
    if (args['--profile'] === '1') await writeFile(resolve(output, 'allocation-profile.json'), JSON.stringify((await inspector.post('HeapProfiler.stopSampling')).profile));
    inspector.disconnect(); inspector = undefined;
  }
  worker.postMessage({ kind: 'metrics', objects: args['--objects'] === '1' });
  report.sourceMetrics = await expected('metrics');
  await new Promise(done => setImmediate(done));
  const windowGc = gcEntries.filter(entry => entry.start >= windowStart && entry.start <= windowEnd);
  report.renderMetrics = { gc: { count: windowGc.length, durationMs: windowGc.reduce((sum, entry) => sum + entry.duration, 0) },
    allocatedHeapBytes: allocationStart === undefined ? null : allocationEnd - allocationStart,
    peakHeapUsed: Math.max(...report.raw.map(row => row.memory.heapUsed)),
    peakExternal: Math.max(...report.raw.map(row => row.memory.external)),
    peakProcessRss: Math.max(...report.raw.map(row => row.memory.rss)),
    processMaxRssBytes: process.resourceUsage().maxRSS * 1024,
    ...(args['--objects'] === '1' ? { objects: await heapCensus() } : {}) };
  await frame(tick, true);
  assert.equal(report.audits[0].renderScene.projectionRecords, sourceReady.expectedProjectionRecords, 'renderer lost source entities');
  report.hostSamples.push(hostSample());
  report.statistics = Object.fromEntries(['mutationMs', 'worldMs', 'prepareMs', 'sendMs', 'drawMs', 'completionWaitMs', 'endToEndMs', 'sourceThreadCpuMs', 'renderThreadCpuMs', 'totalThreadCpuMs'].map(key => [key, stats(report.raw.map(row => row[key]))]));
  report.operationDigest = hash(report.raw.map(row => row.counts.operationHash));
  report.status = 'complete';
  console.log(JSON.stringify({ output, config, status: report.status, endToEnd: report.statistics.endToEndMs, cpu: report.statistics.totalThreadCpuMs }));
} catch (error) {
  report.status = 'failed'; report.failure = { message: error.message, stack: error.stack, renderer: renderer?.inspect() }; process.exitCode = 1;
  console.error(error);
} finally {
  const retirement = performance.now();
  report.retirementFailures = [];
  const attempt = async (owner, action) => {
    try { await action(); }
    catch (error) { report.retirementFailures.push({ owner, message: error.message }); report.status = 'failed'; process.exitCode = 1; }
  };
  await attempt('observers', () => { unsubscribe?.(); inspector?.disconnect(); });
  if (worker && report.status === 'complete') await attempt('source publisher', async () => { worker.postMessage({ kind: 'dispose' }); await expected('disposed'); });
  if (worker) await attempt('source Worker', () => worker.terminate());
  if (renderer) await attempt('Renderer', () => renderer.dispose());
  for (const device of devices) await attempt('native queue', () => device.queue.onSubmittedWorkDone());
  for (const texture of textures) await attempt('native texture', () => texture.destroy());
  for (const device of devices) await attempt('native device', () => device.destroy());
  await new Promise(done => setImmediate(done));
  gc.disconnect();
  report.renderThreadGc = { durationMs: gcMs, count: gcCount, scope: 'entire runner including initialization/audit/retirement; not per-frame or source Worker GC' };
  report.retirementMs = performance.now() - retirement;
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
