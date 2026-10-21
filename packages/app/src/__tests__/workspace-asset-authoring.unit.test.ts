import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, meshAssetContribution } from '@forgeax/engine-geometry';
import { prepareRuntimePackContent } from '@forgeax/engine-import';
import { AssetGuid, definePackageId, PackageId } from '@forgeax/engine-pack/source';
import { MeshFilter, SceneInstance } from '@forgeax/engine-render';
import {
  ChildOf,
  Children,
  sceneAssetContribution,
  sceneEntity,
  Transform,
  worldDespawnScene,
  worldResolveSceneEntity,
} from '@forgeax/engine-scene';
import { SkinJointPathUnresolvedError } from '@forgeax/engine-skinning';
import { expect, it, vi } from 'vitest';
import { createWorkspaceAssetAuthoring } from '../workspace-asset-authoring';

it('commits and retires private generations while nested writes stay instance-local', async () => {
  let rejectSpawn = false;
  const assets = new AssetRegistry({
    scopeId: 'author-test',
    postSpawnHook: () =>
      rejectSpawn
        ? { ok: false, error: new SkinJointPathUnresolvedError(0, ['missing'], 0) }
        : { ok: true },
  });
  assets.installDecoder(sceneAssetContribution.kind, sceneAssetContribution.decoder);
  assets.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  assets.setCatalogSource(
    createCatalogSource({ entries: [], expectedScope: { scopeId: 'author-test', generation: 1 } }),
  );
  const world = new World({ assets });
  for (const component of [SceneInstance, ChildOf, Children, Transform, MeshFilter])
    world.components.register(component).unwrap();
  const packageId = definePackageId('01900000-0000-7000-8000-000000000090');
  const childGuid = AssetGuid.format(AssetGuid.derive(packageId, 'scene/child'));
  const guid = AssetGuid.format(AssetGuid.derive(packageId, 'scene/main'));
  const meshGuid = AssetGuid.format(AssetGuid.derive(packageId, 'mesh/cube'));
  const outputs = {
    'mesh/cube': createBoxGeometry(1, 1, 1).unwrap(),
    'scene/child': {
      kind: 'scene' as const,
      entities: {
        cube: {
          components: { Transform: { pos: [0, 0, 0] }, MeshFilter: { assetHandle: meshGuid } },
        },
      },
    },
    'scene/main': {
      kind: 'scene' as const,
      entities: {
        room: {
          components: {},
          instance: {
            source: childGuid,
            overrides: [
              { target: ['cube'] as [string], components: { Transform: { pos: [1, 0, 0] } } },
            ],
          },
        },
      },
    },
  };
  const owner = createWorkspaceAssetAuthoring({ assets, world });
  try {
    const content = (
      await prepareRuntimePackContent(PackageId.format(packageId), outputs, {
        sceneComponents: [Transform, MeshFilter],
      })
    ).unwrap();
    const first = await owner.prepare(content);
    const second = await owner.prepare(content); // retiring unused preparation must not fail withdrawal
    expect(() => owner.commit(first, [])).toThrow('retired');
    expect(() => owner.commit(second, [])).not.toThrow();
    expect(() => owner.commit(second, [])).toThrow('retired');
    expect((await assets.enumerateCatalog()).unwrap()).toHaveLength(0);
    const handle = (await assets.load(guid, 'scene')).unwrap();
    const root = assets.instantiate(handle, world).unwrap();
    const other = assets.instantiate(handle, world).unwrap();
    const scene = assets.read(handle).unwrap();
    const beforeEntities = [...world.query({}).unwrap()].length;
    const failedContent = (
      await prepareRuntimePackContent(
        PackageId.format(packageId),
        {
          ...outputs,
          'mesh/cube': createBoxGeometry(4, 4, 4).unwrap(),
        },
        { sceneComponents: [Transform, MeshFilter] },
      )
    ).unwrap();
    const failed = await owner.prepare(failedContent);
    rejectSpawn = true;
    expect(() =>
      owner.commit(failed, [], () => {
        assets.instantiate(handle, world).unwrap();
      }),
    ).toThrow();
    rejectSpawn = false;
    expect([...world.query({}).unwrap()]).toHaveLength(beforeEntities);
    expect(assets.read(handle).unwrap()).toEqual(scene);
    const mesh = (await assets.load(meshGuid, 'mesh')).unwrap();
    const cube = worldResolveSceneEntity(world, root, sceneEntity('', ['room', 'cube'])).unwrap();
    expect(mesh).not.toBe(0);
    expect(world.get(cube, MeshFilter).unwrap().assetHandle).toBe(mesh);
    const replacement = await owner.prepare(content);
    owner.commit(replacement, []);
    const replacementRoot = assets.instantiate(handle, world).unwrap();
    const replacementCube = worldResolveSceneEntity(
      world,
      replacementRoot,
      sceneEntity('', ['room', 'cube']),
    ).unwrap();
    expect(world.get(replacementCube, MeshFilter).unwrap().assetHandle).toBe(mesh);
    worldDespawnScene(world, replacementRoot).unwrap();
    assets.release(mesh).unwrap();
    const author = createWorkspaceAssetAuthoring({
      assets,
      world,
      scene: { guid, sourceKey: '', root, asset: scene },
    });
    const query = vi.spyOn(world, 'query').mockImplementation(() => {
      throw new Error('No entity scan');
    });
    const read = vi.spyOn(assets, 'read').mockImplementation(() => {
      throw new Error('No Scene copy during edit');
    });
    try {
      await author.write({
        guid,
        path: ['entities', 'room', 'instance', 'overrides', '0', 'components', 'Transform', 'pos'],
        value: [3, 2, 1],
      });
      const one = worldResolveSceneEntity(world, root, sceneEntity('', ['room', 'cube'])).unwrap();
      const two = worldResolveSceneEntity(world, other, sceneEntity('', ['room', 'cube'])).unwrap();
      expect(Array.from(world.get(one, Transform).unwrap().pos)).toEqual([3, 2, 1]);
      expect(Array.from(world.get(two, Transform).unwrap().pos)).toEqual([1, 0, 0]);
      expect(query).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
      read.mockRestore();
      author.close();
    }
    worldDespawnScene(world, root).unwrap();
    worldDespawnScene(world, other).unwrap();
    assets.release(handle).unwrap();
  } finally {
    owner.close();
    assets.dispose();
  }
});
