import type { StandardClusterLayout } from './layout';

/** Physical width of the single-row rgba32uint Cluster transport. */
export const STANDARD_CLUSTER_TEXTURE_WIDTH = 1024;

export interface StandardClusterAoExtent {
  readonly width: number;
  readonly height: number;
}

/** The same u32 payload as storage, packed four words per integer texel. */
export function standardClusterTextureLayout(
  layout: StandardClusterLayout,
  directLightSlotBytes: number,
  aoExtent?: StandardClusterAoExtent,
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
  const endWord = Math.max(clusterEndWord, aoEndWord);
  return {
    width,
    height: Math.ceil(endWord / rowWords),
    gridOffset,
    indexOffset,
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
