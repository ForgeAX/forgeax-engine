import { createHash } from 'node:crypto';
import {
  buildMeshCardLayout,
  buildVisibilityDistanceField,
  createBoxGeometry,
  encodeMeshDistanceField,
  MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
} from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';
import type { StandardProbeGlobal } from '../../pipeline/standard-profile';

export const probeGlobalProfile: StandardProbeGlobal = {
  grid: {
    origin: [-4, -4, -6],
    dimensions: [17, 17, 17],
    spacing: 0.5,
    maxDistance: 4,
    coverageDistance: 0.5,
  },
  maxInstances: 16,
  maxFieldBytes: 1024 * 1024,
  rayResolution: 9,
  tMax: 1,
};

/** Real geometry producer and encoded field provenance, shared by owner/GPU tests. */
export async function createProbeGlobalMesh(
  width = 2,
  height = 2,
  depth = 0.1,
): Promise<MeshAsset> {
  const mesh = createBoxGeometry(width, height, depth).unwrap();
  const indices = mesh.indices;
  if (indices === undefined) throw new Error('indexed fixture geometry required');
  const field = (
    await buildVisibilityDistanceField(mesh.attributes.position as Float32Array, indices, {
      voxelSize: 0.25,
      triangleSidedness: new Uint8Array(indices.length / 3),
    })
  ).unwrap();
  const bytes = (await encodeMeshDistanceField(field)).unwrap();
  return {
    ...mesh,
    cardLayout: (
      await buildMeshCardLayout(mesh.attributes.position as Float32Array, indices)
    ).unwrap(),
    distanceField: {
      ...field,
      sectionSidedness: mesh.submeshes.map(() => 0),
      artifact: {
        integrity: {
          algorithm: 'sha256',
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        },
        assetCodec: { ...MESH_VISIBILITY_DISTANCE_FIELD_CODEC },
      },
    },
  };
}
