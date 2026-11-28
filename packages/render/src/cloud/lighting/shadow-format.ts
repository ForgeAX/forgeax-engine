import type { RhiCaps, TextureFormat } from '@forgeax/engine-rhi';

export type CloudShadowFormat = 'rg11b10ufloat' | 'rgba16float' | 'rgba32float';

export function selectCloudShadowFormat(
  caps: Pick<RhiCaps, 'rg11b10ufloatRenderable' | 'rgba16floatRenderable'>,
): CloudShadowFormat {
  if (caps.rg11b10ufloatRenderable) return 'rg11b10ufloat';
  if (caps.rgba16floatRenderable) return 'rgba16float';
  return 'rgba32float';
}

export function isCloudShadowFormat(
  format: TextureFormat | undefined,
): format is CloudShadowFormat {
  return format === 'rg11b10ufloat' || format === 'rgba16float' || format === 'rgba32float';
}
