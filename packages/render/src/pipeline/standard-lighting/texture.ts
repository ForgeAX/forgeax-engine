import { BYTES_PER_DIRECT_LIGHT_SLOT } from '../../light-buffer-layout';
import type { StandardClusterLayout } from './layout';

/** The same u32 payload as storage, packed four words per integer texel. */
export function standardClusterTextureLayout(layout: StandardClusterLayout) {
  const width = 1024;
  const gridOffset = (layout.lightDataSlotCount * BYTES_PER_DIRECT_LIGHT_SLOT) / 4;
  const indexOffset = gridOffset + layout.clusterGridU32Length;
  const height = Math.ceil((indexOffset + layout.lightIndexListCapacity) / (width * 4));
  return { width, height, gridOffset, indexOffset };
}
