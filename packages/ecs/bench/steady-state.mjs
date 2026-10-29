// Steady-state change workload: per-frame time, allocated bytes and retained heap.
//
//   pnpm --filter @forgeax/engine-ecs build
//   node --expose-gc packages/ecs/bench/steady-state.mjs [COUNTS] [DIRTY] [range|set] [view|get] [OUTPUT.json]
//
// COUNTS and DIRTY are comma lists (default 10000,100000,1000000 and 8,100,1000).
// One frame = D pose writes, D/8 sparse-tag flips (residual set bounded at
// 4096), D/10 flag writes, 4 spawns and 4 despawns, then one `Update` run:
// a changed-pose row query, a StateProjection batch over the low-frequency
// components and a residual query.
// `allocated` comes from v8 total_allocated_bytes, read only around the whole
// sample (each read itself allocates ~100 KB); `retained` is the forced-GC
// heap+ArrayBuffer growth across all sampled frames (a leak signal).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';

assert.ok(globalThis.gc, 'Run with node --expose-gc');
const [
  countArg = '10000,100000,1000000',
  dirtyArg = '8,100,1000',
  poseMode = 'range',
  readMode = 'view',
  output,
] = process.argv.slice(2);
assert.ok(poseMode === 'range' || poseMode === 'set', 'pose writes are range or set');
assert.ok(readMode === 'view' || readMode === 'get', 'pose reads are view or get');
const counts = countArg.split(',').map(Number);
const dirties = dirtyArg.split(',').map(Number);
// ECS_DIST=<dir> compares another build of this package (for example a baseline).
const dist = process.env.ECS_DIST
  ? new URL(`file://${process.env.ECS_DIST.replace(/\/?$/, '/')}`)
  : new URL('../dist/', import.meta.url);
const { World, defineComponent, Update } = await import(new URL('index.mjs', dist));
const { createStateProjection, readRenderArrayView } = await import(
  new URL('projection/index.mjs', dist),
);

const Source = defineComponent('BenchSource', { world: 'u32', entity: 'u32' });
const Pose = defineComponent('BenchPose', { world: 'array<f32, 16>' });
const Geometry = defineComponent('BenchGeometry', { mesh: 'u32', layer: 'u32' });
const Materials = defineComponent('BenchMaterials', { handles: 'array<u32>' });
const Flags = defineComponent('BenchFlags', {
  bits: 'u32',
  shadowChannels: 'u32',
  lightingChannels: 'u32',
});
const Row = defineComponent('BenchRow', { primitive: 'u32', prevIndex: 'u32', stamp: 'u32' });
const Residual = defineComponent('BenchResidual', {}, { storage: 'sparse' });
const schedule = Update;
const RESIDUAL = 4096;

const allocated = () => getHeapStatistics().total_allocated_bytes;
const retainedBytes = () => {
  for (let i = 0; i < 4; i++) globalThis.gc();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
};
const median = (values) => values.toSorted((a, b) => a - b)[values.length >> 1];
const p95 = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length * 0.95)];

const pose = new Float32Array(16);
const materials = new Uint32Array([7, 9]);
function spawn(world, i) {
  pose[12] = i;
  return world
    .spawn(
      { component: Source, data: { world: 1, entity: i } },
      { component: Pose, data: { world: pose } },
      { component: Geometry, data: { mesh: i & 255, layer: 0 } },
      { component: Materials, data: { handles: materials } },
      { component: Flags, data: { bits: 1, shadowChannels: 1, lightingChannels: 1 } },
      { component: Row, data: { primitive: i, prevIndex: 0, stamp: 0 } },
    )
    .unwrap();
}

