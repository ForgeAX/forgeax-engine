import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineComponent, World } from '@forgeax/engine-ecs';
import * as SceneOwner from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { registerSceneComponents } from './helpers/register-scene-components';

const Selected = defineComponent('SparseSceneSelected', {}, { storage: 'sparse' });
const RuntimeOnly = defineComponent(
  'SparseSceneRuntimeOnly',
  {},
  {
    storage: 'sparse',
    transient: true,
  },
);

describe('sparse tag scene persistence', () => {
  it('round-trips authored sparse tags and omits transient sparse tags', () => {
    const source = new World();
    registerSceneComponents(source, [Selected, RuntimeOnly]);
    const entity = source
      .spawn({ component: Selected, data: {} }, { component: RuntimeOnly, data: {} })
      .unwrap();
    const registry = {} as AssetRegistry;
    const collected = rootsToSceneAsset(registry, source, [entity]).unwrap();
    const components = Object.values(collected.entities)[0]?.components as
      | Record<string, Record<string, unknown>>
      | undefined;

    expect(components?.SparseSceneSelected).toEqual({});
    expect(components?.SparseSceneRuntimeOnly).toBeUndefined();

    const target = new World();
    registerSceneComponents(target, [Selected, RuntimeOnly]);
    const handle = target.allocSharedRef('SceneAsset', collected);
    SceneOwner.worldInstantiateScene(target, handle).unwrap();
    expect(
      Array.from(target.query({ with: [Selected] }).unwrap(), (row) => row.entity),
    ).toHaveLength(1);
    expect(Array.from(target.query({ with: [RuntimeOnly] }).unwrap())).toEqual([]);
  });
});
