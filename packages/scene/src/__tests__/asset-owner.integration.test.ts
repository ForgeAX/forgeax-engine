import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { defineComponent, World } from '@forgeax/engine-ecs';
import type { SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  ChildOf,
  Children,
  sceneEntityAddressKey,
  worldDespawnScene,
  worldGetSceneInstanceState,
} from '../index';
import { worldSceneEntityRefOf } from '../instances/entity-ref';
import { instantiateSource } from './managed-scene-fixture';

const SceneInstance = defineComponent('SceneInstance', {
  source: { type: 'asset<scene>' },
  mapping: { type: 'array<entity>' },
  state: { type: 'unique<SceneInstanceState>' },
});
const SceneLinks = defineComponent('SceneLinks', { target: 'entity', peers: 'array<entity>' });
const SceneMarker = defineComponent('ScenePayloadMarker', { value: 'i32' });

function registerSceneWorld(world: World): void {
  for (const component of [SceneInstance, ChildOf, Children, SceneMarker, SceneLinks]) {
    world.components.register(component).unwrap();
  }
}

function scene(): SceneAsset {
  return {
    kind: 'scene',
    entities: {
      marker: { components: { ScenePayloadMarker: { value: 7 } } },
    },
  };
}

describe('scene payload ownership', () => {
  it('retains the payload for the mounted instance and releases it on despawn', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    registerSceneWorld(world);

    const result = instantiateSource(assets, world, scene());

    expect(result.ok).toBe(true);
    expect(runtimeAssets(assets).inspect().assets).toBe(1);
    if (!result.ok) return;
    expect(worldDespawnScene(world, result.value.root).ok).toBe(true);
    expect(runtimeAssets(assets).inspect().assets).toBe(0);
  });

  it('allocates the same complete managed state that readers observe', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    registerSceneWorld(world);
    const allocated = vi.spyOn(world, 'allocUniqueRef');
    const root = instantiateSource(assets, world, scene()).unwrap().root;
    const state = worldGetSceneInstanceState(world, root).unwrap();
    const handle = world.get(root, SceneInstance).unwrap().state;
    expect(allocated).toHaveBeenCalledTimes(1);
    expect(allocated.mock.calls[0]?.[1]).toBe(state);
    expect(world.resolveUniqueRef(handle).unwrap()).toBe(state);
    const member = state.bindings.get(sceneEntityAddressKey('marker'));
    expect(member).toBeDefined();
    if (member === undefined) throw new Error('scene marker was not materialised');
    expect(worldSceneEntityRefOf(world, member)).toEqual({
      sceneSourceKey: '',
      address: 'marker',
    });
    worldDespawnScene(world, root).unwrap();
    expect(world.resolveUniqueRef(handle)).toMatchObject({
      ok: false,
      error: { code: 'unique-ref-stale' },
    });
    expect(worldGetSceneInstanceState(world, root).ok).toBe(false);
    expect(worldSceneEntityRefOf(world, member)).toBeUndefined();
    expect(runtimeAssets(assets).inspect().assets).toBe(0);
  });

  it('releases the temporary producer grant when materialisation fails', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    registerSceneWorld(world);

    const result = instantiateSource(assets, world, {
      kind: 'scene',
      entities: { missing: { components: { ScenePayloadMarker: { value: 'invalid' } } } },
    } as SceneAsset);

    expect(result.ok).toBe(false);
    expect(runtimeAssets(assets).inspect().assets).toBe(0);
  });
  it('binds forward, cyclic and array references after all scene members are live', async () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    registerSceneWorld(world);
    const child = assets.create(scene()).unwrap();
    const source: SceneAsset = {
      kind: 'scene',
      entities: {
        a: { components: { SceneLinks: { target: 'z', peers: ['z', 'a'] } } },
        z: {
          components: {
            SceneLinks: { target: 'a', peers: ['a', 'mounted'] },
            ChildOf: { parent: 'a' },
          },
        },
        mounted: {
          components: {
            SceneLinks: { target: 'z', peers: ['z', 'a'] },
            ChildOf: { parent: 'a' },
          },
          instance: { source: child },
        },
      },
    };
    const first = instantiateSource(assets, world, source).unwrap();
    const second = instantiateSource(assets, world, source).unwrap();
    for (const instance of [first, second]) {
      const state = worldGetSceneInstanceState(world, instance.root).unwrap();
      const a = state.bindings.get(sceneEntityAddressKey('a'));
      const z = state.bindings.get(sceneEntityAddressKey('z'));
      const mounted = state.bindings.get(sceneEntityAddressKey('mounted'));
      if (a === undefined || z === undefined || mounted === undefined)
        throw new Error('Missing scene member');
      expect(world.get(a, SceneLinks).unwrap().target).toBe(z);
      expect(Array.from(world.get(a, SceneLinks).unwrap().peers)).toEqual([z, a]);
      expect(world.get(z, SceneLinks).unwrap().target).toBe(a);
      expect(Array.from(world.get(z, SceneLinks).unwrap().peers)).toEqual([a, mounted]);
      expect(world.get(mounted, SceneLinks).unwrap().target).toBe(z);
      expect(Array.from(world.get(mounted, SceneLinks).unwrap().peers)).toEqual([z, a]);
      expect(Array.from(world.get(a, Children).unwrap().entities)).toContain(z);
      expect(Array.from(world.get(a, Children).unwrap().entities)).toContain(mounted);
    }
    worldDespawnScene(world, first.root).unwrap();
    worldDespawnScene(world, second.root).unwrap();
    assets.release(child).unwrap();
    assets.dispose();
    expect(runtimeAssets(assets).inspect().assets).toBe(0);
  });
});
