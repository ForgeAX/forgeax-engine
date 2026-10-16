import type { EntityHandle } from '@forgeax/engine/ecs';
import { SceneInstance } from '@forgeax/engine/render';
import { ChildOf, GlobalTransform, Name } from '@forgeax/engine/scene';
import type { SceneAsset } from '@forgeax/engine/types';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';

const MISSING_MESH = '7c1d4c52-3f4e-4b7a-9c61-0d9a3b1f2e10';

const ROOM: SceneAsset = {
  kind: 'scene',
  entities: {
    root: { components: { Name: { value: 'room-root' }, Transform: { pos: [1, 0, 0] } } },
    lamp: {
      components: {
        Name: { value: 'room-lamp' },
        Transform: { pos: [0, 2, 0] },
        ChildOf: { parent: 'root' },
      },
    },
  },
};

const BROKEN: SceneAsset = {
  kind: 'scene',
  entities: {
    ok: { components: { Name: { value: 'broken-ok' }, Transform: {} } },
    bad: {
      components: {
        Name: { value: 'broken-bad' },
        Transform: {},
        MeshFilter: { assetHandle: MISSING_MESH },
      },
    },
  },
};

function byName(
  world: Parameters<typeof spawnStage>[0],
  root: EntityHandle,
  value: string,
): EntityHandle | undefined {
  for (const entity of world.iterDescendants(root)) {
    const name = world.get(entity, Name);
    if (name.ok && name.value.value === value) return entity;
  }
  return undefined;
}

export default defineFeature({
  title: 'SceneAsset instantiation',
  catalog: 'SceneAsset instantiation',
  kind: 'probe',
  summary:
    'AssetRegistry.instantiate materialises a keyed SceneAsset under a synthetic SceneInstance root; key-addressed ChildOf becomes a real hierarchy, and a failing attempt rolls back only what it created.',
  expect:
    'PASS when the room instantiates under a SceneInstance root with lamp parented to root and resolved to world (1,2,0), and a scene referencing an uncatalogued mesh GUID fails with asset-not-found leaving the entity count unchanged.',
  setup({ app, world, frames }) {
    spawnStage(world);
    return {
      async checks() {
        const checks = new CheckList();
        const assets = app.assets;
        checks.ok('asset registry available', assets !== undefined);
        if (assets === undefined) return checks.items;
        const instantiated = assets.instantiate(world.allocSharedRef('SceneAsset', ROOM), world);
        checks.ok(
          'instantiate succeeds',
          instantiated.ok,
          instantiated.ok ? undefined : instantiated.error.code,
        );
        if (!instantiated.ok) return checks.items;
        const root = instantiated.value;
        checks.ok('synthetic root carries SceneInstance', world.get(root, SceneInstance).ok);
        const sceneRoot = byName(world, root, 'room-root');
        const lamp = byName(world, root, 'room-lamp');
        checks.ok('both authored entities spawned', sceneRoot !== undefined && lamp !== undefined);
        if (sceneRoot === undefined || lamp === undefined) return checks.items;
        const parent = world.get(lamp, ChildOf);
        checks.equal(
          'lamp parent resolved from key',
          parent.ok ? parent.value.parent : undefined,
          sceneRoot,
        );
        await frames(2);
        const global = world.get(lamp, GlobalTransform);
        const worldPos = global.ok
          ? [global.value.world[12], global.value.world[13], global.value.world[14]]
          : [];
        checks.equal('lamp world position', worldPos, [1, 2, 0]);

        const before = world.inspect().entityCount;
        const failed = assets.instantiate(world.allocSharedRef('SceneAsset', BROKEN), world);
        checks.equal('missing GUID fails', failed.ok ? 'ok' : failed.error.code, 'asset-not-found');
        checks.equal('failed attempt rolls back', world.inspect().entityCount, before);
        return checks.items;
      },
    };
  },
});
