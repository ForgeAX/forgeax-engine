import type { TerrainSource } from '@forgeax/engine-types';

/** Power-of-two tile width keeps every hardware mip aligned to the same section roster. */
export function terrainHeightAtlas(
  source: Pick<TerrainSource, 'columns' | 'rows' | 'subsectionVertices'>,
) {
  const vertices = source.subsectionVertices;
  const columns = (source.columns - 1) / (vertices - 1);
  const rows = (source.rows - 1) / (vertices - 1);
  const count = columns * rows;
  const tileColumns = 2 ** Math.ceil(Math.log2(Math.sqrt(count)));
  const tileRows = Math.ceil(count / tileColumns);
  // The admitted 4,194,304-sample budget and 2..128 vertices bound both axes
  // by 4096 even for a long, narrow author grid. No logical-axis texture limit.
  return {
    columns,
    rows,
    tileColumns,
    tileRows,
    width: tileColumns * vertices,
    height: tileRows * vertices,
  };
}

/** Ordinary packed texture mip offset; each level retains the same tile count. */
export function terrainHeightMipOffset(width: number, height: number, mip: number): number {
  let bytes = 0;
  for (let level = 0; level < mip; level++) {
    bytes += width * height * 4;
    width /= 2;
    height /= 2;
  }
  return bytes;
}

const scalar = new DataView(new ArrayBuffer(4));
/** RGBA carries little-endian f32 bytes, sampled only through textureLoad. */
export function encodeTerrainHeight(height: number): readonly number[] {
  scalar.setFloat32(0, height, true);
  return [scalar.getUint8(0), scalar.getUint8(1), scalar.getUint8(2), scalar.getUint8(3)];
}

export function decodeTerrainHeight(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getFloat32(0, true);
}
