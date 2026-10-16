import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { SceneInstance } from '@forgeax/engine-render';
import { ChildOf, Children, Transform } from '@forgeax/engine-scene';
import type { Asset, Handle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const G_CHILD = '11111111-1111-4111-8111-111111111111';
const G_PARENT = '22222222-2222-4222-8222-222222222222';

function guid(value: string): AssetGuid {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw new Error(`bad GUID: ${value}`);
  return parsed.value;
}

function makeWorld(): World {
  const world = new World();
  for (const component of [ChildOf, Children, SceneInstance, Transform]) {
    world.components.register(component).unwrap();
  }
  return world;
}

describe('instantiate keyed nested instance wiring', () => {
  it('attaches a nested SceneInstance root under the keyed instance entity', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = makeWorld();
    const child: SceneAsset = {
      kind: 'scene',
      entities: { childRoot: { components: { Transform: { pos: [7, 0, 0] } } } },
    };
    registry.catalog(guid(G_CHILD), child as Asset);
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        wrapper: {
          components: { Transform: { pos: [1, 0, 0] } },
          instance: { source: G_CHILD },
        },
      },
    };
    registry.catalog(guid(G_PARENT), parent as Asset);

    const result = registry.instantiate(
      world.allocSharedRef('SceneAsset', parent) as Handle<'SceneAsset', 'shared'>,
      world,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outer = world.get(result.value, SceneInstance);
    expect(outer.ok).toBe(true);
    if (!outer.ok) return;
    const wrapper = outer.value.mapping[0] as unknown as EntityHandle;
    expect(wrapper).toBeDefined();

    let nestedRoot: EntityHandle | undefined;
    for (const entity of world.iterDescendants(result.value)) {
      if (entity === result.value) continue;
      if (world.get(entity, SceneInstance).ok) {
        nestedRoot = entity;
        break;
      }
    }
    expect(nestedRoot).toBeDefined();
    if (nestedRoot === undefined) return;
    const childOf = world.get(nestedRoot, ChildOf);
    expect(childOf.ok).toBe(true);
    if (!childOf.ok) return;
    expect(childOf.value.parent).toBe(wrapper);
  });
});
