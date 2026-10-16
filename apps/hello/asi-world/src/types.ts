// Type shapes for the asi_world JSON we read at runtime. Fields mirror the
// asi_world `.tsj` / world data verbatim — no rename, no shape change.
//
// Note on collider: the asi_world `.tsj` flavor carries three variants
// (`none` / `rect` / `polygon`). This is an asi_world extension; the
// upstream Tiled `.tsj` schema for object colliders looks different.
// See packages/runtime/README.md §Object layer for the engine-side
// collider schema (TilesetTileCollider) which mirrors this 3-variant
// union 1:1 (charter P3 closed enum, P4 consistent abstraction).

export interface TsjPivot {
  readonly x: number;
  readonly y: number;
}

export type TsjCollider =
  | { readonly type: 'none' }
  | { readonly type: 'rect'; readonly rect: readonly [number, number, number, number] }
  | { readonly type: 'polygon'; readonly points: readonly (readonly [number, number])[] };

export interface TsjTile {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly pivot: TsjPivot;
  readonly collider: TsjCollider;
}

export interface TsjFile {
  readonly type: 'tileset';
  readonly name: string;
  readonly image: string;
  readonly imagewidth: number;
  readonly imageheight: number;
  readonly tilewidth: number;
  readonly tileheight: number;
  readonly tilecount: number;
  readonly tiles: readonly TsjTile[];
}

export interface TerrainCell {
  readonly x: number;
  readonly y: number;
  readonly height: number;
  readonly template_id: readonly string[];
  readonly graphic_index: readonly number[];
}

export interface TerrainObject {
  readonly instanceId: string;
  readonly typeId: string;
  readonly x: number;
  readonly y: number;
  readonly height: number;
  readonly direction: number;
}

export interface TerrainFile {
  readonly version: string;
  readonly cols: number;
  readonly rows: number;
  readonly cells: { readonly [heightKey: string]: readonly TerrainCell[] };
  readonly objects: readonly TerrainObject[];
}

export interface TerrainTemplate {
  readonly passability?: { readonly category?: string };
}
export interface TerrainConfigFile {
  readonly templates: { readonly [name: string]: TerrainTemplate };
}

export interface ObjectType {
  readonly graphic: number;
  readonly graphicSize?: { readonly cols: number; readonly rows: number };
  readonly passability?: { readonly blocksMovement?: boolean };
}
export interface ObjectTypeConfigFile {
  readonly types: { readonly [name: string]: ObjectType };
}
