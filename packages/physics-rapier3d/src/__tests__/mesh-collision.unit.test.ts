import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import {
  buildMeshCollision,
  createBoxGeometry,
  createPlaneGeometry,
} from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { createRapier3DPhysicsWorld, loadRapier3D } from '@forgeax/engine-physics-rapier3d';
import { ChildOf, GlobalTransform, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, test, vi } from 'vitest';

test('G28: cooked mesh enters the ordinary ECS Collider and native solver', async () => {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const world = new World({ assets: new AssetRegistry() });
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const cooked = buildMeshCollision(mesh).unwrap();
  const handle = runtimeAssetRegistry(world.assets)
    .create({ ...mesh, collision: cooked })
    .unwrap();
  const ground = world
    .spawn(
      { component: Transform, data: {} },
      { component: Collider, data: { shape: ColliderShapeValue.trimesh, mesh: handle } },
    )
    .unwrap();
  const ball = world
    .spawn(
      { component: Transform, data: { pos: [0, 3, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
      { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.25 } },
    )
    .unwrap();
  const physics = createRapier3DPhysicsWorld(rapier);
  try {
    physics._syncFromEcs(world, Transform, GlobalTransform);
    expect(physics.hasBody(ground)).toBe(true);
    for (let frame = 0; frame < 240; frame++) physics.step(1 / 60);
    const row = physics.writebackDynamicBodies().find((row) => row.entity === ball);
    if (!row) throw new Error('missing dynamic body');
    const y = row.pos.y;
    expect(y).toBeGreaterThan(0.7);
    expect(y).toBeLessThan(0.8);
  } finally {
    physics.dispose();
  }
});

async function fixture() {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const world = new World({ assets: new AssetRegistry() });
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const physics = createRapier3DPhysicsWorld(rapier);
  const sync = () => physics._syncFromEcs(world, Transform, GlobalTransform);
  return { rapier, world, physics, sync };
}

function cookedBox(world: World, x = 1, y = 1, z = 1) {
  const mesh = createBoxGeometry(x, y, z).unwrap();
  return runtimeAssetRegistry(world.assets)
    .create({
      ...mesh,
      collision: buildMeshCollision(mesh).unwrap(),
    })
    .unwrap();
}

function nativeBody(physics: ReturnType<typeof createRapier3DPhysicsWorld>, entity: number) {
  let found: import('../../pkg/rapier.mjs').RigidBody | undefined;
  physics.raw.forEachRigidBody((body: import('../../pkg/rapier.mjs').RigidBody) => {
    if (body.userData === entity) found = body;
  });
  if (!found) throw new Error('missing native body');
  return found;
}

test.each([
  'cylinder',
  'cone',
] as const)('G28: %s has its actual round footprint', async (shape) => {
  const { world, physics, sync } = await fixture();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: Collider, data: { shape: ColliderShapeValue[shape] } },
    )
    .unwrap();
  try {
    sync();
    physics.step(1 / 60);
    const center = physics.raycast(vec3.create(0, 2, 0), vec3.create(0, -1, 0), 4);
    expect(center).toBeDefined();
    const corner = physics.raycast(vec3.create(0.45, 2, 0.45), vec3.create(0, -1, 0), 4);
    expect(corner).toBeUndefined();
  } finally {
    physics.dispose();
  }
});

