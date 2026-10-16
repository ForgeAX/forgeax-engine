// @forgeax/engine-runtime - tilemap-chunk-extract-system.
//
// Walks every TileLayer attached to a Tilemap via ChildOf; when a layer is
// dirty (or has never been extracted), purges its previously-spawned derived
// per-cell entities and re-spawns one ECS entity per non-zero cell. Each
// derived entity carries Transform + MeshFilter (HANDLE_QUAD) + MeshRenderer
// + Layer + ChildOf { parent: layerEntity }. The ChildOf edge lets
// `world.despawn(tilemapEntity)` cascade-despawn the entire subtree
// (Tilemap -> TileLayer -> derived render entities) via the engine's
// default `linkedSpawn: true` (tweak-20260714 M2, requirements AC-02/03/04).
//
// M0 baseline: unit-cell 1x1 form, single-atlas, no UV inset.
// M2 extension (plan-strategy §D-2 + §D-7 step 3):
// M3 extension (plan-strategy §D-7 step 2 + §D-12):
//   - resolveTilesetMaterial walks the 3-hop chain
//     `tile.regionIndex -> regions[i].atlasIndex ?? 0 -> atlases[idx]`
//     so multi-atlas tilesets route each region to the correct GPU
//     texture handle (requirements AC-04 / AC-11). Cache key stays
//     binary `(atlasHandle, regionIndex)` -- atlasHandle already
//     encodes the atlas pick.
//   - spawnDerivedRenderEntities scales the quad by widthCells x
//     heightCells (defaults 1 x 1) and offsets the centre so the pivot
//     lands at the (pivotX, pivotY) location inside the anchor cell.
//   - basePivotForX = D ? pivotY : pivotX (and dually for Y), so the
//     90deg CW z-rotation correctly swaps which atlas-axis pivot maps
//     to which world axis.
//   - effectivePivotX = H ? (1 - basePivotForX) : basePivotForX (and
//     dually for Y). The anchor pivot under H flip lands at the
//     mirrored cell position (charter P4 - same semantics as Tiled's
//     "pivot stays in atlas-local coords, flips with the texel grid").
//   - posX = (cellX + effectivePivotX + (0.5 - effectivePivotX) * widthCells)
//            * tileSizeX
//     posY analogous with effectivePivotY + heightCells.
//   - scaleX/scaleY: signed by H/V flip; magnitude is widthCells *
//     tileSizeX / heightCells * tileSizeY (multi-cell scale).
//   - resolveTilesetMaterial inset-shrinks the region UV rectangle by
//     half a texel on every edge so GPU bilinear filtering at the
//     atlas-tile boundary never bleeds into the adjacent tile
//     (charter P3 - default behaviour avoids visual defects).
//
// M3 boundary: per-entity sort key with effectivePivotY is wired in
// render-system-extract (m3-t5), not here.
//
// Cache key for resolveTilesetMaterial is BINARY: (atlasHandle, regionIndex).
// AI users widthCells / pivot variations share the same material handle
// (charter P4 consistent abstraction; plan-strategy §D-9 / §D-12).
//
// Anchors: plan-tasks m0-t10 / m2-t2 / m2-t4; plan-strategy §D-1 +
// §D-2 (multi-cell + flip x pivot) + §D-5 (M0 baseline file-by-file
// ECS API adaptation) + §D-7 step 3 (half-texel UV inset).

import {
  HANDLE_QUAD,
  resolveTilesetRuntime,
  type TilesetAtlasLookup,
} from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { decodeTileBits } from '@forgeax/engine-graphics-extras';
import { type box3, frustum, mat4 } from '@forgeax/engine-math';
import { ChildOf, Children, GlobalTransform, Transform } from '@forgeax/engine-scene';
import {
  type Handle,
  type MaterialAsset,
  type TilesetAsset,
  type TilesetRegion,
  type TilesetTileEntry,
  toShared,
  unwrapHandle,
} from '@forgeax/engine-types';
import {
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  Camera,
  decodeSortScope,
  Layer,
  MeshFilter,
  MeshRenderer,
  type SortScope,
  SpriteInstances,
  TileLayer,
  Tilemap,
} from './components';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from './materials';

// Module-scoped caches (charter P5 — engine-side memoisation; AI users
// never reach in). Test harness can flush them via the reset helpers.
//
// Two material caches coexist because the extract system produces two
// kinds of derived entities, each with a different material-key granularity:
//
//   1. `atlasMaterialCache` — key `${atlasId}|${regionIndex}` → per-region
//      material with the UV rectangle baked into `values.region`.
//      Used by the per-cell entity path (sortScope='per-cell' object
//      layers). Each tile graphic gets a distinct MaterialAsset.
//
//   2. `atlasOnlyMaterialCache` — key `${atlasId}` → per-atlas material
//      with `values.region: [0,0,1,1]` placeholder. Used by the
//      SpriteInstances batched path (sortScope='layer' terrain layers).
//      The shader's PER_INSTANCE_REGION=true variant reads per-instance
//      UV from the instance buffer, not from the material UBO, so the
//      placeholder is ignored at draw time.
let atlasMaterialCache = new WeakMap<World, Map<string, Handle<'MaterialAsset', 'shared'>>>();
let atlasOnlyMaterialCache = new WeakMap<World, Map<string, Handle<'MaterialAsset', 'shared'>>>();
// tweak-20260714 M3 (plan-strategy §2 D-3): the terrain (sortScope='layer')
// derived-entity tracker Map + first-frame-heuristic Set that used to live
// alongside these material caches were retired once every derived entity
// was attached as `ChildOf` child of its TileLayer (M2). The reverse
// mirror `Children.entities` on the TileLayer is now the SSOT for
// "which derived entities belong to this layer" — engine-maintained on
// `world.addComponent(ChildOf) / world.despawn`, deriving-not-duplicating
// (architecture-principles §2). `purgeDerivedEntities` reads that mirror
// directly; the "already built" gate uses `Children.entities.length > 0`,
// which naturally handles both first frames (empty ⇒ rebuild) and steady
// state (populated ⇒ skip) without a second parallel ledger.

