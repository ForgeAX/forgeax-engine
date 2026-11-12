// Complete Scene capture, hierarchy propagation and presentation publication owner.
// node --expose-gc presentation-allocation.mjs SCENE_ENTRY.mjs OUTPUT.json
// Run matched entries serially, retaining every ordinary CPU round and sample.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createWorldContext, FixedTime, FixedUpdate, World } from '@forgeax/engine-ecs';
import { measureAllocations } from '../../../skills/forgeax-engine-performance/scripts/allocation_probe.mjs';
const [entry, output] = process.argv.slice(2);
assert(entry && output && globalThis.gc, 'Require scene entry, output and --expose-gc');
const { scenePlugin, Transform, TransformInterpolation, ChildOf, readPresentationWorldMatrix } =
  await import(pathToFileURL(entry));
const results = [];
for (const fixture of [
  { count: 1, active: 1, steps: 1 }, { count: 16, active: 16, steps: 1 },
  { count: 128, active: 1, steps: 4 }, { count: 128, active: 128, steps: 4 },
  { count: 128, active: 0, steps: 4 },
]) {
  const world = new World(), context = await createWorldContext(world, [scenePlugin()]);
  const roots = [], children = [];
  for (let index = 0; index < fixture.count; index++) {
    const root = world.spawn({ component: Transform, data: { pos: [index, 0, 0] } },
      { component: TransformInterpolation, data: {} }).unwrap();
    roots.push(root);
    children.push(world.spawn({ component: Transform, data: { pos: [0, 2, 0] } },
      { component: ChildOf, data: { parent: root } }).unwrap());
  }
  const pos = new Float32Array(3), patch = { pos };
  let fixedRuns = 0, calls = 0, moving = true;
  world.addSystem(FixedUpdate, { name: 'allocation-source-writer', commands: 'none', queries: [],
    fn() {
      fixedRuns++;
      if (!moving) return;
      const tick = world.getResource(FixedTime).tick;
      for (let index = 0; index < fixture.active; index++) {
        pos[0] = index + tick * 0.01; pos[1] = tick % 7; pos[2] = 0;
        world.set(roots[index], Transform, patch).unwrap();
      }
    },
  }).unwrap();
  const frame = () => { calls++; world.update(fixture.steps / 60).unwrap(); };
  const poses = (tick = world.getResource(FixedTime).tick - 1) => children.map((entity, index) => {
    const matrix = readPresentationWorldMatrix(world, entity);
    assert(matrix);
    const expectedX = index < fixture.active ? Math.fround(index + tick * 0.01) : index;
    assert(Math.abs(matrix[12] - expectedX) < 0.0001);
    return Array.from(matrix);
  });
  try {
    for (let warm = 0; warm < 80; warm++) frame();
    const cpuRounds = [];
    for (let round = 0; round < 7; round++) {
      const started = performance.now(), cpu = process.threadCpuUsage();
      for (let i = 0; i < 60; i++) frame();
      const used = process.threadCpuUsage(cpu);
      cpuRounds.push({ wallMsPerFrame: (performance.now() - started) / 60,
        threadCpuMsPerFrame: (used.user + used.system) / 60000 });
    }
    const allocation = await measureAllocations(frame, { calls: 200, warmup: 100, samplingWarmup: 50, samplingInterval: 1024 });
    assert.equal(fixedRuns, calls * fixture.steps);
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const movingDigest = digest(poses());
    const stoppedAtTick = world.getResource(FixedTime).tick;
    moving = false; frame();
    const stoppedDigest = digest(poses(stoppedAtTick));
    results.push({ fixture, calls, fixedRuns, cpuRounds, allocation, movingDigest, stoppedDigest });
  } finally { await context.fiber.dispose(); }
}
writeFileSync(output, JSON.stringify({ node: process.version, entry, sceneEntrySha256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
  interpretation: 'Node complete Scene owner. Ordinary thread CPU rounds and collected-object allocation sampling are separate. Child pose oracles cover moving and stopped settlement; no browser Worker, retained object census or FPS claim.', results }, null, 2) + '\n');
