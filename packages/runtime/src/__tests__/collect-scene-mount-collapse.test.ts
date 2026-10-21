import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { SceneInstance } from '@forgeax/engine-render';
import {
  ChildOf,
  sceneEntityAddressKey,
  worldGetSceneInstanceState,
  worldInstantiateScene,
} from '@forgeax/engine-scene';
import type { SceneAsset, SceneEntityAddress } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { publishTestAssets } from './helpers/publish-runtime-assets';
import { registerSceneComponents } from './helpers/register-scene-components';
import { testAssets } from './helpers/runtime-assets';

const G1 = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
const G2 = 'f6af7007-158f-4d92-9e47-93bf2f213e1f';
const ROOT = '00000000-0000-5000-8000-000000000001';
const owners: AssetRegistry[] = [];
afterEach(() => {
  for (const assets of owners.splice(0)) assets.dispose();
});

const child = (count = 1): SceneAsset => ({
  kind: 'scene',
  entities: Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `entity-${index}`,
      { components: { Transform: { pos: [index + 1, 0, 0] } } },
    ]),
  ),
});
const parent = (): SceneAsset => ({
  kind: 'scene',
  entities: {
    'entity-0': { components: { Transform: { pos: [10, 0, 0] } } },
    child: { components: {}, instance: { source: G1 } },
  },
});

async function setup(
  root: SceneAsset,
  children: readonly [string, SceneAsset][] = [[G1, child()]],
) {
  const world = new World();
  registerSceneComponents(world);
  const assets = testAssets(world);
  owners.push(assets);
  publishTestAssets(
    assets,
    [...children, [ROOT, root] as const].map(([guid, payload]) => ({
      guid,
      kind: 'scene',
      payload,
      refs: children
        .map(([guid]) => guid)
        .filter((ref) =>
          Object.values(payload.entities).some((entity) => entity.instance?.source === ref),
        ),
      artifacts: {},
    })),
  );
  const handle = (await assets.load(ROOT, 'scene')).unwrap();
  return { world, assets, handle };
}
function collect(assets: AssetRegistry, world: World, root: EntityHandle) {
  const result = rootsToSceneAsset(assets, world, [root]).unwrap();
  for (const entity of Object.values(result.entities))
    expect(entity.components.SceneInstance).toBeUndefined();
  return result;
}
function instances(asset: SceneAsset) {
  return Object.values(asset.entities).flatMap((entity) =>
    entity.instance ? [entity.instance] : [],
  );
}
function member(world: World, root: EntityHandle, path: SceneEntityAddress) {
  const entity = worldGetSceneInstanceState(world, root)
    .unwrap()
    .bindings.get(sceneEntityAddressKey(path));
  if (entity === undefined) throw new Error(`missing scene member ${JSON.stringify(path)}`);
  return entity;
}