// ─── Chunk-streaming state for sortScope='per-cell' (object) layers ───────
//
// Object layers stream per-chunk: only chunks whose world AABB intersects the
// camera frustum have per-cell entities alive in the ECS world. This keeps
// extractFrame's entity count proportional to visible tile count rather than
// total map tile count (charter P5: engine-side memoisation / streaming).
//
// Design: one WeakMap entry per World owns three bounded maps:
//   layers : layerKey → pre-bucketed specs by chunkIndex (built once
//                      from bucketTileLayer, rebuilt on dirty). Avoids re-reading
//                      the full tileset and re-materialising every frame.
//   chunkEntities : "${layerKey}:${chunkIdx}" → spawned entity ids
//                      for that chunk (purged when chunk leaves frustum).
//   activeChunks : layerKey → Set<chunkIdx> currently spawned.
//
// bug-20260703-tilemap-chunk-stale-frustum-and-cull-overhang (D2): each entry
// stores the ACTUAL world-space bounding box (union of every tile's post-TRS
// footprint from `computeTileTrs`) rather than a tile-aligned grid box.
// Multi-cell tiles (`widthCells` / `heightCells > 1`) and non-central pivots
// let a tile extend beyond its anchor chunk's grid; the grid box would
// despawn the anchor chunk while overhanging tiles were still on screen,
// causing edge-of-chunk flicker as the camera pans. Bounds are computed once
// per (dirty | first-time) rebuild, so the per-frame visibility test stays a
// single `frustum.intersectsBox` call (plan-strategy §2 D-3).
interface ChunkStreamEntry {
  readonly specs: readonly DerivedSpawnSpec[];
  readonly bounds: box3.Box3Like;
}
interface StreamLayerCache {
  readonly byChunk: ReadonlyMap<number, ChunkStreamEntry>;
  readonly tilemap: {
    readonly cols: number;
    readonly rows: number;
    readonly tileSize: ArrayLike<number>;
    readonly chunkSize: number;
  };
  readonly layerOrder: number;
  readonly sortScope: SortScope;
}
interface PerWorldStreamingCache {
  readonly layers: Map<string, StreamLayerCache>;
  readonly chunkEntities: Map<string, EntityHandle[]>;
  readonly activeChunks: Map<string, Set<number>>;
}

let streamingCacheByWorld = new WeakMap<World, PerWorldStreamingCache>();

function streamingCache(world: World): PerWorldStreamingCache {
  let cache = streamingCacheByWorld.get(world);
  if (cache === undefined) {
    cache = {
      layers: new Map(),
      chunkEntities: new Map(),
      activeChunks: new Map(),
    };
    streamingCacheByWorld.set(world, cache);
  }
  return cache;
}

/**
 * Flush both material caches. Useful in test harnesses + after a
 * TilesetAsset reload.
 */
export function resetTilemapChunkExtractCache(): void {
  atlasMaterialCache = new WeakMap<World, Map<string, Handle<'MaterialAsset', 'shared'>>>();
  atlasOnlyMaterialCache = new WeakMap<World, Map<string, Handle<'MaterialAsset', 'shared'>>>();
}

/**
 * Flush the per-cell streaming caches. Useful in test harnesses + when
 * the World is re-created.
 *
 * Signature preserved (AC-08 hard constraint) after tweak-20260714 M3
 * retired the terrain-side tracker Map + first-frame heuristic Set:
 * terrain layers now derive their "already-built" state from
 * `Children.entities` on the TileLayer (mirror of ChildOf, engine-
 * maintained), so the tracker only needs to clear the 3 streaming
 * caches (plan-strategy §2 D-3 + §2 D-5).
 */
export function resetTilemapDerivedEntityTracker(): void {
  streamingCacheByWorld = new WeakMap<World, PerWorldStreamingCache>();
}

/**
 * @internal Test-only helper for AC-11 (tweak-20260714 M4). Returns the
 * union of `layerKey`s currently referenced by the three per-cell
 * streaming caches. Post-diff-cleanup, an evicted layerKey MUST NOT
 * appear here; a slot subsequently reused for a fresh TileLayer sees
 * empty caches and rebuilds from zero (plan-strategy §2 D-4).
 *
 * Parsing the per-World `chunkEntities` key format `${entity}:${chunkIdx}`
 * is intentional so callers observe cleanup on all three maps without
 * depending on the invariant `activeSet ↔ chunkEntities
 * keys are paired` — the test then also cross-checks that invariant.
 */
export function _peekPerCellStreamingLayerKeys(world: World): readonly number[] {
  const cache = streamingCacheByWorld.get(world);
  if (cache === undefined) return [];
  const out = new Set<number>();
  for (const layerKey of cache.layers.keys()) {
    if (Number.isFinite(Number(layerKey))) out.add(Number(layerKey));
  }
  for (const layerKey of cache.activeChunks.keys()) {
    if (Number.isFinite(Number(layerKey))) out.add(Number(layerKey));
  }
  for (const key of cache.chunkEntities.keys()) {
    const parts = key.split(':');
    const entity = parts[0];
    if (entity !== undefined && Number.isFinite(Number(entity))) out.add(Number(entity));
  }
  return Array.from(out);
}

/**
 * Compute the per-layer / per-chunk packed value carried in `Layer.value`
 * on derived entities. `sortScope` is the closed string union from
 * `TileLayer.sortScope`:
 *   - `'layer'`    (default): `(layerOrder << 20) | (chunkIndex & 0xFFFFF)` —
 *                  terrain semantics, layerOrder dominates with chunkIndex
 *                  tiebreak within the layer.
 *   - `'per-cell'`: returns `(layerOrder << 20)` (chunkIndex folded to 0)
 *                  so every derived entity in the layer shares one
 *                  Layer.value and can Y-interleave with sprite entities
 *                  carrying the same value (e.g. a player sprite riding
 *                  `SPRITE_LAYER_VALUE = layerOrder << 20`).
 *
 * Round-2 rename (D-V-3): the third arg was `ySort: boolean` before the
 * sortScope union landed; it is now the closed `SortScope` union with
 * default `'layer'`. The 0x200000 / chunked-bits semantics for the two
 * arms are preserved exactly so existing pixel-parity baselines stay
 * stable (only the AI-user surface widens to a self-documenting literal).
 */
export function encodeTilemapLayerValue(
  layerOrder: number,
  chunkIndex: number,
  sortScope: SortScope = 'layer',
): number {
  if (sortScope === 'per-cell') return (layerOrder << 20) | 0;
  return (layerOrder << 20) | (chunkIndex & 0xfffff) | 0;
}

/**
 * Resolve (regionIndex) into a per-tile sprite material handle by walking
 * the 3-hop chain:
 *
 *   tile.regionIndex -> regions[regionIndex] -> region.atlasIndex ?? 0
 *                    -> atlases[atlasIndex]
 *
 * (plan-strategy §D-7 step 2 + requirements §AC-04 / §AC-11). Caches the
 * resulting MaterialAsset handle so repeated lookups hit a single
 * registered material per atlas-region pair; the cache key stays the
 * binary tuple `(atlasHandle, regionIndex)` -- atlasHandle already
 * encodes the atlasIndex pick so widening to a 3-tuple key would only
 * inflate the SSOT without adding signal (charter P4 + plan-strategy
 * §D-12). atlasIndex out-of-range is caught at register time by
 * `validateTilesetPayload` (m1-t6); the runtime resolver falls through
 * to handle 0 when an atlas slot is unexpectedly empty so the renderer
 * skips the draw rather than silently sampling the wrong texture
 * (charter P3 fail-safe).
 *
 * The shader is `forgeax::sprite`; values are filled with the atlas
 * texture handle + a UV region rectangle covering the supplied
 * TilesetRegion (half-texel inset added in m2-t4).
 */
