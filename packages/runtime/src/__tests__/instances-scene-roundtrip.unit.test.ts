import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { RuntimePackAssetInput } from '@forgeax/engine-pack/runtime';
import { Instances } from '@forgeax/engine-render';
import { worldDespawnScene } from '@forgeax/engine-scene';
import type { AssetHandle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset, serializeSceneAssetToPack } from '../collect-scene-asset';
import { publishTestAssets } from './helpers/publish-runtime-assets';
import { registerSceneComponents } from './helpers/register-scene-components';
import { testAssets } from './helpers/runtime-assets';

const GUID = '019d0000-0000-7000-8000-000000000007';
const MATRICES = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1, 2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, -5, 6, 7, 1,
];

function instantiate(registry: AssetRegistry, world: World, asset: AssetHandle<'scene'>) {
  registerSceneComponents(world, [Instances]);
  return registry.instantiate(asset, world);
}

describe('Instances Scene asset authority', () => {
  it('saves, serializes and reopens the same layout independently without any Renderer', async () => {
    const source: SceneAsset = {
      kind: 'scene',
      entities: { forest: { components: { Instances: { transforms: MATRICES } } } },
    };
    const world = new World();
    registerSceneComponents(world, [Instances]);
    const registry = testAssets(world);
    const root = instantiate(registry, world, registry.create(source).unwrap()).unwrap();
    const saved = rootsToSceneAsset(registry, world, [root]).unwrap();
    expect(saved.entities.forest?.components.Instances).toEqual({ transforms: MATRICES });

    const serialized = serializeSceneAssetToPack(saved, world.components.entries(), GUID).unwrap();
    // Exercise the real JSON transport boundary as well as native scene compilation.
    const wire = JSON.parse(JSON.stringify(serialized)) as {
      assets: RuntimePackAssetInput[];
    };
    const row = wire.assets[0];
    if (row === undefined) throw new Error('missing serialized Scene');
    expect(row.guid).toBe(GUID);
    expect(JSON.stringify(wire)).not.toContain('collectionId');
    const reopenedWorld = new World();
    registerSceneComponents(reopenedWorld, [Instances]);
    const reopenedRegistry = testAssets(reopenedWorld);
    publishTestAssets(reopenedRegistry, wire.assets as RuntimePackAssetInput[]);
    const decoded = (await reopenedRegistry.load(GUID, 'scene')).unwrap();
    const first = instantiate(reopenedRegistry, reopenedWorld, decoded).unwrap();
    instantiate(reopenedRegistry, reopenedWorld, decoded).unwrap();
    const entities = Array.from(
      reopenedWorld.query({ read: [Instances] }).unwrap(),
      (entry) => entry.entity,
    );
    expect(entities).toHaveLength(2);
    const a = entities[0];
    const b = entities[1];
    if (a === undefined || b === undefined) throw new Error('missing reopened Instances');
    expect([...reopenedWorld.get(a, Instances).unwrap().transforms]).toEqual(MATRICES);
    expect([...reopenedWorld.get(b, Instances).unwrap().transforms]).toEqual(MATRICES);
    const edited = new Float32Array(MATRICES);
    edited[12] = 99;
    reopenedWorld.set(a, Instances, { transforms: edited }).unwrap();
    expect(reopenedWorld.get(b, Instances).unwrap().transforms[12]).toBe(2);
    expect(source.entities.forest?.components.Instances?.transforms).toEqual(MATRICES);
    worldDespawnScene(reopenedWorld, first).unwrap();
    expect([...reopenedWorld.query({ read: [Instances] }).unwrap()]).toHaveLength(1);
    instantiate(reopenedRegistry, reopenedWorld, decoded).unwrap();
    expect([...reopenedWorld.query({ read: [Instances] }).unwrap()]).toHaveLength(2);
  });

  it('rejects a renderer-local collection identity as Scene author data', () => {
    const world = new World();
    registerSceneComponents(world, [Instances]);
    const registry = testAssets(world);
    const asset = registry
      .create({
        kind: 'scene',
        entities: { forest: { components: { Instances: { collectionId: 7 } } } },
      })
      .unwrap();
    const result = instantiate(registry, world, asset);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: 'asset-package-invalid' });
  });
});
