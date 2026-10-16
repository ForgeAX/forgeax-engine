import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, loadavg, platform, release } from 'node:os';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { Path, PathFollower, pathPlugin } from '../dist/index.mjs';

// Same controls/table/time step as the frozen static-World benchmark. This
// separate diagnostic includes invalidation and all shared-table replacements.
const definition = {
  points: Float32Array.from([0, 0, 0, 0.2, 4, 0, 1, 4.2, 2, 7, 1, -1, 8, 0, 0]),
  closed: true,
  parameterization: 1,
  subdivisions: 2048,
  up: Float32Array.from([0, 1, 0]),
};
const points = definition.points.slice(),
  results = [];
for (const count of [100, 1000]) {
  for (const pathCount of [1, 10]) {
    for (let round = 0; round < 3; round++) {
      const world = new World({ time: { fixedDeltaSeconds: 1 / 60 } });
      const context = await createWorldContext(world, [pathPlugin()]);
      const paths = Array.from({ length: pathCount }, () =>
        world.spawn({ component: Path, data: definition }).unwrap(),
      );
      const followers = Array.from({ length: count }, (_, i) =>
        world
          .spawn({
            component: PathFollower,
            data: {
              path: paths[i % pathCount],
              distance: i * 0.01,
              speed: 2,
              loop: true,
            },
          })
          .unwrap(),
      );
      world.update(1 / 60).unwrap();
      const rawMs = [];
      try {
        for (let i = 0; i < 300; i++) {
          points[4] = 4 + (i % 2) * 0.01;
          const start = performance.now();
          for (const path of paths) world.set(path, Path, { points }).unwrap();
          world.update(1 / 60).unwrap();
          if (i >= 60) rawMs.push(performance.now() - start);
        }
        const enabled = Array.from(world.query({ read: [PathFollower] }).unwrap()).length;
        if (enabled !== count) throw new Error('Rebuild benchmark lost enabled followers');
        const sorted = rawMs.slice().sort((a, b) => a - b);
        results.push({
          count,
          pathCount,
          round,
          enabled,
          rawMs,
          p50Ms: sorted[120],
          p95Ms: sorted[228],
          maxMs: sorted.at(-1),
        });
      } finally {
        for (const entity of [...followers, ...paths]) world.despawn(entity).unwrap();
        await context.fiber.dispose();
      }
    }
  }
}
const outputDirectory = new URL('../../../artifacts/path-bench/', import.meta.url);
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  new URL('rebuild.json', outputDirectory),
  `${JSON.stringify(
    {
      hardware: {
        cpu: cpus()[0]?.model,
        cores: cpus().length,
        loadAverage: loadavg(),
        platform: platform(),
        release: release(),
        node: process.version,
        backend: 'CPU / real ECS World',
      },
      contract: {
        warmup: 60,
        samples: 240,
        rounds: 3,
        subdivisions: 2048,
        change: 'Every Path control Y alternates 4 / 4.01 via World.set before each fixed frame',
        scope:
          'Diagnostic wall time includes author writes, all table rebuilds, all followers and Scene propagation; no new acceptance budget or static-frame replacement.',
      },
      results,
    },
    null,
    2,
  )}\n`,
);
