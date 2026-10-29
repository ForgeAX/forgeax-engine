import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createWorldContext, FixedUpdate, FixedTime, World } from '@forgeax/engine-ecs';
import {
  scenePlugin,
  Transform,
  TransformInterpolation,
  readPresentationWorldMatrix,
} from '../dist/index.mjs';
if (typeof process.threadCpuUsage !== 'function')
  throw Error('This opt-in CPU benchmark requires process.threadCpuUsage');
const world = new World();
const context = await createWorldContext(world, [scenePlugin()]);
const entities = [];
const count = 2304;
for (let i = 0; i < count; i++)
  entities.push(
    world
      .spawn(
        { component: Transform, data: { pos: [i, 0, 0] } },
        { component: TransformInterpolation, data: {} },
      )
      .unwrap(),
  );
let move = true;
world
  .addSystem(FixedUpdate, {
    name: 'controlled-fixed-writer',
    queries: [],
    fn: () => {
      if (!move) return;
      const tick = world.getResource(FixedTime).tick;
      for (let i = 0; i < entities.length; i++)
        world
          .set(entities[i], Transform, {
            pos: [i + tick * 0.01, Math.sin(tick * 0.01), 0],
            quat: [0, Math.sin(tick * 0.001), 0, Math.cos(tick * 0.001)],
          })
          .unwrap();
    },
  })
  .unwrap();
const phaseRows = [];
const rows = [];
let active;
const internal = world[Symbol.for('forgeax.ecs.worldInternal')];
const restores = [];
for (const schedule of internal.getSchedules().values())
  for (const [name, record] of schedule.systems) {
    if (!['captureTransformCurrent', 'captureTransformPrevious'].includes(name)) continue;
    const original = record.descriptor;
    record.descriptor = {
      ...original,
      fn(...args) {
        const start = performance.now();
        try {
          return original.fn(...args);
        } finally {
          if (active) active[name] = (active[name] ?? 0) + performance.now() - start;
        }
      },
    };
    restores.push(() => (record.descriptor = original));
  }
if (restores.length !== 2) throw Error('Expected both Scene capture producers');
try {
  for (let frame = 0; frame < 105; frame++) {
    active = { frame };
    const beforeTick = world.getResource(FixedTime).tick;
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    world.update(4 / 60).unwrap();
    active.updateWallMs = performance.now() - start;
    active.steps = world.getResource(FixedTime).tick - beforeTick;
    if (active.steps !== 4) throw Error('Expected four fixed steps per update');
    const used = process.threadCpuUsage(cpu);
    active.updateThreadCpuMs = (used.user + used.system) / 1000;
    if (frame >= 15) rows.push(active);
    active = null;
  }
  const movingPose = entities.map((entity) =>
    Array.from(readPresentationWorldMatrix(world, entity)),
  );
  move = false;
  world.update(1 / 60).unwrap();
  const settledPose = entities.map((entity) =>
    Array.from(readPresentationWorldMatrix(world, entity)),
  );
  const stats = (key) => {
    const a = rows.map((x) => x[key]).sort((a, b) => a - b);
    return { mean: a.reduce((a, b) => a + b, 0) / a.length, p50: a[44], p95: a[85] };
  };
  console.log(
    JSON.stringify(
      {
        note: 'Real Scene lifecycle and fixed writers; phase observation uses existing ECS schedule records. CPU microbenchmark, not game FPS.',
        environment: { node: process.version, cpu: cpus()[0]?.model },
        workload: {
          movingInterpolatedBodies: count,
          stepsPerUpdate: 4,
          measuredUpdates: 90,
          measuredFixedSteps: rows.reduce((sum, row) => sum + row.steps, 0),
        },
        updateWallMs: stats('updateWallMs'),
        updateThreadCpuMs: stats('updateThreadCpuMs'),
        captureCurrentMs: stats('captureTransformCurrent'),
        capturePreviousMs: stats('captureTransformPrevious'),
        movingDigest: createHash('sha256').update(JSON.stringify(movingPose)).digest('hex'),
        stoppedDigest: createHash('sha256').update(JSON.stringify(settledPose)).digest('hex'),
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  for (const restore of restores) restore();
  await context.fiber.dispose();
}
