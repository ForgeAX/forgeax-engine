// Actual public Query APIs, not a raw-storage ceiling experiment.
// node --expose-gc packages/ecs/bench/query-batches.mjs OUTPUT.json
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { measureAllocations } from '../../../skills/forgeax-engine-performance/scripts/allocation_probe.mjs';
import { World, defineComponent } from '../dist/index.mjs';
import { worldRead } from '../dist/world-read.mjs';

assert.equal(typeof globalThis.gc, 'function', 'Use --expose-gc');
const Position = defineComponent('BatchBenchPosition', { x: 'f32' });
const Tint = defineComponent('BatchBenchTint', { alpha: 'f32' });
const Active = defineComponent('BatchBenchActive', {}, { storage: 'sparse' });
const Shards = Array.from({ length: 8 }, (_, i) => defineComponent(`BatchBenchShard${i}`, {}));
const fixtures = [
  { count: 1000, selected: 1000, optional: false, sparse: false },
  { count: 10000, selected: 10000, optional: false, sparse: false },
  { count: 1000, selected: 1000, optional: true, sparse: false },
  { count: 10000, selected: 10000, optional: true, sparse: false },
  { count: 1000, selected: 10, optional: false, sparse: true },
  { count: 10000, selected: 5000, optional: false, sparse: true },
  { count: 10000, selected: 1000, optional: true, sparse: true },
  { count: 64, selected: 1, optional: false, sparse: true },
  { count: 256, selected: 256, optional: false, sparse: false, fragments: 256 },
];
let sink = 0;
const loops = 64;
const rounds = 7;
const results = [];
function retained() {
  for (let i = 0; i < 3; i++) globalThis.gc();
  const memory = process.memoryUsage();
  return memory.heapUsed + memory.arrayBuffers;
}
function exercise(fn, count) {
  for (let i = 0; i < count; i++) sink += fn();
}
function cpu(fn) {
  const start = performance.now();
  exercise(fn, loops);
  return (performance.now() - start) / loops;
}
for (const fixture of fixtures) {
  const world = new World();
  let expected = 0;
  for (let i = 0; i < fixture.count; i++) {
    const selected = i % (fixture.count / fixture.selected) === 0;
    const tinted = fixture.optional && i % 3 !== 0;
    const alpha = i % 5 === 0 ? 0 : 0.5;
    const entries = [{ component: Position, data: { x: i } }];
    if (tinted) entries.push({ component: Tint, data: { alpha } });
    if (fixture.sparse && selected) entries.push({ component: Active, data: {} });
    if (fixture.fragments !== undefined) {
      for (let bit = 0; bit < Shards.length; bit++) {
        if ((i & (1 << bit)) !== 0) entries.push({ component: Shards[bit], data: {} });
      }
    }
    world.spawn(...entries).unwrap();
    if (selected) expected += i * (tinted ? alpha : 1);
  }
  const query = world.query({ read: [Position], ...(fixture.optional ? { optional: [Tint] } : {}), ...(fixture.sparse ? { with: [Active] } : {}) }).unwrap();
  const batches = query.batches().unwrap();
  const reader = world[worldRead];
  const methods = {
    snapshots() {
      let total = 0;
      for (const row of query) {
        const x = row.get(Position).x;
        const tint = fixture.optional ? row.get(Tint) : undefined;
        total += x * (tint === undefined ? 1 : tint.alpha);
      }
      return total;
    },
    numericProbes() {
      let total = 0;
      for (const row of query) {
        const x = reader.getFieldValue(row.entity, Position, 'x');
        const alpha = fixture.optional ? reader.getFieldValue(row.entity, Tint, 'alpha') : undefined;
        if (x === undefined) throw new Error('Missing required Position.x');
        total += x * (alpha === undefined ? 1 : alpha);
      }
      return total;
    },
    batches() {
      let total = 0;
      for (const batch of batches) {
        const x = batch.read(Position, 'x');
        const alpha = fixture.optional ? batch.read(Tint, 'alpha') : undefined;
        if (batch.kind === 'range') {
          if (alpha === undefined) {
            for (let row = batch.start; row < batch.end; row++) total += x[row];
          } else {
            for (let row = batch.start; row < batch.end; row++) total += x[row] * alpha[row];
          }
        } else {
          const { rows, count } = batch;
          if (alpha === undefined) {
            for (let i = 0; i < count; i++) total += x[rows[i]];
          } else {
            for (let i = 0; i < count; i++) {
              const row = rows[i];
              total += x[row] * alpha[row];
            }
          }
        }
      }
      return total;
    },
  };
  if (!fixture.sparse && !fixture.optional) {
    const spanRanges = query.spans().unwrap();
    methods.spans = function spans() {
      let total = 0;
      for (const span of spanRanges) {
        const x = span.get(Position).x;
        for (let i = 0; i < span.length; i++) total += x[i];
      }
      return total;
    };
  }
  for (const fn of Object.values(methods)) {
    assert.equal(fn(), expected);
    exercise(fn, 200);
  }
  const batchEntities = [];
  for (const batch of batches) {
    if (batch.kind === 'range') {
      const entities = batch.entities;
      for (let row = batch.start; row < batch.end; row++) batchEntities.push(entities[row]);
    } else {
      const entities = batch.entities;
      const { rows, count } = batch;
      for (let i = 0; i < count; i++) batchEntities.push(entities[rows[i]]);
    }
  }
  assert.deepEqual(batchEntities, Array.from(query, row => row.entity));
  const names = Object.keys(methods);
  const times = Object.fromEntries(names.map(name => [name, []]));
  for (let round = 0; round < rounds; round++) {
    for (let n = 0; n < names.length; n++) {
      const name = names[(n + round) % names.length];
      times[name].push(cpu(methods[name]));
    }
  }
  const allocation = {};
  const retainedDelta = {};
  const calls = Math.max(16, Math.min(2000, Math.ceil(100000 / fixture.selected)));
  for (const name of names) {
    allocation[name] = await measureAllocations(methods[name], {
      calls: name === 'snapshots' ? calls : Math.max(64, Math.floor(10000 / (fixture.fragments ?? 1))),
      warmup: 32, samplingWarmup: 256, samplingInterval: 1024,
      includeProfile: process.argv.includes('--profiles'),
      targetFrame: { url: import.meta.url, functionName: methods[name].name },
    });
    const before = retained();
    exercise(methods[name], calls);
    retainedDelta[name] = retained() - before;
  }
  results.push({ fixture: { ...fixture, selection: 'evenly scattered physical rows' }, expected, matchingEntityOrder: true, cpuMsPerTraversal: times, allocation, retainedHeapAndArrayBuffersDelta: retainedDelta });
}
const report = {
  runtime: process.version,
  ecsDistSha256: createHash('sha256').update(readFileSync(new URL('../dist/index.mjs', import.meta.url))).digest('hex'),
  boundary: 'Warmed actual APIs on structurally frozen fixtures. CPU runs without inspector; Poisson allocation sampling includes collected objects. Signed retained deltas include GC/JIT noise. Not browser Worker or GPU acceptance.',
  loopsPerCpuRound: loops, rounds, results, sink,
};
writeFileSync(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${results.length} actual-API fixtures passed; ${process.argv[2]}\n`);
