import { deriveVertexLayoutProjection, visitStaticMeshWordSpans } from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';
import { copyAssetRows } from './asset-data';
import type { AssetRange } from './asset-records';

/** Wire vertex offsets always address canonical rows. The payload may store those rows by stream. */
export function visitStaticMeshRange(
  mesh: MeshAsset,
  range: Pick<AssetRange, 'byteOffset' | 'byteLength' | 'rowBytes' | 'byteStride'>,
  visit: (
    slot: number,
    physicalOffset: number,
    physicalStride: number,
    packedOffset: number,
    packedStride: number,
    width: number,
    count: number,
  ) => void,
): void {
  const layout = deriveVertexLayoutProjection(mesh.attributes);
  const stride = layout.arrayStride;
  const width = range.rowBytes ?? range.byteLength;
  const step = range.byteStride ?? width;
  const count = (range.byteLength - width) / step + 1;

  const valid = visitStaticMeshWordSpans(
    layout,
    mesh.vertices.byteLength / stride,
    (physicalWord, rowWord, widthWords, strideWords, slot) => {
      const physical = physicalWord * 4,
        start = rowWord * 4,
        end = start + widthWords * 4;
      const streamStride = strideWords * 4;
      // One command covers all vertices of a regular channel edit.
      const span = (
        offset: number,
        length: number,
        wire: number,
        wireStride: number,
        rows: number,
      ) => {
        const column = offset % stride;
        const first = Math.max(start, column);
        const last = Math.min(end, column + length);
        if (first < last)
          visit(
            slot,
            physical + Math.floor(offset / stride) * streamStride + first - start,
            streamStride,
            wire + first - column,
            wireStride,
            last - first,
            rows,
          );
      };
      const contiguous = (offset: number, length: number, wire: number) => {
        const head = Math.min(length, (stride - (offset % stride)) % stride);
        if (head) span(offset, head, wire, head, 1);
        const whole = Math.floor((length - head) / stride);
        if (whole) span(offset + head, stride, wire + head, stride, whole);
        const used = head + whole * stride;
        if (used < length) span(offset + used, length - used, wire + used, length - used, 1);
      };
      if (step === stride && (range.byteOffset % stride) + width <= stride)
        span(range.byteOffset, width, 0, width, count);
      else if (step === width) contiguous(range.byteOffset, range.byteLength, 0);
      else
        for (let index = 0; index < count; index++)
          contiguous(range.byteOffset + index * step, width, index * width);
      return true;
    },
  );
  if (!valid) throw new RangeError('Invalid static mesh range layout');
}

/** Gather to a compact packet or scatter its owned bytes into the actual stream intervals. */
export function copyStaticMeshRange(
  mesh: MeshAsset,
  range: Pick<AssetRange, 'byteOffset' | 'byteLength' | 'rowBytes' | 'byteStride'>,
  packed: Uint8Array,
  direction: 'gather' | 'scatter',
): void {
  const physical = new Uint8Array(
    mesh.vertices.buffer,
    mesh.vertices.byteOffset,
    mesh.vertices.byteLength,
  );
  visitStaticMeshRange(mesh, range, (_slot, at, stride, offset, step, width, rows) => {
    const stream = physical.subarray(at),
      wire = packed.subarray(offset);
    if (direction === 'gather') copyAssetRows(stream, stride, wire, step, width, rows);
    else copyAssetRows(wire, step, stream, stride, width, rows);
  });
}