function resolveTilesetMaterial(
  world: World,
  tileset: TilesetAsset,
  regionIndex: number,
  lookup: (guid: string) => TilesetAtlasLookup,
): Handle<'MaterialAsset', 'shared'> {
  const region = tileset.regions[regionIndex];
  if (region === undefined) return toShared<'MaterialAsset'>(0);
  // 3-hop walk: regions[i].atlasIndex (default 0) -> atlases[atlasIndex].
  // atlasIndex out-of-range is register-time fail-fast via
  // `validateTilesetPayload` (m1-t6); the runtime resolver still bails
  // when the slot is unexpectedly empty (charter P3 fail-safe).
  const atlasIndex = region.atlasIndex ?? 0;
  const atlasGuid = tileset.atlases[atlasIndex];
  if (atlasGuid === undefined) return toShared<'MaterialAsset'>(0);
  const atlas = resolveTilesetRuntime(world, atlasGuid, lookup);
  if (!atlas.ok) return toShared<'MaterialAsset'>(0);
  const atlasHandle = atlas.value.handle;
  const atlasId = unwrapHandle(atlasHandle);
  const cacheKey = `${atlasId}|${regionIndex}`;
  const cache =
    atlasMaterialCache.get(world) ?? new Map<string, Handle<'MaterialAsset', 'shared'>>();
  atlasMaterialCache.set(world, cache);
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Atlas-space rectangle -> normalised UV. M2 adds a half-texel inset
  // on every edge (plan-strategy §D-7 step 3) so GPU bilinear filtering
  // at the region boundary never samples the adjacent atlas tile. Atlas
  // pixel extent comes from atlasSizes[atlasIndex] when present (exact
  // per-atlas pixel dimensions); falls back to columns * tileWidth for
  // single-atlas or legacy callers.
  const atlasSize = tileset.atlasSizes?.[atlasIndex];
  const atlasWidth = Math.max(
    1,
    atlasSize !== undefined ? atlasSize.pixelWidth : tileset.columns * tileset.tileWidth,
  );
  const atlasHeight = Math.max(
    1,
    atlasSize !== undefined ? atlasSize.pixelHeight : tileset.rows * tileset.tileHeight,
  );
  const halfTexelU = 0.5 / atlasWidth;
  const halfTexelV = 0.5 / atlasHeight;
  const u = region.x / atlasWidth + halfTexelU;
  const v = region.y / atlasHeight + halfTexelV;
  const w = region.width / atlasWidth - 2 * halfTexelU;
  const h = region.height / atlasHeight - 2 * halfTexelV;

  const matPayload: MaterialAsset = {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::sprite' },
        renderState: {
          ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
          tags: { LightMode: 'Forward' },
          queue: 3000,
        },
      },
    ],
    values: {
      colorTint: [1.0, 1.0, 1.0, 1.0],
      baseColorTexture: atlasHandle,
      region: [u, v, w, h],
      pivotAndSize: [0.5, 0.5, 1.0, 1.0],
      flipY: 1.0,
    },
  };
  const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    matPayload,
  );
  cache.set(cacheKey, matHandle);
  return matHandle;
}

/**
 * Resolve an atlas-only sprite material (no baked-in UV region). One
 * material per atlas — used by the SpriteInstances batched draw path
 * (sortScope='layer'). The per-instance UV region rectangle lives in the
 * `SpriteInstances.regions` buffer instead of in the material UBO.
 *
 * `values.region` is a `[0, 0, 1, 1]` placeholder. The sprite shader's
 * `PER_INSTANCE_REGION=true` variant reads region from
 * `instances[idx].region` and ignores the material slot; selecting that
 * variant is the record stage's responsibility (see
 * `render-system-record.ts` sprite pass pipeline selection).
 *
 * Returns the registered MaterialAsset slot id (unwrapped Handle u32) or
 * 0 if the atlas slot is empty (charter P3 fail-safe; mirrors
 * `resolveTilesetMaterial`).
 */
function resolveAtlasOnlyMaterial(
  world: World,
  tileset: TilesetAsset,
  atlasIndex: number,
  lookup: (guid: string) => TilesetAtlasLookup,
): Handle<'MaterialAsset', 'shared'> {
  const atlasGuid = tileset.atlases[atlasIndex];
  if (atlasGuid === undefined) return toShared<'MaterialAsset'>(0);
  const atlas = resolveTilesetRuntime(world, atlasGuid, lookup);
  if (!atlas.ok) return toShared<'MaterialAsset'>(0);
  const atlasHandle = atlas.value.handle;
  const atlasId = unwrapHandle(atlasHandle);
  const cacheKey = String(atlasId);
  const cache =
    atlasOnlyMaterialCache.get(world) ?? new Map<string, Handle<'MaterialAsset', 'shared'>>();
  atlasOnlyMaterialCache.set(world, cache);
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const matPayload: MaterialAsset = {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::sprite' },
        renderState: {
          ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
          tags: { LightMode: 'Forward' },
          queue: 3000,
        },
      },
    ],
    values: {
      colorTint: [1.0, 1.0, 1.0, 1.0],
      baseColorTexture: atlasHandle,
      region: [0.0, 0.0, 1.0, 1.0],
      pivotAndSize: [0.5, 0.5, 1.0, 1.0],
      flipY: 1.0,
    },
  };
  const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    matPayload,
  );
  cache.set(cacheKey, matHandle);
  return matHandle;
}

/**
 * Compute the half-texel-inset normalised UV rectangle for a TilesetRegion
 * (atlas-space pixels → atlas-normalised [u, v, w, h]). Mirrors the inset
 * computation inside `resolveTilesetMaterial` so the per-instance region
 * data fed into `SpriteInstances.regions` produces pixel-identical sampling
 * to the per-region material path (charter P4 consistent abstraction).
 */
function computeRegionUv(
  tileset: TilesetAsset,
  region: TilesetRegion,
  atlasIndex: number,
): [u: number, v: number, w: number, h: number] {
  const atlasSize = tileset.atlasSizes?.[atlasIndex];
  const atlasWidth = Math.max(
    1,
    atlasSize !== undefined ? atlasSize.pixelWidth : tileset.columns * tileset.tileWidth,
  );
  const atlasHeight = Math.max(
    1,
    atlasSize !== undefined ? atlasSize.pixelHeight : tileset.rows * tileset.tileHeight,
  );
  const halfTexelU = 0.5 / atlasWidth;
  const halfTexelV = 0.5 / atlasHeight;
  return [
    region.x / atlasWidth + halfTexelU,
    region.y / atlasHeight + halfTexelV,
    region.width / atlasWidth - 2 * halfTexelU,
    region.height / atlasHeight - 2 * halfTexelV,
  ];
}

