import { arch, cpus, platform } from 'node:os';
import { performance } from 'node:perf_hooks';
import { World } from '@forgeax/engine-ecs';
import {
  Collider,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { createRapier3DPhysicsWorld, loadRapier3D } from '../dist/index.mjs';

const rapier = await loadRapier3D();
if ('code' in rapier) throw rapier;
const world = new World();
world.components.register(Transform).unwrap();
world.components.register(GlobalTransform).unwrap();
registerPhysicsComponents(world);
const physics = createRapier3DPhysicsWorld(rapier);
const movers = [];
for (let index = 0; index < 2048; index++) {
  world.spawn(
    { component: Transform, data: { pos: [(index % 64) * 3, -0.5, Math.floor(index / 64) * 3] } },
    { component: Collider, data: { halfExtents: [1.4, 0.5, 1.4] } },
  ).unwrap();
}
for (let index = 0; index < 128; index++) {
  movers.push(world.spawn(
    { component: Transform, data: { pos: [(index % 64) * 3, 0.5, Math.floor(index / 64) * 3] } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
    { component: Collider, data: { halfExtents: [0.5, 0.5, 0.5] } },
  ).unwrap());
}
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    medianMs: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
  };
}
const sync = [], step = [];
try {
  physics._syncFromEcs(world, Transform, GlobalTransform);
  for (let frame = 0; frame < 360; frame++) {
    const offset = Math.sin(frame * 0.03) * 0.2;
    for (let index = 0; index < movers.length; index++) {
      world.set(movers[index], Transform, {
        pos: [(index % 64) * 3 + offset, 0.5, Math.floor(index / 64) * 3],
      }).unwrap();
    }
    const start = performance.now();
    physics._syncFromEcs(world, Transform, GlobalTransform);
    const synced = performance.now();
    physics.step(1 / 60);
    if (frame >= 60) {
      sync.push(synced - start);
      step.push(performance.now() - synced);
    }
  }
  console.log(JSON.stringify({
    environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
    workload: { staticCuboids: 2048, kinematicCuboids: 128, measuredFixedSteps: 300, delta: 1 / 60 },
    note: 'Real Rapier and ECS sync; pose-only movement retains identical geometry, contact policy and fixed delta. CPU microbenchmark, not game FPS.',
    sync: stats(sync), step: stats(step),
  }, null, 2));
} finally {
  physics.dispose();
}
