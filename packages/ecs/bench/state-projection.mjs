// Complete current-state projection owner, including writes, discard and cold construction.
// node --expose-gc state-projection.mjs ENTRY.mjs PRIVATE_OUTPUT.json
// ENTRY exposes the ECS root; an optional createStateProjection export selects a matched source build.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { measureAllocations } from '../../../skills/forgeax-engine-performance/scripts/allocation_probe.mjs';
const [entry, output] = process.argv.slice(2);
assert(entry && output && globalThis.gc, 'Require entry, private output and --expose-gc');
const api = await import(pathToFileURL(entry));
const { World, defineComponent } = api;
const { createStateProjection } = api.createStateProjection ? api : await import('../dist/projection/index.mjs');
const results = [];
let sink = 0;
for (const mode of ['empty', 'quiet', 'moving', 'discard', 'held', 'cold']) {
  const Position = defineComponent('ProjectionOwner' + mode, { x: 'f32' });
  const world = new World();
  const entities = mode === 'empty' ? [] : Array.from({ length: 64 }, (_, x) => world.spawn({ component: Position, data: { x } }).unwrap());
  const components = [Position], patch = { x: 0 }, held = [];
  let projection = createStateProjection(world, components), frame = 0;
  function projectionOwner() {
    frame++;
    if (mode === 'cold') projection = createStateProjection(world, components);
    if (mode === 'moving' || mode === 'discard' || mode === 'held') {
      patch.x = frame;
      world.set(entities[frame % entities.length], Position, patch).unwrap();
    }
    const batch = projection.read();
    sink += batch.scannedRows + batch.indices.length;
    if (mode !== 'discard' || frame % 2 === 0) batch.accept();
    if (mode === 'held') held[frame % 32] = batch;
  }
  for (let i = 0; i < 5000; i++) projectionOwner();
  const cpu = [];
  for (let round = 0; round < 11; round++) {
    const before = process.threadCpuUsage(), start = performance.now();
    for (let i = 0; i < 1000; i++) projectionOwner();
    const used = process.threadCpuUsage(before);
    cpu.push({ threadUs: (used.user + used.system) / 1000, wallUs: performance.now() - start });
  }
  const allocation = await measureAllocations(projectionOwner, { calls: 5000, warmup: 2000, samplingWarmup: 500, samplingInterval: 128, targetFrame: { functionName: 'projectionOwner', url: import.meta.url } });
  const oracle = entities.map(entity => world.get(entity, Position).unwrap().x);
  projection.read().accept();
  assert.equal(projection.isCurrent(), true);
  results.push({ mode, cpu, allocation, oracle, frame });
}
const positive = [];
function positiveBox(i) { positive[i % 64] = { value: i }; }
const control = await measureAllocations(positiveBox, { calls: 10000, warmup: 5000, samplingWarmup: 1000, samplingInterval: 32, targetFrame: { functionName: 'positiveBox', url: import.meta.url } });
assert(control.attributedBytesPerCall > 16, 'Require a visible positive allocation control');
writeFileSync(output, JSON.stringify({ entry, sha256: createHash('sha256').update(readFileSync(entry)).digest('hex'), node: process.version, sink, results, control, qualification: 'Matched complete Node projection owner. Ordinary CPU and collected-object sampling are separate. Held stale candidates remain independent but their numeric indices retain the documented borrowed lifetime. Does not prove whole-Worker, retained object count, GC or FPS savings.' }, null, 2) + '\n');