interface DerivedSpawnSpec {
  readonly cellX: number;
  readonly cellY: number;
  readonly tileId: number;
  readonly packedTile: number;
  readonly materialHandle: Handle<'MaterialAsset', 'shared'>;
  readonly chunkIndex: number;
  // M2: multi-cell footprint + custom pivot land per-tile via TilesetTileEntry.
  readonly widthCells: number;
  readonly heightCells: number;
  readonly pivotX: number;
  readonly pivotY: number;
  // Atlas + region indices retained so the SpriteInstances (sortScope=
  // 'layer') path can group cells by atlas and look up per-instance UV
  // without re-walking the 3-hop chain `tileId → regions → atlasIndex`.
  readonly atlasIndex: number;
  readonly regionIndex: number;
}

const SQRT1_2 = Math.SQRT1_2;

/**
 * Compute the post-flip "effective pivot Y" for a tilemap tile entry.
 *
 * Mirrors the D-2 first-line composition used by `spawnDerivedRenderEntities`:
 *
 *   basePivotForY = flipDiagonal ? pivotX : pivotY
 *   effectivePivotY = flipV ? (1 - basePivotForY) : basePivotForY
 *
 * Exported so the render-system-extract sprite-bucket sort key path can
 * reproduce the *same* per-entity pivot value that landed on
 * `Transform.posY` -- otherwise the foot-Y formula
 * `posY - effectivePivotY * |scaleY|` would drift on flipped tiles
 * (charter P4 single-source pivot SSOT; plan-strategy §D-1 + §D-2 +
 * requirements §AC-12 / §AC-13).
 */
export function effectivePivotYForTilemapFlip(
  pivotY: number,
  pivotX: number,
  flipV: boolean,
  flipDiagonal: boolean,
): number {
  const base = flipDiagonal ? pivotX : pivotY;
  return flipV ? 1 - base : base;
}

/**
 * Compute the per-cell derived spawn spec for one non-zero cell. Carries
 * widthCells / heightCells / pivotX / pivotY from the TilesetTileEntry so
 * `spawnDerivedRenderEntities` can apply the D-2 geometric correction
 * without re-reading the asset registry.
 */
function specFor(
  layerCols: number,
  chunkSize: number,
  cellIndex: number,
  packedTile: number,
  materialHandle: Handle<'MaterialAsset', 'shared'>,
  entry: TilesetTileEntry,
  atlasIndex: number,
): DerivedSpawnSpec {
  const cellX = cellIndex % layerCols;
  const cellY = Math.floor(cellIndex / layerCols);
  const chunkX = Math.floor(cellX / chunkSize);
  const chunkY = Math.floor(cellY / chunkSize);
  const chunksPerRow = Math.max(1, Math.ceil(layerCols / chunkSize));
  const chunkIndex = chunkY * chunksPerRow + chunkX;
  const { tileId } = decodeTileBits(packedTile);
  return {
    cellX,
    cellY,
    tileId,
    packedTile,
    materialHandle,
    chunkIndex,
    widthCells: entry.widthCells ?? 1,
    heightCells: entry.heightCells ?? 1,
    pivotX: entry.pivotX ?? 0.5,
    pivotY: entry.pivotY ?? 0.5,
    atlasIndex,
    regionIndex: entry.regionIndex,
  };
}

/**
 * Compute the post-flip TRS components for one tile cell. The plan-strategy
 * §D-2 multi-cell + flip x pivot composite formula (first-line form):
 *
 *   basePivotForX = D ? pivotY : pivotX
 *   basePivotForY = D ? pivotX : pivotY
 *   effectivePivotX = H ? (1 - basePivotForX) : basePivotForX
 *   effectivePivotY = V ? (1 - basePivotForY) : basePivotForY
 *   posX = (cellX + effectivePivotX + (0.5 - effectivePivotX) * widthCells)
 *          * tileSizeX
 *   posY = (cellY + effectivePivotY + (0.5 - effectivePivotY) * heightCells)
 *          * tileSizeY
 *   scaleX = (H ? -1 : 1) * widthCells  * tileSizeX
 *   scaleY = (V ? -1 : 1) * heightCells * tileSizeY
 *   quatZ  = D ? Math.SQRT1_2 : 0
 *   quatW  = D ? Math.SQRT1_2 : 1
 *
 * Single SSOT consumed by both the per-cell entity spawn path and the
 * SpriteInstances batched path so the two routes produce pixel-identical
 * world transforms (charter P4 consistent abstraction).
 */
function computeTileTrs(
  tilemap: { tileSize: ArrayLike<number> },
  spec: DerivedSpawnSpec,
  packedTile: number,
): {
  posX: number;
  posY: number;
  scaleX: number;
  scaleY: number;
  quatZ: number;
  quatW: number;
} {
  const { flipH, flipV, flipDiagonal } = decodeTileBits(packedTile);
  const basePivotForX = flipDiagonal ? spec.pivotY : spec.pivotX;
  const effectivePivotX = flipH ? 1 - basePivotForX : basePivotForX;
  const effectivePivotY = effectivePivotYForTilemapFlip(
    spec.pivotY,
    spec.pivotX,
    flipV,
    flipDiagonal,
  );
  const tileSizeX = tilemap.tileSize[0] ?? 1;
  const tileSizeY = tilemap.tileSize[1] ?? 1;
  return {
    posX: (spec.cellX + effectivePivotX + (0.5 - effectivePivotX) * spec.widthCells) * tileSizeX,
    posY: (spec.cellY + effectivePivotY + (0.5 - effectivePivotY) * spec.heightCells) * tileSizeY,
    scaleX: (flipH ? -1 : 1) * spec.widthCells * tileSizeX,
    scaleY: (flipV ? -1 : 1) * spec.heightCells * tileSizeY,
    quatZ: flipDiagonal ? SQRT1_2 : 0,
    quatW: flipDiagonal ? SQRT1_2 : 1,
  };
}

/**
 * Spawn a single derived per-cell render entity. Used by the per-cell
 * sortScope path (`sortScope='per-cell'`, object layers) where each cell
 * needs an independent Y-sort position to interleave with sprite entities
 * (e.g. player) at arbitrary Y positions.
 *
 * `layerEntity` becomes the derived entity's `ChildOf.parent`, so
 * `world.despawn(layerEntity)` cascade-despawns every derived cell entity
 * via the engine's `linkedSpawn: true` default (feat-20260616). Combined
 * with the Tilemap -> TileLayer ChildOf edge, a single
 * `world.despawn(tilemapEntity)` unwinds the entire subtree without a
 * bespoke tilemap-scoped cleanup pass (requirements AC-02 / AC-03).
 */
function spawnDerivedRenderEntities(
  world: World,
  tilemap: { tileSize: ArrayLike<number> },
  layerEntity: EntityHandle,
  layerOrder: number,
  spec: DerivedSpawnSpec,
  packedTile: number,
  sortScope: SortScope = 'layer',
): EntityHandle {
  const { posX, posY, scaleX, scaleY, quatZ, quatW } = computeTileTrs(tilemap, spec, packedTile);
  const layerValue = encodeTilemapLayerValue(layerOrder, spec.chunkIndex, sortScope);
  return world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [posX, posY, 0],
          quat: [0, 0, quatZ, quatW],
          scale: [scaleX, scaleY, 1],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      {
        component: MeshRenderer,
        data: {
          materials: [spec.materialHandle],
        },
      },
      { component: Layer, data: { value: layerValue } },
      { component: ChildOf, data: { parent: layerEntity } },
    )
    .unwrap();
}

