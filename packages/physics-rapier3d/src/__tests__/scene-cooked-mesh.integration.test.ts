import { AssetRegistry } from '@forgeax/engine-assets-runtime';
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
  sceneAssetContribution,
  Transform,
  worldDespawnScene,
} from '@forgeax/engine-scene';
import { expect, test } from 'vitest';
import { importedSource } from '../../../import/src/__tests__/fixtures/runtime-import';

test('Pack JSON Scene and binary Mesh retain the exact Collider source through native collision', async () => {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const registry = new AssetRegistry({ scopeId: 'import-fixture' });
  const world = new World({ assets: registry });
  const SceneInstance = defineComponent('SceneInstance', {
    source: 'asset<scene>',
    mapping: 'array<entity>',
    state: 'unique<SceneInstanceState>',
  });
  for (const token of [Transform, GlobalTransform, ChildOf, Children, SceneInstance]) {
    world.components.register(token).unwrap();
  }
  registerPhysicsComponents(world);
  const meshGuid = '11111111-1111-4111-8111-111111111111';
  const sceneGuid = '22222222-2222-4222-8222-222222222222';
  const mesh = createBoxGeometry(3, 2, 4).unwrap();
  const source = { ...mesh, collision: buildMeshCollision(mesh).unwrap() };
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
  registry.installDecoder(sceneAssetContribution.kind, sceneAssetContribution.decoder);
  importedSource(
    {
      assets: [
        {
          guid: meshGuid,
          kind: 'mesh',
          payload: { kind: 'mesh' },
          refs: [],
          artifacts: {
            body: {
              mediaType: 'application/x-forgeax-mesh',
              assetCodec: { name: 'mesh-binary', version: '5' },
              bytes: packMeshBin(source, 'ground', []).unwrap(),
            },
          },
        },
        {
          guid: sceneGuid,
          kind: 'scene',
          payload: cooked.payload as unknown as Record<string, unknown>,
          refs: cooked.refs.map((ref) => ref.guid),
          artifacts: {},
        },
      ],
    },
    registry,
  );
  const accepted = (await registry.load(meshGuid, 'mesh')).unwrap();
  const handle = (await registry.load(sceneGuid, 'scene')).unwrap();
  const root = registry.instantiate(handle, world).unwrap();
  const ground = [...world.iterDescendants(root)].find((e) => world.hasComponent(e, Collider));
  if (ground === undefined) throw new Error('missing ground Collider');
  const actualHandle = world.get(ground, Collider).unwrap().mesh;
  expect(actualHandle).toBe(accepted);
  expect(registry.read(accepted).unwrap().collision).toEqual(source.collision);
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
    registry.release(handle).unwrap();
  }
  registry.dispose();
});
