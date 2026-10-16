import { World } from '@forgeax/engine-ecs';
import { TileLayer, Tilemap } from '@forgeax/engine-render/authoring';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import {
  resetTilemapChunkExtractCache,
  tilemapChunkExtractSystem,
} from '../../../render/src/tilemap-chunk-extract-system';
import { makeTilemapAssetLookup } from './helpers/tilemap-assets';

describe('tilemap extraction owner boundary', () => {
  it('recognizes canonical scene ChildOf and Transform tokens', () => {
    const world = new World();
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
    const tilemap = world
      .spawn(
        {
          component: Tilemap,
          data: {
            cols: 1,
            rows: 1,
            tileSize: [1, 1],
            chunkSize: 1,
            tileset: 'test/tileset',
          },
        },
        { component: Transform, data: {} },
      )
      .unwrap();
    world
      .spawn(
        {
          component: TileLayer,
          data: {
            tiles: new Uint32Array([1]),
            layerOrder: 0,
            dirty: 1,
            sortScope: 0,
          },
        },
        { component: ChildOf, data: { parent: tilemap } },
      )
      .unwrap();

    resetTilemapChunkExtractCache();
    tilemapChunkExtractSystem(world, lookup);

    const derived = world
      .inspect()
      .archetypes.find(
        (arch) =>
          arch.componentNames.includes('MeshFilter') && arch.componentNames.includes('Transform'),
      );
    expect(derived?.entityCount).toBe(1);
  });
});