/**
 * Spawn one batched SpriteInstances entity per (TileLayer, chunk, atlas)
 * group. Used by the `sortScope='layer'` path (terrain layers): every
 * cell in the group becomes one instance in the same drawIndexed call.
 *
 * The chunk grid is the unit declared by `Tilemap.chunkSize` (default
 * 16x16). One SpriteInstances entity per (chunk, atlas) pair keeps each
 * GPU instance buffer small (256 cells x 80B = 20KB worst case) and lets
 * downstream frustum culling / incremental rebuild operate at chunk
 * granularity (industry standard: Godot quadrant_size, Bevy ChunkSize,
 * Tiled TMX chunks).
 *
 * Layout:
 *   - Transform: identity (the per-instance mat4 carries world-space TRS).
 *   - MeshFilter: HANDLE_QUAD.
 *   - MeshRenderer: atlas-only sprite material (region placeholder; shader
 *     reads per-instance UV from SpriteInstances.regions under the
 *     PER_INSTANCE_REGION=true variant — selected at record stage).
 *   - SpriteInstances: { transforms: Float32Array(N*16),
 *                        regions:    Float32Array(N*4) }.
 *   - Layer: encodeTilemapLayerValue(layerOrder, chunkIndex, 'layer').
 *     chunkIndex distinguishes adjacent chunks of the same layer in the
 *     transparent-sort key so the back-to-front ordering between chunks
 *     remains stable (chunks within a layer don't visually overlap in
 *     normal tilemap scenes; the chunkIndex tiebreaker is byte-exact
 *     with the per-cell path's encoding).
 *
 * Returns the spawned EntityHandle. Empty groups (zero cells) short-circuit
 * and return `undefined`.
 */
function spawnSpriteInstancesGroup(
  world: World,
  tilemap: { cols: number; tileSize: ArrayLike<number>; chunkSize: number },
  tileset: TilesetAsset,
  layerEntity: EntityHandle,
  layerOrder: number,
  chunkIndex: number,
  atlasIndex: number,
  materialHandle: Handle<'MaterialAsset', 'shared'>,
  cellSpecs: readonly DerivedSpawnSpec[],
): EntityHandle | undefined {
  if (cellSpecs.length === 0) return undefined;
  const N = cellSpecs.length;
  const transforms = new Float32Array(N * 16);
  const regions = new Float32Array(N * 4);
  const tmpMat = mat4.create();
  const tmpT: [number, number, number] = [0, 0, 0];
  const tmpR: [number, number, number, number] = [0, 0, 0, 1];
  const tmpS: [number, number, number] = [1, 1, 1];

  // Per-chunk frustum cull: entity Transform = chunk world center + chunk
  // extents (scaleX/Y). The frustum culler reads the entity AABB (HANDLE_QUAD
  // local [-0.5, 0.5]² expanded by entity scale/pos) → world AABB exactly
  // covers the chunk footprint.
  //
  // Per-instance transforms become chunk-local: inv_chunk * world_tile.
  // inv_chunk is a pure TRS-inverse (no rotation), so for each column c of
  // the world mat W:
  //   local[c*4+0] = (W[c*4+0] - chunkCenterX * W[c*4+3]) * invSX
  //   local[c*4+1] = (W[c*4+1] - chunkCenterY * W[c*4+3]) * invSY
  //   local[c*4+2] = W[c*4+2]
  //   local[c*4+3] = W[c*4+3]
  // The sprite shader then produces:
  //   world = chunk_TRS * local_tile * pos_local
  //         = chunk_TRS * (inv_chunk * world_tile) * pos_local
  //         = world_tile * pos_local  ✓ (pixel-identical to identity path)
  //
  // Tiles whose widthCells/heightCells straddle a chunk boundary will have
  // instance transforms that exceed the chunk AABB; the entity is still drawn
  // (conservative cull only skips when the chunk AABB is fully outside).
  const chunksPerRow = Math.max(1, Math.ceil(tilemap.cols / tilemap.chunkSize));
  const chunkX = chunkIndex % chunksPerRow;
  const chunkY = Math.floor(chunkIndex / chunksPerRow);
  const chunkScaleX = tilemap.chunkSize * (tilemap.tileSize[0] ?? 1);
  const chunkScaleY = tilemap.chunkSize * (tilemap.tileSize[1] ?? 1);
  const chunkCenterX = (chunkX + 0.5) * chunkScaleX;
  const chunkCenterY = (chunkY + 0.5) * chunkScaleY;
  const invSX = chunkScaleX > 0 ? 1 / chunkScaleX : 1;
  const invSY = chunkScaleY > 0 ? 1 / chunkScaleY : 1;

  for (let i = 0; i < N; i++) {
    const spec = cellSpecs[i] as DerivedSpawnSpec;
    const { posX, posY, scaleX, scaleY, quatZ, quatW } = computeTileTrs(
      tilemap,
      spec,
      spec.packedTile,
    );
    tmpT[0] = posX;
    tmpT[1] = posY;
    tmpT[2] = 0;
    tmpR[0] = 0;
    tmpR[1] = 0;
    tmpR[2] = quatZ;
    tmpR[3] = quatW;
    tmpS[0] = scaleX;
    tmpS[1] = scaleY;
    tmpS[2] = 1;
    mat4.compose(tmpMat, tmpT, tmpR, tmpS);

    // Write chunk-local transform: inv_chunk * world_tile (see formula above).
    const dst = i * 16;
    for (let c = 0; c < 4; c++) {
      const base = c * 4;
      const w3 = tmpMat[base + 3] ?? 0;
      transforms[dst + base + 0] = ((tmpMat[base + 0] ?? 0) - chunkCenterX * w3) * invSX;
      transforms[dst + base + 1] = ((tmpMat[base + 1] ?? 0) - chunkCenterY * w3) * invSY;
      transforms[dst + base + 2] = tmpMat[base + 2] ?? 0;
      transforms[dst + base + 3] = w3;
    }

    const region = tileset.regions[spec.regionIndex];
    if (region !== undefined) {
      const [u, v, w, h] = computeRegionUv(tileset, region, atlasIndex);
      regions[i * 4 + 0] = u;
      regions[i * 4 + 1] = v;
      regions[i * 4 + 2] = w;
      regions[i * 4 + 3] = h;
    }
  }

  const layerValue = encodeTilemapLayerValue(layerOrder, chunkIndex, 'layer');
  // plan-strategy D-2: the SpriteInstances entity's Transform.posY is set
  // to `chunkCenterY` (becomes `world[13]` in the entity's local-to-world
  // matrix). This is the LAYER_Y fold sort key — terrain rows share a
  // chunk Y, so per-chunk Y resolution is exactly the granularity the
  // fold pass needs. Per-tile world[13] (instance-level) is intentionally
  // _not_ used; instances live in the chunk-local space anchored at
  // chunkCenterY (see line 601-647 above). This is intentional, not a bug.
  return world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [chunkCenterX, chunkCenterY, 0],
          quat: [0, 0, 0, 1],
          scale: [chunkScaleX, chunkScaleY, 1],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      {
        component: MeshRenderer,
        data: {
          materials: [materialHandle],
        },
      },
      { component: SpriteInstances, data: { transforms, regions } },
      { component: Layer, data: { value: layerValue } },
      { component: ChildOf, data: { parent: layerEntity } },
    )
    .unwrap();
}

