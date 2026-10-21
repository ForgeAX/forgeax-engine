import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import type { World } from '@forgeax/engine/ecs';

export type Rgba8 = readonly [number, number, number, number];
type TextureRef = import('@forgeax/engine/types').AssetHandle<'texture'>;
type SamplerRef = import('@forgeax/engine/types').AssetHandle<'sampler'>;

/** Fills a size x size RGBA8 image from a per-texel callback (u, v in [0, 1)). */
export function pixels(size: number, texel: (u: number, v: number) => Rgba8): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = texel(x / size, y / size);
      data.set(value, (y * size + x) * 4);
    }
  }
  return data;
}

export function texture(
  world: World,
  size: number,
  data: Uint8Array,
  colorSpace: 'srgb' | 'linear' = 'srgb',
): TextureRef {
  const sceneAssets = world.assets;
  if (!(sceneAssets instanceof AssetRegistry))
    throw new Error('Scene requires its runtime asset owner');

  return sceneAssets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: size, height: size } },
      format: colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
      colorSpace,
      mips: { kind: 'none' },
      data,
    })
    .unwrap();
}

export function sampler(
  world: World,
  filter: GPUFilterMode = 'nearest',
  address: GPUAddressMode = 'repeat',
): SamplerRef {
  const sceneAssets = world.assets;
  if (!(sceneAssets instanceof AssetRegistry))
    throw new Error('Scene requires its runtime asset owner');

  return sceneAssets
    .create({
      kind: 'sampler',
      magFilter: filter,
      minFilter: filter,
      addressModeU: address,
      addressModeV: address,
    })
    .unwrap();
}

/** Two-color checkerboard with `cells` squares per side. */
export function checker(world: World, a: Rgba8, b: Rgba8, cells = 4, size = 64): TextureRef {
  return texture(
    world,
    size,
    pixels(size, (u, v) => ((Math.floor(u * cells) + Math.floor(v * cells)) % 2 === 0 ? a : b)),
  );
}

/** Linear grey-scale map; `height(u, v)` returns [0, 1]. */
export function heightMap(
  world: World,
  height: (u: number, v: number) => number,
  size = 64,
): TextureRef {
  return texture(
    world,
    size,
    pixels(size, (u, v) => {
      const h = Math.round(Math.min(1, Math.max(0, height(u, v))) * 255);
      return [h, h, h, 255];
    }),
    'linear',
  );
}
