// Complete World variable-array read owner; run each source version serially.
// node --expose-gc scalar-array-elements.mjs ENTRY.mjs PRIVATE_OUTPUT.json
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { measureAllocations } from '../../../skills/forgeax-engine-performance/scripts/allocation_probe.mjs';

const [entry, output] = process.argv.slice(2);
assert(entry && output && globalThis.gc, 'Require built entry, private output and --expose-gc');
const { World, defineComponent } = await import(pathToFileURL(entry));
// The semantic read capability has one stable identity across built entries.
const read = Symbol.for('forgeax.ecs.worldRead');
const components = ['f32', 'u32', 'entity'].map(type =>
  defineComponent(`ScalarArrayRead_${type}`, { values: `array<${type}>` }),
);
const world = new World();
const entities = Array.from({ length: 64 }, () => world.spawn(
  ...components.map(component => ({ component, data: { values: [7, 7, 7, 7] } })),
).unwrap());
let checksum = 0;
function scalarArrayElementOwner(index) {
  const value = world[read].getArrayElement(entities[index % entities.length], components[index % 3], 'values', index % 4);
  checksum += value;
  return value;
}
for (let index = 0; index < 192; index++) assert.equal(scalarArrayElementOwner(index), 7);
for (let index = 0; index < 100000; index++) scalarArrayElementOwner(index);
const cpu = [];
for (let round = 0; round < 7; round++) {
  const before = process.threadCpuUsage(), started = performance.now();
  for (let index = 0; index < 200000; index++) scalarArrayElementOwner(index);
  const used = process.threadCpuUsage(before);
  cpu.push({ threadCpuNsPerRead: (used.user + used.system) * 1000 / 200000, wallNsPerRead: (performance.now() - started) * 1e6 / 200000 });
}
const allocation = await measureAllocations(scalarArrayElementOwner, {
  calls: 100000, warmup: 50000, samplingWarmup: 10000, samplingInterval: 256,
  targetFrame: { functionName: 'scalarArrayElementOwner', url: import.meta.url },
});
const ring = [];
function escapingControl(index) {
  const value = { value: index };
  ring[index % 1024] = value;
  return value;
}
const positive = await measureAllocations(escapingControl, {
  calls: 100000, warmup: 50000, samplingWarmup: 10000, samplingInterval: 256,
  targetFrame: { functionName: 'escapingControl', url: import.meta.url },
});
writeFileSync(output, JSON.stringify({
  entry, cpu, allocation, positive, checksum,
  qualification: 'World-owned f32/u32/entity array scalar reads; separate ordinary CPU and collected-object sampling. Positive escaping control rejects a missing sampler. Not whole-Worker or retained-object acceptance.',
}, null, 2) + '\n');
assert(positive.bytesPerCall > 8, 'Allocation positive control was not observed');
assert(allocation.bytesPerCall <= 8, `Scalar array reads allocated ${allocation.bytesPerCall.toFixed(2)} sampled B/read; budget 8`);
