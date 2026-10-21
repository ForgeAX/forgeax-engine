import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [checkout, output, size = '100000'] = process.argv.slice(2);
assert.ok(checkout && output && globalThis.gc, 'Use node --expose-gc change-storage.mjs CHECKOUT OUTPUT COUNT');
const count = Number(size);
assert.ok(Number.isSafeInteger(count) && count > 0);
const root = resolve(checkout);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const artifactPaths = ['packages/ecs/dist/index.mjs', 'packages/ecs/dist/projection/index.mjs'];
const identity = {
  source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  artifacts: artifactPaths.map(path => ({ path, sha256: hash(readFileSync(resolve(root, path))) })),
  carrierSha256: hash(readFileSync(new URL(import.meta.url))),
  node: process.version,
};
const { World, defineComponent } = await import(pathToFileURL(resolve(root, artifactPaths[0])));
const { createStateProjection } = await import(pathToFileURL(resolve(root, artifactPaths[1])));
const Value = defineComponent('ChangeStorageValue', { x: 'f32' });
const phases = [];
const sample = phase => {
  globalThis.gc();
  globalThis.gc();
  phases.push({ phase, ...process.memoryUsage() });
};
sample('loaded');
const world = new World();
const entities = [];
const coldStart = performance.now();
for (let i = 0; i < count; i++) entities.push(world.spawn({ component: Value, data: { x: i } }).unwrap());
const coldMs = performance.now() - coldStart;
sample('live');
const projection = createStateProjection(world, [Value]);
projection.read().accept();
sample('accepted-projection');
for (let i = 0; i < 100_000; i++) world.set(entities[i % count], Value, { x: -i - 1 }).unwrap();
projection.read().accept();
sample('after-repeated-writes');
for (const entity of entities) world.removeComponent(entity, Value).unwrap();
let removal = projection.read();
assert.equal(removal.indices.length, count);
removal.accept();
removal = undefined;
sample('component-retired');
for (const entity of entities) world.despawn(entity).unwrap();
projection.read().accept();
sample('entities-retired');
// Keep the World/projection alive through the final sample; this measures
// owned retained capacity, not whether the entire graph can be collected.
assert.equal(projection.entity(entities[0] & 0xffffff), undefined);
writeFileSync(output, JSON.stringify({
  identity, count, coldMs, phases,
  boundary: 'Forced-GC Node source retention diagnostic; external includes arrayBuffers; not allocation throughput, natural GC or Worker evidence',
}, null, 2) + '\n');
console.log(JSON.stringify({ output, count, coldMs, phases }));
