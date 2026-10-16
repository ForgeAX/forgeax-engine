import {
  cookMeshDistanceFieldProduct,
  type MeshDistanceFieldProduct,
} from '@forgeax/engine-import';
import { AssetError, err, type MeshAsset, ok, type Result } from '@forgeax/engine-types';
import type { GltfMaterialIr, GltfMeshIr } from './parse-gltf';

/** Opt-in Meta setting; material sidedness is sampled only by this build-time owner. */
export async function cookGltfMeshDistanceField(
  mesh: MeshAsset,
  meshGuid: string,
  primitives: readonly GltfMeshIr[],
  materials: readonly GltfMaterialIr[],
  settings: unknown,
): Promise<Result<MeshDistanceFieldProduct | undefined, AssetError>> {
  if (settings === undefined || settings === false) return ok(undefined);
  try {
    if (
      !settings ||
      typeof settings !== 'object' ||
      Array.isArray(settings) ||
      Object.keys(settings).some((key) => key !== 'voxelSize')
    )
      throw new TypeError('meshDistanceField must be false or { voxelSize } in source mesh units');
    const voxelSize = (settings as { voxelSize?: unknown }).voxelSize;
    if (typeof voxelSize !== 'number' || !Number.isFinite(voxelSize) || voxelSize <= 0)
      throw new TypeError('meshDistanceField requires an explicit positive finite voxelSize');
    if (primitives.length !== mesh.submeshes.length)
      throw new TypeError('one primitive per mesh section is required');
    const sidedness = primitives.map((primitive): 0 | 1 => {
      if (primitive.materialIndex === null) return 0;
      const material = materials[primitive.materialIndex];
      if (!material) throw new TypeError('missing source material');
      if (material.alphaMode === 'BLEND')
        throw new TypeError('translucent sections cannot use static visibility fields');
      return material.doubleSided ? 1 : 0;
    });
    return ok(await cookMeshDistanceFieldProduct(mesh, meshGuid, voxelSize, sidedness));
  } catch (error) {
    return err(
      new AssetError({
        code: 'asset-parse-failed',
        expected: 'static triangle geometry and valid meshDistanceField source settings',
        hint: 'Repair meshDistanceField in the source Meta or source geometry/material, then reimport the same mesh GUID.',
        detail: {
          field: 'meshDistanceField',
          value: settings,
          reason: error instanceof Error ? error.message : String(error),
        },
      }),
    );
  }
}
