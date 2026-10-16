// pick-tile.ts - cell-level Tilemap query (feat-20260608 M0 baseline rebuild).
//
// `pickTile(world, tilemapEntity, worldX, worldY)` is a free function (not a
// method on `World` -- charter F1 single-import barrel from
// `@forgeax/engine-runtime`). It converts world-space coordinates into the
// Tilemap's local cell grid, walks every TileLayer that ChildOf-s the
// supplied tilemap, and returns the FIRST non-zero tile id seen when scanning
// layers in DESCENDING `layerOrder` (highest layer drawn on top wins).
//
// charter mapping:
//   - P3 explicit failure as value: out-of-bounds and "every layer empty"
//     resolve to `Result.ok(null)` -- never throws or fires onError. Dead
//     handles and live entities without Tilemap are separate structural
//     failures; the `PickTileError` union is closed to two variants and stays
//     a runtime-only type (not exported through `@forgeax/engine-types`, since
//     pickTile is a runtime-only system).
//   - P4 consistent abstraction: matches the `pick(world, ...)` raycast
//     surface in pick.ts -- free function, world+entity input, structured
//     error union, hit-or-null return.
//   - F1 single-import: exported from `@forgeax/engine-picking`'s barrel.
//
// Anchors: requirements §integration-points (engine-runtime pickTile);
// plan-tasks m0-t8; plan-strategy §D-5 file-by-file ECS API adaptation
// (World-owned Query pattern from render-system-extract.ts).

import { Entity, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { mat4, vec3 } from '@forgeax/engine-math';
import { TileLayer, Tilemap } from '@forgeax/engine-render/authoring';
import { ChildOf, GlobalTransform } from '@forgeax/engine-scene';
import { err, ok, type Result } from '@forgeax/engine-types';

/**
 * Closed error union for `pickTile` (charter P3 + P4). Two variants cover the
 * structural-break paths; "ray hit nothing" is a value (`Result.ok(null)`),
 * not an error.
 */
export type PickTileError =
  | { readonly code: 'tilemap-not-found'; readonly tilemapEntity: EntityHandle }
  | { readonly code: 'tilemap-component-missing'; readonly tilemapEntity: EntityHandle };

/**
 * Successful picking outcome. Returned through `Result.ok`; a `null` value
 * means the query landed in-bounds but every layer at that cell was empty
 * (or the point was outside the tilemap world bounds).
 */
export interface PickTileHit {
  readonly layerEntity: EntityHandle;
  readonly cellX: number;
  readonly cellY: number;
  readonly tileId: number;
}

/**
 * Find the topmost non-zero tile under `(worldX, worldY)` for a given
 * Tilemap entity, walking child TileLayer entities in DESCENDING
 * `layerOrder`.
 *
 * @returns
 *   - `Result.ok(PickTileHit)` for a non-zero cell on some layer.
 *   - `Result.ok(null)` for an empty cell or out-of-bounds query.
 *   - `Result.err({ code: 'tilemap-not-found' })` for a dead handle.
 *   - `Result.err({ code: 'tilemap-component-missing' })` for a live entity
 *     without a Tilemap component.
 *
 * The caller must propagate the World so `GlobalTransform.world` is current. A
 * singular world transform follows `mat4.invert`'s deterministic identity
 * fallback, which keeps this error union structural rather than adding a
 * third diagnostic arm.
 */
export function pickTile(
  world: World,
  tilemapEntity: EntityHandle,
  worldX: number,
  worldY: number,
): Result<PickTileHit | null, PickTileError> {
  const entityResult = world.get(tilemapEntity, Entity);
  if (!entityResult.ok) {
    return err({ code: 'tilemap-not-found', tilemapEntity });
  }

  const tilemapResult = world.get(tilemapEntity, Tilemap);
  if (!tilemapResult.ok) {
    return err({ code: 'tilemap-component-missing', tilemapEntity });
  }
  const tilemap = tilemapResult.value;
  const cols = tilemap.cols;
  const rows = tilemap.rows;
  // feat-20260709 M3: tileSize is one inline array<f32,2> column; the
  // world.get read path materialises it as a Float32Array ([width, height]).
  const tileSizeX = tilemap.tileSize[0] ?? 1;
  const tileSizeY = tilemap.tileSize[1] ?? 1;

  // Tilemap entities without a Transform retain the origin-default path. For
  // transformed maps, the full propagated affine inverse is the only correct
  // way to recover local cell coordinates under rotation and non-uniform scale.
  let localX = worldX;
  let localY = worldY;
  const transformResult = world.get(tilemapEntity, GlobalTransform);
  if (transformResult.ok) {
    const w = transformResult.value.world;
    if (w !== undefined && w.length >= 16) {
      const local = mat4.transformPoint(vec3.create(), mat4.invert(mat4.create(), w), [
        worldX,
        worldY,
        0,
      ]);
      localX = local[0] ?? 0;
      localY = local[1] ?? 0;
    }
  }

  if (tileSizeX <= 0 || tileSizeY <= 0) return ok(null);
  if (localX < 0 || localY < 0) return ok(null);

  const cellX = Math.floor(localX / tileSizeX);
  const cellY = Math.floor(localY / tileSizeY);
  if (cellX < 0 || cellY < 0 || cellX >= cols || cellY >= rows) return ok(null);

  // Collect every TileLayer ChildOf-ing the supplied Tilemap entity, with
  // its layerOrder + tile array snapshot through one row iterator.
  type LayerInfo = {
    readonly entity: EntityHandle;
    readonly tiles: ArrayLike<number>;
    readonly layerOrder: number;
  };
  const layers: LayerInfo[] = [];
  const layerQuery = world.query({ read: [TileLayer, ChildOf] }).unwrap();
  for (const row of layerQuery) {
    const layerEntity = row.entity;
    const parent = row.get(ChildOf).parent;
    if ((parent as unknown as number) !== (tilemapEntity as unknown as number)) continue;
    const layerData = world.get(layerEntity, TileLayer);
    if (!layerData.ok) continue;
    layers.push({
      entity: layerEntity,
      tiles: layerData.value.tiles as ArrayLike<number>,
      layerOrder: row.get(TileLayer).layerOrder,
    });
  }

  layers.sort((a, b) => b.layerOrder - a.layerOrder);

  const cellIndex = cellY * cols + cellX;
  for (const layer of layers) {
    if (cellIndex >= layer.tiles.length) continue;
    const tileId = layer.tiles[cellIndex] ?? 0;
    if (tileId !== 0) {
      return ok({
        layerEntity: layer.entity,
        cellX,
        cellY,
        tileId,
      });
    }
  }
  return ok(null);
}