/**
 * Bucket a single layer's tiles into per-non-zero-cell spawn specs.
 * Returns the parent Tilemap metadata + the resolved spawn specs.
 */
function bucketTileLayer(
  world: World,
  layerEntity: EntityHandle,
  parentEntity: EntityHandle,
  lookup: (guid: string) => TilesetAtlasLookup,
):
  | {
      readonly tilemap: {
        cols: number;
        rows: number;
        tileSize: ArrayLike<number>;
        chunkSize: number;
      };
      readonly layerOrder: number;
      readonly sortScope: SortScope;
      readonly tileset: TilesetAsset;
      readonly specs: readonly DerivedSpawnSpec[];
    }
  | undefined {
  const tilemapRes = world.get(parentEntity, Tilemap);
  if (!tilemapRes.ok) return undefined;
  const tilemap = tilemapRes.value;
  const tilesetPayload = lookup(tilemap.tileset);
  if (tilesetPayload === undefined || 'code' in tilesetPayload) return undefined;
  if (tilesetPayload.kind !== 'tileset') return undefined;
  const tileset = tilesetPayload;

  const layerRes = world.get(layerEntity, TileLayer);
  if (!layerRes.ok) return undefined;
  const layer = layerRes.value;
  const tiles = layer.tiles as Uint32Array;
  const sortScope = decodeSortScope(layer.sortScope);

  // sortScope='layer' (terrain) uses the SpriteInstances batched path which
  // groups cells by atlas under an atlas-only material; sortScope='per-cell'
  // (object) keeps the per-cell entity path with per-region materials so
  // each cell can interleave with sprites by foot-Y. The material resolver
  // selection here keeps the spec's `materialHandle` in the correct
  // granularity for whichever spawn path consumes it downstream.
  const useSpriteInstances = sortScope === 'layer';

  const specs: DerivedSpawnSpec[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const packed = tiles[i] ?? 0;
    if (packed === 0) continue;
    const { tileId } = decodeTileBits(packed);
    if (tileId === 0) continue;
    const entry = tileset.tiles[tileId - 1];
    if (entry === undefined) continue;
    const region = tileset.regions[entry.regionIndex];
    if (region === undefined) continue;
    const atlasIndex = region.atlasIndex ?? 0;
    const materialHandle = useSpriteInstances
      ? resolveAtlasOnlyMaterial(world, tileset, atlasIndex, lookup)
      : resolveTilesetMaterial(world, tileset, entry.regionIndex, lookup);
    const spec = specFor(
      tilemap.cols,
      tilemap.chunkSize,
      i,
      packed,
      materialHandle,
      entry,
      atlasIndex,
    );
    specs.push(spec);
  }
  return {
    tilemap,
    layerOrder: layer.layerOrder,
    sortScope,
    tileset,
    specs,
  };
}

/**
 * Compute the camera frustum planes for the first Camera + Transform entity
 * found in the world. Returns null when no camera exists or the projection
 * parameters are degenerate (callers treat null as always-visible).
 *
 * Mirrors the frustum-plane computation in render-system-extract so both
 * cull paths use byte-identical planes (charter P4 consistent abstraction).
 */
function buildCameraFrustumPlanes(world: World): frustum.Frustum | null {
  const query = world.query({ with: [Camera, Transform, GlobalTransform] }).unwrap();
  let result: frustum.Frustum | null = null;
  for (const row of query) {
    const camEntity = row.entity;

    const camRes = world.get(camEntity, Camera);
    const trRes = world.get(camEntity, GlobalTransform);
    if (!camRes.ok || !trRes.ok) continue;

    const cam = camRes.value;
    const tr = trRes.value;

    const { near, far } = cam;
    if (near >= far) continue;

    const proj = mat4.create();
    if (cam.projection === CAMERA_PROJECTION_ORTHOGRAPHIC) {
      mat4.orthographicReverseZ(
        proj as Parameters<typeof mat4.orthographicReverseZ>[0],
        cam.left,
        cam.right,
        cam.top,
        cam.bottom,
        near,
        far,
      );
    } else {
      mat4.perspectiveReverseZ(
        proj as Parameters<typeof mat4.perspectiveReverseZ>[0],
        cam.fov,
        cam.aspect,
        near,
        far,
      );
    }
    const view = mat4.create();
    mat4.invert(
      view as Parameters<typeof mat4.invert>[0],
      tr.world as Parameters<typeof mat4.invert>[1],
    );
    const vp = mat4.create();
    mat4.multiply(
      vp as Parameters<typeof mat4.multiply>[0],
      proj as Parameters<typeof mat4.multiply>[1],
      view as Parameters<typeof mat4.multiply>[2],
    );
    const f = frustum.create();
    frustum.fromViewProjection(f, vp as Parameters<typeof frustum.fromViewProjection>[1]);
    result = f;
    break;
  }
  return result;
}

/**
 * bug-20260703-tilemap-chunk-stale-frustum-and-cull-overhang (D2): compute
 * the world-space AABB that tightly encloses every tile inside a chunk
 * after post-TRS placement (`computeTileTrs` applied per spec, SSOT shared
 * with the per-cell spawn path and SpriteInstances batched path). This is
 * the SSOT the streaming visibility test uses to decide whether a chunk's
 * tiles could still be visible; using it instead of the tile-aligned grid
 * box makes multi-cell / non-central-pivot overhang round-trip correctly,
 * so an overhanging tile no longer disappears when its anchor chunk goes
 * off-screen (plan-strategy §2 D-2).
 *
 * Empty spec list -> inverted `Number.MAX_VALUE` sentinel (plan-strategy
 * §2 D-4). `bucketTileLayer` filters empty cells before the byChunk map
 * is built, so this branch should never trigger in production; the
 * sentinel is an explicit "no visible pixels" value that
 * `frustum.intersectsBox` rejects immediately, avoiding a silent NaN
 * propagation path (charter P3 explicit failure).
 *
 * Note: `frustum.intersectsBox` picks a p-vertex per plane and computes
 * `dot(normal, p) + d`. When normal has a zero component, multiplying by
 * `Infinity` yields `NaN` (`NaN < 0 === false` -> false positive
 * intersection). The sentinel uses finite `Number.MAX_VALUE` on the axes
 * we want inverted so `0 * MAX_VALUE === 0` and the non-zero-normal axis
 * dominates, driving `dot` to `-Infinity` and correctly rejecting.
 *
 * Z is expanded to +/- 1 so flat sprite geometry (`pos_local.z === 0`) is
 * never degenerate against the frustum's near/far planes.
 *
 * @internal exported for M2 overhang / empty-chunk sentinel unit tests
 * (plan-strategy §5.3); not part of the AI user surface.
 */
