import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { FixedTime, World } from '@forgeax/engine-ecs';
import {
  Collider,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import {
  createRapier3DPhysicsWorld,
  loadRapier3D,
  registerPhysicsSystems,
} from '../dist/index.mjs';

const rapier = await loadRapier3D();
if ('code' in rapier) throw rapier;
const world = new World();
world.components.register(Transform).unwrap();
world.components.register(GlobalTransform).unwrap();
registerPhysicsComponents(world);
const physics = createRapier3DPhysicsWorld(rapier);
world.insertResource('PhysicsWorld', physics);
const release = registerPhysicsSystems(world);
const count = 2304;
for (let index = 0; index < count; index++) {
  world.spawn(
    { component: Transform, data: { pos: [(index % 48) * 2, 4, Math.floor(index / 48) * 2] } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, ccdEnabled: true } },
    { component: Collider, data: { halfExtents: [0.05, 0.05, 0.05] } },
  ).unwrap();
}
const samples = [];
try {
  for (let frame = 0; frame < 360; frame++) {
    const start = performance.now();
    world.update(1 / 60).unwrap();
    if (frame >= 60) samples.push(performance.now() - start);
  }
  const poses = physics.writebackDynamicBodies().sort((a, b) => a.entity - b.entity);
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({
    environment: { node: process.version, cpu: cpus()[0]?.model },
    workload: { dynamicCuboids: count, fixedSteps: world.getResource(FixedTime).tick, measuredUpdates: samples.length },
    note: 'Full ECS physics schedule with native pose writeback. Spaced falling bodies isolate wrapper cost; not dense-pile solver cost or browser FPS.',
    update: { medianMs: samples[150], p95Ms: samples[285] },
    finalPoseCount: poses.length,
    finalPoseSha256: createHash('sha256').update(JSON.stringify(poses)).digest('hex'),
  }, null, 2));
} finally {
  release();
  physics.dispose();
}
