import type { TextureAsset } from '@forgeax/engine-types';
import { COOKIE_MIP_LEVEL_COUNT, COOKIE_SLICE_SIZE } from '../prepare/extended-lighting/resources';

function axisWeights(index: number, length: number): readonly (readonly [number, number])[] {
  const scale = length / COOKIE_SLICE_SIZE;
  if (scale < 1) {
    const position = Math.min(1, Math.max(0, (index + 0.5) / COOKIE_SLICE_SIZE)) * (length - 1);
    const first = Math.floor(position);
    const second = Math.min(length - 1, first + 1);
    const amount = position - first;
    return [
      [first, 1 - amount],
      [second, amount],
    ];
  }
  const begin = index * scale;
  const end = begin + scale;
  const result: [number, number][] = [];
  for (let texel = Math.floor(begin); texel < Math.ceil(end); texel += 1) {
    const coverage = Math.min(end, texel + 1) - Math.max(begin, texel);
    result.push([texel, Math.max(coverage, 0) / scale]);
  }
  return result;
}

/** Independent area/bilinear reference; each stored intermediate rounds to f32. */
export function expectedLightTextureF32Levels(asset: TextureAsset): Float32Array[] {
  const { width, height } = asset.shape.extent;
  let current = new Float32Array(COOKIE_SLICE_SIZE * COOKIE_SLICE_SIZE * 4);
  for (let y = 0; y < COOKIE_SLICE_SIZE; y += 1) {
    const ys = axisWeights(y, height);
    for (let x = 0; x < COOKIE_SLICE_SIZE; x += 1) {
      const xs = axisWeights(x, width);
      const out = (y * COOKIE_SLICE_SIZE + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        let value = 0;
        for (const [sy, wy] of ys) {
          for (const [sx, wx] of xs) {
            value += ((asset.data[(sy * width + sx) * 4 + channel] ?? 0) / 255) * wx * wy;
          }
        }
        current[out + channel] = Math.fround(Math.min(1, Math.max(0, value)));
      }
    }
  }
  const levels: Float32Array[] = [];
  let size = COOKIE_SLICE_SIZE;
  for (let level = 0; level < COOKIE_MIP_LEVEL_COUNT; level += 1) {
    levels.push(current.slice());
    if (size === 1) break;
    const nextSize = size >> 1;
    const next = new Float32Array(nextSize * nextSize * 4);
    for (let y = 0; y < nextSize; y += 1) {
      for (let x = 0; x < nextSize; x += 1) {
        for (let channel = 0; channel < 4; channel += 1) {
          const value = (sx: number, sy: number) => current[(sy * size + sx) * 4 + channel] ?? 0;
          next[(y * nextSize + x) * 4 + channel] = Math.fround(
            (value(2 * x, 2 * y) +
              value(2 * x + 1, 2 * y) +
              value(2 * x, 2 * y + 1) +
              value(2 * x + 1, 2 * y + 1)) *
              0.25,
          );
        }
      }
    }
    current = next;
    size = nextSize;
  }
  return levels;
}

export function packLightTextureLevel(level: Float32Array): Uint8Array {
  return Uint8Array.from(level, (value) => Math.round(Math.min(1, Math.max(0, value)) * 255));
}
