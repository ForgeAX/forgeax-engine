import { defineComponent, World } from '@forgeax/engine-ecs';
import {
  ChildOf,
  Children,
  sceneAssetContribution,
  sceneEntityAddressKey,
  worldDespawnScene,
  worldGetSceneInstanceState,
  worldRemoveSceneOverride,
  worldSetSceneOverride,
} from '@forgeax/engine-scene';
import type { SceneAsset } from '@forgeax/engine-types';
import { describe, expect, test } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { runtimeAssets } from '../internal/runtime-assets';
import { defined } from './assert-defined';
import { publishRuntimeAssets } from './fixtures/runtime-publication';

const Instance = defineComponent('SceneInstance', {
  source: 'asset<scene>',
  mapping: 'array<entity>',
  state: 'unique<SceneInstanceState>',
});
const Value = defineComponent('ManagedSceneValue', { amount: 'f32', material: 'asset<material>' });
const materialGuid = '82cba345-a34a-4b7a-b410-399109c9f461';
const childGuid = 'b7df5072-e723-4daa-9344-dc51383d02f9';
const sceneGuid = '55c354b2-6b73-4f05-953d-74c661309f39';
function setup() {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  for (const component of [Instance, Value, ChildOf, Children])
    world.components.register(component).unwrap();
  return { assets, world };
}
function source(amount: number, material: unknown = 0): SceneAsset {
  return {
    kind: 'scene',
    entities: { object: { components: { ManagedSceneValue: { amount, material } } } },
  };
}

describe('managed Scene identity and instance content', () => {
  test('uses loaded material and scene identities across repeated and nested instantiation', async () => {
    const { assets, world } = setup();
    assets.installDecoder(sceneAssetContribution.kind, sceneAssetContribution.decoder);
    publishRuntimeAssets(assets, [
      {
        guid: materialGuid,
        asset: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: { roughness: 1 },
        },
      },
      { guid: childGuid, asset: source(1, 0), refs: [materialGuid] },
      {
        guid: sceneGuid,
        asset: {
          kind: 'scene',
          entities: { nested: { components: {}, instance: { source: childGuid } } },
        },
        refs: [childGuid],
      },
    ]);
    const material = (await assets.load(materialGuid, 'material')).unwrap();
    const child = (await assets.load(childGuid, 'scene')).unwrap();
    const scene = (await assets.load(sceneGuid, 'scene')).unwrap();
    assets.update(material, { values: { roughness: 0.2 } }).unwrap();
    const before = runtimeAssets(assets).inspect().assets;
    const roots = [
      assets.instantiate(scene, world).unwrap(),
      assets.instantiate(scene, world).unwrap(),
    ];
    for (const root of roots) {
      expect(world.get(root, Instance).unwrap().source).toBe(scene);
      const nested = defined(worldGetSceneInstanceState(world, root).unwrap().mountRoots[0]);
      expect(world.get(nested, Instance).unwrap().source).toBe(child);
      const member = defined(
        worldGetSceneInstanceState(world, nested)
          .unwrap()
          .bindings.get(sceneEntityAddressKey('object')),
      );
      expect(world.get(member, Value).unwrap().material).toBe(material);
    }
    expect(assets.read(material).unwrap().values?.roughness).toBe(0.2);
    expect(world.sharedRefs._liveCount()).toBe(0);
    expect(runtimeAssets(assets).inspect().assets).toBe(before);
    for (const root of roots) worldDespawnScene(world, root).unwrap();
  });

  test('template edits affect future instances; removing an old override uses captured values', () => {
    const { assets, world } = setup();
    const scene = assets.create(source(1)).unwrap();
    const root = assets.instantiate(scene, world).unwrap();
    const member = defined(
      worldGetSceneInstanceState(world, root)
        .unwrap()
        .bindings.get(sceneEntityAddressKey('object')),
    );
    worldSetSceneOverride(world, root, member, Value, 'amount', 5).unwrap();
    assets.update(scene, { entities: source(9).entities }).unwrap();
    worldRemoveSceneOverride(world, root, member, Value, 'amount').unwrap();
    expect(world.get(member, Value).unwrap().amount).toBe(1);
    const next = assets.instantiate(scene, world).unwrap();
    const nextMember = defined(
      worldGetSceneInstanceState(world, next)
        .unwrap()
        .bindings.get(sceneEntityAddressKey('object')),
    );
    expect(world.get(nextMember, Value).unwrap().amount).toBe(9);
    assets.release(scene).unwrap();
    worldDespawnScene(world, root).unwrap();
    expect(assets.read(scene).ok).toBe(true);
    worldDespawnScene(world, next).unwrap();
    expect(assets.read(scene).ok).toBe(false);
  });

  test('foreign references and invalid source fields cannot create instances or leak holds', () => {
    const { assets, world } = setup();
    const other = new AssetRegistry();
    const foreign = other.create({ kind: 'scene', entities: {} }).unwrap();
    expect(assets.instantiate(foreign, world).ok).toBe(false);
    const scene = assets.create(source('invalid' as unknown as number)).unwrap();
    const before = runtimeAssets(assets).inspect();
    expect(assets.instantiate(scene, world).ok).toBe(false);
    expect(runtimeAssets(assets).inspect()).toEqual(before);
    expect(world.sharedRefs._liveCount()).toBe(0);
    assets.release(scene).unwrap();
    expect(assets.read(scene).ok).toBe(false);
  });
});