test('G28: convex hull is dynamic, updates without losing native momentum, and rebuilds only on source/scale change', async () => {
  const { rapier, world, physics, sync } = await fixture();
  const mesh = cookedBox(world);
  const entity = world
    .spawn(
      { component: Transform, data: { pos: [0, 2, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
      { component: Collider, data: { shape: ColliderShapeValue.convexHull, mesh } },
    )
    .unwrap();
  const hull = vi.spyOn(rapier.ColliderDesc, 'convexHull');
  try {
    sync();
    const body = nativeBody(physics, entity),
      handle = body.handle;
    body.setLinvel({ x: 1, y: 2, z: 3 }, true);
    body.setAngvel({ x: 0, y: 0.5, z: 0 }, true);
    const get = vi.spyOn(world, 'get');
    for (let frame = 0; frame < 120; frame++) sync();
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
    expect(hull).toHaveBeenCalledTimes(1);
    world.set(entity, Collider, { mesh: cookedBox(world, 2, 1, 1) }).unwrap();
    sync();
    expect(nativeBody(physics, entity).handle).toBe(handle);
    expect(body.linvel()).toEqual({ x: 1, y: 2, z: 3 });
    expect(body.angvel()).toEqual({ x: 0, y: 0.5, z: 0 });
    expect(hull).toHaveBeenCalledTimes(2);
    world.set(entity, RigidBody, { type: RigidBodyTypeValue.kinematic }).unwrap();
    sync();
    for (let frame = 0; frame < 120; frame++) {
      world.set(entity, Transform, { pos: [frame / 60, 2, 0] }).unwrap();
      sync();
    }
    expect(hull).toHaveBeenCalledTimes(2);
    world.set(entity, Transform, { scale: [-2, 1, 1] }).unwrap();
    sync();
    expect(hull).toHaveBeenCalledTimes(2);
  } finally {
    hull.mockRestore();
    physics.dispose();
  }
});

test('G28: parent rotation does not recook a hull, cumulative scale edits still resize it', async () => {
  const { rapier, world, physics } = await fixture();
  const parent = world.spawn({ component: Transform, data: { scale: [2, 2, 2] } }).unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: ChildOf, data: { parent } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.convexHull, mesh: cookedBox(world) },
      },
    )
    .unwrap();
  const hull = vi.spyOn(rapier.ColliderDesc, 'convexHull');
  try {
    for (let frame = 0; frame < 120; frame++) {
      const angle = frame * 0.03;
      world
        .set(parent, Transform, { quat: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)] })
        .unwrap();
      propagateTransforms(world).unwrap();
      physics._syncFromEcs(world, Transform, GlobalTransform);
      physics.step(1 / 60);
    }
    expect(hull).toHaveBeenCalledTimes(1);
    for (let frame = 1; frame <= 20; frame++) {
      const scale = 2 + frame * 2 ** -22;
      world.set(parent, Transform, { scale: [scale, scale, scale] }).unwrap();
      propagateTransforms(world).unwrap();
      physics._syncFromEcs(world, Transform, GlobalTransform);
    }
    physics.step(1 / 60);
    expect(hull).toHaveBeenCalledTimes(1);
    let collider: import('../../pkg/rapier.mjs').Collider | undefined;
    physics.raw.forEachCollider((value: import('../../pkg/rapier.mjs').Collider) => {
      collider = value;
    });
    const points = collider?.vertices();
    if (!(points instanceof Float32Array)) throw new Error('missing native hull snapshot');
    expect(Math.max(...points)).toBeGreaterThan(1.000001);
  } finally {
    hull.mockRestore();
    physics.dispose();
  }
});

function concaveMesh() {
  const points: number[] = [],
    triangles: number[] = [];
  for (const [x, y, width, height] of [
    [-1, 0, 0.5, 2.5],
    [1, 0, 0.5, 2.5],
    [0, -1, 2.5, 0.5],
  ]) {
    const box = createBoxGeometry(Number(width), Number(height), 1).unwrap();
    const offset = points.length / 3,
      positions = box.attributes.position;
    if (!(positions instanceof Float32Array) || !box.indices)
      throw new Error('invalid box fixture');
    for (let i = 0; i < positions.length; i += 3)
      points.push(
        Number(positions[i]) + Number(x),
        Number(positions[i + 1]) + Number(y),
        Number(positions[i + 2]),
      );
    triangles.push(...Array.from(box.indices, (index) => index + offset));
  }
  const vertices = new Float32Array(points);
  return {
    kind: 'mesh' as const,
    vertices,
    attributes: { position: vertices },
    indices: new Uint32Array(triangles),
    aabb: new Float32Array([-1.25, -1.25, -0.5, 1.25, 1.25, 0.5]),
    materialSlots: [{ slotName: 'collision' }],
    submeshes: [
      {
        topology: 'triangle-list' as const,
        indexOffset: 0,
        indexCount: triangles.length,
        vertexCount: vertices.length / 3,
        materialSlot: 0,
      },
    ],
  };
}

