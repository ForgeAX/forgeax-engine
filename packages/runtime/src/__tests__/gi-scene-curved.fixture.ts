import { createHash } from 'node:crypto';
import {
  buildMeshCardLayout,
  buildVisibilityDistanceField,
  createSphereGeometry,
  encodeMeshDistanceField,
  MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
} from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';

/** The actual authored triangles, Card layout and cooked Mesh SDF share one source. */
export async function sceneSphere(): Promise<MeshAsset> {
  const mesh = createSphereGeometry(1, 32, 24).unwrap();
  return cookSceneMesh(mesh, 0.15);
}

export async function cookSceneMesh(mesh: MeshAsset, voxelSize: number): Promise<MeshAsset> {
  const indices = mesh.indices;
  if (!indices) throw new Error('Indexed scene mesh required');
  const field = (
    await buildVisibilityDistanceField(mesh.attributes.position as Float32Array, indices, {
      voxelSize,
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
