import { producerBoundsInt32Length } from '../../cluster-binner';

export const DEFAULT_CLUSTER_GRID = Object.freeze({ x: 16, y: 9, z: 24 } as const);
export const CLUSTER_GRID_STRIDE_U32 = 2 as const;
export const CLUSTER_GRID_COUNT_WORD_OFFSET_U32 = 1 as const;
export const LIGHT_INDEX_LIST_CAPACITY = 1048576 as const;

export interface StandardClusterLayout {
  readonly grid: { readonly x: number; readonly y: number; readonly z: number };
  readonly clusterCount: number;
  readonly clusterGridStrideU32: typeof CLUSTER_GRID_STRIDE_U32;
  readonly clusterGridCountWordOffsetU32: typeof CLUSTER_GRID_COUNT_WORD_OFFSET_U32;
  readonly clusterGridU32Length: number;
  readonly lightIndexListCapacity: typeof LIGHT_INDEX_LIST_CAPACITY;
  readonly lightDataSlotCount: number;
  readonly lightBoundsInt32Length: number;
}

export function createStandardClusterLayout(
  lightDataSlotCount: number,
  grid: { readonly x: number; readonly y: number; readonly z: number } = DEFAULT_CLUSTER_GRID,
): StandardClusterLayout {
  const clusterCount = grid.x * grid.y * grid.z;
  return Object.freeze({
    grid,
    clusterCount,
    clusterGridStrideU32: CLUSTER_GRID_STRIDE_U32,
    clusterGridCountWordOffsetU32: CLUSTER_GRID_COUNT_WORD_OFFSET_U32,
    clusterGridU32Length: clusterCount * CLUSTER_GRID_STRIDE_U32,
    lightIndexListCapacity: LIGHT_INDEX_LIST_CAPACITY,
    lightDataSlotCount,
    lightBoundsInt32Length: producerBoundsInt32Length(lightDataSlotCount),
  });
}
