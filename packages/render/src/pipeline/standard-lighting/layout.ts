export const DEFAULT_CLUSTER_GRID = { x: 16, y: 9, z: 24 } as const;
export const CLUSTER_GRID_STRIDE_U32 = 2 as const;
export const LIGHT_INDEX_LIST_CAPACITY = 1048576 as const;
export const MAX_LIGHTS = 256 as const;

export interface StandardClusterLayout {
  readonly grid: { readonly x: number; readonly y: number; readonly z: number };
  readonly clusterCount: number;
  readonly clusterGridStrideU32: typeof CLUSTER_GRID_STRIDE_U32;
  readonly clusterGridU32Length: number;
  readonly lightIndexListCapacity: typeof LIGHT_INDEX_LIST_CAPACITY;
  readonly lightDataSlotCount: typeof MAX_LIGHTS;
  readonly lightBoundsInt32Length: number;
}

export function createStandardClusterLayout(
  grid: { readonly x: number; readonly y: number; readonly z: number } = DEFAULT_CLUSTER_GRID,
): StandardClusterLayout {
  const clusterCount = grid.x * grid.y * grid.z;
  return Object.freeze({
    grid,
    clusterCount,
    clusterGridStrideU32: CLUSTER_GRID_STRIDE_U32,
    clusterGridU32Length: clusterCount * CLUSTER_GRID_STRIDE_U32,
    lightIndexListCapacity: LIGHT_INDEX_LIST_CAPACITY,
    lightDataSlotCount: MAX_LIGHTS,
    lightBoundsInt32Length: MAX_LIGHTS * 6,
  });
}