const results = [];
for (const count of counts) {
  const before = retainedBytes();
  const world = new World();
  const entities = new Array(count);
  for (let i = 0; i < count; i++) entities[i] = spawn(world, i);
  const heapPerEntity = (retainedBytes() - before) / count;
  let sink = 0;
  let projectedRows = 0;
  const projection = createStateProjection(world, [Geometry, Materials, Flags]);
  projection.read().accept();
  world
    .addSystem(schedule, {
      name: 'pose',
      queries: [{ read: [Pose], changed: [Pose] }],
      fn: (_world, [changed]) => {
        if (readMode === 'get') for (const row of changed) sink += row.get(Pose).world[12];
        else
          for (const row of changed)
            sink += readRenderArrayView(world, row.entity, Pose, 'world')?.[12] ?? 0;
      },
    })
    .unwrap();
  world
    .addSystem(schedule, {
      name: 'geometry',
      after: ['pose'],
      queries: [],
      fn: () => {
        const batch = projection.read();
        projectedRows += batch.indices.length;
        batch.accept();
      },
    })
    .unwrap();
  world
    .addSystem(schedule, {
      name: 'residual',
      after: ['geometry'],
      queries: [{ read: [Row], with: [Residual] }],
      fn: (_world, [residual]) => {
        for (const row of residual) sink += row.entity & 1;
      },
    })
    .unwrap();
  world.update(0).unwrap();
  let spawned = count;
  const residual = new Array(RESIDUAL);
  let residualAt = 0;
  let cursor = 0;
  for (const dirty of dirties) {
    const tags = Math.max(1, dirty >> 3);
    const flags = Math.max(1, (dirty / 10) | 0);
    const phases = { pose: 0, tags: 0, flags: 0, churn: 0, run: 0 };
    const frame = (sampled) => {
      let t = performance.now();
      const lap = (phase) => {
        const now = performance.now();
        if (sampled) phases[phase] += now - t;
        t = now;
      };
      for (let i = 0; i < dirty; i++) {
        const entity = entities[(cursor = (cursor + 7919) % entities.length)];
        pose[12] = i;
        if (poseMode === 'range') world.setArrayRange(entity, Pose, 'world', 0, pose).unwrap();
        else world.set(entity, Pose, { world: pose }).unwrap();
      }
      lap('pose');
      // Residual membership stays bounded (RESIDUAL entities): each flip tags
      // one entity and untags the oldest still-live member.
      for (let i = 0; i < tags; i++) {
        const entity = entities[(cursor = (cursor + 104729) % entities.length)];
        if (world.hasComponent(entity, Residual)) continue;
        world.addComponent(entity, { component: Residual, data: {} }).unwrap();
        const evicted = residual[residualAt];
        residual[residualAt] = entity;
        residualAt = (residualAt + 1) % RESIDUAL;
        if (evicted !== undefined && world.hasComponent(evicted, Residual))
          world.removeComponent(evicted, Residual).unwrap();
      }
      lap('tags');
      for (let i = 0; i < flags; i++) {
        const entity = entities[(cursor = (cursor + 15485863) % entities.length)];
        world.set(entity, Flags, { bits: (cursor & 7) + 1 }).unwrap();
      }
      lap('flags');
      for (let i = 0; i < 4; i++) {
        const at = (cursor = (cursor + 31) % entities.length);
        world.despawn(entities[at]).unwrap();
        entities[at] = spawn(world, spawned++);
      }
      lap('churn');
      world.update(0).unwrap();
      lap('run');
    };
    for (let i = 0; i < 60; i++) frame(false);
    const samples = 200;
    const retainedBefore = retainedBytes();
    const times = [];
    const startBytes = allocated();
    for (let i = 0; i < samples; i++) {
      const started = performance.now();
      frame(true);
      times.push(performance.now() - started);
    }
    const allocatedPerFrame = (allocated() - startBytes) / samples;
    const retainedGrowth = retainedBytes() - retainedBefore;
    const row = {
      count,
      dirty,
      poseMode,
      readMode,
      frameMsMedian: +median(times).toFixed(4),
      frameMsP95: +p95(times).toFixed(4),
      allocatedPerFrame: Math.round(allocatedPerFrame),
      allocatedPerDirty: +(allocatedPerFrame / dirty).toFixed(1),
      retainedGrowthPerFrame: Math.round(retainedGrowth / samples),
      heapPerEntity: Math.round(heapPerEntity),
      phaseMs: Object.fromEntries(
        Object.entries(phases).map(([k, v]) => [k, +(v / samples).toFixed(4)]),
      ),
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }
  assert.ok(sink !== Number.NEGATIVE_INFINITY && projectedRows >= 0);
}
if (output !== undefined) {
  writeFileSync(
    output,
    `${JSON.stringify({ node: process.version, boundary: 'Node forced-GC diagnostic; allocated = v8 total_allocated_bytes', results }, null, 2)}\n`,
  );
}
