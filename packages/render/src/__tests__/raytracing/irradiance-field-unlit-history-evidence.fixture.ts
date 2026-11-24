import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodePng } from '../../../../image/src/png-encoder';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';
import { type HistorySnapshot, historyProbeIds } from './irradiance-field-unlit-history.fixture';

export function historyRadianceRgb(snapshot: HistorySnapshot): Float32Array {
  const values: number[] = [];
  for (const probe of historyProbeIds)
    for (let texel = 0; texel < 64; texel++) {
      const index = (probe * IRRADIANCE_FIELD_PROBE_STRIDE + 64 + texel) * 4;
      values.push(...snapshot.irradiance.subarray(index, index + 3));
    }
  return Float32Array.from(values);
}
export function momentConstantAssessment(snapshot: HistorySnapshot, mean: number, second: number) {
  let absolute = 0,
    normalized = 0;
  for (const probe of historyProbeIds)
    for (let texel = 0; texel < 64; texel++) {
      const index = (probe * 64 + texel) * 2;
      for (const [component, expected] of [mean, second].entries()) {
        const error = Math.abs((snapshot.moments[index + component] ?? Number.NaN) - expected);
        absolute = Math.max(absolute, error);
        normalized = Math.max(normalized, error / Math.max(1, Math.abs(expected)));
      }
    }
  return { absolute, normalized };
}
function texelRgb(
  snapshot: HistorySnapshot,
  probe: number,
  texel: number,
  plane: 'cache' | 'angular' | 'moments' | 'validity',
): number[] {
  if (plane === 'moments')
    return [
      (snapshot.moments[(probe * 64 + texel) * 2] ?? 0) / 12,
      (snapshot.moments[(probe * 64 + texel) * 2 + 1] ?? 0) / 144,
      0,
    ];
  const index =
    (probe * IRRADIANCE_FIELD_PROBE_STRIDE + texel + (plane === 'angular' ? 64 : 0)) * 4;
  if (plane === 'validity') return Array(3).fill(snapshot.irradiance[index + 3] ?? 0);
  return Array.from(snapshot.irradiance.subarray(index, index + 3), (value) => value / 2.5);
}
function cacheComparison(
  reference: HistorySnapshot,
  actual: HistorySnapshot,
  plane: 'cache' | 'angular' | 'moments' | 'validity',
): Uint8Array {
  const scale = 8,
    width = 24 * scale,
    height = 24 * scale;
  const rgba = new Uint8Array(width * height * 4);
  for (const [row, probe] of historyProbeIds.entries())
    for (let texel = 0; texel < 64; texel++) {
      const a = texelRgb(reference, probe, texel, plane),
        b = texelRgb(actual, probe, texel, plane);
      const columns = [a, b, a.map((value, channel) => Math.abs((b[channel] ?? 0) - value) * 5)];
      for (const [column, rgb] of columns.entries())
        for (let yy = 0; yy < scale; yy++)
          for (let xx = 0; xx < scale; xx++) {
            const offset =
              (((row * 8 + Math.floor(texel / 8)) * scale + yy) * width +
                (column * 8 + (texel % 8)) * scale +
                xx) *
              4;
            rgba.set(
              [...rgb.map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255)), 255],
              offset,
            );
          }
    }
  return encodePng(width, height, rgba);
}
/** Actual signed angular cache, before cosine convolution can hide alternating locations. */
export async function saveAngularHistorySnapshot(
  directory: string | undefined,
  name: string,
  snapshot: HistorySnapshot,
  reference: HistorySnapshot,
) {
  if (directory)
    await writeFile(
      join(directory, `${name}-angular-comparison.png`),
      cacheComparison(reference, snapshot, 'angular'),
    );
}
export async function saveHistorySnapshot(
  directory: string | undefined,
  name: string,
  snapshot: HistorySnapshot,
  reference = snapshot,
) {
  if (!directory) return;
  for (const key of ['irradiance', 'moments', 'meta'] as const)
    await writeFile(
      join(directory, `${name}-${key}.${key === 'meta' ? 'u32' : 'f32'}`),
      new Uint8Array(snapshot[key].buffer),
    );
  await writeFile(
    join(directory, `${name}-cache-comparison.png`),
    cacheComparison(reference, snapshot, 'cache'),
  );
  await writeFile(
    join(directory, `${name}-moments-comparison.png`),
    cacheComparison(reference, snapshot, 'moments'),
  );
  await writeFile(
    join(directory, `${name}-validity-comparison.png`),
    cacheComparison(reference, snapshot, 'validity'),
  );
}
