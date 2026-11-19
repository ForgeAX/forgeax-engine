import { definePack } from '@forgeax/engine-pack/source';
import { ok, type TextureAsset } from '@forgeax/engine-types';
import { CONTENT_PACKAGE_IDS, CONTENT_SOURCE_KEYS } from '../../src/ids.ts';
import { linearToSrgb } from '../checker.pack.ts';
import { waterImpulseSourcePixels } from './texture-pixels.ts';

const SIZE = 256;

function sharpen4Kernel(): Float32Array {
  const blur = (source: Float32Array) =>
    Float32Array.from(
      source,
      (_, index) =>
        ((source[index - 1] ?? 0) + (source[index] as number) + (source[index + 1] ?? 0)) / 3,
    );
  const positive = new Float32Array(8);
  const negative = new Float32Array(8);
  positive[3] = positive[4] = 1.3;
  negative[3] = negative[4] = -0.8;
  const sharpened = blur(positive);
  const gaussian = blur(blur(blur(negative)));
  return Float32Array.from(sharpened, (value, index) => value + (gaussian[index] as number));
}

/** Gamma 2.2 source decode, value exponent 1.2 and an eight-tap sharpened mip pyramid. */
export function impulseNoiseLevels(source: Uint8Array): readonly Float32Array[] {
  const levels: Float32Array[] = [
    Float32Array.from(
      { length: SIZE * SIZE },
      (_, index) => Math.fround(((source[index * 4] as number) / 255) ** 2.2) ** Math.fround(1.2),
    ),
  ];
  const kernel = sharpen4Kernel();
  let average = levels[0] as Float32Array;
  for (let width = SIZE; width > 1; width /= 2) {
    const nextWidth = width / 2;
    const output = new Float32Array(nextWidth * nextWidth);
    const nextAverage = new Float32Array(output.length);
    for (let y = 0; y < nextWidth; y++)
      for (let x = 0; x < nextWidth; x++) {
        let value = 0;
        for (let ky = 0; ky < 8; ky++)
          for (let kx = 0; kx < 8; kx++) {
            const sx = (x * 2 + kx - 3) & (width - 1);
            const sy = (y * 2 + ky - 3) & (width - 1);
            value +=
              (average[sy * width + sx] as number) *
              (kernel[kx] as number) *
              (kernel[ky] as number);
          }
        output[y * nextWidth + x] = value;
        const origin = y * 2 * width + x * 2;
        nextAverage[y * nextWidth + x] =
          ((average[origin] as number) +
            (average[origin + 1] as number) +
            (average[origin + width] as number) +
            (average[origin + width + 1] as number)) *
          0.25;
      }
    levels.push(output);
    // The average pyramid prevents sharpening from accumulating between levels.
    average = nextAverage;
  }
  return levels;
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: CONTENT_PACKAGE_IDS.waterImpulse,
  name: 'Engine Content / Default Fluid Impulse Noise',
  build() {
    const levels = impulseNoiseLevels(waterImpulseSourcePixels());
    const data = new Uint8Array(levels.reduce((count, level) => count + level.length * 4, 0));
    let offset = 0;
    for (const level of levels)
      for (const linear of level) {
        const encoded = Math.round(linearToSrgb(Math.max(0, Math.min(linear, 1))) * 255);
        data.set([encoded, encoded, encoded, 255], offset);
        offset += 4;
      }
    return ok({
      [CONTENT_SOURCE_KEYS.waterTexture('impulse-noise')]: {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: SIZE, height: SIZE } },
        format: 'rgba8unorm-srgb',
        colorSpace: 'srgb',
        data,
        mips: { kind: 'packed', levelCount: levels.length },
      } satisfies TextureAsset,
    });
  },
});
