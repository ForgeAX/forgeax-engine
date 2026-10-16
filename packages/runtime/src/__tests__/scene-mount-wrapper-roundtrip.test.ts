import type { Asset } from '@forgeax/engine-assets-runtime';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { SceneInstance } from '@forgeax/engine-render';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';
import { registerSceneComponents } from './helpers/register-scene-components';

const CHILD = '11111111-1111-4111-8111-111111111111';
function guid(value: string): AssetGuid {
  const result = AssetGuid.parse(value);
  if (!result.ok) throw new Error(`bad GUID: ${value}`);
  return result.value;
}
function makeHandle(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
  registerSceneComponents(world);
  return world.allocSharedRef('SceneAsset', asset);
}

describe('keyed instance wrapper collect', () => {
  it('collect preserves the wrapper key, source and explicit parent declaration', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    const child: SceneAsset = {
      kind: 'scene',
      entities: { leaf: { components: { Transform: {} } } },
    };
    expect(registry.catalog(guid(CHILD), child as Asset).ok).toBe(true);
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        root: { components: { Transform: {} } },
        wrapper: {
          components: { ChildOf: { parent: 'root' } },
          instance: { source: CHILD },
        },
      },
    };
    const result = registry.instantiate(makeHandle(world, parent), world);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      [...world.iterDescendants(result.value)].filter(
        (entity) => world.get(entity, SceneInstance).ok,
      ),
    ).toHaveLength(1);
    const collected = rootsToSceneAsset(registry, world, [result.value]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    expect(collected.value.entities.wrapper?.instance?.source).toBe(CHILD);
    expect(collected.value.entities.wrapper?.components.ChildOf).toEqual({ parent: 'root' });
  });
});
