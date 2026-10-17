import {
  AssetRegistry,
  LoaderRegistry,
  meshLoader,
  parseScenePayload,
  resolveAssetHandle,
} from '@forgeax/engine-assets-runtime';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { componentSchema } from '@forgeax/engine-ecs/internal';
import { buildMeshCollision, createBoxGeometry } from '@forgeax/engine-geometry';
import { packMeshBin } from '@forgeax/engine-import';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { createRapier3DPhysicsWorld, loadRapier3D } from '@forgeax/engine-physics-rapier3d';
import {
  ChildOf,
  Children,
  externalizeSceneAsset,
  GlobalTransform,
  Transform,
  worldDespawnScene,
} from '@forgeax/engine-scene';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import type { MeshAsset } from '@forgeax/engine-types';
import { expect, test } from 'vitest';

test('Pack JSON Scene and binary Mesh retain the exact Collider source through native collision', async () => {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const world = new World();
  const SceneInstance = defineComponent('SceneInstance', {
    source: 'shared<SceneAsset>',
    mapping: 'array<entity>',
    state: 'unique<SceneInstanceState>',
  });
  for (const token of [Transform, GlobalTransform, ChildOf, Children, SceneInstance]) {
    world.components.register(token).unwrap();
  }
  registerPhysicsComponents(world);
  // Shader preparation is not involved in cataloguing or simulating this Mesh.
  const registry = new AssetRegistry({} as ShaderRegistry);
  const meshGuid = '11111111-1111-4111-8111-111111111111';
  const sceneGuid = '22222222-2222-4222-8222-222222222222';
  const mesh = createBoxGeometry(3, 2, 4).unwrap();
  const source = { ...mesh, collision: buildMeshCollision(mesh).unwrap() };
  const loaders = new LoaderRegistry();
  loaders.register(meshLoader);
  const loaded = await loaders.loadPack(
    {
      guid: meshGuid,
      kind: 'mesh',
      payload: {},
      refs: [],
      artifacts: {
        body: {
          bytes: packMeshBin(source, 'ground', []).unwrap(),
          descriptor: {
            path: 'ground.mesh',
            mediaType: 'application/x-forgeax-mesh',
            assetCodec: { name: 'mesh-binary', version: '5' },
          },
        },
      },
    },
    {} as never,
  );
  if (!loaded.ok) throw loaded.error;
  const accepted = registry.catalog(meshGuid, loaded.value as MeshAsset).unwrap();
  const cooked = externalizeSceneAsset(
    {
      kind: 'scene',
      entities: {
        ground: {
          components: {
            Transform: {},
            Collider: { shape: ColliderShapeValue.trimesh, mesh: meshGuid },
          },
        },
      },
    },
    (name) => {
      const token = world.components.resolve(name);
      return token === undefined ? undefined : componentSchema(token);
    },
  ).unwrap();
  const scene = parseScenePayload(
    JSON.parse(JSON.stringify(cooked.payload)),
    cooked.refs.map((r) => r.guid),
  );
  if (!scene) throw new Error('expected Scene payload');
  registry.catalog(sceneGuid, scene, cooked.refs).unwrap();
  const handle = world.allocSharedRef('SceneAsset', scene);
  const root = registry.instantiate(handle, world).unwrap();
  const ground = [...world.iterDescendants(root)].find((e) => world.hasComponent(e, Collider));
  if (ground === undefined) throw new Error('missing ground Collider');
  const actualHandle = world.get(ground, Collider).unwrap().mesh;
  expect(resolveAssetHandle(world, actualHandle).unwrap()).toBe(accepted);
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
    for (let frame = 0; frame < 120; frame++) physics.step(1 / 60);
    const body = physics.writebackDynamicBodies().find((row) => row.entity === ball);
    expect(body?.pos.y).toBeGreaterThan(1.2);
    expect(body?.pos.y).toBeLessThan(1.3);
  } finally {
    physics.dispose();
    world.despawn(ball).unwrap();
    worldDespawnScene(world, root).unwrap();
    world.sharedRefs.release(handle).unwrap();
  }
  expect(world.sharedRefs._liveCount()).toBe(0);
});
