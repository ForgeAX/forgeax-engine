import { defineComponent } from '@forgeax/engine-ecs';

/** One grid layer. Compose layers with ordinary Transform/ChildOf entities.
 * world.set(Tilemap, ...) publishes edits; no dirty flag or derived entities exist. */
export const Tilemap = defineComponent('Tilemap', {
  cols: { type: 'u32', default: 0 },
  rows: { type: 'u32', default: 0 },
  tileSize: { type: 'array<f32, 2>', default: new Float32Array([1, 1]) },
  chunkSize: { type: 'u32', default: 16 },
  tileset: { type: 'asset<tileset>', default: 0 as never, simulationTransient: true },
  tiles: { type: 'array<u32>' },
  layerOrder: { type: 'i32', default: 0 },
  sortScope: { type: 'u8', default: 0 },
});

/** Whole-chunk terrain or individual cells interleaved with ordinary transparent meshes. */
export const TilemapSort = Object.freeze({ layer: 0 as const, perCell: 1 as const });
