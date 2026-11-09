// Complete Query span owner; run versions serially with --expose-gc.
// node query-span-traversal.mjs ENTRY.mjs PRIVATE_OUTPUT.json
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { measureAllocations } from '../../../skills/forgeax-engine-performance/scripts/allocation_probe.mjs';
const [entry, output] = process.argv.slice(2);
assert(entry && output && globalThis.gc, 'Require built entry, private output and --expose-gc');
const { World, defineComponent } = await import(entry),
  results = [];
let sink = 0;
for (const mode of ['empty', 'dense', 'changed', 'partial', 'cold']) {
  const Position = defineComponent('SpanOwner' + mode, { x: 'f32' }),
    world = new World();
  const entities =
    mode === 'empty'
      ? []
      : Array.from({ length: 64 }, (_, x) =>
          world.spawn({ component: Position, data: { x } }).unwrap(),
        );
  let query = world
      .query({ read: [Position], ...(mode === 'changed' ? { changed: [Position] } : {}) })
      .unwrap(),
    frame = 0;
  function spanOwner() {
    frame++;
    if (mode === 'cold') query = world.query({ read: [Position] }).unwrap();
    if (mode === 'changed') world.set(entities[frame % 64], Position, { x: frame }).unwrap();
    for (const span of query.spans().unwrap()) {
      const values = span.get(Position).x;
      for (let i = 0; i < span.length; i++) sink += values[i];
      if (mode === 'partial') break;
    }
  }
  for (let i = 0; i < 10000; i++) spanOwner();
  const cpu = [];
  for (let r = 0; r < 9; r++) {
    const before = process.threadCpuUsage(),
      start = performance.now();
    for (let i = 0; i < 10000; i++) spanOwner();
    const used = process.threadCpuUsage(before);
    cpu.push({
      threadUs: (used.user + used.system) / 10000,
      wallUs: ((performance.now() - start) * 1000) / 10000,
    });
  }
  const allocation = await measureAllocations(spanOwner, {
    calls: 10000,
    warmup: 5000,
    samplingWarmup: 1000,
    samplingInterval: 256,
    targetFrame: { functionName: 'spanOwner', url: import.meta.url },
  });
  results.push({ mode, cpu, allocation });
}
assert(sink > 0);
const ring = [];
function escapingControl(index) {
  const value = { index };
  ring[index % 1024] = value;
  return value;
}
const positive = await measureAllocations(escapingControl, {
  calls: 10000,
  warmup: 5000,
  samplingWarmup: 1000,
  samplingInterval: 256,
  targetFrame: { functionName: 'escapingControl', url: import.meta.url },
});
writeFileSync(
  output,
  JSON.stringify(
    {
      entry,
      sha256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
      results,
      sink,
      positive,
      qualification:
        'Complete query traversal owner: World reads/writes, numeric span shapes, changed/empty/early-close and cold descriptor construction. Public span/result values remain independent; no whole-Worker claim. Ordinary thread CPU separate from allocation sampling.',
    },
    null,
    2,
  ) + '\n',
);
assert(positive.bytesPerCall > 16, 'Allocation positive control was not observed');
const empty = results.find((row) => row.mode === 'empty').allocation.bytesPerCall;
assert(empty <= 224, `Empty span traversal allocated ${empty.toFixed(2)} B/call; budget 224`);
