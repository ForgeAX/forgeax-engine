import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [checkout, output, profile = 'sparse'] = process.argv.slice(2);
assert.ok(['sparse', 'dense', 'idle', 'churn'].includes(profile), 'Unknown source profile');
if (!checkout || !output) throw new Error('Usage: node change-projection.mjs CHECKOUT OUTPUT.json [sparse|dense|idle|churn]');
const root = resolve(checkout);
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const artifactPaths = ['packages/ecs/dist/index.mjs', 'packages/ecs/dist/projection/index.mjs'];
const sourceFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'packages/ecs/src'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
const sourceInventory = sourceFiles.map(path => ({ path, sha256: hash(resolve(root, path)) }));
const identity = {
  sourceInventorySha256: createHash('sha256').update(JSON.stringify(sourceInventory)).digest('hex'),
  sourceInventory,
  source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDiffSha256: createHash('sha256')
    .update(execFileSync('git', ['diff', 'HEAD', '--', 'packages/ecs/src'], { cwd: root }))
    .digest('hex'),
  artifacts: artifactPaths.map((path) => ({ path, sha256: hash(resolve(root, path)) })),
  carrierSha256: hash(new URL(import.meta.url)),
  node: process.version,
  cpu: cpus()[0]?.model,
};
const { World, defineComponent } = await import(pathToFileURL(resolve(root, artifactPaths[0])));
const { createStateProjection } = await import(pathToFileURL(resolve(root, artifactPaths[1])));
const Value = defineComponent('ChangeQualificationValue', { x: 'f32' });
const contract = {
  profile,
  counts: profile === 'dense' ? [1_000, 10_000] : [1_000, 10_000, 100_000],
  warmup: profile === 'dense' ? 60 : 120,
  samples: profile === 'dense' ? 120 : 240,
  writes: profile === 'dense' ? 'all' : profile === 'idle' ? 0 : 1,
};
const rows = [];
const statistics = (samples) => {
  const ordered = samples.toSorted((a, b) => a - b);
  return { median: ordered[ordered.length >> 1], p95: ordered[Math.floor(ordered.length * 0.95)] };
};
for (const count of contract.counts) {
  const world = new World();
  const entities = Array.from({ length: count }, (_, x) =>
    world.spawn({ component: Value, data: { x } }).unwrap(),
  );
  const projection = createStateProjection(world, [Value]);
  projection.read().accept();
  let checkedBlocks = 0,
    scannedRows = 0,
    checkedIndexEntries = 0,
    indexCounterAvailable = true;
  const times = [],
    writeTimes = [],
    readTimes = [];
  for (let step = 0; step < contract.warmup + contract.samples; step++) {
    const started = performance.now();
    const target = (step * 67) % count;
    if (profile === 'dense') {
      for (const entity of entities) world.set(entity, Value, { x: -step - 1 }).unwrap();
    } else if (profile === 'churn') {
      world.despawn(entities[target]).unwrap();
      entities[target] = world.spawn({ component: Value, data: { x: -step - 1 } }).unwrap();
    } else if (profile === 'sparse') {
      world.set(entities[target], Value, { x: -step - 1 }).unwrap();
    }
    const written = performance.now();
    const candidate = projection.read();
    if (profile === 'churn') {
      const targetIndex = entities[target] & 0xffffff;
      assert.ok(candidate.indices.includes(targetIndex));
      assert.equal(projection.entity(targetIndex), entities[target]);
      // The old block projection also forwards an unchanged swap neighbor.
      // Preserve that baseline work instead of weakening current-state checks.
      assert.ok(candidate.indices.length >= 1 && candidate.indices.length <= 2);
      if (typeof candidate.checkedIndexEntries === 'number') assert.equal(candidate.indices.length, 1);
    } else assert.equal(candidate.indices.length, profile === 'dense' ? count : profile === 'idle' ? 0 : 1);
    candidate.accept();
    const accepted = performance.now();
    if (step >= contract.warmup) {
      times.push(accepted - started);
      writeTimes.push(written - started);
      readTimes.push(accepted - written);
      checkedBlocks += candidate.checkedBlocks;
      indexCounterAvailable &&= typeof candidate.checkedIndexEntries === 'number';
      checkedIndexEntries += candidate.checkedIndexEntries ?? 0;
      scannedRows += candidate.scannedRows;
    }
  }
  rows.push({
    count,
    workload: `${profile}+projection-read+accept`,
    completed: times.length,
    checkedBlocks: checkedBlocks / times.length,
    scannedRows: scannedRows / times.length,
    checkedIndexEntries: indexCounterAvailable ? checkedIndexEntries / times.length : null,
    totalMs: statistics(times),
    writeMs: statistics(writeTimes),
    readMs: statistics(readTimes),
    samples: { times, writeTimes, readTimes },
  });
}
writeFileSync(
  output,
  `${JSON.stringify({ identity, contract, boundary: 'CPU source owner only; no Worker transport, Renderer, GPU or natural GC acceptance', rows }, null, 2)}\n`,
);
console.log(JSON.stringify(rows.map(({ samples: _samples, ...row }) => row)));
