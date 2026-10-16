// Reproduce G28 through managed ECS admission and the scheduled native tick.
// Run after build: node packages/physics-rapier3d/bench/mesh-collision-effect.mjs
import assert from 'node:assert/strict';
import { World } from '@forgeax/engine-ecs';
import { buildMeshCollision, createBoxGeometry } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
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
const blocks = [
  [-1, 0, 0.5, 2.5],
  [1, 0, 0.5, 2.5],
  [0, -1, 2.5, 0.5],
];
function cavity() {
  const positions = [],
    indices = [];
  for (const [x, y, width, height] of blocks) {
    const box = createBoxGeometry(width, height, 1).unwrap();
    const offset = positions.length / 3;
    for (let i = 0; i < box.attributes.position.length; i += 3)
      positions.push(
        box.attributes.position[i] + x,
        box.attributes.position[i + 1] + y,
        box.attributes.position[i + 2],
      );
    indices.push(...Array.from(box.indices, (index) => index + offset));
  }
  const vertices = new Float32Array(positions);
  return {
    kind: 'mesh',
    vertices,
    attributes: { position: vertices },
    indices: new Uint32Array(indices),
    aabb: new Float32Array([-1.25, -1.25, -0.5, 1.25, 1.25, 0.5]),
    materialSlots: [{ slotName: 'collision' }],
    submeshes: [
      {
        topology: 'triangle-list',
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: vertices.length / 3,
        materialSlot: 0,
      },
    ],
  };
}
function fixture() {
  const world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const physics = createRapier3DPhysicsWorld(rapier);
  world.insertResource('PhysicsWorld', physics);
  const releaseScene = registerPropagateTransforms(world);
  const releasePhysics = registerPhysicsSystems(world);
  return {
    world,
    physics,
    dispose() {
      releasePhysics();
      releaseScene();
      physics.dispose();
    },
  };
}
function cooked(world, source) {
  return world.sharedRefs.alloc('MeshAsset', {
    ...source,
    collision: buildMeshCollision(source).unwrap(),
  });
}
function body(physics, entity) {
  let result;
  physics.raw.forEachRigidBody((value) => {
    if (value.userData === entity) result = value;
  });
  assert.ok(result);
  return result;
}
const result = {
  backend: `Rapier ${rapier.version()}`,
  timestamp: new Date().toISOString(),
  timestep: 1 / 60,
  blocks,
  trajectories: [],
  roundShapes: [],
  replacement: {},
};
for (const kind of ['trimesh', 'convexHull']) {
  const f = fixture();
  try {
    const mesh = cooked(f.world, cavity());
    const ground = f.world
      .spawn(
        { component: Transform, data: {} },
        { component: Collider, data: { shape: ColliderShapeValue[kind], mesh } },
      )
      .unwrap();
    const ball = f.world
      .spawn(
        { component: Transform, data: { pos: [0, 3, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
        { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.2 } },
      )
      .unwrap();
    const samples = [[0, 3]];
    for (let frame = 1; frame <= 240; frame++) {
      f.world.update(1 / 60).unwrap();
      samples.push([frame / 60, f.world.get(ball, Transform).unwrap().pos[1]]);
    }
    const y = samples.at(-1)[1];
    const contact = f.physics.getCollisionPairs().get(ball)?.has(ground) === true;
    const surfaceY = f.physics.raycast(vec3.create(0, 3, 0.4), vec3.create(0, -1, 0), 5)?.point[1];
    assert.ok(contact);
    assert.ok(Math.abs(y - (kind === 'trimesh' ? -0.55 : 1.45)) < 0.025, `${kind} final y=${y}`);
    assert.ok(Math.abs(surfaceY - (kind === 'trimesh' ? -0.75 : 1.25)) < 0.005);
    result.trajectories.push({ kind, samples, finalY: y, surfaceY, contact, completedTicks: 240 });
  } finally {
    f.dispose();
  }
}
for (const kind of ['cylinder', 'cone']) {
  const f = fixture();
  try {
    f.world
      .spawn(
        { component: Transform, data: {} },
        {
          component: Collider,
          data: { shape: ColliderShapeValue[kind], radius: 0.5, halfHeight: 0.5 },
        },
      )
      .unwrap();
    f.world.update(1 / 60).unwrap();
    const hits = [];
    for (let row = 0; row <= 24; row++)
      for (let col = 0; col <= 24; col++) {
        const x = -0.6 + col * 0.05,
          z = -0.6 + row * 0.05;
        const hit = f.physics.raycast(vec3.create(x, 2, z), vec3.create(0, -1, 0), 4);
        const radius = Math.hypot(x, z);
        if (radius < 0.49) {
          assert.ok(hit, `${kind}: missed interior ray at ${x}, ${z}`);
          const expectedY = kind === 'cylinder' ? 0.5 : 0.5 - 2 * radius;
          assert.ok(Math.abs(hit.point[1] - expectedY) < 0.01, `${kind}: wrong surface height`);
        }
        if (radius > 0.51) assert.equal(hit, undefined, `${kind}: hit outside round footprint`);
        hits.push({ x, z, hit: hit !== undefined, y: hit?.point[1] ?? null });
      }
    const center = f.physics.raycast(vec3.create(0, 2, 0), vec3.create(0, -1, 0), 4);
    const corner = f.physics.raycast(vec3.create(0.45, 2, 0.45), vec3.create(0, -1, 0), 4);
    assert.ok(center);
    assert.equal(corner, undefined);
    result.roundShapes.push({ kind, hits, centerHit: true, squareCornerHit: false });
  } finally {
    f.dispose();
  }
}
{
  const f = fixture();
  const original = rapier.ConvexPolyhedron.prototype.intoRaw;
  let nativeBuilds = 0;
  rapier.ConvexPolyhedron.prototype.intoRaw = function () {
    nativeBuilds++;
    return original.call(this);
  };
  try {
    const entity = f.world
      .spawn(
        { component: Transform, data: {} },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, gravityScale: 0 } },
        {
          component: Collider,
          data: {
            shape: ColliderShapeValue.convexHull,
            mesh: cooked(f.world, createBoxGeometry(1, 1, 1).unwrap()),
          },
        },
      )
      .unwrap();
    f.world.update(1 / 60).unwrap();
    const value = body(f.physics, entity),
      handle = value.handle;
    value.setLinvel({ x: 1, y: 2, z: 3 }, true);
    value.setAngvel({ x: 0, y: 0.5, z: 0 }, true);
    const before = { velocity: value.linvel(), angularVelocity: value.angvel() };
    const initialBuilds = nativeBuilds;
    for (let frame = 0; frame < 120; frame++)
      f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
    const warmRebuilds = nativeBuilds - initialBuilds;
    f.world
      .set(entity, Collider, { mesh: cooked(f.world, createBoxGeometry(2, 1, 1).unwrap()) })
      .unwrap();
    f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
    const after = { velocity: value.linvel(), angularVelocity: value.angvel() };
    assert.equal(body(f.physics, entity).handle, handle);
    assert.deepEqual(after, before);
    assert.equal(warmRebuilds, 0);
    assert.equal(nativeBuilds, 2);
    const colliderHandle = value.collider(0).handle;
    f.world.set(entity, Collider, { shape: ColliderShapeValue.trimesh }).unwrap();
    assert.throws(
      () => f.physics._syncFromEcs(f.world, Transform, GlobalTransform),
      (error) => error.code === 'invalid-body-config',
    );
    assert.equal(value.collider(0).handle, colliderHandle);
    assert.equal(body(f.physics, entity).handle, handle);
    result.replacement = {
      before,
      after,
      sameBody: true,
      warmSyncs: 120,
      warmRebuilds,
      nativeBuilds,
      rejectedDynamicTrimeshPreservesCollider: true,
    };
  } finally {
    rapier.ConvexPolyhedron.prototype.intoRaw = original;
    f.dispose();
  }
}
console.log(JSON.stringify(result, null, 2));
