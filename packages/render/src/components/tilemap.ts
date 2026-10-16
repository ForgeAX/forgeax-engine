// @forgeax/engine-runtime - Tilemap (grid + tileset reference).
//
// Schema (5 fields):
//   cols       u32               total grid columns
//   rows       u32               total grid rows
//   tileSize   array<f32, 2>     per-cell world [width, height] (default [1, 1];
//                                feat-20260709 M3: collapsed from the tileSizeX
//                                / tileSizeY scalar pair into one inline column)
//   chunkSize  u32               per-chunk axis-length in cells (default 16)
//   tileset    string                durable TilesetAsset GUID
//
// Naming: single-semantic Tilemap (AGENTS.md §Component naming drops
// `Component` suffix). One Tilemap entity per grid; TileLayer entities
// attach via ChildOf relationship and supply the per-cell tile id array
// for a single render-layer.
//
// charter mapping: F1 (single-import barrel from `@forgeax/engine-runtime`),
// P1 (progressive disclosure - defaults cover the common case), P4 (durable
// asset identity stays separate from World-local handles).

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Tilemap component (M0 baseline rebuild).
 *
 * A Tilemap entity carries grid metadata + a single durable `tileset` GUID. The
 * actual per-cell tile id array lives on attached `TileLayer` entities
 * (one per render layer; ChildOf points back to the Tilemap entity).
 *
 * Defaults:
 *   - `tileSize = [1, 1]` (unit-cell world coordinates).
 *   - `chunkSize = 16` (tilemap-chunk-extract-system chunks 16x16 cells).
 *
 * @example Spawn a 32x32 unit-cell Tilemap referencing a TilesetAsset:
 *   const tilemap = world.spawn(
 *     { component: Tilemap, data: { cols: 32, rows: 32, tileset } },
 *     { component: Transform, data: {} },
 *   ).unwrap();
 */
export const Tilemap = defineComponent('Tilemap', {
  cols: { type: 'u32', default: 0 },
  rows: { type: 'u32', default: 0 },
  // tileSize carries an explicit layer-2 default [1,1] (unit cell); the array
  // layer-3 fallback is all-zero, so the default MUST be explicit (D-5).
  tileSize: { type: 'array<f32, 2>', default: new Float32Array([1, 1]) },
  chunkSize: { type: 'u32', default: 16 },
  tileset: { type: 'string' },
});
