import assert from 'node:assert/strict';
import { Session } from 'node:inspector';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { runCrowd } from './crowd.mjs';
import { box } from './fixtures.mjs';

const output = new URL('../../../artifacts/roi-navigation/', import.meta.url);
mkdirSync(output, { recursive: true });
const session = new Session();
session.connect();
const post = (method, params = {}) => new Promise((resolve, reject) => {
  session.post(method, params, (error, result) => error ? reject(error) : resolve(result));
});
const sampling = {
  samplingInterval: 16384,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
};
function summarize(profile) {
  const nodes = [], byModule = {};
  function visit(node) {
    assert.ok(Number.isFinite(node.selfSize) && node.selfSize >= 0);
    const url = node.callFrame.url, owner = /\/packages\/([^/]+)\//.exec(url)?.[1] ?? 'other';
    byModule[owner] = (byModule[owner] ?? 0) + node.selfSize;
    nodes.push({ id: node.id, selfSize: node.selfSize, ...node.callFrame });
    for (const child of node.children) visit(child);
  }
  visit(profile.head);
  return {
    attributedBytes: nodes.reduce((sum, node) => sum + node.selfSize, 0),
    sampleBytes: profile.samples.reduce((sum, sample) => sum + sample.size, 0),
    samples: profile.samples.length,
    byModule,
    topNodes: nodes.sort((a, b) => b.selfSize - a.selfSize).slice(0, 30),
  };
}
// A collected-object falsifier separates cumulative allocation from live heap.
function temporaryObjects() {
  const objects = Array.from({ length: 200000 }, (_, index) => ({ index, pair: [index, index + 1] }));
  assert.equal(objects.at(-1).index, 199999);
}
const report = {
  timestamp: new Date().toISOString(),
  hardware: { cpu: cpus()[0].model, platform: platform(), arch: arch(), node: process.version },
  protocol: 'https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/js_protocol.json',
  sampling,
  scope: 'Whole workload in one process: bake, query, fresh Scene/Catalog/World setup, 400 real fixed steps and disposal. This is not a cold-process timing measurement. V8 JS allocation sampling includes collected objects; native/WASM allocation is not measured. This observer run is not a performance acceptance gate.',
  runtimeHashes: Object.fromEntries(['navigation', 'physics', 'physics-rapier3d', 'ecs', 'scene'].map(owner => [owner,
    createHash('sha256').update(readFileSync(new URL(`../../${owner}/dist/index.mjs`, import.meta.url))).digest('hex')])),
  falsifier: {},
  workloads: [],
};
try {
  await post('HeapProfiler.enable');
  for (const includeCollected of [false, true]) {
    await post('HeapProfiler.collectGarbage');
    await post('HeapProfiler.startSampling', {
      ...sampling,
      includeObjectsCollectedByMajorGC: includeCollected,
      includeObjectsCollectedByMinorGC: includeCollected,
    });
    temporaryObjects();
    await post('HeapProfiler.collectGarbage');
    const { profile } = await post('HeapProfiler.stopSampling');
    report.falsifier[includeCollected ? 'collectedIncluded' : 'liveOnly'] = summarize(profile);
    writeFileSync(new URL(`allocation-falsifier-${includeCollected}.heapprofile`, output), JSON.stringify(profile));
  }
  assert.ok(report.falsifier.collectedIncluded.attributedBytes > 1000000);
  assert.ok(report.falsifier.collectedIncluded.attributedBytes > report.falsifier.liveOnly.attributedBytes * 10);
  for (const count of [100, 1000]) {
    const side = Math.ceil(Math.sqrt(count));
    const starts = Array.from({ length: count }, (_, i) => [(i % side - side / 2) * 2, (Math.floor(i / side) - side / 2) * 2]);
    const spec = { geometry: [box(90, .2, 90, 0, -.1, 0)], starts, goals: starts.map(([x, z]) => [x + 5, 0, z]), frames: 400, trace: false };
    const runs = {};
    const order = count === 100 ? ['direct', 'sampled'] : ['sampled', 'direct'];
    let allocation;
    for (const mode of order) {
      if (mode === 'sampled') await post('HeapProfiler.startSampling', sampling);
      const result = await runCrowd({ ...spec, name: `allocation-${count}-${mode}` });
      if (mode === 'sampled') {
        const { profile } = await post('HeapProfiler.stopSampling');
        allocation = summarize(profile);
        writeFileSync(new URL(`allocation-${count}.heapprofile`, output), JSON.stringify(profile));
      }
      for (const key of ['asset', 'geometry', 'trajectories']) delete result[key];
      assert.equal(result.arrived, count);
      assert.equal(result.blocked, 0);
      runs[mode] = result;
    }
    assert.deepEqual(runs.sampled.states, runs.direct.states);
    report.workloads.push({
      count, order, allocation, runs,
      observedP50DifferenceMs: runs.sampled.fullWorld.p50 - runs.direct.fullWorld.p50,
      observedP95DifferenceMs: runs.sampled.fullWorld.p95 - runs.direct.fullWorld.p95,
    });
    writeFileSync(new URL('allocations.json', output), JSON.stringify(report));
    console.log(JSON.stringify({ count, allocation, observedP50DifferenceMs: report.workloads.at(-1).observedP50DifferenceMs }));
  }
} finally {
  session.disconnect();
}
console.log('Allocation observer and collected-object falsifier PASS');
