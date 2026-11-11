import type { StandardClusterLayout } from './layout';

/** Physical width of the single-row rgba32uint Cluster transport. */
export const STANDARD_CLUSTER_TEXTURE_WIDTH = 1024;
/** Transmittance (16), multiple (1), distant (1), and 32 aerial slices. */
export const STANDARD_ATMOSPHERE_TEXTURE_ROWS = 50;

export interface StandardClusterTextureExtent {
  readonly width: number;
  readonly height: number;
  readonly screen?: { readonly width: number; readonly height: number };
  readonly atmosphere?: boolean;
}

/** The same u32 payload as storage, packed four words per integer texel. */
export function standardClusterTextureLayout(
  layout: StandardClusterLayout,
  directLightSlotBytes: number,
  aoExtent?: StandardClusterTextureExtent,
) {
  const width = STANDARD_CLUSTER_TEXTURE_WIDTH;
  const rowWords = width * 4;
  const gridOffset = (layout.lightDataSlotCount * directLightSlotBytes) / 4;
  const indexOffset = gridOffset + layout.clusterGridU32Length;
  const clusterEndWord = indexOffset + layout.lightIndexListCapacity;
  const aoPackedWidth = aoExtent === undefined ? 0 : Math.ceil(Math.max(1, aoExtent.width) / 4);
  const aoHeight = aoExtent === undefined ? 0 : Math.max(1, aoExtent.height);
  const aoBaseWord = aoExtent === undefined ? 0 : Math.ceil(clusterEndWord / rowWords) * rowWords;
  const aoRowWords = aoPackedWidth * 4;
  const aoEndWord = aoBaseWord + aoRowWords * aoHeight;
  const screen = aoExtent?.screen;
  const screenBaseWord =
    screen === undefined ? 0 : Math.ceil(Math.max(clusterEndWord, aoEndWord) / rowWords) * rowWords;
  const screenWords = screen === undefined ? 0 : screen.width * screen.height * 8;
  const endWord = Math.max(clusterEndWord, aoEndWord, screenBaseWord + screenWords);
  const hostHeight = Math.ceil(endWord / rowWords);
  const atmosphere = aoExtent?.atmosphere === true;
  return {
    width,
    height: hostHeight + (atmosphere ? STANDARD_ATMOSPHERE_TEXTURE_ROWS : 0),
    gridOffset,
    indexOffset,
    ...(atmosphere
      ? { atmosphere: { originY: hostHeight, writeHeight: STANDARD_ATMOSPHERE_TEXTURE_ROWS } }
      : {}),
    ...(screen === undefined
      ? {}
      : {
          screen: {
            baseWord: screenBaseWord,
            width: screen.width,
            height: screen.height,
            originY: screenBaseWord / rowWords,
            textureWidth: width,
            writeHeight: Math.ceil(screenWords / rowWords),
          },
        }),
    ...(aoExtent === undefined
      ? {}
      : {
          ao: {
            baseWord: aoBaseWord,
            width: aoExtent.width,
            height: aoExtent.height,
            packedWidth: aoPackedWidth,
            rowWords: aoRowWords,
            originX: 0,
            originY: aoBaseWord / rowWords,
            textureWidth: width,
            writeHeight: Math.ceil((aoPackedWidth * aoHeight) / width),
          },
        }),
  } as const;
}

export type StandardClusterTextureLayout = ReturnType<typeof standardClusterTextureLayout>;
