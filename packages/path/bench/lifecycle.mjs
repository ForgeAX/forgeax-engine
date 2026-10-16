import { mkdir, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { Path, PathFollower, pathPlugin } from '../dist/index.mjs';

const definition = { points: [0, 0, 0, 0.2, 4, 0, 1, 4.2, 2, 7, 1, -1, 8, 0, 0], closed: true };
function memory() {
  global.gc();
  const value = process.memoryUsage();
  return { heapUsed: value.heapUsed, arrayBuffers: value.arrayBuffers };
}
async function round(count = 1000, replacements = 64) {
  const world = new World({ time: { fixedDeltaSeconds: 1 / 60 } }),
    context = await createWorldContext(world, [pathPlugin()]);
  const path = world.spawn({ component: Path, data: definition }).unwrap();
  for (let i = 0; i < count; i++)
    world
      .spawn({ component: PathFollower, data: { path, distance: i * 0.01, speed: 2, loop: true } })
      .unwrap();
  world.update(1 / 60).unwrap();
  const snapshots = [];
  for (let i = 0; i < replacements; i++) {
    world
      .set(path, Path, {
        points: definition.points.map((v, j) => (j === 4 ? v + (i % 2) * 0.1 : v)),
        subdivisions: i % 2 ? 2048 : 4096,
      })
      .unwrap();
    world
      .set(path, Transform, { scale: [1, 1 + (i % 2) * 0.1, 1], pos: [i * 0.01, 0, 0] })
      .unwrap();
    world.update(1 / 60).unwrap();
    if (i % 16 === 15) snapshots.push({ replacement: i + 1, ...memory() });
  }
  const inspector = new Session();
  inspector.connect();
  await inspector.post('HeapProfiler.startSampling', {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < 120; i++) world.update(1 / 60).unwrap();
  const profile = await inspector.post('HeapProfiler.stopSampling');
  inspector.disconnect();
  const rows = [];
  function walk(node) {
    if (node.selfSize)
      rows.push({
        bytes: node.selfSize,
        function: node.callFrame.functionName,
        url: node.callFrame.url,
      });
    for (const child of node.children ?? []) walk(child);
  }
  walk(profile.profile.head);
  const followers = Array.from(world.query({ read: [PathFollower] }).unwrap(), (row) => row.entity);
  for (const entity of followers) world.despawn(entity).unwrap();
  world.despawn(path).unwrap();
  world.update(1 / 60).unwrap();
  await context.fiber.dispose();
  if (world.inspect().systems.some((s) => s.name === 'path/follow'))
    throw new Error('System survived detach');
  return {
    count,
    replacements,
    snapshots,
    allocation: {
      method:
        'V8 statistical HeapProfiler; 512-byte sampling, collected allocations included; instrumentation run separate from timings',
      frames: 120,
      estimatedBytes: rows.reduce((n, r) => n + r.bytes, 0),
      rows,
    },
  };
}
// Warm module/World caches separately from retained-buffer measurement.
await round(100, 4);
const baseline = memory(),
  rounds = [];
for (let i = 0; i < 4; i++) {
  rounds.push(await round());
  rounds.at(-1).afterDetach = memory();
}
const final = memory();
const report = {
  node: process.version,
  baseline,
  final,
  retainedArrayBuffersDelta: final.arrayBuffers - baseline.arrayBuffers,
  contract: {
    rounds: 4,
    replacementsPerRound: 64,
    followersPerRound: 1000,
    maxRetainedArrayBufferDelta: 1048576,
  },
  rounds,
};
const outputDirectory = new URL('../../../artifacts/path-bench/', import.meta.url);
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  new URL('lifecycle.json', outputDirectory),
  `${JSON.stringify(report, null, 2)}\n`,
);
if (report.retainedArrayBuffersDelta > report.contract.maxRetainedArrayBufferDelta)
  throw new Error('Retained buffer gate failed');
