import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, loadavg, platform, release } from 'node:os';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { createPathSample, Path, PathFollower, pathPlugin, preparePath } from '../dist/index.mjs';

const definition = {
  points: Float32Array.from([0, 0, 0, 0.2, 4, 0, 1, 4.2, 2, 7, 1, -1, 8, 0, 0]),
  closed: true,
  parameterization: 1,
  subdivisions: 2048,
  up: Float32Array.from([0, 1, 0]),
};
const sample = createPathSample(),
  prepared = preparePath(definition).unwrap();
const results = [];
function measure(label, run, count = 240) {
  for (let i = 0; i < 60; i++) run(i);
  const values = [];
  for (let i = 0; i < count; i++) {
    const begin = performance.now();
    run(i);
    values.push(performance.now() - begin);
  }
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    label,
    samples: count,
    rawMs: values,
    p50Ms: sorted[Math.floor(count * 0.5)],
    p95Ms: sorted[Math.floor(count * 0.95)],
    maxMs: sorted.at(-1),
  };
}
results.push(measure('prepare-one-2048', () => preparePath(definition).unwrap(), 60));
for (const count of [100, 1000]) {
  results.push(
    measure(`lookup-${count}`, (i) => {
      for (let j = 0; j < count; j++)
        prepared.parameterAtDistance(((i + j) * 0.1) % prepared.length);
    }),
  );
  results.push(
    measure(`sample-with-orientation-${count}`, (i) => {
      for (let j = 0; j < count; j++) prepared.sample(sample, ((i + j) * 0.1) % prepared.length);
    }),
  );
  for (const pathCount of [1, 10])
    for (let round = 0; round < 3; round++) {
      const world = new World({ time: { fixedDeltaSeconds: 1 / 60 } }),
        context = await createWorldContext(world, [pathPlugin()]);
      const paths = Array.from({ length: pathCount }, () =>
        world.spawn({ component: Path, data: definition }).unwrap(),
      );
      const entities = Array.from({ length: count }, (_, j) =>
        world
          .spawn({
            component: PathFollower,
            data: { path: paths[j % pathCount], distance: j * 0.01, speed: 2, loop: true },
          })
          .unwrap(),
      );
      const first = performance.now();
      world.update(1 / 60).unwrap();
      const preparationFrameMs = performance.now() - first;
      global.gc?.();
      const before = process.memoryUsage();
      const frame = measure(`world-${count}-paths-${pathCount}-round-${round}`, () =>
        world.update(1 / 60).unwrap(),
      );
      global.gc?.();
      const after = process.memoryUsage();
      results.push({
        ...frame,
        entities: Array.from(world.query({ read: [PathFollower] }).unwrap()).length,
        preparationFrameMs,
        retainedHeapDelta: after.heapUsed - before.heapUsed,
        retainedArrayBuffersDelta: after.arrayBuffers - before.arrayBuffers,
      });
      // Isolate source writes plus propagation, while the follower system is idle.
      for (const entity of entities) world.set(entity, PathFollower, { paused: true }).unwrap();
      results.push(
        measure(`writes-${count}-paths-${pathCount}-round-${round}`, (i) => {
          sample.position[0] = i * 0.001;
          for (const entity of entities)
            world.set(entity, Transform, { pos: sample.position }).unwrap();
        }),
      );
      results.push(
        measure(`writes-and-propagation-${count}-paths-${pathCount}-round-${round}`, (i) => {
          sample.position[0] = i * 0.001;
          for (const entity of entities)
            world.set(entity, Transform, { pos: sample.position }).unwrap();
          propagateTransforms(world).unwrap();
        }),
      );
      await context.fiber.dispose();
    }
}
const report = {
  hardware: {
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    loadAverage: loadavg(),
    platform: platform(),
    release: release(),
    node: process.version,
    backend: 'CPU / real ECS World',
  },
  contract: { warmup: 60, samples: 240, rounds: 3, fullWorld1000P95Ms: 8, prepareP95Ms: 30 },
  results,
};
const outputDirectory = new URL('../../../artifacts/path-bench/', import.meta.url);
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  new URL('performance.json', outputDirectory),
  `${JSON.stringify(report, null, 2)}\n`,
);
const failed = results.filter(
  (r) =>
    (r.label.startsWith('world-1000') && r.p95Ms > 8) ||
    (r.label === 'prepare-one-2048' && r.p95Ms > 30),
);
if (failed.length) process.exitCode = 1;
