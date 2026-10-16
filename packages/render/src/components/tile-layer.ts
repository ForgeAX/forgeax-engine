// @forgeax/engine-runtime - TileLayer (one render layer of a Tilemap).
//
// Schema (4 fields):
//   tiles       array<u32>  per-cell tile id (packed Tiled .tmj wire form);
//                           length == parent.Tilemap.cols * rows.
//   layerOrder  i32         render-order key (higher = drawn on top).
//   dirty       u8          0 means clean, non-zero means dirty - the next
//                           tilemap-chunk-extract-system pass rebuilds derived
//                           per-cell entities for this layer.
//   sortScope   u8 (TS:     0 = 'layer'    (default) - terrain semantics:
//               closed                       every derived entity in this
//               'layer' |                    layer shares one Layer.value
//               'per-cell'                   (layerOrder << 20), so the
//               union)                       whole layer Y-sorts as a single
//                                            bucket. AI users grep
//                                            `sortScope: 'layer'` to confirm.
//                           1 = 'per-cell' - object semantics: each derived
//                                            entity carries its own foot-Y
//                                            key; preserves per-cell entity
//                                            derivation for Y-interleave
//                                            with sprite entities sharing
//                                            the same Layer.value.
//
//   Storage rationale (D-V-3 R-NEW-1 fallback / round-2): ECS schema does not
//   yet support `values: ['layer', 'per-cell']` literal-union constraints
//   on a `'string'` column, so the on-disk shape is `u8` (0/1) but every
//   AI-facing TS surface (`TileLayerData.sortScope`) is the closed
//   `'layer' | 'per-cell'` string union. The bridge functions
//   `encodeSortScope` / `decodeSortScope` are the SSOT for the two-way
//   mapping (charter F1 — single grep target).
//
// Each TileLayer entity attaches to a Tilemap entity via ChildOf (the parent
// field carries the Tilemap entity). M0 supports multiple TileLayer entities
// per Tilemap (each rendered as an independent z-ordered layer).
//
// charter mapping: F1 (single-import barrel + single grep target for
// `sortScope`), P1 (progressive disclosure — `'layer'` / `'per-cell'`
// reads directly without a magic-number table), P3 (dirty flag is
// explicit - silent re-extraction is forbidden), P4 (handle-free row
// schema mirrors MeshFilter / MeshRenderer conventions).

import { defineComponent, type EcsError, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { Result } from '@forgeax/engine-types';

/**
 * Closed string-literal union for the TileLayer.sortScope field. AI users
 * grep `sortScope` and land on this single SSOT type alias; switch
 * statements over this type are exhaustive without a default arm.
 *
 *   - 'layer'    - terrain semantics; whole layer shares one Layer.value
 *                  bucket and Y-sorts together (chunkIndex is folded into 0).
 *   - 'per-cell' - object semantics; each derived entity gets its own
 *                  chunkIndex tiebreak so it can Y-interleave with
 *                  sprite entities carrying the same Layer.value (e.g. a
 *                  player sprite riding the same SPRITE_LAYER_VALUE).
 */
export type SortScope = 'layer' | 'per-cell';

/** Compact authoring values for the stored u8 sort-scope field. */
export const TilemapSort = Object.freeze({
  layer: 0 as const,
  perCell: 1 as const,
});

/**
 * Bridge: `SortScope` -> on-disk u8. SSOT for the encoding (`'layer'` -> 0,
 * `'per-cell'` -> 1). The compile-time exhaustive switch guards against
 * silent drift if the union ever grows; adding a new literal here without
 * adding its arm fails typecheck (charter P3 — closed unions never default).
 */
export function encodeSortScope(scope: SortScope): 0 | 1 {
  switch (scope) {
    case 'layer':
      return TilemapSort.layer;
    case 'per-cell':
      return TilemapSort.perCell;
  }
}

/**
 * Bridge: on-disk u8 -> `SortScope`. Defaults to `'layer'` for any value
 * outside `{0, 1}` (defensive — the column is typed `u8` so out-of-range
 * values can only appear if a future schema migration loosens the bound;
 * the default preserves terrain semantics which is the safer of the two).
 */
export function decodeSortScope(raw: number | undefined): SortScope {
  return raw === 1 ? 'per-cell' : 'layer';
}

/**
 * Public TileLayer field shape (`world.spawn({ component: TileLayer, data:
 * { ... } })` payload). `sortScope` is the closed string union surfaced to
 * AI users; the runtime row encodes it as `u8` via `encodeSortScope` at
 * spawn time so on-disk storage stays compact.
 *
 * Treat as the `TileLayer` data SSOT — `defineComponent` schema below
 * mirrors it field-for-field with the bridge `sortScope: u8` in place of
 * the union literal.
 */
export interface TileLayerData {
  readonly tiles: Uint32Array;
  readonly layerOrder?: number;
  readonly dirty?: number;
  readonly sortScope?: SortScope;
}

/**
 * TileLayer component (M0 baseline rebuild + round-2 sortScope rename).
 *
 * AI users typically spawn a TileLayer + ChildOf pair pointing at an
 * existing Tilemap entity:
 *
 * @example
 *   const tilesArray = new Uint32Array(cols * rows);
 *   tilesArray[5 * cols + 7] = 1; // tile id 1 at cell (7, 5)
 *   world.spawn(
 *     { component: TileLayer, data: { tiles: tilesArray, layerOrder: 0 } },
 *     { component: ChildOf,  data: { parent: tilemapEntity } },
 *   );
 *
 * Object-layer variant (Y-interleave with sprite entities):
 *
 * > NOTE: schema storage is `u8` (ECS schema does not support
 * > string-literal-union column constraints; see R-NEW-2). The
 * > AI-user surface is the closed `SortScope` string union, but
 * > `world.spawn` requires the numeric encoding — pass through
 * > `encodeSortScope('per-cell')` rather than the literal string.
 *
 * @example
 *   world.spawn(
 *     { component: TileLayer, data: {
 *         tiles: objectTiles,
 *         layerOrder: 1000,
 *         sortScope: encodeSortScope('per-cell'),
 *       } },
 *     { component: ChildOf, data: { parent: tilemapEntity } },
 *   );
 *
 * Defaults: `layerOrder = 0`, `dirty = 0`, `sortScope = 'layer'` (stored
 * as `u8 = 0`, i.e. `encodeSortScope('layer')`). `tiles` has no default -
 * AI users supply the per-cell array at spawn time. To trigger a re-build
 * after mutating tiles in place, call `markTileLayerDirty(world, layer)`.
 */
export const TileLayer = defineComponent('TileLayer', {
  tiles: { type: 'array<u32>' },
  layerOrder: { type: 'i32', default: 0 },
  dirty: { type: 'u8', default: 0 },
  sortScope: { type: 'u8', default: 0 },
});

/**
 * Mark a TileLayer entity dirty so the next `tilemapChunkExtractSystem`
 * pass purges and re-spawns its derived per-cell entities. Use this after
 * mutating `TileLayer.tiles` (e.g. an in-place patch via a column view).
 *
 * Returns the underlying ECS write result - on `err` branch the caller
 * can read `.code` to recover (`'stale-entity'` if the layer was
 * despawned, `'component-not-present'` if the entity is missing the
 * TileLayer column; both kebab-case literals are members of the closed
 * `EcsErrorCode` union).
 */
export function markTileLayerDirty(
  world: World,
  layerEntity: EntityHandle,
): Result<void, EcsError> {
  return world.set(layerEntity, TileLayer, { dirty: 1 });
}