describe('collect keyed scene mounts through source-owned assets', () => {
  it('whole tree collapses: root stripped, child mount excludes members', async () => {
    const { world, assets, handle } = await setup(parent());
    const { root } = worldInstantiateScene(world, handle).unwrap();
    const result = collect(assets, world, root);
    expect(Object.keys(result.entities)).toHaveLength(2);
    expect(instances(result).map((instance) => instance.source)).toEqual([G1]);
  });

  it('deep anchor subtree collapses and ancestors remain owned', async () => {
    const { world, assets, handle } = await setup(child(), []);
    const host = world.spawn().unwrap();
    const outer = world.spawn({ component: ChildOf, data: { parent: host } }).unwrap();
    worldInstantiateScene(world, handle, outer).unwrap();
    const result = collect(assets, world, outer);
    expect(Object.keys(result.entities)).toHaveLength(2);
    expect(instances(result).map((instance) => instance.source)).toEqual([ROOT]);
  });

  it('mount covers the complete child mapping', async () => {
    const { world, assets, handle } = await setup(parent(), [[G1, child(3)]]);
    const { root } = worldInstantiateScene(world, handle).unwrap();
    expect(world.get(root, SceneInstance).unwrap().mapping).toHaveLength(5);
    const result = collect(assets, world, root);
    expect(instances(result)).toHaveLength(1);
    expect(Object.keys(result.entities)).toHaveLength(2);
  });

  it('sparse child mapping preserves its mount', async () => {
    const { world, assets, handle } = await setup(parent(), [[G1, child(2)]]);
    const { root } = worldInstantiateScene(world, handle).unwrap();
    world.despawn(member(world, root, ['child', 'entity-0'])).unwrap();
    expect(instances(collect(assets, world, root))).toHaveLength(1);
  });

  it('distinct child mounts retain their source GUID and disjoint mappings', async () => {
    const { world, assets, handle } = await setup(
      {
        kind: 'scene',
        entities: {
          own: { components: { Transform: {} } },
          childA: { components: {}, instance: { source: G1 } },
          childB: { components: {}, instance: { source: G2 } },
        },
      },
      [
        [G1, child()],
        [G2, child(2)],
      ],
    );
    const { root } = worldInstantiateScene(world, handle).unwrap();
    expect(member(world, root, ['childA', 'entity-0'])).not.toBe(
      member(world, root, ['childB', 'entity-0']),
    );
    expect(
      new Set(instances(collect(assets, world, root)).map((instance) => instance.source)),
    ).toEqual(new Set([G1, G2]));
  });

  it('graft under a child member survives as an owned entity', async () => {
    const { world, assets, handle } = await setup(parent());
    const { root } = worldInstantiateScene(world, handle).unwrap();
    world
      .spawn({ component: ChildOf, data: { parent: member(world, root, ['child', 'entity-0']) } })
      .unwrap();
    const result = collect(assets, world, root);
    expect(Object.keys(result.entities)).toHaveLength(3);
    expect(
      Object.values(result.entities).some(
        (entity) =>
          JSON.stringify(entity.components.ChildOf?.parent) ===
          JSON.stringify(['child', 'entity-0']),
      ),
    ).toBe(true);
  });

  it('a graft reference outside the collected closure fails', async () => {
    const { world, assets, handle } = await setup(parent());
    const CrossWindowRef = defineComponent('CrossWindowRef', { target: 'entity' });
    registerSceneComponents(world, [CrossWindowRef]);
    const { root } = worldInstantiateScene(world, handle).unwrap();
    world
      .spawn(
        { component: ChildOf, data: { parent: member(world, root, 'entity-0') } },
        { component: CrossWindowRef, data: { target: world.spawn().unwrap() } },
      )
      .unwrap();
    expect(rootsToSceneAsset(assets, world, [root]).ok).toBe(false);
  });

  it('preserves graft references through nested keyed instances', async () => {
    const { world, assets, handle } = await setup(
      {
        kind: 'scene',
        entities: { child: { components: {}, instance: { source: G1 } } },
      },
      [
        [G1, { kind: 'scene', entities: { nested: { components: {}, instance: { source: G2 } } } }],
        [G2, { kind: 'scene', entities: { leaf: { components: { Transform: {} } } } }],
      ],
    );
    const { root } = worldInstantiateScene(world, handle).unwrap();
    world
      .spawn({
        component: ChildOf,
        data: { parent: member(world, root, ['child', 'nested', 'leaf']) },
      })
      .unwrap();
    const result = collect(assets, world, root);
    expect(instances(result)).toHaveLength(1);
    const carrier = Object.values(result.entities).find((entity) => entity.instance);
    expect(Array.isArray(carrier?.components.Transform?.pos)).toBe(true);
    expect(
      Object.values(result.entities).some(
        (entity) =>
          JSON.stringify(entity.components.ChildOf?.parent) ===
          JSON.stringify(['child', 'nested', 'leaf']),
      ),
    ).toBe(true);
  });
});
