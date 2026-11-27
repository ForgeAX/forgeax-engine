import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodePng } from '../../../../image/src/png-encoder';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';
import {
  type WorldKeyCache,
  type WorldKeyRow,
  worldKeyRatios,
} from './probe-clipmap-world-key.fixture';

export function markerError(cache: WorldKeyCache, row: WorldKeyRow) {
  let maximum = 0;
  for (let texel = 0; texel < IRRADIANCE_FIELD_PROBE_STRIDE; texel++) {
    const actual = worldKeyRatios(cache, row.slot, texel);
    if (!actual.every(Number.isFinite)) return Infinity;
    maximum = Math.max(
      maximum,
      Math.abs(actual[0] - row.ratio[0]),
      Math.abs(actual[1] - row.ratio[1]),
    );
  }
  return maximum;
}
/** Actual marker chromaticity, independent integer-key expected, and5x absolute difference. */
function markerPlane(
  cache: WorldKeyCache,
  rows: readonly WorldKeyRow[],
  offset: number,
  axis: number,
) {
  const scale = 4,
    width = axis * 3 * scale,
    height = Math.max(1, rows.length) * axis * scale,
    rgba = new Uint8Array(width * height * 4);
  for (const [rowIndex, row] of rows.entries())
    for (let t = 0; t < axis * axis; t++) {
      const actual = worldKeyRatios(cache, row.slot, offset + t),
        expected = row.ratio;
      const a = actual.every(Number.isFinite) ? [actual[0] / 4, 0.25, actual[1] / 3] : [1, 0, 1],
        b = [expected[0] / 4, 0.25, expected[1] / 3],
        colors = [a, b, a.map((v, c) => Math.abs(v - (b[c] ?? Number.NaN)) * 5)];
      for (const [column, rgb] of colors.entries())
        for (let y = 0; y < scale; y++)
          for (let x = 0; x < scale; x++) {
            const pixel =
              (((rowIndex * axis + Math.floor(t / axis)) * scale + y) * width +
                (column * axis + (t % axis)) * scale +
                x) *
              4;
            rgba.set(
              [...rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)), 255],
              pixel,
            );
          }
    }
  return encodePng(width, height, rgba);
}
export async function saveWorldKeyCache(
  directory: string | undefined,
  name: string,
  cache: WorldKeyCache,
  rows: readonly WorldKeyRow[],
) {
  if (!directory) return;
  for (const key of ['irradiance', 'moments', 'meta'] as const)
    await writeFile(
      join(directory, `${name}-${key}.bin`),
      new Uint8Array(cache[key].buffer, cache[key].byteOffset, cache[key].byteLength),
    );
  for (const [label, offset, axis] of [
    ['D', 0, 8],
    ['L', 64, 8],
    ['mip', 128, 4],
  ] as const)
    await writeFile(
      join(directory, `${name}-${label}-marker-comparison.png`),
      markerPlane(cache, rows, offset, axis),
    );
}