test('G28: trimesh preserves a concave cavity, actual contact and fresh-backend recovery', async () => {
  const { world, physics, sync } = await fixture();
  const source = concaveMesh();
  const mesh = runtimeAssetRegistry(world.assets)
    .create({
      ...source,
      collision: buildMeshCollision(source).unwrap(),
    })
    .unwrap();
  const ground = world
    .spawn(
      { component: Transform, data: {} },
      { component: Collider, data: { shape: ColliderShapeValue.trimesh, mesh } },
    )
    .unwrap();
  const ball = world
    .spawn(
      { component: Transform, data: { pos: [0, 3, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
      { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.2 } },
    )
    .unwrap();
  try {
    sync();
    for (let frame = 0; frame < 240; frame++) physics.step(1 / 60);
    const body = nativeBody(physics, ball);
    expect(body.translation().y).toBeGreaterThan(-0.57);
    expect(body.translation().y).toBeLessThan(-0.53);
    expect(physics.getCollisionPairs().get(ball)?.has(ground)).toBe(true);
    const first = physics.raycast(vec3.create(0, 3, 0.4), vec3.create(0, -1, 0), 5);
    expect(first?.entity).toBe(ground);
    expect(first?.point[1]).toBeCloseTo(-0.75, 3);
    const fresh = createRapier3DPhysicsWorld(await loadRapier3D());
    try {
      fresh._syncFromEcs(world, Transform, GlobalTransform);
      fresh.step(1 / 60);
      const second = fresh.raycast(vec3.create(0, 3, 0.4), vec3.create(0, -1, 0), 5);
      expect(second?.point).toEqual(first?.point);
    } finally {
      fresh.dispose();
    }
    world.despawn(ground).unwrap();
    sync();
    expect(physics.hasBody(ground)).toBe(false);
  } finally {
    physics.dispose();
  }
});

test('G28: refused dynamic trimesh and failed native replacement retain the prior body', async () => {
  const { world, physics, sync } = await fixture();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      { component: Collider, data: { shape: ColliderShapeValue.trimesh, mesh: cookedBox(world) } },
    )
    .unwrap();
  try {
    sync();
    const body = nativeBody(physics, entity),
      handle = body.collider(0).handle;
    world.set(entity, RigidBody, { type: RigidBodyTypeValue.dynamic }).unwrap();
    expect(sync).toThrowError(expect.objectContaining({ code: 'invalid-body-config' }));
    expect(body.isFixed()).toBe(true);
    expect(body.collider(0).handle).toBe(handle);
    world.set(entity, RigidBody, { type: RigidBodyTypeValue.static }).unwrap();
    world.set(entity, Collider, { mesh: cookedBox(world, 2) }).unwrap();
    const fail = vi.spyOn(physics.raw, 'createCollider').mockImplementationOnce(() => {
      throw new Error('injected native allocation failure');
    });
    expect(sync).toThrow('injected native allocation failure');
    expect(body.collider(0).handle).toBe(handle);
    fail.mockRestore();
    sync();
    expect(body.numColliders()).toBe(1);
    expect(nativeBody(physics, entity).handle).toBe(body.handle);
  } finally {
    physics.dispose();
  }
});

test('G28: managed Mesh edits adopt the root without replacing a committed collider', async () => {
  const { world, physics, sync } = await fixture();
  const assets = runtimeAssetRegistry(world.assets);
  const mesh = cookedBox(world);
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: Collider, data: { shape: ColliderShapeValue.trimesh, mesh } },
    )
    .unwrap();
  try {
    sync();
    const body = nativeBody(physics, entity),
      before = body.collider(0).handle;
    const create = vi.spyOn(physics.raw, 'createCollider');
    assets.replace(mesh, createBoxGeometry(2, 2, 2).unwrap()).unwrap();
    sync();
    physics.step(1 / 60);
    expect(create).not.toHaveBeenCalled();
    expect(body.collider(0).handle).toBe(before);
    expect(
      physics.raycast(vec3.create(0.75, 3, 0), vec3.create(0, -1, 0), 5)?.point[1],
    ).toBeCloseTo(1);
    create.mockRestore();
  } finally {
    physics.dispose();
  }
});

