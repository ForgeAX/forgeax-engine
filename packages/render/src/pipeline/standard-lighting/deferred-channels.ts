import { LIGHTING_CHANNELS_DEFAULT } from '../../components/lighting-channels';
import type { RenderableSnapshot } from '../../render-system-extract';
import { type FrameList, rasterRowsOf } from '../../scene/frame-list';
import { hasRasterDemand } from '../../scene/raster-demand';

// The low 15 bits are three source bit indices, in increasing order. The
// next two hold the count, where zero disables projection. The view word
// also carries the projected sun mask in bits 17..19.
export const DEFERRED_CHANNEL_MAPPING_MASK = 0x1ffff;

export function projectDeferredLightingMask(original: number, mapping: number): number {
  const count = (mapping >>> 15) & 3;
  let mask = 0;
  for (let i = 0; i < count; i += 1) {
    const bit = (mapping >>> (i * 5)) & 31;
    mask |= ((original >>> bit) & 1) << i;
  }
  return mask;
}

/** Prove one mapping for the complete captured raster domain and admitted light slots. */
export function prepareDeferredLightingChannels(
  renderables: FrameList<
    Pick<
      RenderableSnapshot,
      'lightingChannels' | 'authorVisible' | 'instances' | 'spriteInstances' | 'probeBlendRecord'
    >
  >,
  local: readonly { readonly source?: { readonly lightingChannels?: number } | undefined }[],
  directional: { readonly lightingChannels?: number } | undefined,
): number {
  const sunMask = directional?.lightingChannels ?? LIGHTING_CHANNELS_DEFAULT;
  let union = explicitBits(sunMask);
  for (const row of local) {
    if (row.source === undefined) return 0;
    union |= explicitBits(row.source.lightingChannels);
  }
  // Include retained rows that may survive GPU visibility and LOD selection.
  // A partial CPU draw list cannot certify the GPU receiver domain.
  for (const source of rasterRowsOf(renderables)) {
    if (!hasRasterDemand(source)) continue;
    // Local SH requires the full lighting-context row.
    if (source.probeBlendRecord !== undefined) return 0;
    union |= explicitBits(source.lightingChannels);
  }
  // All/default masks still need a common nonzero channel.
  let remaining = union || 1;
  let word = 0;
  let count = 0;
  while (remaining !== 0) {
    if (count === 3) return 0;
    const bit = 31 - Math.clz32(remaining & -remaining);
    word |= bit << (count * 5);
    count += 1;
    remaining &= remaining - 1;
  }
  const mapping = word | (count << 15);
  return mapping | (projectDeferredLightingMask(sunMask, mapping) << 17);
}

function explicitBits(mask: number | undefined): number {
  return mask === undefined || mask === LIGHTING_CHANNELS_DEFAULT ? 0 : mask;
}
