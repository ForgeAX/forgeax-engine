import { definePack } from '@forgeax/engine-pack/source';
import type { SamplerAsset, TextureAsset } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { CONTENT_PACKAGE_IDS, CONTENT_SOURCE_KEYS } from '../src/ids.ts';

/** Texels per side; a power of two keeps every mip level an exact 2x2 box reduction. */
export const CHECKER_SIZE = 256;
/** Checker cells per side of one texture tile; each cell spans a power-of-two texel run. */
export const CHECKER_CELLS = 2;
/** Linear reflectances of the two cells, a neutral mid-gray pair. */
export const CHECKER_LINEAR = [0.18, 0.3] as const;

export function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/**
 * Linear-float mip chain: level 0 is the exact checker; each next level is the
 * 2x2 box average of the previous one in linear space, so distant and grazing
 * samples converge to the true mean gray instead of aliasing into moire.
 */
export function checkerLinearLevels(): readonly Float32Array[] {
  const cell = CHECKER_SIZE / CHECKER_CELLS;
  const base = new Float32Array(CHECKER_SIZE * CHECKER_SIZE);
  for (let y = 0; y < CHECKER_SIZE; y++)
    for (let x = 0; x < CHECKER_SIZE; x++)
      base[y * CHECKER_SIZE + x] =
        CHECKER_LINEAR[(Math.floor(x / cell) + Math.floor(y / cell)) % 2] ?? 0;
  const levels = [base];
  for (let size = CHECKER_SIZE / 2; size >= 1; size /= 2) {
    const previous = levels[levels.length - 1] as Float32Array;
    const next = new Float32Array(size * size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const source = 2 * y * (2 * size) + 2 * x;
        next[y * size + x] =
          ((previous[source] ?? 0) +
            (previous[source + 1] ?? 0) +
            (previous[source + 2 * size] ?? 0) +
            (previous[source + 2 * size + 1] ?? 0)) /
          4;
      }
    levels.push(next);
  }
  return levels;
}

/** Packed rgba8unorm-srgb bytes of every level, finest first. */
export function checkerTextureBytes(): Uint8Array {
  const levels = checkerLinearLevels();
  const bytes = new Uint8Array(levels.reduce((total, level) => total + level.length * 4, 0));
  let offset = 0;
  for (const level of levels)
    for (const value of level) {
      const encoded = Math.round(linearToSrgb(value) * 255);
      bytes.set([encoded, encoded, encoded, 255], offset);
      offset += 4;
    }
  return bytes;
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: CONTENT_PACKAGE_IDS.textures,
  name: 'Engine Content / Textures',
  build: () =>
    ok({
      [CONTENT_SOURCE_KEYS.checkerTexture]: {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: CHECKER_SIZE, height: CHECKER_SIZE } },
        format: 'rgba8unorm-srgb',
        colorSpace: 'srgb',
        data: checkerTextureBytes(),
        mips: { kind: 'packed', levelCount: Math.log2(CHECKER_SIZE) + 1 },
      } satisfies TextureAsset,
      [CONTENT_SOURCE_KEYS.checkerSampler]: {
        kind: 'sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
        maxAnisotropy: 16,
      } satisfies SamplerAsset,
    }),
});
