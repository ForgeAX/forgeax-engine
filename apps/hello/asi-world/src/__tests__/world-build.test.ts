// bug-20260622-sprite-double-scale-and-tilemap-sub-layer-collapse
// B-01 unit tests for buildWorld sub-layer expansion (AC-04 / AC-05 / AC-07).
//
// Regression gate: the earlier path collapsed `graphic_index` to only the
// last entry, hiding lower-painted terrain transitions. `buildWorld` now
// spawns one TileLayer per sub-layer index with `layerOrder = baseLayerOrder
// + subIndex`, so sub-layers stack within their height bucket but never
// cross into the next bucket (HEIGHT_LAYER_BASE = 100 per world-build.ts).
//
// Two cases:
//   (1) 2-entry graphic_index [4, 6] at height=0, cell (2,2) in a 5×5 grid:
//       layers.length >= 2, subIndex-0 tiles[cellIdx]=5, subIndex-1 tiles[cellIdx]=7.
//   (2) 3-entry graphic_index [4, 6, 8] at height=0, cell (1,1) in a 3×3 grid:
//       three layers for height bucket '0', subIndex=[0,1,2],
//       layerOrder strictly monotonically increasing.
//
// Anchors: requirements AC-04/AC-05/AC-07; plan-strategy §B-01.

import { describe, expect, it } from 'vitest';
import { buildWorld } from '../world-build';
import type {
  ObjectTypeConfigFile,
  TerrainConfigFile,
  TerrainFile,
  TsjFile,
} from '../types';

// Shared minimal fixtures — no tiles, no templates, no objects.
const minTerrainTsj: TsjFile = {
  type: 'tileset',
  name: 'terrain',
  image: 'terrain.png',
  imagewidth: 256,
  imageheight: 256,
  tilewidth: 16,
  tileheight: 16,
  tilecount: 64,
  tiles: [],
};

const minObjectTsj: TsjFile = {
  type: 'tileset',
  name: 'objects',
  image: 'objects.png',
  imagewidth: 256,
  imageheight: 256,
  tilewidth: 16,
  tileheight: 16,
  tilecount: 64,
  tiles: [],
};

const minTerrainConfig: TerrainConfigFile = { templates: {} };
const minObjectTypes: ObjectTypeConfigFile = { types: {} };

describe('buildWorld sub-layer expansion (B-01, AC-04/AC-05/AC-07)', () => {
  it('(1) 2-entry graphic_index [4,6] -> layers.length >= 2; subIndex-0 tiles = 5, subIndex-1 tiles = 7', () => {
    const terrain: TerrainFile = {
      version: '1',
      cols: 5,
      rows: 5,
      cells: {
        '0': [
          {
            x: 2,
            y: 2,
            height: 0,
            template_id: [],
            graphic_index: [4, 6],
          },
        ],
      },
      objects: [],
    };

    const result = buildWorld({
      terrain,
      terrainConfig: minTerrainConfig,
      terrainTsj: minTerrainTsj,
      objectTsj: minObjectTsj,
      objectTypes: minObjectTypes,
    });

    // At least two layers must exist for the height-0 bucket.
    expect(result.layers.length).toBeGreaterThanOrEqual(2);

    // Cell (x=2, y=2) in a 5-col grid: idx = y*cols + x = 2*5 + 2 = 12.
    const cellIdx = 2 * 5 + 2;

    const layer0 = result.layers.find((l) => l.heightKey === '0' && l.subIndex === 0);
    const layer1 = result.layers.find((l) => l.heightKey === '0' && l.subIndex === 1);

    expect(layer0).toBeDefined();
    expect(layer1).toBeDefined();
    // +1 because tile id 0 is the engine's transparent-cell sentinel.
    expect(layer0?.tiles[cellIdx]).toBe(5); // 4 + 1
    expect(layer1?.tiles[cellIdx]).toBe(7); // 6 + 1
  });

  it('(2) 3-entry graphic_index [4,6,8] -> three sub-layers; subIndex=[0,1,2]; layerOrder strictly monotonic', () => {
    const terrain: TerrainFile = {
      version: '1',
      cols: 3,
      rows: 3,
      cells: {
        '0': [
          {
            x: 1,
            y: 1,
            height: 0,
            template_id: [],
            graphic_index: [4, 6, 8],
          },
        ],
      },
      objects: [],
    };

    const result = buildWorld({
      terrain,
      terrainConfig: minTerrainConfig,
      terrainTsj: minTerrainTsj,
      objectTsj: minObjectTsj,
      objectTypes: minObjectTypes,
    });

    const heightLayers = result.layers.filter((l) => l.heightKey === '0');
    expect(heightLayers.length).toBe(3);

    // Sub-layers must be ordered bottom-to-top: subIndex 0, 1, 2.
    expect(heightLayers.map((l) => l.subIndex)).toEqual([0, 1, 2]);

    // layerOrder must be strictly monotonically increasing within the bucket.
    const orders = heightLayers.map((l) => l.layerOrder);
    for (let i = 1; i < orders.length; i++) {
      const prev = orders[i - 1];
      const curr = orders[i];
      expect(curr).toBeGreaterThan(prev ?? -Infinity);
    }
  });
});
