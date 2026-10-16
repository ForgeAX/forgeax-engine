// Diagnostic only: wall time stays the acceptance clock; CPU/GC explain tails.

import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { PerformanceObserver } from 'node:perf_hooks';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { Path, PathFollower, pathPlugin } from '../dist/index.mjs';

const gc = [],
  observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      gc.push({ start: entry.startTime, duration: entry.duration, kind: entry.detail.kind });
  });
observer.observe({ entryTypes: ['gc'] });
const cpu = process.threadCpuUsage?.bind(process) ?? process.cpuUsage.bind(process);
const results = [];
const definition = { points: [0, 0, 0, 0.2, 4, 0, 1, 4.2, 2, 7, 1, -1, 8, 0, 0], closed: true };
for (const pacing of ['burst', 'host-yield'])
  for (let round = 0; round < 3; round++) {
    const world = new World({ time: { fixedDeltaSeconds: 1 / 60 } }),
      context = await createWorldContext(world, [pathPlugin()]);
    const path = world.spawn({ component: Path, data: definition }).unwrap();
    const entities = Array.from({ length: 1000 }, (_, i) =>
      world
        .spawn({
          component: PathFollower,
          data: { path, distance: i * 0.01, speed: 2, loop: true },
        })
        .unwrap(),
    );
    for (let i = 0; i < 60; i++) world.update(1 / 60).unwrap();
    const samples = [];
    for (let i = 0; i < 240; i++) {
      const before = cpu(),
        start = performance.now();
      world.update(1 / 60).unwrap();
      const end = performance.now(),
        after = cpu();
      samples.push({
        start,
        end,
        wallMs: end - start,
        cpuMs: (after.user + after.system - before.user - before.system) / 1000,
      });
      if (pacing === 'host-yield') await new Promise(setImmediate);
    }
    const count = Array.from(world.query({ read: [PathFollower] }).unwrap()).length;
    for (const entity of entities) world.despawn(entity).unwrap();
    world.despawn(path).unwrap();
    world.update(1 / 60).unwrap();
    await context.fiber.dispose();
    await new Promise(setImmediate);
    for (const sample of samples) {
      sample.gcMs = gc.reduce(
        (sum, entry) =>
          sum +
          Math.max(
            0,
            Math.min(sample.end, entry.start + entry.duration) -
              Math.max(sample.start, entry.start),
          ),
        0,
      );
      sample.offThreadWallMs = Math.max(0, sample.wallMs - sample.cpuMs);
    }
    const quantile = (key, p) =>
      samples.map((row) => row[key]).sort((a, b) => a - b)[Math.floor(samples.length * p)];
    results.push({
      pacing,
      round,
      count,
      wallP50Ms: quantile('wallMs', 0.5),
      wallP95Ms: quantile('wallMs', 0.95),
      cpuP95Ms: quantile('cpuMs', 0.95),
      samples,
      overBudget: samples.filter((row) => row.wallMs > 8),
    });
  }
observer.disconnect();
const outputDirectory = new URL('../../../artifacts/path-bench/', import.meta.url);
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  new URL('contention.json', outputDirectory),
  `${JSON.stringify(
    {
      node: process.version,
      cpuScope: process.threadCpuUsage ? 'thread' : 'process',
      hardware: { cpu: cpus()[0]?.model, cores: cpus().length, loadAverage: loadavg() },
      acceptanceClock: 'wall; this diagnostic does not replace frozen benchmark',
      results,
    },
    null,
    2,
  )}\n`,
);
