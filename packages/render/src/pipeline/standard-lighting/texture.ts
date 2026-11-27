import type { StandardClusterLayout } from './layout';

/** Physical width of the single-row rgba32uint Cluster transport. */
export const STANDARD_CLUSTER_TEXTURE_WIDTH = 1024;
/** Transmittance (16), multiple (1), distant (1), and 32 aerial slices. */
export const STANDARD_ATMOSPHERE_TEXTURE_ROWS = 50;

export interface StandardClusterTextureExtent {
  readonly screen?: { readonly width: number; readonly height: number };
  readonly atmosphere?: boolean;
}

/** The same u32 payload as storage, packed four words per integer texel. */
export function standardClusterTextureLayout(
  layout: StandardClusterLayout,
  directLightSlotBytes: number,
  extent?: StandardClusterTextureExtent,
) {
  const width = STANDARD_CLUSTER_TEXTURE_WIDTH;
  const rowWords = width * 4;
  const gridOffset = (layout.lightDataSlotCount * directLightSlotBytes) / 4;
  const indexOffset = gridOffset + layout.clusterGridU32Length;
  const hostHeight = Math.ceil((indexOffset + layout.lightIndexListCapacity) / rowWords);
  const atmosphere = extent?.atmosphere === true;
  return {
    width,
    height: hostHeight + (atmosphere ? STANDARD_ATMOSPHERE_TEXTURE_ROWS : 0),
    gridOffset,
    indexOffset,
    ...(atmosphere
      ? { atmosphere: { originY: hostHeight, writeHeight: STANDARD_ATMOSPHERE_TEXTURE_ROWS } }
      : {}),
  } as const;
}

export type StandardClusterTextureLayout = ReturnType<typeof standardClusterTextureLayout>;
