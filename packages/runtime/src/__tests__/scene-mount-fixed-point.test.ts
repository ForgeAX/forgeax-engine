import { World } from '@forgeax/engine-ecs';
import type { RuntimePackAssetInput } from '@forgeax/engine-pack/runtime';
import { SceneInstance } from '@forgeax/engine-render';
import type { SceneAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { rootsToSceneAsset, serializeSceneAssetToPack } from '../collect-scene-asset';
import { publishTestAssets } from './helpers/publish-runtime-assets';
import { registerSceneComponents } from './helpers/register-scene-components';
import { testAssets } from './helpers/runtime-assets';

const CHILD = '11111111-1111-4111-8111-111111111111';
const SAVED = '22222222-2222-4222-8222-222222222222';

it('collect -> serialize -> reload -> collect preserves the nested declaration and keys', async () => {
  const world = new World();
  registerSceneComponents(world);
  const assets = testAssets(world);
  try {
    const child = {
      guid: CHILD,
      kind: 'scene',
      payload: {
        kind: 'scene',
        entities: { door: { components: { Transform: { pos: [2, 0, 0] } } } },
      },
    };
    publishTestAssets(assets, [child]);
    const childHandle = (await assets.load(CHILD, 'scene')).unwrap();
    const parent = assets
      .create({
        kind: 'scene',
        entities: {
          root: { components: { Transform: {} } },
          house: { components: {}, instance: { source: childHandle } },
        },
      })
      .unwrap();
    const first = assets.instantiate(parent, world).unwrap();
    const collected = rootsToSceneAsset(assets, world, [first]).unwrap();
    expect(collected.entities.house?.instance?.source).toBe(CHILD);
    const packed = serializeSceneAssetToPack(collected, world.components.entries(), SAVED).unwrap();
    publishTestAssets(assets, [child, ...(packed.assets as RuntimePackAssetInput[])]);
    const saved = (await assets.load(SAVED, 'scene')).unwrap();
    expect(assets.read(saved).unwrap().entities.house?.instance?.source).toBe(childHandle);
    const secondWorld = new World();
    registerSceneComponents(secondWorld);
    const secondAssets = testAssets(secondWorld);
    try {
      publishTestAssets(secondAssets, [child, ...(packed.assets as RuntimePackAssetInput[])]);
      const reloaded = (await secondAssets.load(SAVED, 'scene')).unwrap();
      const second = secondAssets.instantiate(reloaded, secondWorld).unwrap();
      const recollected = rootsToSceneAsset(secondAssets, secondWorld, [second]).unwrap();
      expect(Object.keys(recollected.entities)).toEqual(Object.keys(collected.entities));
      expect(recollected.entities.house?.instance).toEqual(collected.entities.house?.instance);
    } finally {
      secondAssets.dispose();
    }
  } finally {
    assets.dispose();
  }
});

it('a Scene without nested instances remains a keyed two-entity asset', () => {
  const world = new World();
  registerSceneComponents(world);
  const assets = testAssets(world);
  try {
    const scene: SceneAsset = {
      kind: 'scene',
      entities: {
        root: { components: { Transform: {} } },
        child: { components: { Transform: {}, ChildOf: { parent: 'root' } } },
      },
    };
    const root = assets.instantiate(assets.create(scene).unwrap(), world).unwrap();
    const collected = rootsToSceneAsset(assets, world, [root]).unwrap();
    expect(Object.keys(collected.entities)).toEqual(['root', 'child']);
    expect(collected.entities.child?.components.ChildOf).toEqual({ parent: 'root' });
  } finally {
    assets.dispose();
  }
});

it('transient SceneInstance state is not emitted as an authored component', () => {
  const world = new World();
  registerSceneComponents(world);
  const assets = testAssets(world);
  try {
    const scene = assets
      .create({ kind: 'scene', entities: { root: { components: { Transform: {} } } } })
      .unwrap();
    const root = assets.instantiate(scene, world).unwrap();
    expect(world.get(root, SceneInstance).ok).toBe(true);
    const collected = rootsToSceneAsset(assets, world, [root]).unwrap();
    expect(collected.entities.root?.components.SceneInstance).toBeUndefined();
  } finally {
    assets.dispose();
  }
});
