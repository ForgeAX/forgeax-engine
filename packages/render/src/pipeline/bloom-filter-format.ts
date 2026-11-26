import type { RhiCaps } from '@forgeax/engine-rhi';

export type BloomFilterFormat = 'rgba16float' | 'rg11b10ufloat';

/** Only the nonnegative RGB raster filters use the packed attachment. */
export function bloomFilterFormat(
  capabilities: Partial<Pick<RhiCaps, 'rg11b10ufloatRenderable'>> | undefined,
): BloomFilterFormat {
  return capabilities?.rg11b10ufloatRenderable === true ? 'rg11b10ufloat' : 'rgba16float';
}
