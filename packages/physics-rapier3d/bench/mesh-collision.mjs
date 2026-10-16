import { performance } from 'node:perf_hooks';
import { arch, cpus, platform } from 'node:os';
import { World } from '@forgeax/engine-ecs';
import { buildMeshCollision, createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform, registerPropagateTransforms } from '@forgeax/engine-scene';
import {
  createRapier3DPhysicsWorld,
  loadRapier3D,
  registerPhysicsSystems,
} from '../dist/index.mjs';

const rapier = await loadRapier3D();
if ('code' in rapier) throw rapier;
function stats(samples) {
  const ordered = [...samples].sort((a, b) => a - b);
  return {
    samples: samples.length,
    medianMs: ordered[Math.floor(ordered.length * 0.5)],
    p95Ms: ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))],
  };
}
const source = createBoxGeometry(2, 2, 2, 32, 32, 32).unwrap();
const cookTimes = [];
let collision;
for (let run = 0; run < 25; run++) {
  const start = performance.now();
  collision = buildMeshCollision(source).unwrap();
  if (run >= 5) cookTimes.push(performance.now() - start);
}
const results = {
  environment: {
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    rapier: rapier.version(),
    timestamp: new Date().toISOString(),
  },
  source: {
    triangles: source.indices.length / 3,
    vertices: source.attributes.position.length / 3,
    weldedVertices: collision.positions.length / 3,
  },
  cook: stats(cookTimes),
  scenes: [],
};
for (const workload of [
  'isolated',
  'contact-stacks',
  'active-contact-stacks',
  'active-world-ticks',
])
  for (const kind of ['cuboid', 'convexHull']) {
    const world = new World();
    world.components.register(Transform).unwrap();
    world.components.register(GlobalTransform).unwrap();
    registerPhysicsComponents(world);
    const meshSource = createBoxGeometry(1, 1, 1).unwrap();
    const mesh = world.sharedRefs.alloc('MeshAsset', {
      ...meshSource,
      collision: buildMeshCollision(meshSource).unwrap(),
    });
    const count = 256;
    if (workload !== 'isolated')
      world
        .spawn(
          { component: Transform, data: { pos: [15, -0.25, 0] } },
          { component: Collider, data: { halfExtents: [20, 0.25, 4] } },
        )
        .unwrap();
    for (let i = 0; i < count; i++)
      world
        .spawn(
          {
            component: Transform,
            data: {
              pos: [
                (i % 16) * 2,
                workload === 'isolated'
                  ? 5 + Math.floor(i / 16) * 2
                  : 0.5 + Math.floor(i / 16) * 1.05,
                0,
              ],
            },
          },
          {
            component: RigidBody,
            data: {
              type: RigidBodyTypeValue.dynamic,
              gravityScale: workload === 'isolated' ? 0 : 1,
            },
          },
          { component: Collider, data: { shape: ColliderShapeValue[kind], mesh } },
        )
        .unwrap();
    const physics = createRapier3DPhysicsWorld(rapier);
    const scheduled = workload === 'active-world-ticks';
    world.insertResource('PhysicsWorld', physics);
    const releasePhysics = scheduled ? registerPhysicsSystems(world) : () => {};
    const releaseScene = scheduled ? registerPropagateTransforms(world) : () => {};
    const original = rapier.ConvexPolyhedron.prototype.intoRaw;
    try {
      let nativeBuilds = 0;
      rapier.ConvexPolyhedron.prototype.intoRaw = function () {
        nativeBuilds++;
        return original.call(this);
      };
      const start = performance.now();
      physics._syncFromEcs(world, Transform, GlobalTransform);
      const admissionMs = performance.now() - start;
      const syncTimes = [],
        stepTimes = [],
        worldTimes = [];
      for (let frame = 0; frame < 360; frame++) {
        if (scheduled) {
          const start = performance.now();
          physics.raw.forEachRigidBody((body) => {
            if (body.isDynamic()) body.wakeUp();
          });
          world.update(1 / 60).unwrap();
          if (frame >= 60) worldTimes.push(performance.now() - start);
          continue;
        }
        const syncStart = performance.now();
        physics._syncFromEcs(world, Transform, GlobalTransform);
        const syncMs = performance.now() - syncStart;
        const stepStart = performance.now();
        if (workload === 'active-contact-stacks')
          physics.raw.forEachRigidBody((body) => {
            if (body.isDynamic()) body.wakeUp();
          });
        physics.step(1 / 60);
        const stepMs = performance.now() - stepStart;
        if (frame >= 60) {
          syncTimes.push(syncMs);
          stepTimes.push(stepMs);
        }
      }
      rapier.ConvexPolyhedron.prototype.intoRaw = original;
      let awakeDynamicBodies = 0;
      physics.raw.forEachRigidBody((body) => {
        if (body.isDynamic() && !body.isSleeping()) awakeDynamicBodies++;
      });
      results.scenes.push({
        awakeDynamicBodies,
        wakeIncludedInStep: workload === 'active-contact-stacks' || scheduled,
        workload,
        kind,
        count,
        contacts:
          [...physics.getCollisionPairs().values()].reduce((sum, set) => sum + set.size, 0) / 2,
        admissionMs,
        nativeBuilds,
        ...(scheduled
          ? { worldTick: stats(worldTimes) }
          : { unchangedSync: stats(syncTimes), step: stats(stepTimes) }),
      });
      if (kind === 'convexHull' && nativeBuilds !== count)
        throw new Error('steady sync rebuilt native hull descriptors');
    } finally {
      rapier.ConvexPolyhedron.prototype.intoRaw = original;
      releasePhysics();
      releaseScene();
      physics.dispose();
    }
  }
console.log(JSON.stringify(results, null, 2));
