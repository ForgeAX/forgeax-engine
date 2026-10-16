import { type EntityHandle, Update, World } from '@forgeax/engine-ecs';
import { MeshFilter } from '@forgeax/engine-render';
import { TileLayer, Tilemap } from '@forgeax/engine-render/authoring';
import {
  ChildOf,
  Children,
  GlobalTransform,
  registerPropagateTransforms,
  Transform,
} from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { tilemapChunkExtractSystem } from '../../../render/src/tilemap-chunk-extract-system';
import { registerRuntimeComponents } from './helpers/register-runtime-components';
import { makeTilemapAssetLookup } from './helpers/tilemap-assets';

describe('tilemap derivation and Transform publication order', () => {
  it('materializes in Update and publishes the new world matrix before update returns', () => {
    const world = new World();
    registerRuntimeComponents(world);
    const tileset = {
      kind: 'tileset' as const,
      atlases: ['test/atlas'],
      tileWidth: 1,
      tileHeight: 1,
      columns: 1,
      rows: 1,
      regions: [{ x: 0, y: 0, width: 1, height: 1 }],
      tiles: [{ regionIndex: 0 }],
    };
    const lookup = makeTilemapAssetLookup(tileset);
    registerPropagateTransforms(world);
    const map = world
      .spawn(
        {
          component: Tilemap,
          data: {
            cols: 1,
            rows: 1,
            tileSize: [2, 2],
            chunkSize: 1,
            tileset: 'test/tileset',
          },
        },
        { component: Transform, data: { pos: [4, 0, 0] } },
      )
      .unwrap();
    const layer = world
      .spawn(
        {
          component: TileLayer,
          data: { tiles: new Uint32Array([1]), dirty: 1, sortScope: 1 },
        },
        { component: Transform, data: {} },
        { component: ChildOf, data: { parent: map } },
      )
      .unwrap();
    world
      .addSystem(Update, {
        name: 'renderDerivedEntities',
        queries: [],
        fn: (world) => tilemapChunkExtractSystem(world, lookup),
      })
      .unwrap();

    world.update(1 / 60).unwrap();

    const derivedTable = world
      .inspect()
      .archetypes.find((table) => table.componentNames.includes(MeshFilter.name));
    expect(derivedTable?.entityCount).toBe(1);
    const children = world.get(layer, Children).unwrap();
    const derived = children.entities[0] as EntityHandle | undefined;
    expect(derived).toBeDefined();
    const transform = derived === undefined ? undefined : world.get(derived, GlobalTransform);
    const matrix = transform?.ok ? transform.value.world : undefined;
    expect({
      derived: matrix?.[12],
      layer: world.get(layer, GlobalTransform).unwrap().world[12],
      map: world.get(map, GlobalTransform).unwrap().world[12],
      entityCount: world.inspect().entityCount,
    }).toEqual({ derived: 5, layer: 4, map: 4, entityCount: expect.any(Number) });
    expect(matrix?.[13]).toBeCloseTo(1);
    expect(world.inspect().schedules.map((entry) => entry.schedule.name)).not.toContain(
      'FramePublish',
    );
  });
});
