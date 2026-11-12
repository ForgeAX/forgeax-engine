// Complete Update/FixedUpdate owner, including queries, gates and command draining.
// node --expose-gc schedule-windows.mjs ENTRY.mjs OUTPUT.json
// Run baseline/candidate serially in a preselected order; retain every raw round.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { measureAllocations } from '../../../skills/forgeax-engine-performance/scripts/allocation_probe.mjs';

const [entry, output] = process.argv.slice(2);
assert(entry && output && globalThis.gc, 'Require entry, output and --expose-gc');
const { World, defineComponent, Update, FixedUpdate } = await import(pathToFileURL(entry));
const Value = defineComponent('ScheduleWindowBenchValue', { x: 'f32' });
const results = [];
for (const mode of ['plain', 'queried', 'deferred', 'replaced']) {
  const world = new World();
  const entities = Array.from({ length: 32 }, (_, x) => world.spawn({ component: Value, data: { x } }).unwrap());
  let runs = 0, frames = 0, fixedRuns = 0;
  const deferred = mode === 'deferred';
  const plain = mode === 'plain';
  const producer = {
    name: 'before', before: [FixedUpdate], commands: deferred ? 'deferred' : 'none',
    queries: plain ? [] : [{ write: [Value] }],
    fn(_world, queries) {
      runs++;
      if (plain) return;
      for (const span of queries[0].spans().unwrap()) {
        const values = span.mut(Value).x;
        for (let i = 0; i < span.length; i++) values[i]++;
      }
    },
  };
  world.addSystem(Update, producer).unwrap();
  world.addSystem(FixedUpdate, {
    name: 'fixed', commands: 'none', queries: [], fn() { fixedRuns++; },
  }).unwrap();
  world.addSystem(Update, {
    name: 'after', after: [FixedUpdate], commands: deferred ? 'deferred' : 'none',
    queries: [], runIf: () => true, fn() { runs++; },
  }).unwrap();
  const frame = () => {
    if (mode === 'replaced' && frames % 64 === 0) world.replaceSystem(Update, 'before', producer).unwrap();
    frames++;
    world.update(1 / 60).unwrap();
  };
  for (let i = 0; i < 4000; i++) frame();
  const cpuRounds = [];
  for (let round = 0; round < 7; round++) {
    const cpu = process.cpuUsage(), start = performance.now();
    for (let i = 0; i < 10000; i++) frame();
    const used = process.cpuUsage(cpu);
    cpuRounds.push({ wallUsPerFrame: (performance.now() - start) / 10,
      processCpuUsPerFrame: (used.user + used.system) / 10000 });
  }
  const allocation = await measureAllocations(frame, {
    calls: 4000, warmup: 2000, samplingWarmup: 1000, samplingInterval: 1024,
  });
  assert.equal(runs, frames * 2);
  assert.equal(fixedRuns, frames);
  assert.equal(world.get(entities[0], Value).unwrap().x, plain ? 0 : frames);
  results.push({ mode, frames, runs, fixedRuns, cpuRounds, allocation });
}
writeFileSync(output, JSON.stringify({ entry, node: process.version,
  boundary: 'Node complete schedule owner; ordinary CPU rounds are separate from allocation sampling. Not game/Worker/GPU acceptance. process.cpuUsage covers this process, not wall time.', results }, null, 2) + '\n');
