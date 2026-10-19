import type { RhiCaps } from '@forgeax/engine-rhi';

/** Device-backed facts that the portable tape records; canvas facts have a separate owner. */
export function recordReplayCapabilities(caps?: RhiCaps) {
  return {
    rgba16floatRenderable: caps?.rgba16floatRenderable ?? false,
    rg11b10ufloatRenderable: caps?.rg11b10ufloatRenderable ?? false,
    float32Filterable: caps?.float32Filterable ?? false,
    firstInstanceIndirect: caps?.firstInstanceIndirect ?? false,
    textureCompressionBc: caps?.textureCompressionBc ?? false,
    textureCompressionEtc2: caps?.textureCompressionEtc2 ?? false,
    textureCompressionAstc: caps?.textureCompressionAstc ?? false,
    storageBuffer: caps?.storageBuffer ?? false,
    timestampQuery: caps?.timestampQuery ?? false,
  } as const;
}

export const RECORDED_CAPABILITY_KEYS: ReadonlySet<string> = new Set(
  Object.keys(recordReplayCapabilities()),
);
