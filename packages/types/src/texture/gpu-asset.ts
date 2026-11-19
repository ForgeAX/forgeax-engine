import type { TextureAsset } from './asset.js';
import type { GeneratedTextureDescriptor, GeneratedTextureSource } from './generator.js';

/** GPU-only texture identity; pixels and mip levels belong to its consuming Renderer. */
export interface GpuTextureAsset extends GeneratedTextureDescriptor {
  readonly kind: 'gpu-texture';
  readonly source: GeneratedTextureSource;
}

/** Texture assets accepted by GPU sampling consumers. CPU image APIs retain TextureAsset. */
export type SampledTextureAsset = TextureAsset | GpuTextureAsset;

export function isGpuTextureAsset(asset: { readonly kind: string }): asset is GpuTextureAsset {
  return asset.kind === 'gpu-texture';
}
