// @forgeax/engine-graphics-extras - tile-bits (Tiled .tmj wire-format helpers).
//
// Tiled .tmj packs each cell as a uint32 where the high 4 bits encode flip /
// rotation slots and the low 28 bits encode the 1-indexed tile id (id 0 means
// "empty cell"). The wire layout, from MSB to LSB:
//
//   bit 31  flipHorizontal
//   bit 30  flipVertical
//   bit 29  flipDiagonal       (== 90deg CW rotation in Tiled semantics)
//   bit 28  flipHex120         (Tiled hex 120deg flip; preserved for fidelity,
//                              unused by the orthogonal renderer in M0)
//   bits 0..27  tileId         (0..0x0FFFFFFF; 0 sentinel = empty)
//
// Anchors: requirements integration points (engine-runtime tile-bits SSOT);
// plan-strategy §M0 targetFiles (tile-bits.ts); feat-20260604 D-2 wire
// compatibility lock.
//
// charter mapping: F1 (single-import barrel — encode/decode pair lives at
// `@forgeax/engine-runtime/tile-bits`), P3 (overflow / negative / non-integer
// tile id surface as RangeError, never silently clamp), P4 (encode and decode
// share the same bit layout and are inverse functions over the supported
// 0..0x0FFFFFFF tile id range).

const TILE_ID_MAX = 0x0fffffff;
const FLIP_H_BIT = 1 << 31;
const FLIP_V_BIT = 1 << 30;
const FLIP_D_BIT = 1 << 29;
const FLIP_HEX120_BIT = 1 << 28;

/**
 * Pack a Tiled .tmj cell into its u32 wire form.
 *
 * @param tileId 1-indexed tile id in [0, 0x0FFFFFFF]; `0` is the empty-cell
 *   sentinel that `TileLayer.tiles` carries downstream. `1` is the first real
 *   tile entry index into `TilesetAsset.tiles[0]`.
 * @throws RangeError when `tileId` is non-integer, negative, or > 0x0FFFFFFF.
 */
export function encodeTileBits(
  tileId: number,
  flipH: boolean,
  flipV: boolean,
  flipDiagonal: boolean,
  flipHex120: boolean,
): number {
  if (!Number.isInteger(tileId) || tileId < 0 || tileId > TILE_ID_MAX) {
    throw new RangeError(
      `encodeTileBits: tileId must be an integer in [0, ${TILE_ID_MAX}]; got ${tileId}`,
    );
  }
  let packed = tileId >>> 0;
  if (flipH) packed |= FLIP_H_BIT;
  if (flipV) packed |= FLIP_V_BIT;
  if (flipDiagonal) packed |= FLIP_D_BIT;
  if (flipHex120) packed |= FLIP_HEX120_BIT;
  return packed >>> 0;
}

/**
 * Unpack a Tiled .tmj cell from its u32 wire form into the structured shape
 * consumed by `tilemap-chunk-extract-system.ts:spawnDerivedRenderEntities`.
 */
export function decodeTileBits(packed: number): {
  readonly tileId: number;
  readonly flipH: boolean;
  readonly flipV: boolean;
  readonly flipDiagonal: boolean;
  readonly flipHex120: boolean;
} {
  const u = packed >>> 0;
  return {
    tileId: u & TILE_ID_MAX,
    flipH: (u & FLIP_H_BIT) !== 0,
    flipV: (u & FLIP_V_BIT) !== 0,
    flipDiagonal: (u & FLIP_D_BIT) !== 0,
    flipHex120: (u & FLIP_HEX120_BIT) !== 0,
  };
}
