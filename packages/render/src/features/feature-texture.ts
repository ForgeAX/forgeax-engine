import type { SamplerDescriptor, TextureFormat } from '@forgeax/engine-rhi';

/** Portable generation-owned compute texture. The renderer allocates, derives
 * graph hazards, binds and retires it; producers never receive a device. */
export interface RenderFeatureTextureDescriptor {
  readonly width: number;
  readonly height: number;
  readonly layers?: number;
  readonly format: TextureFormat;
  readonly dimension?: '2d' | '2d-array';
  readonly usage: readonly ('sampled' | 'storage' | 'copy-src' | 'copy-dst')[];
  /** Ordinary scene materials sample this output after feature production. */
  readonly consumer?: 'material';
}
export type RenderFeatureSamplerDescriptor = Omit<SamplerDescriptor, 'label'>;
export function validFeatureTexture(value: RenderFeatureTextureDescriptor): boolean {
  return (
    Number.isSafeInteger(value.width) &&
    value.width > 0 &&
    Number.isSafeInteger(value.height) &&
    value.height > 0 &&
    Number.isSafeInteger(value.layers ?? 1) &&
    (value.layers ?? 1) > 0 &&
    value.usage.length > 0 &&
    value.usage.every((role) => ['sampled', 'storage', 'copy-src', 'copy-dst'].includes(role)) &&
    ((value.dimension ?? '2d') === '2d-array' || (value.layers ?? 1) === 1)
  );
}