test('G28: first native allocation failure leaves no orphan body and retry admits once', async () => {
  const { world, physics, sync } = await fixture();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.convexHull, mesh: cookedBox(world) },
      },
    )
    .unwrap();
  try {
    const fail = vi.spyOn(physics.raw, 'createCollider').mockImplementationOnce(() => {
      throw new Error('injected initial allocation failure');
    });
    expect(sync).toThrow('injected initial allocation failure');
    expect(physics.hasBody(entity)).toBe(false);
    let bodies = 0;
    physics.raw.forEachRigidBody(() => {
      bodies++;
    });
    expect(bodies).toBe(0);
    fail.mockRestore();
    sync();
    expect(nativeBody(physics, entity).numColliders()).toBe(1);
  } finally {
    physics.dispose();
  }
});

test('G28: dynamic hull scale edits resize collision while native pose remains authoritative', async () => {
  const { world, physics, sync } = await fixture();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: RigidBody, data: { gravityScale: 0 } },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.convexHull, mesh: cookedBox(world) },
      },
    )
    .unwrap();
  try {
    sync();
    physics.step(1 / 60);
    const body = nativeBody(physics, entity),
      handle = body.handle;
    expect(physics.raycast(vec3.create(0.75, 2, 0), vec3.create(0, -1, 0), 4)).toBeUndefined();
    world.set(entity, Transform, { scale: [2, 1, 1], pos: [100, 0, 0] }).unwrap();
    sync();
    physics.step(1 / 60);
    expect(physics.raycast(vec3.create(0.75, 2, 0), vec3.create(0, -1, 0), 4)).toBeDefined();
    expect(nativeBody(physics, entity).handle).toBe(handle);
    expect(body.translation().x).toBeCloseTo(0);
  } finally {
    physics.dispose();
  }
});

test('G28: native hull admits planar source with its actual bounded footprint', async () => {
  const { world, physics, sync } = await fixture();
  const source = createPlaneGeometry(1, 1).unwrap();
  const mesh = runtimeAssetRegistry(world.assets)
    .create({
      ...source,
      collision: buildMeshCollision(source).unwrap(),
    })
    .unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: Collider, data: { shape: ColliderShapeValue.convexHull, mesh } },
    )
    .unwrap();
  try {
    sync();
    physics.step(1 / 60);
    expect(physics.hasBody(entity)).toBe(true);
    expect(physics.raycast(vec3.create(0, 0, 2), vec3.create(0, 0, -1), 4)?.entity).toBe(entity);
    expect(physics.raycast(vec3.create(0.75, 0, 2), vec3.create(0, 0, -1), 4)).toBeUndefined();
  } finally {
    physics.dispose();
  }
});

test('G28: mesh replacement retires sensor pairs that no longer intersect', async () => {
  const { world, physics, sync } = await fixture();
  const sensor = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.convexHull, mesh: cookedBox(world), isSensor: true },
      },
    )
    .unwrap();
  const ball = world
    .spawn(
      { component: Transform, data: { pos: [0.6, 0, 0] } },
      { component: RigidBody, data: { gravityScale: 0 } },
      { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.25 } },
    )
    .unwrap();
  try {
    sync();
    physics.step(1 / 60);
    expect(physics.getCollisionPairs().get(sensor)?.has(ball)).toBe(true);
    world.set(sensor, Collider, { mesh: cookedBox(world, 0.1, 0.1, 0.1) }).unwrap();
    sync();
    physics.step(1 / 60);
    expect(physics.getCollisionPairs().get(sensor)?.has(ball) ?? false).toBe(false);
  } finally {
    physics.dispose();
  }
});

test('G28: replacement preserves logical sensor overlap without a spurious stop/start', async () => {
  const { world, physics, sync } = await fixture();
  const sensor = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.convexHull, mesh: cookedBox(world), isSensor: true },
      },
    )
    .unwrap();
  const ball = world
    .spawn(
      { component: Transform, data: { pos: [0.6, 0, 0] } },
      { component: RigidBody, data: { gravityScale: 0 } },
      { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.25 } },
    )
    .unwrap();
  try {
    sync();
    physics.step(1 / 60);
    physics.drainCollisionEvents();
    world.set(sensor, Collider, { mesh: cookedBox(world, 1.2) }).unwrap();
    sync();
    physics.step(1 / 60);
    expect(physics.getCollisionPairs().get(sensor)?.has(ball)).toBe(true);
    expect(physics.drainCollisionEvents()).toEqual([]);
  } finally {
    physics.dispose();
  }
});
