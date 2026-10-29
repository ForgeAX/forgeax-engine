import type { MeshAsset } from '@forgeax/engine-types';

/** Published base geometry for CPU processing, not a render Asset or Ready receipt. */
export type MeshGeometry = Pick<
  MeshAsset,
  'vertices' | 'attributes' | 'indices' | 'submeshes' | 'aabb'
>;