export function computeChunkStreamBounds(
  tilemap: { tileSize: ArrayLike<number> },
  specs: readonly DerivedSpawnSpec[],
): box3.Box3Like {
  let minX = Number.MAX_VALUE;
  let minY = Number.MAX_VALUE;
  let maxX = -Number.MAX_VALUE;
  let maxY = -Number.MAX_VALUE;
  for (const spec of specs) {
    const { posX, posY, scaleX, scaleY } = computeTileTrs(tilemap, spec, spec.packedTile);
    const halfW = Math.abs(scaleX) * 0.5;
    const halfH = Math.abs(scaleY) * 0.5;
    const x0 = posX - halfW;
    const x1 = posX + halfW;
    const y0 = posY - halfH;
    const y1 = posY + halfH;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
  }
  return [minX, minY, -1, maxX, maxY, 1];
}

/**
 * Despawn every derived render entity currently attached to `layerEntity`.
 *
 * After tweak-20260714 M3 the terrain path locates its previously-spawned
 * children via `Children.entities` on the TileLayer (mirror of ChildOf,
 * engine-maintained via the relationship hook) rather than a module-level
 * tracker Map — SSOT collapse per architecture-principles §2 (Derive,
 * Don't Duplicate). The snapshot returned by
 * `world.get(layerEntity, Children).entities` is a fresh read-only
 * Uint32Array that is stable across the iteration even though each
 * despawn prunes the mirror in place.
 *
 * Empty children (never-built layer, or already-purged) trivially
 * short-circuits — this is the "empty array no-op" equivalence to the
 * old first-frame-heuristic guard (plan-strategy §2 D-3 edge case 3).
 */
function purgeDerivedEntities(world: World, layerEntity: EntityHandle): void {
  const r = world.get(layerEntity, Children);
  if (!r.ok) return;
  const snap = r.value.entities;
  for (let i = 0; i < snap.length; i++) {
    const e = snap[i];
    if (e !== undefined) world.despawn(e as EntityHandle);
  }
}

/**
 * Snapshot of a single TileLayer's per-frame work item — populated by the
 * main-loop query and consumed both by the per-cell diff-cleanup preamble
 * (`evictDeadPerCellStreamingCaches`) and the per-layer processing branches.
 */
interface LayerWork {
  readonly layerEntity: EntityHandle;
  readonly parentEntity: EntityHandle;
  readonly dirty: number;
  readonly sortScopeRaw: number;
}

/**
 * tweak-20260714 M4 diff-cleanup preamble (plan-strategy §2 D-4 +
 * requirements §5 AC-11 + §8 edge case #4).
 *
 * The per-cell streaming maps are owned by one weak World entry and outlive
 * individual TileLayer entities while that World is alive. When a TileLayer
 * is despawned (or cascade-collected via `world.despawn(tilemapEntity)`) the
 * ECS mirrors clean up entities and `Children.entities`, but these maps retain
 * the dead layer's entries until this diff. On slot reuse, the stale entries
 * would corrupt rebuild: `activeSet` still lists old
 * chunkIndexes, and the rebuild branch would attempt to despawn stale
 * entity IDs before repopulating.
 *
 * Fix: at the top of each frame, diff this World's cached layer keys against
 * the fresh query. The set
 * difference names layers that vanished since the previous call; evict
 * their entries from all three Maps. `activeSet` is the SSOT for "which
 * chunkIndexes have entries under this layer" (each insertion / removal
 * pairs a `chunkEntities` set/delete with an `activeSet` add/delete), so
 * cleanup iterates `activeSet` rather than scanning `chunkEntities.keys()` —
 * O(chunks-per-dead-layer) instead
 * of O(total-cache-keys).
 *
 * Cross-world isolation is structural: the WeakMap key is the World object.
 * No duplicated World id is retained in every layer/chunk key.
 *
 * Per-frame cost (OOS-3 invariant): the two `keys()` iterations scan
 * O(cache_size) ≤ O(all-ever-seen-layers-for-this-worldId). Typical
 * scenes have ≤ 10 layers so this is a handful of Map lookups; no
 * matrix arithmetic. Actual eviction work only runs on frames where a
 * layer vanished — steady-state frames pay only the diff scan.
 */
function evictDeadPerCellStreamingCaches(work: readonly LayerWork[], world: World): void {
  const cache = streamingCache(world);
  const aliveLayerKeys = new Set<string>();
  for (const w of work) {
    aliveLayerKeys.add(String(w.layerEntity));
  }
  const deadLayerKeys = new Set<string>();
  for (const layerKey of cache.activeChunks.keys()) {
    if (!aliveLayerKeys.has(layerKey)) deadLayerKeys.add(layerKey);
  }
  for (const layerKey of cache.layers.keys()) {
    if (!aliveLayerKeys.has(layerKey)) deadLayerKeys.add(layerKey);
  }
  for (const deadKey of deadLayerKeys) {
    const activeSet = cache.activeChunks.get(deadKey);
    if (activeSet !== undefined) {
      for (const chunkIdx of activeSet) {
        cache.chunkEntities.delete(`${deadKey}:${chunkIdx}`);
      }
      cache.activeChunks.delete(deadKey);
    }
    cache.layers.delete(deadKey);
  }
}

/**
 * Walk every TileLayer ChildOf-ing a Tilemap, extract its non-zero cells
 * into derived render entities. A Renderer attaches this system to FrameEnd;
 * World's final publication then resolves newly-created GlobalTransform.world values before the
 * read-only render walk begins.
 *
 * Two paths based on `TileLayer.sortScope`:
 *
 *   `'layer'` (terrain, default):
 *     Batched SpriteInstances path — spawned once, reused until dirty. Each
 *     (chunk, atlas) pair becomes one SpriteInstances entity whose Transform
 *     covers the chunk footprint, so the frustum culler rejects off-screen
 *     chunks at entity granularity.
 *
 *   `'per-cell'` (object layers):
 *     Chunk-streaming path — specs are bucketed by chunkIndex once (rebuilt
 *     on dirty) and the live entity set is updated every frame to match the
 *     camera frustum. Only chunks whose world AABB intersects the frustum
 *     have ECS entities alive, keeping `extractFrame` iteration proportional
 *     to visible tile count rather than total map tile count.
 */
