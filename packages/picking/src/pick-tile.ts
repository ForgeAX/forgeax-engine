import { Entity, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { decodeTileBits } from '@forgeax/engine-graphics-extras';
import { mat4, vec3 } from '@forgeax/engine-math';
import { Tilemap } from '@forgeax/engine-render/authoring';
import { GlobalTransform } from '@forgeax/engine-scene';
import { err, ok, type Result } from '@forgeax/engine-types';

export type PickTileError =
  | { readonly code: 'tilemap-not-found'; readonly tilemapEntity: EntityHandle }
  | { readonly code: 'tilemap-component-missing'; readonly tilemapEntity: EntityHandle };

export interface PickTileHit {
  readonly tilemapEntity: EntityHandle;
  readonly cellX: number;
  readonly cellY: number;
  readonly tileId: number;
}

/** Query one ordinary Tilemap layer's author grid. No child entities or parallel asset catalogue. */
export function pickTile(
  world: World,
  tilemapEntity: EntityHandle,
  worldX: number,
  worldY: number,
): Result<PickTileHit | null, PickTileError> {
  if (!world.get(tilemapEntity, Entity).ok)
    return err({ code: 'tilemap-not-found', tilemapEntity });
  const row = world.get(tilemapEntity, Tilemap);
  if (!row.ok) return err({ code: 'tilemap-component-missing', tilemapEntity });
  const tilemap = row.value;
  const transform = world.get(tilemapEntity, GlobalTransform);
  const local = transform.ok
    ? mat4.transformPoint(vec3.create(), mat4.invert(mat4.create(), transform.value.world), [
        worldX,
        worldY,
        0,
      ])
    : ([worldX, worldY] as const);
  const width = tilemap.tileSize[0] ?? 0,
    height = tilemap.tileSize[1] ?? 0;
  if (!(width > 0) || !(height > 0) || !local.every(Number.isFinite)) return ok(null);
  const cellX = Math.floor(local[0] / width),
    cellY = Math.floor(local[1] / height);
  if (cellX < 0 || cellY < 0 || cellX >= tilemap.cols || cellY >= tilemap.rows) return ok(null);
  const tileId = decodeTileBits(tilemap.tiles[cellY * tilemap.cols + cellX] ?? 0).tileId;
  return ok(tileId === 0 ? null : { tilemapEntity, cellX, cellY, tileId });
}
