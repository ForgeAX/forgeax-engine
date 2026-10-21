import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import {
  ChildOf,
  Children,
  sceneEntity,
  worldDespawnScene,
  worldResolveSceneEntity,
  worldWriteSceneField,
} from '../index';
import { instantiateSource } from './managed-scene-fixture';

const SceneInstance = defineComponent('SceneInstance', {
  source: 'asset<scene>',
  mapping: 'array<entity>',
  state: 'unique<SceneInstanceState>',
});
const Light = defineComponent('DirectionalLight', {
  color: 'array<f32, 3>',
  intensity: 'f32',
  target: 'entity',
});

describe('explicit Scene instance field writes', () => {
  it('writes only the addressed instance and emits normal World change evidence without a query', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    for (const component of [SceneInstance, ChildOf, Children, Light])
      world.components.register(component).unwrap();
    const source = {
      kind: 'scene' as const,
      entities: { sun: { components: { DirectionalLight: { color: [1, 1, 1], intensity: 2 } } } },
    };
    const first = instantiateSource(assets, world, source).unwrap().root;
    const second = instantiateSource(assets, world, source).unwrap().root;
    const ref = sceneEntity('', 'sun');
    const sun = worldResolveSceneEntity(world, first, ref).unwrap();
    const other = worldResolveSceneEntity(world, second, ref).unwrap();
    const changes = world.query({ changed: [Light] }).unwrap();
    changes.spans().unwrap();
    const query = vi.spyOn(world, 'query').mockImplementation(() => {
      throw new Error('writes must not scan entities');
    });
    expect(
      worldWriteSceneField(world, first, ref, 'DirectionalLight', 'color', [0.1, 0.2, 0.3]).ok,
    ).toBe(true);
    expect(Array.from(world.get(sun, Light).unwrap().color)).toEqual(
      expect.arrayContaining([expect.closeTo(0.1), expect.closeTo(0.2), expect.closeTo(0.3)]),
    );
    expect(Array.from(world.get(other, Light).unwrap().color)).toEqual([1, 1, 1]);
    expect([...changes.spans().unwrap()].flatMap((span) => [...span.entities])).toContain(sun); // changed queries operate on archetype spans
    expect(source.entities.sun.components.DirectionalLight.color).toEqual([1, 1, 1]);
    expect(query).not.toHaveBeenCalled();
    expect(
      worldWriteSceneField(
        world,
        first,
        sceneEntity('another-scene', 'sun'),
        'DirectionalLight',
        'intensity',
        3,
      ).ok,
    ).toBe(false);
    expect(worldWriteSceneField(world, first, ref, 'DirectionalLight', 'color', [1, 2]).ok).toBe(
      false,
    );
    expect(worldWriteSceneField(world, first, ref, 'DirectionalLight', 'target', other).ok).toBe(
      false,
    );
    worldDespawnScene(world, first).unwrap();
    expect(worldWriteSceneField(world, first, ref, 'DirectionalLight', 'intensity', 3).ok).toBe(
      false,
    );
    query.mockRestore();
    worldDespawnScene(world, second).unwrap();
    assets.dispose();
  });
});