export function tilemapChunkExtractSystem(
  world: World,
  lookup: (guid: string) => TilesetAtlasLookup = () => undefined,
): void {
  const streaming = streamingCache(world);
  const work: LayerWork[] = [];
  const tileLayerQuery = world.query({ read: [TileLayer, ChildOf] }).unwrap();
  for (const row of tileLayerQuery) {
    const layer = row.get(TileLayer);
    const parent = row.get(ChildOf).parent;
    if (parent === null) continue;
    work.push({
      layerEntity: row.entity,
      parentEntity: parent,
      dirty: layer.dirty,
      sortScopeRaw: layer.sortScope,
    });
  }

  evictDeadPerCellStreamingCaches(work, world);

  // Compute the camera frustum once per frame — only needed when at least
  // one streaming (per-cell) layer exists. Null = always-visible fallback.
  let frustumPlanes: frustum.Frustum | null | undefined;

  for (const w of work) {
    // The outer WeakMap owns World identity; this generation-bearing packed
    // entity handle prevents aliasing when an ECS slot is reused.
    const layerKey = String(w.layerEntity);
    // AC-04: decode via the canonical SortScope union; avoid relying on the
    // raw encoding (0='layer', 1='per-cell') leaking through this call site.
    // `decodeSortScope` is the SSOT used throughout `bucketTileLayer` (see
    // line 730); this main-loop branch is the last remaining numeric check.
    const isStreaming = decodeSortScope(w.sortScopeRaw) === 'per-cell';

    if (!isStreaming) {
      // ── Terrain batched path (sortScope='layer') ──────────────────────
      // Spawn once per dirty; entity AABB covers the chunk footprint for
      // entity-level frustum culling in render-system-extract.
      //
      // "already built" is derived from Children.entities (mirror of
      // ChildOf, engine-maintained). Empty children ⇒ never built (or
      // just purged) ⇒ don't skip. Populated children + dirty=0 ⇒
      // steady state ⇒ skip. Populated + dirty=1 ⇒ purge + rebuild.
      // architecture-principles §2 (Derive, Don't Duplicate): the
      // former module-level "ever-built" Set was a second copy of
      // information that Children.entities already carries.
      const childrenRes = world.get(w.layerEntity, Children);
      const childCount = childrenRes.ok ? childrenRes.value.entities.length : 0;
      if (childCount > 0 && w.dirty === 0) continue;

      purgeDerivedEntities(world, w.layerEntity);

      const bucket = bucketTileLayer(world, w.layerEntity, w.parentEntity, lookup);
      if (bucket === undefined) continue;

      const byChunkAtlas = new Map<number, DerivedSpawnSpec[]>();
      for (const spec of bucket.specs) {
        const key = ((spec.chunkIndex & 0xfffff) << 16) | (spec.atlasIndex & 0xffff);
        const list = byChunkAtlas.get(key);
        if (list === undefined) {
          byChunkAtlas.set(key, [spec]);
        } else {
          list.push(spec);
        }
      }
      for (const groupSpecs of byChunkAtlas.values()) {
        const first = groupSpecs[0];
        if (first === undefined) continue;
        spawnSpriteInstancesGroup(
          world,
          bucket.tilemap,
          bucket.tileset,
          w.layerEntity,
          bucket.layerOrder,
          first.chunkIndex,
          first.atlasIndex,
          first.materialHandle,
          groupSpecs,
        );
      }
      if (w.dirty !== 0) {
        world.set(w.layerEntity, TileLayer, { dirty: 0 }).unwrap();
      }
      continue;
    }

    // ── Object streaming path (sortScope='per-cell') ───────────────────
    // Step 1: rebuild specs cache when dirty or first time.
    if (w.dirty !== 0 || !streaming.layers.has(layerKey)) {
      // Despawn all currently-active chunks for this layer.
      const activeSet = streaming.activeChunks.get(layerKey);
      if (activeSet !== undefined) {
        for (const chunkIdx of activeSet) {
          const key = `${layerKey}:${chunkIdx}`;
          const entities = streaming.chunkEntities.get(key);
          if (entities !== undefined) {
            for (const e of entities) world.despawn(e as EntityHandle);
            streaming.chunkEntities.delete(key);
          }
        }
        activeSet.clear();
      }
      streaming.layers.delete(layerKey);

      const bucket = bucketTileLayer(world, w.layerEntity, w.parentEntity, lookup);
      if (bucket !== undefined) {
        const byChunkSpecs = new Map<number, DerivedSpawnSpec[]>();
        for (const spec of bucket.specs) {
          const list = byChunkSpecs.get(spec.chunkIndex);
          if (list === undefined) {
            byChunkSpecs.set(spec.chunkIndex, [spec]);
          } else {
            list.push(spec);
          }
        }
        // bug-20260703 D2: promote each chunk's bucket to a ChunkStreamEntry
        // carrying the world-space bounds that enclose every tile's actual
        // footprint (not the tile-aligned grid box). The visibility test
        // then rejects the chunk only when its TRUE pixels are all
        // off-screen, so multi-cell / off-pivot tiles no longer flicker at
        // chunk-boundary crossings (plan-strategy §2 D-2 / D-3).
        const byChunk = new Map<number, ChunkStreamEntry>();
        for (const [chunkIdx, specs] of byChunkSpecs) {
          byChunk.set(chunkIdx, {
            specs,
            bounds: computeChunkStreamBounds(bucket.tilemap, specs),
          });
        }
        streaming.layers.set(layerKey, {
          byChunk,
          tilemap: bucket.tilemap,
          layerOrder: bucket.layerOrder,
          sortScope: bucket.sortScope,
        });
      }
      if (w.dirty !== 0) {
        world.set(w.layerEntity, TileLayer, { dirty: 0 }).unwrap();
      }
    }

    const cache = streaming.layers.get(layerKey);
    if (cache === undefined) continue;

    // Step 2: lazy-compute camera frustum on first streaming layer.
    if (frustumPlanes === undefined) {
      frustumPlanes = buildCameraFrustumPlanes(world);
    }

    // Step 3: diff visible chunks against active set.
    const activeSet = streaming.activeChunks.get(layerKey) ?? new Set<number>();
    streaming.activeChunks.set(layerKey, activeSet);
    const { tilemap } = cache;

    for (const [chunkIdx, entry] of cache.byChunk) {
      const { specs, bounds } = entry;
      const visible = frustumPlanes === null || frustum.intersectsBox(frustumPlanes, bounds);
      const wasActive = activeSet.has(chunkIdx);

      if (visible && !wasActive) {
        // Spawn per-cell entities for this newly-visible chunk.
        const spawned: EntityHandle[] = [];
        for (const spec of specs) {
          const e = spawnDerivedRenderEntities(
            world,
            tilemap,
            w.layerEntity,
            cache.layerOrder,
            spec,
            spec.packedTile,
            cache.sortScope,
          );
          spawned.push(e);
        }
        streaming.chunkEntities.set(`${layerKey}:${chunkIdx}`, spawned);
        activeSet.add(chunkIdx);
      } else if (!visible && wasActive) {
        // Despawn per-cell entities for this newly-invisible chunk.
        const key = `${layerKey}:${chunkIdx}`;
        const entities = streaming.chunkEntities.get(key);
        if (entities !== undefined) {
          for (const e of entities) world.despawn(e);
          streaming.chunkEntities.delete(key);
        }
        activeSet.delete(chunkIdx);
      }
    }
  }
}
